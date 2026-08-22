// Register the curated event sources the hunt reads BEFORE any paid web
// search (Arsen 2026-08-23: "i can give urls for yerevan, validator also" …
// "can we test on tomsarkgh too"). Repo convention: DRY-RUN by default.
//
//   node scripts/seedEventSources.js            # show what would be added
//   node scripts/seedEventSources.js --apply    # write
//
// Idempotent: skips a url already registered for that city, so re-running
// never duplicates and never clobbers a validator's enable/disable choice.

require('dotenv').config();
const mongoose = require('mongoose');
const EventSource = require('../models/EventSource');

const APPLY = process.argv.includes('--apply');

const SOURCES = [
    { name: 'Tomsarkgh',         url: 'https://www.tomsarkgh.am/en',      city: 'Yerevan', country: 'Armenia' },
    { name: 'AllEvents Yerevan', url: 'https://allevents.in/yerevan/all', city: 'Yerevan', country: 'Armenia' },
    { name: 'Ticketing.am',      url: 'https://ticketing.am/en',          city: 'Yerevan', country: 'Armenia' },
];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log(`[sources] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);
    for (const s of SOURCES) {
        const existing = await EventSource.findOne({ url: s.url, city: s.city }).lean();
        if (existing) { console.log(`  = ${s.name} — already registered (enabled=${existing.enabled})`); continue; }
        console.log(`  + ${s.name} — ${s.url} [${s.city}, ${s.country}]`);
        if (APPLY) await EventSource.create(s);
    }
    const total = await EventSource.countDocuments({ enabled: true });
    console.log(`[sources] ${total} enabled source(s) registered`);
    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
