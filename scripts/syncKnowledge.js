// Fill the LocalFact store from Wikivoyage + UK FCDO (Arsen 2026-08-23:
// "lets build wikivoyage and fcdo"). Repo convention: DRY-RUN by default.
//
//   node scripts/syncKnowledge.js                      # show what would be read
//   node scripts/syncKnowledge.js --apply              # read + store
//   node scripts/syncKnowledge.js --apply Yerevan,Armenia "Dubai,United Arab Emirates"
//
// With no place arguments it syncs every city already registered in the event
// source registry, so one curation effort feeds both pipelines.

require('dotenv').config();
const mongoose = require('mongoose');
const { syncKnowledge } = require('../engine/knowledge/sync');
const { fetchCityKnowledge } = require('../engine/knowledge/wikivoyage');
const { fetchAdvisory } = require('../engine/knowledge/advisories');

const APPLY = process.argv.includes('--apply');
const PAIRS = process.argv.slice(2).filter(a => !a.startsWith('--'))
    .map(a => {
        const [city, country] = a.split(',').map(s => s.trim());
        return { city: city || null, country: country || null };
    });

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    let places = PAIRS;
    if (!places.length) {
        const EventSource = require('../models/EventSource');
        const rows = await EventSource.find({ enabled: true }).lean();
        const seen = new Set();
        places = rows.map(r => ({ city: r.city, country: r.country }))
            .filter(p => {
                const k = `${p.city}|${p.country}`.toLowerCase();
                if (seen.has(k) || !(p.city || p.country)) return false;
                seen.add(k);
                return true;
            });
    }
    if (!places.length) {
        console.log('[knowledge] nothing to sync — register event sources first, or pass "City,Country" arguments');
        await mongoose.disconnect();
        return;
    }
    console.log(`[knowledge] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'} · ${places.length} place(s)`);

    for (const p of places) {
        if (APPLY) {
            await syncKnowledge(p);
        } else {
            const wv = p.city ? await fetchCityKnowledge(p.city) : [];
            const adv = p.country ? await fetchAdvisory(p.country) : [];
            const show = [...wv, ...adv];
            console.log(`  ${[p.city, p.country].filter(Boolean).join(', ')} → ${show.length} fact(s)`);
            for (const f of show) console.log(`    · ${f.topic} — ${f.body.length} chars from ${f.sourceName}`);
        }
    }
    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
