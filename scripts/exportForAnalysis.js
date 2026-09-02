#!/usr/bin/env node
/**
 * Export the retrieval-relevant collections as lean JSON, for offline analysis.
 *
 *   node scripts/exportForAnalysis.js                     # → ./export/*.json
 *   node scripts/exportForAnalysis.js --out=/tmp/jinni
 *   node scripts/exportForAnalysis.js --only=destinations
 *
 * READ-ONLY: writes files, touches nothing in the database.
 *
 * Run it wherever the app can reach Mongo — on the server it always can; from
 * a laptop only if that IP is on the Atlas whitelist (the same constraint
 * corpusAudit.js and embedPlaceCache.js record).
 *
 * WHY (founder, 2026-09-03: "download destination database too"): three bugs
 * in one evening turned on what a row actually CONTAINS — a destination tagged
 * both `luxury` and `budget`, cache rows with an empty `actions` array, a card
 * whose stored photo had no bytes. Every test written for those was built on
 * an INVENTED row shape, which is the kind of test that stays green while the
 * code is wrong. Real rows settle it.
 *
 * Deliberately NOT exported:
 *  · photos[].imageData — the image bytes live inside the document, so a plain
 *    dump is hundreds of MB that no analysis can use;
 *  · embedding — 384 floats per row, same reason;
 *  · opening_hours.periods — bulky, and nothing here reasons about it.
 * What remains is public place data: names, Google types, coordinates,
 * aggregate vote counts. No user documents are exported at all.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const ARG = (k, dflt = null) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : dflt;
};
const OUT_DIR = ARG('out', path.join(process.cwd(), 'export'));
const ONLY = (ARG('only') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Explicit inclusion, never exclusion: a field added to a model later cannot
// silently start leaking into an export.
const PLACE_FIELDS = [
    'placeId', 'searchName', 'name', 'actions', 'actionsCurated', 'types', 'primaryType',
    'interests', 'priceLevel', 'imagesStored', 'nameAskPending', 'askedByNameCount',
    'aiBlocked', 'explore.status', 'country', 'city', 'rating', 'likes', 'dislikes',
    'useCount', 'fetchCount', 'lastFetched', 'lastUsed',
    'details.formatted_address', 'details.geometry.location', 'photos.width',
].join(' ');

const DEST_FIELDS = [
    'name', 'type', 'isActive', 'description', 'location', 'pricing', 'images',
    'popularity', 'bestTimeToVisit', 'openingHours', 'eventSchedule', 'createdAt', 'updatedAt',
].join(' ');

const BIZ_FIELDS = [
    'businessName', 'name', 'type', 'isActive', 'status', 'location', 'pricing',
    'images', 'partnerTier', 'createdAt', 'updatedAt',
].join(' ');

const want = (n) => !ONLY.length || ONLY.includes(n);

async function dump(label, Model, fields, shape = (d) => d) {
    const rows = await Model.find({}).select(fields).lean();
    const out = rows.map(shape);
    const file = path.join(OUT_DIR, `${label}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(`[export] ${label}: ${out.length} row(s) → ${file} (${mb} MB)`);
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log(`[export] connected · out=${OUT_DIR}${ONLY.length ? ` · only=${ONLY.join(',')}` : ''}`);

    if (want('placecache')) {
        // Photos are projected down to their width alone, so a row can still
        // say HOW MANY photos it claims without carrying a byte of them — the
        // gap that matters, since `imagesStored: true` with no readable bytes
        // is exactly what carded a dead image (live 2026-09-03).
        await dump('placecache', require('../models/PlaceCache'), PLACE_FIELDS, (d) => {
            const { photos, ...rest } = d;
            return { ...rest, photoCount: Array.isArray(photos) ? photos.length : 0 };
        });
    }
    if (want('destinations')) {
        await dump('destinations', require('../models/Destination'), DEST_FIELDS, (d) => {
            const { images, ...rest } = d;
            return { ...rest, imageCount: Array.isArray(images) ? images.length : 0 };
        });
    }
    if (want('businesses')) {
        await dump('businesses', require('../models/Business'), BIZ_FIELDS, (d) => {
            const { images, ...rest } = d;
            return { ...rest, imageCount: Array.isArray(images) ? images.length : 0 };
        });
    }

    console.log('[export] done — nothing in the database was modified.');
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error('[export] failed:', err.message); process.exit(1); });
