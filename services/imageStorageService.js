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
    constructor() { this.downloading = new Set() }

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
            await PlaceCache.findOneAndUpdate({ placeId }, { $set: { photos: storedPhotos, imagesStored: successfulDownloads > 0 } }, { upsert: true });
            console.log(`✅ Stored ${successfulDownloads}/${photosToDownload.length} images for ${placeId}`);
            return storedPhotos;
        } catch (error) {
            console.error('❌ Image storage service error:', error);
            throw error;
        } finally {this.downloading.delete(placeId)}
    }

    /**
     * Serve image directly from database (NO API CALLS)
     */
    async serveImage(placeId, photoIndex = 0) {
        try {
            const cached = await PlaceCache.findOne({ placeId });
            if (!cached) throw new Error('Place not found in cache');
            if (!cached.photos || !cached.photos.length) throw new Error('Photo not found at index');

            const isJson = (p) => p && p.contentType && p.contentType.includes('application/json');

            // Try the requested index first.
            let photo = cached.photos[photoIndex];
            let imageBuffer = (photo && !isJson(photo)) ? this._toBuffer(photo.imageData) : null;

            // Fallback: requested slot is missing / null / JSON-poisoned. Serve the
            // first photo that actually has readable bytes, so a poisoned index 0
            // doesn't 404 the whole card. (Self-heals stale cache entries.)
            if (!imageBuffer) {
                const valid = (cached.photos || []).find(p => !isJson(p) && this._toBuffer(p.imageData));
                if (valid) {
                    if (photoIndex !== cached.photos.indexOf(valid)) {
                        console.warn(`⚠️ ${placeId}/${photoIndex} unreadable — serving first valid photo instead`);
                    }
                    photo = valid;
                    imageBuffer = this._toBuffer(valid.imageData);
                }
            }

            if (!imageBuffer) {
                console.error(`❌ No readable image for ${placeId} (requested index ${photoIndex}) - none of ${cached.photos.length} photo(s) have bytes`);
                throw new Error('Invalid image data format');
            }
            return { data: imageBuffer, contentType: photo.contentType || 'image/jpeg' };
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