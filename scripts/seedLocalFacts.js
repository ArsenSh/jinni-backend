// Staff-written local facts — the TOP trust tier (Arsen 2026-08-24, after Jinni
// told a traveler that "Yerevan Mobile" sells tourist SIM cards. It does not:
// it is a phone/electronics and repair chain. The real answer was never in any
// place card, because it is knowledge, not a venue).
//
//   node scripts/seedLocalFacts.js            # show what would be written
//   node scripts/seedLocalFacts.js --apply    # write
//
// Written rows are tier 'validator': they outrank Wikivoyage and FCDO, the
// daily sync never overwrites them, and they never go stale on a timer — a
// human owns them. Everything below was verified from primary sources on
// 2026-08-24 (zvartnots.aero, viva.am, telecomarmenia.am, ucom.am).

require('dotenv').config();
const mongoose = require('mongoose');
const LocalFact = require('../models/LocalFact');

const APPLY = process.argv.includes('--apply');

const FACTS = [
    {
        city: 'Yerevan', country: 'Armenia', topic: 'connect',
        title: 'Yerevan — SIM cards & mobile data',
        body: [
            'Armenia has three mobile operators: Team (formerly Beeline), Ucom, and Viva (formerly VivaCell-MTS).',
            'All three run desks in the ARRIVALS hall of Zvartnots airport, first floor, open 24 hours — that is the',
            'normal place for a traveler to buy a SIM on landing. You must show your PASSPORT to be connected;',
            'this is a legal requirement, not a shop policy.',
            '',
            'In the city, use the operators\' own branded stores (branches throughout Kentron). General phone or',
            'electronics shops mostly sell handsets, accessories and repairs — they are not connectivity sellers.',
            '',
            'Example tariff published by Viva: TOURIST UNLIM, 2,500 AMD for 15 days — unlimited internet, 300 minutes,',
            '300 SMS, SIM valid 60 days. Viva also offers eSIM.',
        ].join('\n'),
        sourceName: 'Jinni staff', sourceUrl: 'https://www.zvartnots.aero/EN/Content/Connectivity',
    },
];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log(`[local-facts] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'} · ${FACTS.length} fact(s)`);
    for (const f of FACTS) {
        const key = `${[f.city, f.country].filter(Boolean).join('|').toLowerCase()}|${f.topic}`;
        console.log(`  ${key} — ${f.body.length} chars (${f.sourceName})`);
        if (!APPLY) continue;
        await LocalFact.findOneAndUpdate({ key }, {
            $set: {
                key, city: f.city || null, country: f.country || null, topic: f.topic,
                title: f.title, body: f.body,
                sourceName: f.sourceName, sourceUrl: f.sourceUrl, license: null, caveat: null,
                tier: 'validator', status: 'approved',
                fetchedAt: new Date(), reviewedAt: new Date(), staleAfter: null,
            },
        }, { upsert: true });
    }
    console.log(`[local-facts] ${APPLY ? 'written' : 'nothing written'}`);
    await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
