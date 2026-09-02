// Local knowledge store — Wikivoyage + UK FCDO (Arsen 2026-08-23: "lets build
// wikivoyage and fcdo" … "is it trusty to use and keep always").
// All network is injected; these run offline.

const { _wikitextToText, fetchCityKnowledge } = require('../engine/knowledge/wikivoyage');
const { _htmlToText, _countrySlug, fetchAdvisory, BRITISH_CAVEAT } = require('../engine/knowledge/advisories');
const { syncKnowledge, lookupFacts, topicFor } = require('../engine/knowledge/sync');
const { localFactsBlock } = require('../engine/narrator/prompts/grounded');

const NOW = Date.parse('2026-08-23T10:00:00Z');

describe('wikivoyage: wikitext → traveler prose', () => {
    test('templates, links and markup are stripped; the sentences survive', () => {
        const wt = `== Get around ==\n'''Yerevan''' has a [[metro]] with one line.\n`
            + `* Buses and {{marshrutka|type=van}} cost 100 AMD.\n<ref>cite</ref><!-- hidden -->\n`
            + `See [https://example.am/metro the metro site] for details.`;
        const t = _wikitextToText(wt);
        expect(t).toContain('Yerevan has a metro with one line');
        expect(t).toContain('• Buses and');
        expect(t).toContain('the metro site');
        expect(t).not.toMatch(/\[\[|\]\]|'''|<ref|<!--|https:\/\//);
    });

    test('fetches only the practical sections, skipping stubs', async () => {
        const get = jest.fn(async (_url, cfg) => {
            if (cfg.params.prop === 'sections') {
                return { data: { parse: { title: 'Yerevan', sections: [
                    { index: 3, line: 'Get around' }, { index: 4, line: 'Stay safe' }, { index: 9, line: 'Sleep' },
                ] } } };
            }
            return { data: { parse: { wikitext: cfg.params.section === 3
                ? `The metro runs 06:30-23:00 and costs 100 AMD. Marshrutkas cover the rest of the city; `
                  + `flag them down anywhere. Taxis are cheap — use GG or Yandex Go rather than hailing.`
                : 'Short.' } } };                                  // stub → dropped
        });
        const out = await fetchCityKnowledge('Yerevan', { get });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ topic: 'get_around', sourceName: 'Wikivoyage', license: 'CC BY-SA 4.0' });
        expect(out[0].sourceUrl).toBe('https://en.wikivoyage.org/wiki/Yerevan');
        // The identifying User-Agent is a 20x rate-limit difference — not optional.
        expect(get.mock.calls[0][1].headers['User-Agent']).toMatch(/JinniTravelBot/);
    });
});

describe('fcdo: official entry rules, with their caveat attached', () => {
    test('html → text, country slugs, and the British-passport caveat rides along', async () => {
        expect(_countrySlug('United Arab Emirates')).toBe('united-arab-emirates');
        expect(_htmlToText('<p>Visa on arrival.</p><ul><li>90 days</li></ul>')).toBe('Visa on arrival.\n• 90 days');

        const get = async () => ({ data: {
            title: 'Armenia',
            public_updated_at: '2026-08-01T00:00:00Z',
            details: {
                reviewed_at: '2026-08-20T00:00:00Z',
                alert_status: ['avoid_all_travel_to_parts'],
                parts: [
                    { slug: 'entry-requirements', title: 'Entry requirements',
                      body: '<p>' + 'British citizens can enter visa-free for 180 days. '.repeat(6) + '</p>' },
                    { slug: 'safety-and-security', title: 'Safety and security', body: '<p>Short.</p>' },
                ],
            },
        } });
        const out = await fetchAdvisory('Armenia', { get });
        expect(out).toHaveLength(1);                                  // the short part is dropped
        expect(out[0].topic).toBe('entry_requirements');
        expect(out[0].caveat).toBe(BRITISH_CAVEAT);                   // nationality caveat is DATA
        expect(out[0].reviewedAt.toISOString()).toBe('2026-08-20T00:00:00.000Z');
        expect(out[0].license).toBe('Open Government Licence v3.0');
        expect(await fetchAdvisory('', { get })).toEqual([]);
    });
});

describe('sync + lookup: owned, ranked, and refused when stale', () => {
    const factsFor = (rows) => ({ find: () => ({ lean: async () => rows }), bulkWrite: jest.fn(async () => {}) });

    test('topicFor maps the open info_ask vocabulary onto stored topics', () => {
        expect(topicFor('transport')).toBe('get_around');
        expect(topicFor('taxi')).toBe('get_around');
        expect(topicFor('which metro')).toBe('get_around');
        expect(topicFor('visa')).toBe('entry_requirements');
        expect(topicFor('sim_card')).toBe('connect');
        expect(topicFor('tipping')).toBe('money');
        expect(topicFor('')).toBeNull();
    });

    // Live 2026-08-23: topicFor defaulted every unknown label to get_around, so
    // "do I need a visa", "do I have limits" and "what AI works under you" were
    // all answered with Yerevan TRANSPORT notes — wrong, and ~1,300 wasted
    // input tokens per turn.
    test('a topic we do not stock returns null — never the nearest notes', () => {
        for (const l of ['how_to', 'app_internals', 'why_created', 'pricing_model'])
            expect(topicFor(l)).toBeNull();
    });

    // A PLACES turn can still need owned knowledge (Arsen 2026-08-24: "where can
    // I buy a SIM card" carded phone-repair shops and Jinni claimed one sold
    // tourist SIMs). Whole-token matching only — "rent an apartment" must not
    // load bus notes.
    test('topicForQuery grounds a places ask, without false positives', () => {
        const { topicForQuery } = require('../engine/knowledge/sync');
        expect(topicForQuery('where can I buy a SIM card')).toBe('connect');
        expect(topicForQuery('currency exchange')).toBe('money');
        expect(topicForQuery('is it safe at night')).toBe('safety');
        // Car hire is both a place and transport knowledge — two tokens needed.
        expect(topicForQuery('where can I rent a car')).toBe('get_around');
        expect(topicForQuery('scooter rental')).toBe('get_around');
        expect(topicForQuery('аренда авто')).toBe('get_around');
        for (const q of ['rent an apartment', 'rooftop bars', 'vegan restaurants', 'carpet shop', ''])
            expect(topicForQuery(q)).toBeNull();
    });

    test('the places prompt carries owned notes, capped, without touching the card contract', () => {
        const { buildStreamedNarrationMessages } = require('../engine/narrator/prompts/grounded');
        const facts = [{ sourceName: 'Jinni staff', title: 'Yerevan — SIM cards', body: 'X'.repeat(3000) }];
        const withFacts = buildStreamedNarrationMessages({ query: 'sim card', places: [{ name: 'Viva' }], localFacts: facts });
        expect(withFacts[0].content).toContain('VERIFIED LOCAL NOTES');
        expect(withFacts[0].content).toContain('never claim a listed place offers something no fact states');
        expect(withFacts[1].content).toContain('[Jinni staff]');
        expect(withFacts[1].content).not.toContain('X'.repeat(1300));      // capped at 1200
        const plain = buildStreamedNarrationMessages({ query: 'rooftop bars', places: [{ name: 'Liftup' }] });
        expect(plain[1].content).not.toContain('VERIFIED LOCAL NOTES');
        expect(plain[0].content).toContain('<<<CARDS>>>');                 // contract intact
    });

    test('validateIntent keeps the RAW label beside the folded one', () => {
        const { validateIntent } = require('../services/intentService');
        const base = { is_travel: true, action_type: 'general', language: 'en', place_search_query: '' };
        const visa = validateIntent({ ...base, info_ask: 'visa' }, 'x');
        expect(visa.infoAsk).toBe('how_to');          // folded: answer, do not card
        expect(visa.infoTopic).toBe('visa');          // raw: which notes to load
        expect(topicFor(visa.infoTopic)).toBe('entry_requirements');
        const none = validateIntent(base, 'x');
        expect(none.infoTopic).toBeNull();
    });

    test('sync stores city + country rows and never overwrites validator work', async () => {
        const LocalFact = factsFor([]);
        const out = await syncKnowledge({ city: 'Yerevan', country: 'Armenia' }, {
            LocalFact, nowFn: () => NOW,
            fetchCityKnowledge: async () => [{ topic: 'get_around', title: 'Yerevan — Get around', body: 'x'.repeat(200), sourceName: 'Wikivoyage', sourceUrl: 'u', license: 'CC BY-SA 4.0' }],
            fetchAdvisory: async () => [{ topic: 'entry_requirements', title: 'Armenia', body: 'y'.repeat(200), sourceName: 'UK FCDO', sourceUrl: 'g', caveat: 'brits', reviewedAt: new Date(NOW) }],
        });
        expect(out.stored).toBe(2);
        const ops = LocalFact.bulkWrite.mock.calls[0][0];
        expect(ops[0].updateOne.filter).toEqual({ key: 'yerevan|armenia|get_around', tier: { $ne: 'validator' } });
        expect(ops[1].updateOne.update.$set.city).toBeNull();          // country-wide row
        // Entry requirements expire in 30 days; city practicalities in 180.
        const days = (op) => Math.round((op.updateOne.update.$set.staleAfter - NOW) / 86400000);
        expect(days(ops[0])).toBe(180);
        expect(days(ops[1])).toBe(30);
    });

    test('city beats country, validator beats fetched, and STALE is never served', async () => {
        const rows = [
            { topic: 'get_around', city: null, country: 'Armenia', tier: 'fcdo', body: 'country', staleAfter: new Date(NOW + 1e9) },
            { topic: 'get_around', city: 'Yerevan', tier: 'wikivoyage', body: 'city', staleAfter: new Date(NOW + 1e9) },
            { topic: 'get_around', city: 'Yerevan', tier: 'validator', body: 'staff', staleAfter: new Date(NOW + 1e9) },
        ];
        const got = await lookupFacts({ city: 'Yerevan', country: 'Armenia', topic: 'get_around' },
            { LocalFact: factsFor(rows), nowFn: () => NOW });
        expect(got.map(f => f.body)).toEqual(['staff', 'city']);      // validator first, country row last

        const stale = await lookupFacts({ country: 'Armenia', topic: 'entry_requirements' }, {
            LocalFact: factsFor([{ topic: 'entry_requirements', city: null, country: 'Armenia', tier: 'fcdo', body: 'old', staleAfter: new Date(NOW - 1) }]),
            nowFn: () => NOW,
        });
        expect(stale).toEqual([]);                                     // re-read, never repeat
    });

    // The live bug: the answer paths skip retrieval, so city/country were never
    // resolved and every lookup came back empty — Jinni answered Yerevan
    // transport from memory and named Uber and Bolt, which don't operate there.
    test('region resolves from GPS (cached) and from a place named in the message', async () => {
        const { resolveRegion, _CACHE } = require('../engine/context/region');
        _CACHE.clear();
        const detectUserRegion = jest.fn(async () => ({ city: 'Yerevan', country: 'Armenia' }));
        const a = await resolveRegion({ center: { lat: 40.1866, lng: 44.5157 } }, { detectUserRegion });
        expect(a).toEqual({ city: 'Yerevan', region: null, country: 'Armenia', place: null });
        // Same ~1 km cell → served from cache. (Points either side of a cell
        // boundary do pay a second lookup; that is the cost of a simple grid
        // and it is one geocode, not a per-turn charge.)
        await resolveRegion({ center: { lat: 40.1871, lng: 44.5152 } }, { detectUserRegion });
        expect(detectUserRegion).toHaveBeenCalledTimes(1);
        const b = await resolveRegion({ center: null, placeNames: ['Armenia'] }, { detectUserRegion });
        expect(b.place).toBe('Armenia');
    });

    test('a named place finds country rows even with no GPS scope', async () => {
        const rows = [{ topic: 'entry_requirements', city: null, country: 'Armenia', tier: 'fcdo', body: 'visa-free', staleAfter: new Date(NOW + 1e9) }];
        const got = await lookupFacts({ place: 'Armenia', topic: 'entry_requirements' },
            { LocalFact: factsFor(rows), nowFn: () => NOW });
        expect(got).toHaveLength(1);
        expect(await lookupFacts({ topic: 'entry_requirements' }, { LocalFact: factsFor(rows), nowFn: () => NOW })).toEqual([]);
    });

    test('the prompt block names the source, its review date and the caveat', () => {
        const block = localFactsBlock([{
            sourceName: 'UK FCDO', title: 'Armenia — Entry requirements', body: 'Visa-free 180 days.',
            reviewedAt: new Date('2026-08-20T00:00:00Z'), caveat: BRITISH_CAVEAT,
        }]);
        expect(block).toContain('[UK FCDO (source reviewed 2026-08-20)]');
        expect(block).toContain('prefer these over your own knowledge');
        expect(block).toContain('CAVEAT you must pass on');
        expect(localFactsBlock([])).toBe('');
    });
});

describe("validateIntent 'place' label (brain-first place questions, 2026-08-30)", () => {
    const { validateIntent } = require('../services/intentService');
    const base = { is_travel: true, action_type: 'hotels', language: 'en' };
    test("'place' passes through unfolded — routes to the tool loop", () => {
        const r = validateIntent({ ...base, info_ask: 'place', place_search_query: 'toufenkian hotel' }, 'is toufenkian hotel open tonight?');
        expect(r.infoAsk).toBe('place');
        expect(r.searchQuery).toBe('toufenkian hotel');   // spelling kept — Google resolves typos
    });
    test("'place_hours'-style labels also count as place; transport/how_to folds unchanged", () => {
        expect(validateIntent({ ...base, info_ask: 'place_hours' }, 'x').infoAsk).toBe('place');
        expect(validateIntent({ ...base, info_ask: 'taxi' }, 'x').infoAsk).toBe('transport');
        expect(validateIntent({ ...base, info_ask: 'visa' }, 'x').infoAsk).toBe('how_to');
        expect(validateIntent({ ...base, info_ask: '' }, 'x').infoAsk).toBeNull();
    });
});
