// Drop unmoderated event finds so the next sweep re-reads them with the
// CURRENT parser. Needed whenever the reader learns to read a site better:
// rows already on the shelf keep whatever the old parser wrote (2026-08-24 —
// allevents rows held 17:00 for a 21:00 party until the epoch parser landed,
// and no amount of re-sweeping fixes a row that already exists).
//
//   node scripts/purgeFoundEvents.js                      # count only
//   node scripts/purgeFoundEvents.js --apply              # delete
//   node scripts/purgeFoundEvents.js --host=allevents.in  # narrow to one source
//
// ONLY status 'new' is ever touched. 'approved' and 'hidden' are validator
// decisions — a human's work is not ours to throw away.

require('dotenv').config();
const mongoose = require('mongoose');
const AiFoundEvent = require('../models/AiFoundEvent');

const APPLY = process.argv.includes('--apply');
const HOST = (process.argv.find(a => a.startsWith('--host=')) || '').split('=')[1] || null;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

    const filter = { status: 'new' };
    if (HOST) filter.sourceUrl = { $regex: HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const total = await AiFoundEvent.countDocuments(filter);
    console.log(`[purge] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to delete)'} · ${total} unmoderated event(s)${HOST ? ` from ${HOST}` : ''}`);

    // Show what's going, so a surprise is visible BEFORE it's irreversible.
    const sample = await AiFoundEvent.find(filter).select('name startDate sourceUrl').limit(10).lean();
    for (const e of sample) {
        const when = e.startDate ? new Date(e.startDate).toISOString().slice(0, 16).replace('T', ' ') : 'no date';
        console.log(`  ${when}  ${String(e.name).slice(0, 48)}`);
    }
    if (total > sample.length) console.log(`  … and ${total - sample.length} more`);

    if (APPLY && total) {
        const { deletedCount } = await AiFoundEvent.deleteMany(filter);
        console.log(`[purge] deleted ${deletedCount} — the next sweep will re-read them`);
    } else if (!APPLY) {
        console.log('[purge] nothing deleted');
    }

    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
