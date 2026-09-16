// Store Google's businessStatus on PlaceCache rows that never had it.
// Repo convention: DRY-RUN by default.
//
//   node scripts/refreshBusinessStatus.js --placeId=ChIJ…        # print one row (no Google call)
//   node scripts/refreshBusinessStatus.js --placeId=ChIJ… --apply # refresh that one row
//   node scripts/refreshBusinessStatus.js                         # count rows missing a status
//   node scripts/refreshBusinessStatus.js --apply --limit=300     # refresh up to 300 rows
//
// ⚠ RUN THIS ON THE SERVER — the Atlas IP whitelist blocks local connections.
//
// WHY (2026-09-16): businessStatus was only requested from Google since
// 2026-09-15, and a cached row is refreshed only after 30 days — so a place
// Google marks CLOSED_TEMPORARILY (Cascade Royal) sits in the cache with no
// status and the closed-business drop cannot see it. This asks Google for the
// status ALONE (field mask id,businessStatus — the cheapest Details tier) and
// stores it. Nothing else on the row is touched.
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const ONE = (process.argv.find(a => a.startsWith('--placeId=')) || '').split('=')[1] || null;
const PLACES_BASE = 'https://places.googleapis.com/v1';

async function fetchStatus(placeId) {
    const res = await axios.get(`${PLACES_BASE}/places/${placeId}`, {
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_API_KEY, 'X-Goog-FieldMask': 'id,businessStatus' },
        timeout: 10000,
    });
    return res.data?.businessStatus || null;
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const coll = mongoose.connection.db.collection('placecaches');
    const proj = { placeId: 1, name: 1, business_status: 1, hoursCurated: 1, 'opening_hours.weekday_text': 1, 'opening_hours.periods': 1, lastFetched: 1, lastUsed: 1, fetchCount: 1, useCount: 1, 'explore.status': 1, aiBlocked: 1 };
    if (ONE) {
        const row = await coll.findOne({ placeId: ONE }, { projection: proj });
        if (!row) { console.log(`no row for ${ONE}`); process.exit(1); }
        console.log(JSON.stringify(row, null, 1));
        if (APPLY) {
            const status = await fetchStatus(ONE);
            await coll.updateOne({ placeId: ONE }, { $set: { business_status: status } });
            console.log(`stored business_status=${status}`);
        } else console.log('(dry run — add --apply to refresh the status from Google)');
        process.exit(0);
    }
    const q = { $or: [{ business_status: null }, { business_status: { $exists: false } }] };
    const total = await coll.countDocuments(q);
    console.log(`rows without a business status: ${total}${LIMIT ? ` (limit ${LIMIT})` : ''}`);
    if (!APPLY) { console.log('(dry run — add --apply to fetch and store; each row is one cheap Details call)'); process.exit(0); }
    const cursor = coll.find(q, { projection: { placeId: 1, name: 1 } }).sort({ useCount: -1 });
    let done = 0, closed = 0, failed = 0;
    for await (const row of cursor) {
        if (LIMIT && done >= LIMIT) break;
        try {
            const status = await fetchStatus(row.placeId);
            await coll.updateOne({ _id: row._id }, { $set: { business_status: status } });
            done++;
            if (status && status !== 'OPERATIONAL') { closed++; console.log(`  ${status}: ${row.name} (${row.placeId})`); }
        } catch (err) { failed++; console.warn(`  failed ${row.name}: ${err.response?.status || err.message}`); }
        await new Promise(r => setTimeout(r, 120));
    }
    console.log(`refreshed: ${done} · non-operational: ${closed} · failed: ${failed}`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
