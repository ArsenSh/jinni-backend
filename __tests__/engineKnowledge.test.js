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
        expect(topicFor('visa')).toBe('entry_requirements');
        expect(topicFor('sim_card')).toBe('connect');
        expect(topicFor('tipping')).toBe('money');
        expect(topicFor('')).toBeNull();
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
