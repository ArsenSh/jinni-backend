const axios = require('axios');
const PlaceCache = require('../models/PlaceCache');
const PLACES_BASE = 'https://places.googleapis.com/v1';

/**
 * Build the correct image download URL for either:
 * - Places API (New): photo.name = "places/ChIJ.../photos/Aaw..."
 * - Places API (Legacy): photo.photo_reference = raw string
 */
function buildPhotoUrl(photo) {
    // New API: photoReference stored as "places/..." string or object with .name
    const ref = photo.name || photo.photoReference || photo.photo_reference;
    if (!ref) return null;
    if (typeof ref === 'object' && ref.name) {return `${PLACES_BASE}/${ref.name}/media?maxWidthPx=800&key=${process.env.GOOGLE_API_KEY}&skipHttpRedirect=false`}
    if (typeof ref === 'string' && ref.startsWith('places/')) {return `${PLACES_BASE}/${ref}/media?maxWidthPx=800&key=${process.env.GOOGLE_API_KEY}&skipHttpRedirect=false`}
    // Legacy fallback
    return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${ref}&key=${process.env.GOOGLE_API_KEY}`;
}

class ImageStorageService {
    constructor() {
        this.downloading = new Set();
        // Places already deep-healed (or attempted) this process — bounds the
        // Place Details re-resolve in serveImage to ONE paid call per place,
        // so a place with genuinely no photos can never become a spend loop.
        this._reResolved = new Set();
    }

    /**
     * Download and store Google Place images in MongoDB
     */
    async downloadAndStoreImages(placeId, photos, limit = 8, requestId = null) {
        if (this.downloading.has(placeId)) {
            await new Promise(resolve => {const checkInterval = setInterval(() => {if (!this.downloading.has(placeId)) { clearInterval(checkInterval); resolve(); }}, 100)});
            return;
        }
        try {
            this.downloading.add(placeId);
            const photosToDownload = photos.slice(0, limit);
            const storedPhotos = await Promise.all(
                photosToDownload.map(async (photo, index) => {
                    // Preserve the reference in whichever format it arrived
                    const photoReference = photo.name || photo.photoReference || photo.photo_reference || null;
                    const width = photo.widthPx || photo.width || null;
                    const height = photo.heightPx || photo.height || null;
                    try {
                        const imageUrl = buildPhotoUrl(photo);
                        if (!imageUrl) {
                            console.error(`❌ No photo reference for image ${index + 1}`);
                            return { photoReference, width, height, imageData: null, contentType: 'image/jpeg', storedAt: new Date() };
                        }
                        console.log(`  📥 Downloading image ${index + 1} from: ${imageUrl.substring(0, 80)}...`);
                        const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000, maxRedirects: 5 });
                        // Per-user billing attribution at the TRUE billing point: each
                        // successful photo fetch is one Place Photos SKU ($0.007).
                        // Cache-served images never reach this code. Lazy requires
                        // avoid load cycles; failures must never break a download.
                        try {
                            const { userId } = require('./requestContext').get();
                            if (userId) require('../models/UserGoogleUsage').track(userId, 'imageDownload');
                        } catch (e) { /* attribution only */ }
                        const contentType = response.headers['content-type'] || 'image/jpeg';
                        console.log(`  ✅ Image ${index + 1} downloaded (${(response.data.length / 1024).toFixed(1)} KB, ${contentType})`);
                        return {photoReference, width, height, imageData: Buffer.from(response.data), contentType, storedAt: new Date()};
                    } catch (error) {
                        console.error(`❌ Failed to download image ${index + 1}:`, error.message);
                        return { photoReference, width, height, imageData: null, contentType: 'image/jpeg', storedAt: new Date() };
                    }
                })
            );
            const successfulDownloads = storedPhotos.filter(p => p.imageData !== null).length;
            // Hidden places must stay image-free (hide purges their photos to
            // reclaim space) — a saved-card image request could otherwise
            // re-store them. Serve the downloads to THIS requester, skip the DB.
            const hiddenCheck = await PlaceCache.findOne({ placeId }).select('explore.status').lean();
            if (hiddenCheck?.explore?.status === 'hidden') {
                console.log(`[images] ${placeId} is hidden — downloaded photos NOT stored`);
                return storedPhotos;
            }
            await PlaceCache.findOneAndUpdate({ placeId }, { $set: { photos: storedPhotos, imagesStored: successfulDownloads > 0 } }, { upsert: true });
            console.log(`✅ Stored ${successfulDownloads}/${photosToDownload.length} images for ${placeId}`);
            return storedPhotos;
        } catch (error) {
            console.error('❌ Image storage service error:', error);
            throw error;
        } finally {this.downloading.delete(placeId)}
    }

    /**
     * Download a single photo from Google by its reference (New API
     * "places/.../photos/..." or legacy raw ref). Used by the gallery stream
     * to send real bytes progressively instead of proxy URLs.
     */
    async downloadPhoto(photoReference) {
        const url = buildPhotoUrl({ photo_reference: photoReference });
        if (!url) throw new Error('no photo reference');
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000, maxRedirects: 5 });
        return { buffer: Buffer.from(response.data), contentType: response.headers['content-type'] || 'image/jpeg' };
    }

    /**
     * Serve image directly from database (NO API CALLS)
     */
    async serveImage(placeId, photoIndex = 0) {
        try {
            // Fetch ONLY the requested slot ($slice projection). The full
            // document carries every photo's binary (often 2-3 MB total), so
            // reading it whole from Atlas for EACH image request made every
            // gallery flip cost seconds.
            const cached = await PlaceCache.findOne({ placeId }, { photos: { $slice: [photoIndex, 1] } }).lean();
            if (!cached) throw new Error('Place not found in cache');

            const isJson = (p) => p && p.contentType && p.contentType.includes('application/json');

            // Try the requested index first (slice returns it as element 0).
            let photo = (cached.photos || [])[0];
            let imageBuffer = (photo && !isJson(photo)) ? this._toBuffer(photo.imageData) : null;

            // Fallback: requested slot is missing / null / JSON-poisoned. Serve the
            // first photo that actually has readable bytes, so a poisoned index 0
            // doesn't 404 the whole card. (Self-heals stale cache entries.)
            // Whether we're substituting a different slot for the requested one.
            // Callers must NOT let clients cache substituted responses — during a
            // gallery download the early requests would pin the first photo into
            // the browser cache for every index (max-age is 30 days).
            let fallback = false;
            let full = null;
            if (!imageBuffer) {
                // Rare self-heal path: requested slot missing / null / JSON-
                // poisoned — only now read the full array to find a valid photo.
                full = await PlaceCache.findOne({ placeId }).lean();
                const valid = (full?.photos || []).find(p => !isJson(p) && this._toBuffer(p.imageData));
                if (valid) {
                    if (photoIndex !== full.photos.indexOf(valid)) {
                        console.warn(`⚠️ ${placeId}/${photoIndex} unreadable — serving first valid photo instead`);
                        fallback = true;
                    }
                    photo = valid;
                    imageBuffer = this._toBuffer(valid.imageData);
                }
            }

            // LAST resort — NO row has bytes but a Google reference survives
            // (live 2026-08-30: Heritage of Alluria's rows all carried null
            // imageData, so every card render logged "no photo has bytes" and
            // 404'd forever). Re-fetch ONCE from the stored reference and put
            // the bytes back, so the place heals instead of erroring on every
            // request. Hidden places keep the purge rule (hide = images gone,
            // never re-stored) and fall through to the throw below.
            if (!imageBuffer && full && full?.explore?.status !== 'hidden') {
                const refRow = (full.photos || []).find(p => p && p.photoReference);
                if (refRow) {
                    try {
                        const { buffer, contentType } = await this.downloadPhoto(refRow.photoReference);
                        // Same per-user Place Photos SKU attribution as the
                        // store path — this is a real Google fetch.
                        try {
                            const { userId } = require('./requestContext').get();
                            if (userId) require('../models/UserGoogleUsage').track(userId, 'imageDownload');
                        } catch (e) { /* attribution only */ }
                        await PlaceCache.updateOne(
                            { placeId, 'photos.photoReference': refRow.photoReference },
                            { $set: { 'photos.$.imageData': buffer, 'photos.$.contentType': contentType, 'photos.$.storedAt': new Date(), imagesStored: true } }
                        ).catch(() => { /* serve anyway — heal again next time */ });
                        console.log(`🔧 ${placeId} self-healed: re-fetched photo bytes from the stored reference`);
                        return { data: buffer, contentType, fallback: photoIndex !== full.photos.indexOf(refRow) };
                    } catch (refetchErr) {
                        console.warn(`⚠️ ${placeId} byte-less photos and the re-fetch failed too (${refetchErr.message})`);
                    }
                }
                // DEEP heal (live 2026-08-31: ChIJf7kh… had rows with NO usable
                // reference at all, so the reference re-fetch above had nothing
                // to work with). One Place Details call gets fresh photo names,
                // the standard store path writes real bytes, and the place is
                // healed for good. Once per place per process, whether it works
                // or not — the _reResolved guard is the cost ceiling.
                if (!this._reResolved.has(placeId)) {
                    this._reResolved.add(placeId);
                    try {
                        const details = await require('./googleService').getPlaceDetails(placeId, false, null);
                        if (details?.photos?.length) {
                            const stored = await this.downloadAndStoreImages(placeId, details.photos, 8);
                            const healed = (stored || []).find(p => p && this._toBuffer(p.imageData));
                            if (healed) {
                                console.log(`🔧 ${placeId} deep-healed: re-resolved Place Details for fresh photo references`);
                                return {
                                    data: this._toBuffer(healed.imageData),
                                    contentType: healed.contentType || 'image/jpeg',
                                    fallback: photoIndex !== stored.indexOf(healed),
                                };
                            }
                        } else {
                            console.warn(`⚠️ ${placeId} deep-heal: Google lists no photos for this place`);
                        }
                    } catch (resolveErr) {
                        console.warn(`⚠️ ${placeId} deep-heal failed (${resolveErr.message})`);
                    }
                }
            }

            if (!imageBuffer) {
                console.error(`❌ No readable image for ${placeId} (requested index ${photoIndex}) — no photo has bytes`);
                // ── DEAD-IMAGE FLIP (2026-09-04) ──
                // Six rows 404'd on every home-screen render because their
                // photos carry no bytes yet imagesStored stayed true, so cards
                // kept pointing at this endpoint forever. Byte-less photos are
                // useless (deep-heal re-resolves from Google, never from these
                // rows) — clear them and flip the flag so the card path stops
                // advertising an image the store cannot serve.
                try {
                    const mongoose = require('mongoose');
                    if (mongoose.connection?.readyState === 1) {
                        await require('../models/PlaceCache').updateOne(
                            { placeId },
                            { $set: { imagesStored: false, photos: [] } });
                        console.log(`🧹 ${placeId}: imagesStored flipped to false (dead image purged)`);
                    }
                } catch (flipErr) {
                    console.warn(`⚠️ dead-image flip failed for ${placeId}: ${flipErr.message}`);
                }
                throw new Error('Invalid image data format');
            }
            return { data: imageBuffer, contentType: photo.contentType || 'image/jpeg', fallback };
        } catch (error) {
            console.error('❌ Serve image error:', error.message);
            throw error;
        }
    }

    /**
     * Convert any MongoDB Binary / Buffer / plain object representation to a Node Buffer
     */
    _toBuffer(imageData) {
        if (!imageData) return null;
        // Already a real Buffer
        if (Buffer.isBuffer(imageData)) return imageData;
        // Mongoose returns Binary as object with .buffer (Uint8Array)
        if (imageData.buffer instanceof ArrayBuffer || ArrayBuffer.isView(imageData.buffer)) {return Buffer.from(imageData.buffer)}
        // MongoDB BSON Binary — has a .value() method
        if (typeof imageData.value === 'function') {return Buffer.from(imageData.value('raw'))}
        // Plain object serialised as { type: 'Buffer', data: [...] }
        if (typeof imageData === 'object' && imageData.type === 'Buffer' && Array.isArray(imageData.data)) {return Buffer.from(imageData.data)}
        // Uint8Array / ArrayBuffer
        if (imageData instanceof Uint8Array || imageData instanceof ArrayBuffer) {return Buffer.from(imageData)}
        return null;
    }
    /**
     * Check if images are already stored (NO API CALLS)
     */
    async hasStoredImages(placeId) {
        const cached = await PlaceCache.findOne({ placeId });
        return cached && cached.imagesStored === true && cached.photos && cached.photos.some(p => p.imageData && p.imageData.length > 0);
    }
    trackPhotoDownload(requestId, count = 1) {
        if (!this.photoStats) this.photoStats = {};
        if (!this.photoStats[requestId]) this.photoStats[requestId] = 0;
        this.photoStats[requestId] += count;
    }
    getPhotoStats(requestId) { return this.photoStats?.[requestId] || 0 }
    clearPhotoStats(requestId) { if (this.photoStats?.[requestId]) delete this.photoStats[requestId]; }
}

module.exports = new ImageStorageService();