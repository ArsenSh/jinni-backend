#!/usr/bin/env node
/**
 * Why can't the engine see this place? — the gate-by-gate report.
 *
 *   node scripts/cacheReport.js
 *   node scripts/cacheReport.js --near=39.878,44.576 --km=15
 *   node scripts/cacheReport.js --name=noah
 *
 * READ-ONLY: no writes, no Google calls, no model calls.
 * Run ON THE SERVER (Atlas IP whitelist blocks local, same as corpusAudit).
 *
 * WHY (2026-09-03): "why doesn't it see my destination" came up four times in
 * one evening, and each answer needed a different file read by hand — the
 * category gate in proximityService, the style verdict, the actions tag in
 * buildCacheQuery, the runtime photo check in canonicalStore. A row is
 * reachable only if it passes ALL of them, so this prints all of them at once.
 *
 * Photo counts are computed inside Mongo ($size): the image bytes live in the
 * document, and a projection that ships them is unusable (2026-09-03: a first
 * attempt projected a subfield that did not survive, and every row read as
 * "claims images it does not have" — a bug in the report, not the data).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const ARG = (k, dflt = null) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : dflt;
};
const NEAR = (ARG('near') || '').split(',').map(Number).filter(Number.isFinite);
const KM = Number(ARG('km', '15')) || 15;
const NAME = (ARG('name') || '').trim();

const km = (aLat, aLng, bLat, bLng) => {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
};

const PHOTO_BYTES = { $size: { $filter: { input: { $ifNull: ['$photos', []] }, as: 'p',
    cond: { $ne: [{ $ifNull: ['$$p.imageData', null] }, null] } } } };

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const PlaceCache = require('../models/PlaceCache');
    const Destination = require('../models/Destination');
    const Business = require('../models/Business');

    const dests = await Destination.find({}).select('name type isActive location').lean();
    const bizes = await Business.find({}).select('businessName name type isActive status location').lean();

    const tag = (d, t) => (d.type || []).includes(t);
    const bothStyles = dests.filter(d => tag(d, 'luxury') && tag(d, 'budget'));
    const noCoords = dests.filter(d => (d.location && d.location.coordinates && d.location.coordinates.lat) == null);
    console.log(`\n== DESTINATIONS (${dests.length}) · BUSINESSES (${bizes.length}) ==`);
    console.log(`tagged BOTH luxury+budget  : ${bothStyles.length}${bothStyles.length ? '  -> ' + bothStyles.map(d => d.name).join(', ') : ''}`);
    console.log(`NO coordinates (unservable): ${noCoords.length}${noCoords.length ? '  -> ' + noCoords.map(d => d.name).join(', ') : ''}`);
    console.log(`inactive                   : ${dests.filter(d => d.isActive === false).length}`);
    const tally = {};
    for (const d of dests) for (const t of (d.type || [])) tally[t] = (tally[t] || 0) + 1;
    console.log(`tags: ${JSON.stringify(tally)}`);

    const agg = await PlaceCache.aggregate([{ $group: {
        _id: null,
        total: { $sum: 1 },
        stored: { $sum: { $cond: ['$imagesStored', 1, 0] } },
        storedNoBytes: { $sum: { $cond: [{ $and: ['$imagesStored', { $eq: [PHOTO_BYTES, 0] }] }, 1, 0] } },
        noActions: { $sum: { $cond: [{ $eq: [{ $size: { $ifNull: ['$actions', []] } }, 0] }, 1, 0] } },
        quarantined: { $sum: { $cond: ['$nameAskPending', 1, 0] } },
        blocked: { $sum: { $cond: ['$aiBlocked', 1, 0] } },
        hidden: { $sum: { $cond: [{ $eq: ['$explore.status', 'hidden'] }, 1, 0] } },
    } }]);
    const h = agg[0] || {};
    console.log(`\n== PLACECACHE (${h.total}) ==`);
    console.log(`imagesStored true          : ${h.stored}`);
    console.log(`  ...of those with 0 bytes : ${h.storedNoBytes}   <- these card a dead image`);
    console.log(`empty actions              : ${h.noActions}`);
    console.log(`name-ask quarantined       : ${h.quarantined}   <- invisible until staff admit`);
    console.log(`aiBlocked / explore hidden : ${h.blocked} / ${h.hidden}`);

    if (NEAR.length === 2) {
        const [lat, lng] = NEAR;
        console.log(`\n== WITHIN ${KM} km OF ${lat},${lng} ==`);
        for (const d of dests) {
            const c = d.location && d.location.coordinates;
            if (!c || c.lat == null) continue;
            const dist = km(lat, lng, c.lat, c.lng);
            if (dist > KM) continue;
            console.log(`  DEST  ${dist.toFixed(1)}km  ${d.name}  [${(d.type || []).join('|')}]  active=${d.isActive !== false}`);
        }
        const rows = await PlaceCache.aggregate([
            { $match: { 'details.geometry.location.lat': { $gte: lat - KM / 111, $lte: lat + KM / 111 } } },
            { $project: { name: 1, actions: 1, imagesStored: 1, nameAskPending: 1, aiBlocked: 1,
                explore: 1, loc: '$details.geometry.location',
                photoCount: { $size: { $ifNull: ['$photos', []] } }, withBytes: PHOTO_BYTES } },
        ]);
        for (const p of rows) {
            if (!p.loc || p.loc.lat == null) continue;
            const dist = km(lat, lng, p.loc.lat, p.loc.lng);
            if (dist > KM) continue;
            const flags = [];
            if (!p.imagesStored) flags.push('no imagesStored');
            if (!p.withBytes) flags.push('NO PHOTO BYTES');
            if (!(p.actions || []).length) flags.push('no actions');
            if (p.nameAskPending) flags.push('quarantined');
            if (p.aiBlocked) flags.push('aiBlocked');
            if (p.explore && p.explore.status === 'hidden') flags.push('hidden');
            console.log(`  CACHE ${dist.toFixed(1)}km  ${p.name}  [${(p.actions || []).join('|') || '-'}]`
                + `  photos=${p.photoCount}/${p.withBytes}  ${flags.length ? 'BLOCKED: ' + flags.join(', ') : 'reachable'}`);
        }
    }

    if (NAME) {
        const rx = new RegExp(NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        console.log(`\n== ROWS MATCHING /${NAME}/i ==`);
        for (const d of dests.filter(x => rx.test(x.name || ''))) {
            console.log(`  DEST  ${d.name}  [${(d.type || []).join('|')}]  active=${d.isActive !== false}`
                + `  coords=${JSON.stringify((d.location && d.location.coordinates) || null)}`);
        }
        for (const b of bizes.filter(x => rx.test(x.businessName || x.name || ''))) {
            console.log(`  BIZ   ${b.businessName || b.name}  [${(b.type || []).join('|')}]  status=${b.status}`);
        }
        const hits = await PlaceCache.aggregate([
            { $match: { name: rx } },
            { $project: { name: 1, actions: 1, imagesStored: 1, nameAskPending: 1, explore: 1, withBytes: PHOTO_BYTES } },
            { $limit: 10 },
        ]);
        for (const p of hits) {
            console.log(`  CACHE ${p.name}  [${(p.actions || []).join('|') || '-'}]  bytes=${p.withBytes}`
                + `  stored=${p.imagesStored}  quar=${!!p.nameAskPending}`);
        }
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error('[report] failed:', err.message); process.exit(1); });
