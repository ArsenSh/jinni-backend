// scripts/purgeHiddenImages.js
//
// One-shot cleanup: hidden places now purge their stored images automatically
// AT hide time, but places hidden BEFORE that change still carry image buffers
// in the DB. This deletes them. Safe to re-run (idempotent).
//
// Run ON THE SERVER (Coolify terminal — the Atlas whitelist blocks local IPs):
//   node scripts/purgeHiddenImages.js           # dry run — reports only
//   node scripts/purgeHiddenImages.js --apply   # actually deletes the images

require('dotenv').config();
const mongoose = require('mongoose');
const PlaceCache = require('../models/PlaceCache');

const APPLY = process.argv.includes('--apply');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const docs = await PlaceCache.find(
        { 'explore.status': 'hidden', 'photos.0': { $exists: true } },
        { placeId: 1, name: 1, 'photos.imageData': 1 }
    ).lean();

    let bytes = 0;
    for (const d of docs) {
        for (const p of (d.photos || [])) bytes += p.imageData?.length || p.imageData?.buffer?.length || 0;
    }
    console.log(`Hidden places still holding images: ${docs.length}`);
    console.log(`Approximate space to reclaim: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    for (const d of docs.slice(0, 20)) console.log(`  - ${d.name} (${d.placeId})`);
    if (docs.length > 20) console.log(`  … and ${docs.length - 20} more`);

    if (!APPLY) {
        console.log('\nDry run — nothing deleted. Re-run with --apply to purge.');
    } else if (docs.length) {
        const r = await PlaceCache.updateMany(
            { 'explore.status': 'hidden', 'photos.0': { $exists: true } },
            { $set: { photos: [], imagesStored: false } }
        );
        console.log(`\n✅ Purged images from ${r.modifiedCount} hidden place(s).`);
    }
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
