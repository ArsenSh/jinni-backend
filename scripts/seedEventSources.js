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

    // ── Category feeds, so the deck has something to FILTER.
    //
    // Arsen 2026-08-24: "add normal urls at least where app can find normal
    // events, romantic events, family events, adventure events and so on,
    // because all events seem production or event types that are not fitting
    // with preferences, i think it doesnt have wide range of events so it has
    // not filtered romantic ones".
    //
    // Exactly right, and it was a supply problem rather than a ranking one.
    // /dubai/all is dominated by trade expos — one Dubai turn returned four
    // cards for Middle East Energy — so a traveler whose preferences say
    // luxury and romantic had nothing romantic in the deck to rank. Taste
    // scoring cannot conjure a candle-lit concert that was never retrieved.
    //
    // Each URL was fetched and run through the adapter before being added; the
    // counts below are what it actually read on 2026-08-24. They are recorded
    // so a site redesign shows up as a drop in yield rather than a mystery.
    //
    // Overlap is fine and expected: Candlelight appears under music, family AND
    // concerts, and the hunt's identity key (normalizedName|startDay|city)
    // collapses those into one event.
    //
    // These are separate rows rather than one fan-out inside the adapter so a
    // validator can see each feed's yield and disable one without touching the
    // rest. MAX_CURATED (hunt.js) must stay above the count here, or the extra
    // sources are silently never read — that query has no sort, so truncation
    // is arbitrary rather than "lowest priority first".

    // ── Eventbrite: the widest general source we found, and the answer to
    //    "maybe another powerful web exists for events" (Arsen 2026-08-24).
    //    Verified 2026-08-24: 50 dated Dubai events and 14 Yerevan ones, all
    //    from a single JSON-LD block, so the generic ladder reads it with no
    //    adapter and no rendering. Registered FIRST because it is the strongest
    //    single feed either city has.
    { name: 'Eventbrite Dubai',   url: 'https://www.eventbrite.com/d/united-arab-emirates--dubai/events/', city: 'Dubai',   country: 'United Arab Emirates' },
    { name: 'Eventbrite Yerevan', url: 'https://www.eventbrite.com/d/armenia--yerevan/events/',            city: 'Yerevan', country: 'Armenia' },

    // Dubai — the category feeds.
    { name: 'AllEvents Dubai · Music',      url: 'https://allevents.in/dubai/music',       city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 15 — Candlelight, concerts
    { name: 'AllEvents Dubai · Nightlife',  url: 'https://allevents.in/dubai/nightlife',   city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 14 — yacht cruises, parties
    { name: 'AllEvents Dubai · Food',       url: 'https://allevents.in/dubai/food-drinks', city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 10 — dinner cruises, tastings
    { name: 'AllEvents Dubai · Arts',       url: 'https://allevents.in/dubai/arts',        city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 15 — exhibitions
    { name: 'AllEvents Dubai · Family',     url: 'https://allevents.in/dubai/family',      city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 15
    { name: 'AllEvents Dubai · Sports',     url: 'https://allevents.in/dubai/sports',      city: 'Dubai', country: 'United Arab Emirates', adapter: 'allevents' },      // 15 — the adventure end

    // Yerevan — thinner than Dubai, which is the city being smaller and not a
    // fault in the feed. /sports read a single event, so it is left out rather
    // than spending a fetch on it.
    { name: 'AllEvents Yerevan · Music',    url: 'https://allevents.in/yerevan/music',       city: 'Yerevan', country: 'Armenia', adapter: 'allevents' },   // 14 — opera, Imany
    { name: 'AllEvents Yerevan · Arts',     url: 'https://allevents.in/yerevan/arts',        city: 'Yerevan', country: 'Armenia', adapter: 'allevents' },   // 5
    { name: 'AllEvents Yerevan · Nightlife', url: 'https://allevents.in/yerevan/nightlife',  city: 'Yerevan', country: 'Armenia', adapter: 'allevents' },   // 5
    { name: 'AllEvents Yerevan · Family',   url: 'https://allevents.in/yerevan/family',      city: 'Yerevan', country: 'Armenia', adapter: 'allevents' },   // 3
    { name: 'AllEvents Yerevan · Food',     url: 'https://allevents.in/yerevan/food-drinks', city: 'Yerevan', country: 'Armenia', adapter: 'allevents' },   // 3 — festivals
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
