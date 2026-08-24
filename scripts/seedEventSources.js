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
    // ticketing.am does not resolve (live 2026-08-23: "[hunt] … fetch failed");
    // ticket.am is the working host.
    { name: 'Ticket.am',         url: 'https://ticket.am',                city: 'Yerevan', country: 'Armenia' },

    // ── Dubai (Arsen 2026-08-24: "lets add the ticketmaster source manually
    //    to the registry").
    //
    // A night of engine work on Dubai, and the answer was a registered source.
    // Discovery could never get there on its own: platinumlist sits behind a
    // Queue-it waiting room, dubaicalendar.ae has a broken certificate,
    // timeoutdubai answers 405, and visitdubai is a marketing page with one
    // date in 394KB. None of that is a bug we can fix.
    //
    // VERIFIED against the live page before registering: the allevents adapter
    // reads 43 dated Dubai events with posters from this URL. Same adapter and
    // same shape as Yerevan — picked automatically from the host, named here
    // anyway so the staff list shows which parser runs.
    { name: 'AllEvents Dubai',   url: 'https://allevents.in/dubai/all',   city: 'Dubai',
      country: 'United Arab Emirates', adapter: 'allevents' },

    // Ticketmaster UAE. city:null ⇒ country-wide, which is what this site is.
    // Its root answers 200 with 456KB, but our markup ladder finds only two
    // dates in it and no structured rows — the listing arrives as JSON from its
    // own API. So this source exists for the network-capture tier to read, and
    // it is the one entry here NOT yet proven to yield events. If it reads 0
    // night after night, lastFoundCount will say so in the staff list; being
    // staff-registered it will never disable itself, because a person's choice
    // is not ours to revoke.
    { name: 'Ticketmaster UAE',  url: 'https://www.ticketmaster.ae/',     city: null,
      country: 'United Arab Emirates' },
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
