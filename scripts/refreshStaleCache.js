// Refresh PlaceCache rows whose Google details are older than N days.
// Repo convention: DRY-RUN by default.
//
//   node scripts/refreshStaleCache.js                       # count stale rows
//   node scripts/refreshStaleCache.js --apply --limit=200   # refresh up to 200 (oldest first)
//   node scripts/refreshStaleCache.js --apply --limit=0     # clear the whole backlog
//   node scripts/refreshStaleCache.js --days=45             # a different "stale" threshold
//
// Same sweep the server runs weekly (services/cacheRefresh.js); this is the
// one-off backlog tool. Each row is one Place Details call.
require('dotenv').config();
const mongoose = require('mongoose');
const { runCacheRefresh, staleQuery, STALE_DAYS } = require('../services/cacheRefresh');

const APPLY = process.argv.includes('--apply');
const arg = (k, d) => { const v = (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]; return v == null || v === '' ? d : Number(v); };
const LIMIT = arg('limit', 100);
const DAYS = arg('days', STALE_DAYS);

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const PlaceCache = require('../models/PlaceCache');
    const total = await PlaceCache.countDocuments(staleQuery({ olderThanDays: DAYS }));
    console.log(`rows older than ${DAYS}d: ${total}${LIMIT ? ` (this run: up to ${LIMIT})` : ' (this run: all)'}`);
    if (!APPLY) { console.log('(dry run — add --apply to refresh; each row is one Place Details call)'); process.exit(0); }
    const summary = await runCacheRefresh({ olderThanDays: DAYS, limit: LIMIT || total || 1 });
    console.log(JSON.stringify({ ...summary, nonOperational: summary.nonOperational.length }));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
