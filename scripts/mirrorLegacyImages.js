// scripts/mirrorLegacyImages.js
//
// One-time backfill (2026-08-30): legacy Destinations/Businesses saved BEFORE
// the save-time image mirror shipped still hotlink external image URLs
// (TripAdvisor CDN, Facebook/Instagram scontent links with signed expiry).
// Facebook links die in ~2 weeks (`oe=` param); TripAdvisor can break any
// time. Live find: 41/57 Destinations + 3 Businesses exposed, 6 already on
// expiring fbcdn URLs — Ureni Restaurant's card image was dead in prod.
//
// The professional rule (already enforced at save time in staffRoutes):
// OWN every image we serve. This script applies it retroactively, per doc:
//   1. keep any image already served through our proxy (bytes owned);
//   2. download each still-alive external URL and store the BYTES in the
//      synthetic PlaceCache row (`dest_<id>` / `biz_<id>`), then point the
//      doc's images at /api/ai/place-image/<key>/<i>;
//   3. if EVERYTHING is dead and nothing is owned → Google Places fallback
//      by name+address (same as staffRoutes Option B): store Google's
//      photos under the Google placeId and reference those — one paid
//      lookup per dead place, cached forever;
//   4. an expired URL is never kept — a dead link is worse than no image.
//
// Usage:  node scripts/mirrorLegacyImages.js --dry-run   (report only)
//         node scripts/mirrorLegacyImages.js             (apply)

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Destination = require('../models/Destination');
const Business = require('../models/Business');
const PlaceCache = require('../models/PlaceCache');

const DRY = process.argv.includes('--dry-run');
const PROXY = '/api/ai/place-image/';
const isProxy = (u) => String(u || '').includes(PROXY);
const isExternal = (u) => /^https?:\/\//i.test(String(u || '')) && !isProxy(u);

async function download(url) {
    const r = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 10000, maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Jinni image mirror)' },
    });
    const ct = r.headers['content-type'] || '';
    if (!ct.startsWith('image/')) throw new Error(`not an image (${ct.slice(0, 30)})`);
    return { photoReference: url, imageData: Buffer.from(r.data), contentType: ct, storedAt: new Date() };
}

// Google Places fallback for a doc whose every image is dead (Option B).
async function googleFallbackImages(doc) {
    try {
        const googleService = require('../services/googleService');
        const imageStorageService = require('../services/imageStorageService');
        const loc = doc.location || {};
        const q = [doc.name, loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        const c = loc.coordinates;
        const coords = (c && Number.isFinite(+c.lat) && Number.isFinite(+c.lng) && +c.lat !== 0)
            ? { lat: +c.lat, lng: +c.lng } : null;
        const places = await googleService.findPlaces(q, coords);
        if (!places || !places.length) return null;
        const placeId = places[0].place_id;
        const details = await googleService.getPlaceDetails(placeId, false);
        if (!details || !details.photos || !details.photos.length) return null;
        const stored = await imageStorageService.downloadAndStoreImages(placeId, details.photos, 8);
        const ok = Array.isArray(stored) ? stored.filter(p => p && p.imageData).length : 0;
        if (!ok) return null;
        return Array.from({ length: ok }, (_, i) => `${PROXY}${placeId}/${i}`);
    } catch (e) {
        console.warn(`  google fallback failed: ${e.message}`);
        return null;
    }
}

async function mirrorDoc(Model, doc, key) {
    const urls = (doc.images || []).map(u => String(u || '').trim()).filter(Boolean);
    // Seed with any bytes ALREADY stored under this doc's own key so existing
    // /place-image/<key>/<idx> references keep their indices; new downloads
    // append after them.
    const cache = await PlaceCache.findOne({ placeId: key }).lean();
    const photos = Array.isArray(cache?.photos) ? [...cache.photos] : [];
    const finalImages = [];
    let kept = 0, mirrored = 0;
    const dead = [];

    for (const u of urls) {
        if (isProxy(u)) { finalImages.push(u); kept++; continue; }   // bytes already owned
        if (!isExternal(u)) continue;                                // junk entry — drop
        if (DRY) { mirrored++; continue; }                            // dry-run: assume alive
        try {
            const photo = await download(u);
            photos.push(photo);
            finalImages.push(`${PROXY}${key}/${photos.length - 1}`);
            mirrored++;
        } catch (e) {
            dead.push(u.slice(0, 70));
        }
    }

    let google = 0;
    if (!DRY) {
        if (mirrored > 0) {
            await PlaceCache.findOneAndUpdate(
                { placeId: key },
                { $set: { name: `mirror:${doc.name}`, photos, imagesStored: true } },
                { upsert: true },
            );
            await Model.findByIdAndUpdate(doc._id, { $set: { images: finalImages } });
        } else if (!finalImages.length) {
            // Everything dead, nothing owned → Google rescue; else leave empty
            // rather than keep corpse URLs.
            const g = await googleFallbackImages(doc);
            if (g) { google = g.length; await Model.findByIdAndUpdate(doc._id, { $set: { images: g } }); }
            else await Model.findByIdAndUpdate(doc._id, { $set: { images: [] } });
        } else {
            // Some proxied images survive; just drop the dead externals.
            await Model.findByIdAndUpdate(doc._id, { $set: { images: finalImages } });
        }
    }
    console.log(`  ${doc.name} (${doc.location?.city || '?'}) — kept ${kept}, mirrored ${mirrored}, dead ${dead.length}${google ? `, google ${google}` : ''}`);
    dead.forEach(d => console.log(`      dead: ${d}`));
    return { kept, mirrored, dead: dead.length, google };
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const targets = [
        { Model: Destination, prefix: 'dest_', label: 'Destinations' },
        { Model: Business, prefix: 'biz_', label: 'Businesses' },
    ];
    const query = { images: { $elemMatch: { $regex: '^https?://', $not: /api\/ai\/place-image/ } } };
    const totals = { kept: 0, mirrored: 0, dead: 0, google: 0, docs: 0 };
    for (const { Model, prefix, label } of targets) {
        const docs = await Model.find(query).lean();
        console.log(`\n${label} with external image URLs: ${docs.length}${DRY ? '  (DRY RUN — no writes)' : ''}`);
        for (const doc of docs) {
            const r = await mirrorDoc(Model, doc, `${prefix}${doc._id}`);
            totals.docs++; totals.kept += r.kept; totals.mirrored += r.mirrored;
            totals.dead += r.dead; totals.google += r.google;
        }
    }
    console.log(`\nTOTAL: ${totals.docs} doc(s) — kept ${totals.kept}, mirrored ${totals.mirrored}, dead ${totals.dead}, google-rescued ${totals.google}`);
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
