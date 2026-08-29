// Tests for the V2 Retrieval Core (plain-Mongo path): BM25, RRF, cosine,
// semantic cache, and the findPlaces orchestration with injected deps.
// Everything is offline: fake candidates, fake embedder, injected clocks.

const { fuseRankings } = require('../engine/retrieval/rrf');
const { rankLexical, tokenize } = require('../engine/retrieval/lexical');
const { cosineSimilarity, rankByVector } = require('../engine/retrieval/vector');
const { SemanticCache } = require('../engine/retrieval/semanticCache');
const { findPlaces } = require('../engine/retrieval/index');
const { effectiveRadiusKm, buildRetrievalQuery, isRightNowAsk, isTransportAsk, rankingWeights, LOCAL_DISCOVERY_CAP_KM } = require('../engine/retrieval/tuning');

describe('fuseRankings (RRF)', () => {
    test('agreement across lists wins; k=60 math', () => {
        const fused = fuseRankings([['a', 'b', 'c'], ['a', 'c']]);
        expect(fused[0].id).toBe('a');
        expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 61, 10);
        expect(fused.map(f => f.id)).toEqual(['a', 'c', 'b']);   // c: 1/63+1/62 > b: 1/62
    });
    test('empty/garbage lists are ignored', () => {
        expect(fuseRankings([])).toEqual([]);
        expect(fuseRankings([null, ['x']])[0].id).toBe('x');
    });
});

describe('rankLexical (BM25)', () => {
    const docs = [
        { id: 'uzbek',   text: 'Uzbechka Uzbek restaurant plov Yerevan' },
        { id: 'armen',   text: 'Lavash Armenian restaurant Yerevan' },
        { id: 'nothing', text: 'Cascade stairs viewpoint' },
    ];
    test('the specific match outranks the shared-word match; no-overlap doc drops', () => {
        const ranked = rankLexical('uzbek restaurant', docs);
        expect(ranked[0].id).toBe('uzbek');
        expect(ranked.map(r => r.id)).not.toContain('nothing');
    });
    test('diacritics fold through normalizePlaceName tokenization', () => {
        expect(tokenize('Café Shéné')).toEqual(['cafe', 'shene']);
    });
    test('empty inputs are safe', () => {
        expect(rankLexical('', docs)).toEqual([]);
        expect(rankLexical('anything', [])).toEqual([]);
    });
});

describe('vector math', () => {
    test('cosine basics', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
        expect(cosineSimilarity([1, 0], [1])).toBe(0);          // dim mismatch → 0, never throws
        expect(cosineSimilarity(null, [1])).toBe(0);
    });
    test('rankByVector orders by similarity, skips vector-less, honors minScore', () => {
        const ranked = rankByVector([1, 0], [
            { id: 'far',   vector: [0, 1] },
            { id: 'near',  vector: [0.9, 0.1] },
            { id: 'novec' },
        ], 0.1);
        expect(ranked.map(r => r.id)).toEqual(['near']);
    });
});

describe('SemanticCache', () => {
    const params = { category: 'restaurants', mode: 'discovery', tapState: 'first', center: { lat: 40.18, lng: 44.51 } };
    test('vector similarity hit; dissimilar miss', () => {
        const cache = new SemanticCache({});
        cache.set(params, { queryVector: [1, 0], queryText: 'uzbek food yerevan' }, { places: ['X'] });
        expect(cache.get(params, { queryVector: [0.99, 0.14] })).toEqual({ places: ['X'] });   // cos ≈ .99
        expect(cache.get(params, { queryVector: [0, 1] })).toBe(null);
    });
    test('text-key fallback works without any vectors (lexical-only installs)', () => {
        const cache = new SemanticCache({});
        cache.set(params, { queryText: 'Uzbek Restaurant, Yerevan!' }, { places: ['X'] });
        expect(cache.get(params, { queryText: 'uzbek restaurant yerevan' })).toEqual({ places: ['X'] });
    });
    test('params bucket isolation: same wording, different city → miss', () => {
        const cache = new SemanticCache({});
        cache.set(params, { queryVector: [1, 0] }, { places: ['yerevan'] });
        const dubai = { ...params, center: { lat: 25.2, lng: 55.27 } };
        expect(cache.get(dubai, { queryVector: [1, 0] })).toBe(null);
    });
    test('TTL expiry via injected clock', () => {
        let now = 1000;
        const cache = new SemanticCache({ ttlMs: 100, nowFn: () => now });
        cache.set(params, { queryVector: [1, 0] }, { places: ['X'] });
        now = 1099;
        expect(cache.get(params, { queryVector: [1, 0] })).toEqual({ places: ['X'] });
        now = 1101;
        expect(cache.get(params, { queryVector: [1, 0] })).toBe(null);
    });
    test('capacity trim drops oldest', () => {
        const cache = new SemanticCache({ max: 2 });
        cache.set(params, { queryText: 'one' }, 1);
        cache.set(params, { queryText: 'two' }, 2);
        cache.set(params, { queryText: 'three' }, 3);
        expect(cache.get(params, { queryText: 'one' })).toBe(null);
        expect(cache.get(params, { queryText: 'three' })).toBe(3);
    });
});

describe('tuning: effectiveRadiusKm (the 37.7 km Tsaghkadzor fix)', () => {
    test('dining/shopping/activities cap at 15 km in discovery', () => {
        expect(effectiveRadiusKm({ category: 'restaurants', mode: 'discovery', radiusKm: 50 })).toBe(LOCAL_DISCOVERY_CAP_KM);
        expect(effectiveRadiusKm({ category: 'shopping', mode: 'discovery', radiusKm: 50 })).toBe(15);
    });
    test('sights/hotels keep full radius; nearby mode passes through; small radii untouched', () => {
        expect(effectiveRadiusKm({ category: 'historical', mode: 'discovery', radiusKm: 50 })).toBe(50);
        expect(effectiveRadiusKm({ category: null, mode: 'discovery', radiusKm: 50 })).toBe(50);
        expect(effectiveRadiusKm({ category: 'restaurants', mode: 'nearby', radiusKm: 5 })).toBe(5);
        expect(effectiveRadiusKm({ category: 'restaurants', mode: 'discovery', radiusKm: 10 })).toBe(10);
    });
});

describe('tuning: buildRetrievalQuery (keep the distinctive message words)', () => {
    test('the girlfriend-dinner case: descriptive words survive, filler does not', () => {
        const q = buildRetrievalQuery('restaurant', 'I am looking for romantic restaurant to meet with my girlfriend');
        expect(q).toContain('restaurant');
        expect(q).toContain('romantic');
        expect(q).toContain('girlfriend');
        expect(q).not.toContain('looking');
        expect(q).not.toContain('with');
    });
    test('duplicates dropped, token budget respected, empty inputs safe', () => {
        expect(buildRetrievalQuery('uzbek restaurant', 'uzbek restaurant please')).toBe('uzbek restaurant');
        const long = buildRetrievalQuery('cafe', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet');
        expect(long.split(' ').length).toBeLessThanOrEqual(8);
        expect(buildRetrievalQuery('', '')).toBe('');
        expect(buildRetrievalQuery(null, 'хинкали здесь')).toContain('хинкали');
    });
});

describe('tuning: isRightNowAsk (open-hours enforcement trigger, fallback tier)', () => {
    test('now-words in EN/RU/HY match; planning-ahead does not', () => {
        expect(isRightNowAsk('where can I eat right now')).toBe(true);
        expect(isRightNowAsk('what to do tonight?')).toBe(true);
        expect(isRightNowAsk('куда сходить сейчас')).toBe(true);
        expect(isRightNowAsk('restaurants for next week')).toBe(false);
        expect(isRightNowAsk('plan my trip for tomorrow')).toBe(false);
        expect(isRightNowAsk('')).toBe(false);
    });
});

describe('tuning: rankingWeights (intent-conditioned fusion)', () => {
    test('defaults reproduce the historical weights exactly', () => {
        expect(rankingWeights({})).toEqual({ lexical: 1, vector: 1, proximity: 0.5, prior: 0.5 });
    });
    test('right-now / nearby boost proximity to full weight', () => {
        expect(rankingWeights({ rightNow: true }).proximity).toBe(1);
        expect(rankingWeights({ nearbyMode: true }).proximity).toBe(1);
    });
    test('romantic asks boost the quality prior and relax distance', () => {
        const w = rankingWeights({ message: 'restaurant for our anniversary dinner' });
        expect(w.prior).toBe(0.9);
        expect(w.proximity).toBe(0.35);
        expect(rankingWeights({ message: 'романтический ужин' }).prior).toBe(0.9);
    });
});

describe('tuning: isTransportAsk (the taxi lesson, six languages)', () => {
    // Every MODE, not just taxis (Arsen: "what if user asks just taxi, or how
    // to walk there or how to fly, or which metro to take").
    test('fires on how-do-I-get-around asks in every app language and every mode', () => {
        for (const m of [
            'I want to book a taxi. How can I do it',
            'taxi',
            'how do i get to the marina',
            'can i walk there',
            'which metro should i take',
            'how to fly to Baku',
            'is the ferry running',
            'how far is the airport',
            'rent a scooter',
            'как добраться до центра',
            'можно дойти пешком?',
            'ինչպես հասնել կենտրոն',
            'comment aller à la plage',
            '怎么去机场',
            'كيف أصل إلى المطار',
        ]) expect(isTransportAsk(m)).toBe(true);
    });
    test('does not fire on ordinary place asks — "bus" must not match "business"', () => {
        for (const m of [
            'best business lunch nearby',
            'romantic dinner for two',
            'suggest historical places',
            'events next week',
        ]) expect(isTransportAsk(m)).toBe(false);
    });
});

// The brain names the topic; code makes ONE distinction (Arsen 2026-08-23:
// "maybe it can ask another question we have not imagined yet").
describe('intent info_ask: open vocabulary, safe folding', () => {
    const { validateIntent } = require('../services/intentService');
    const base = { is_travel: true, action_type: 'general', language: 'en', place_search_query: '' };
    const infoAskOf = (label) => validateIntent({ ...base, info_ask: label }, 'x').infoAsk;

    test('wanting places stays null', () => {
        for (const l of ['', '   ', 'none', 'null', 'places']) expect(infoAskOf(l)).toBeNull();
        expect(validateIntent(base, 'x').infoAsk).toBeNull();          // field absent entirely
    });
    test('any way of naming movement folds to transport', () => {
        for (const l of ['transport', 'taxi', 'metro', 'walking', 'flight', 'ferry', 'getting_around'])
            expect(infoAskOf(l)).toBe('transport');
    });
    test('a topic nobody planned for still gets ANSWERED, never carded', () => {
        for (const l of ['visa', 'tipping', 'safety', 'sim_card', 'currency', 'wedding_paperwork'])
            expect(infoAskOf(l)).toBe('how_to');
    });
});

describe('proximity-aware fusion', () => {
    test('a near candidate climbs past far higher-prior ones (no hard cutoff)', async () => {
        // 12 candidates: prior order c0..c11; c10 is 0.5 km away, everything else 30+ km.
        const cands = Array.from({ length: 12 }, (_, i) => ({
            placeId: `c${i}`, name: `Place ${i}`, text: `spot ${i}`,
            distanceKm: i === 10 ? 0.5 : 30 + i,
        }));
        const r = await findPlaces({ category: 'restaurants', count: 12 }, {
            loadCandidates: async () => cands, cache: new SemanticCache({}), embedder: null,
        });
        expect(r.provenance.proximity).toBe(true);
        const posNear = r.places.findIndex(p => p.placeId === 'c10');
        expect(posNear).toBeGreaterThanOrEqual(0);
        expect(posNear).toBeLessThan(10);                 // climbed above its prior rank
        expect(r.places[0].placeId).toBe('c0');           // prior still leads overall
    });
    test('no distances → no proximity list, prior order intact', async () => {
        const r = await findPlaces({ category: 'restaurants' }, {
            loadCandidates: async () => [{ placeId: 'a', name: 'A' }, { placeId: 'b', name: 'B' }],
            cache: new SemanticCache({}), embedder: null,
        });
        expect(r.provenance.proximity).toBeUndefined();
        expect(r.places.map(p => p.placeId)).toEqual(['a', 'b']);
    });
});

describe('findPlaces orchestration (injected deps)', () => {
    const CANDS = [
        { placeId: 'p1', name: 'Lavash Restaurant', text: 'Lavash Armenian restaurant Yerevan', rating: 4.6 },
        { placeId: 'p2', name: 'Uzbechka', text: 'Uzbechka Uzbek restaurant plov Yerevan', rating: 4.4 },
        { placeId: 'p3', name: 'Sherep', text: 'Sherep Armenian restaurant Yerevan', rating: 4.7 },
    ];
    const deps = () => ({
        loadCandidates: async () => CANDS.map(c => ({ ...c })),
        cache: new SemanticCache({}),
        embedder: null,                       // lexical-only unless a test injects one
    });

    // The relevance brake's signal (Arsen 2026-08-23, after "I want to book a
    // taxi. How can I do it" was answered with six sightseeing cards).
    test('provenance.unmatched marks an ask nothing in the pool answers', async () => {
        const r = await findPlaces({ category: null, coreQuery: 'book taxi', count: 6 }, deps());
        expect(r.provenance.unmatched).toEqual(['book', 'taxi']);
        expect(r.provenance.lexical).toBe(0);                  // and nothing matched lexically
    });
    test('a satisfied demand leaves unmatched unset — the brake must not fire', async () => {
        const r = await findPlaces({ category: 'restaurants', query: 'uzbek plov', coreQuery: 'uzbek plov', count: 6 }, deps());
        expect(r.provenance.unmatched).toBeUndefined();
        expect(r.places[0].placeId).toBe('p2');                // Uzbechka takes its seat
    });
    // Time words must never read as demands: they would buy Google fetches and
    // could brake a perfectly good events turn. (An events pool legitimately
    // reports 'events' as unmatched — no candidate's text spells the word — so
    // the route ALSO requires that the ask carry no category before braking.)
    test('time words are not demands — only "events" survives from "events next week"', async () => {
        const r = await findPlaces({ category: 'events', coreQuery: 'events next week', count: 6 }, deps());
        expect(r.provenance.unmatched).toEqual(['events']);
    });

    test('deps.loadCandidates is required', async () => {
        await expect(findPlaces({})).rejects.toThrow(/loadCandidates is required/);
    });
    test('no query → prior (store) order, count clamp', async () => {
        const r = await findPlaces({ category: 'restaurants', count: 2 }, deps());
        expect(r.degraded).toBe(false);
        expect(r.places.map(p => p.placeId)).toEqual(['p1', 'p2']);
    });
    test('query re-ranks: the Uzbek ask lifts Uzbechka over the prior order', async () => {
        const r = await findPlaces({ category: 'restaurants', query: 'uzbek restaurant' }, deps());
        expect(r.places[0].placeId).toBe('p2');
        expect(r.provenance.lexical).toBeGreaterThan(0);
    });
    test('excludes by placeId and by (normalized) name', async () => {
        const r = await findPlaces({
            category: 'restaurants',
            excludes: { placeIds: ['p1'], names: ['SHEREP!'] },
        }, deps());
        expect(r.places.map(p => p.placeId)).toEqual(['p2']);
    });
    test('open-now: known-closed restaurants drop on a 3 AM right-now ask; unknown hours survive', async () => {
        const d = deps();
        d.loadCandidates = async () => ([
            { placeId: 'closed', name: 'Day Café',
              opening_hours: { periods: [{ open: { day: 6, time: '0900' }, close: { day: 6, time: '2300' } }] } },
            { placeId: 'unknown', name: 'Mystery Bar' },
        ]);
        const r = await findPlaces({
            category: 'restaurants',
            timeContext: { dayOfWeek: 6, hour: 3, minute: 0 },
            enforceOpenNow: true,
        }, d);
        expect(r.places.map(p => p.placeId)).toEqual(['unknown']);
        expect(r.provenance.openNowDropped).toBe(1);
    });
    test('open-now never drops exempt categories (hotels), even known-closed', async () => {
        const d = deps();
        d.loadCandidates = async () => ([{ placeId: 'h1', name: 'Hotel',
            opening_hours: { periods: [{ open: { day: 1, time: '0900' }, close: { day: 1, time: '1700' } }] } }]);
        const r = await findPlaces({
            category: 'hotels',
            timeContext: { dayOfWeek: 6, hour: 3, minute: 0 },
            enforceOpenNow: true,
        }, d);
        expect(r.places).toHaveLength(1);
    });
    test('semantic cache: second identical query is a hit', async () => {
        const d = deps();
        const p = { category: 'restaurants', query: 'best plov in town', center: { lat: 40.18, lng: 44.51 } };
        const first = await findPlaces(p, d);
        expect(first.provenance.cacheHit).toBe(false);
        const second = await findPlaces(p, d);
        expect(second.provenance.cacheHit).toBe(true);
        expect(second.places.map(x => x.placeId)).toEqual(first.places.map(x => x.placeId));
    });
    test('vector path: a fake embedder brings semantic matches in and flags provenance', async () => {
        const d = deps();
        d.loadCandidates = async () => ([
            { placeId: 'sem', name: 'Plov House', text: 'totally different words', vector: [1, 0] },
            { placeId: 'lex', name: 'Rice Place', text: 'rice food spot', vector: [0, 1] },
        ]);
        d.embedder = { model: 'fake', embed: async () => [[1, 0]] };
        const r = await findPlaces({ category: 'restaurants', query: 'rice food' }, d);
        expect(r.provenance.vector).toBe(true);
        expect(r.places.map(p => p.placeId)).toContain('sem');   // found by MEANING, not words
    });
    test('embedder failure is fail-open (lexical still answers)', async () => {
        const d = deps();
        d.embedder = { model: 'broken', embed: async () => { throw new Error('boom'); } };
        const r = await findPlaces({ category: 'restaurants', query: 'uzbek restaurant' }, d);
        expect(r.degraded).toBe(false);
        expect(r.places[0].placeId).toBe('p2');
    });
    test('degraded results instead of throws', async () => {
        const d = deps();
        d.loadCandidates = async () => [];
        expect((await findPlaces({ category: 'restaurants' }, d)).reason).toBe('no_candidates');
        d.loadCandidates = async () => { throw new Error('db down'); };
        expect((await findPlaces({ category: 'restaurants' }, d)).reason).toMatch(/load_failed/);
    });
});

describe('embedSweep (new registrations get vectors automatically)', () => {
    const { sweepMissingEmbeddings } = require('../engine/retrieval/embedSweep');
    test('embeds docs missing a vector, skips textless, records model', async () => {
        const writes = [];
        const fakeModel = {
            find: () => ({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([
                { _id: 'b1', name: 'Zanzibar', type: ['restaurants'], location: { city: 'Yerevan' } },
                { _id: 'b2', name: '' },   // textless → skipped
            ]) }) }) }),
            updateOne: async (q, u) => { writes.push({ q, u }); },
        };
        const r = await sweepMissingEmbeddings({
            getEmbedder: async () => ({ model: 'fake-model', embed: async () => [[0.1, 0.2]] }),
            sources: [{ name: 'Business', model: () => fakeModel, select: 'x',
                textOf: (d) => [d.name, ...(d.type || []), d.location?.city].filter(Boolean).join(' ') }],
        });
        expect(r.embedded).toBe(1);
        expect(r.skipped).toBe(1);
        expect(writes[0].u.$set.embedding).toEqual([0.1, 0.2]);
        expect(writes[0].u.$set.embeddingModel).toBe('fake-model');
    });
    test('no embedder / broken source → fail-open, zero embedded', async () => {
        const r = await sweepMissingEmbeddings({ getEmbedder: async () => null });
        expect(r.embedded).toBe(0);
        const r2 = await sweepMissingEmbeddings({
            getEmbedder: async () => ({ model: 'm', embed: async () => [[1]] }),
            sources: [{ name: 'Boom', model: () => { throw new Error('db down'); }, select: '', textOf: () => 'x' }],
        });
        expect(r2.embedded).toBe(0);
    });
});

describe('adaptive deck size (battery fix #2 — the padding lesson)', () => {
    const pool = () => [
        ...Array.from({ length: 9 }, (_, i) => ({ placeId: `r${i}`, name: `Rest ${i}`, text: `Rest ${i} armenian food`, source: 'cache' })),
        { placeId: 'sushi1', name: 'Tokyo House', text: 'Tokyo House sushi japanese', source: 'cache' },
    ];
    test('specific ask (rare demanded term) → match leads, deck shrinks to 3', async () => {
        const r = await findPlaces(
            { count: 6, coreQuery: 'sushi restaurant', query: 'sushi restaurant', adaptiveDeck: true },
            { loadCandidates: async () => pool(), embedder: null });
        expect(r.places[0].placeId).toBe('sushi1');       // demand seat
        expect(r.places).toHaveLength(3);                 // match + 2 honest alternatives
        expect(r.provenance.adaptive).toBe('specific');
    });
    // Zero-match shrink (live 2026-08-29: "Ethiopian restaurant" shipped SIX
    // padded cards — the demanded term had no match anywhere, yet the deck
    // stayed full because the shrink only fired when seats existed).
    test('zero-match demand → deck shrinks to honest 3, adaptive=no_match, unmatched set', async () => {
        const r = await findPlaces(
            { count: 6, category: 'restaurants', coreQuery: 'ethiopian restaurant', query: 'ethiopian restaurant', adaptiveDeck: true },
            { loadCandidates: async () => pool(), embedder: null });
        expect(r.places).toHaveLength(3);
        expect(r.provenance.adaptive).toBe('no_match');
        expect(r.provenance.unmatched).toContain('ethiopian');
    });
    test('zero-match on a REFILL keeps the asked count (adaptiveDeck:false)', async () => {
        const r = await findPlaces(
            { count: 6, category: 'restaurants', coreQuery: 'ethiopian restaurant', query: 'ethiopian restaurant', adaptiveDeck: false },
            { loadCandidates: async () => pool(), embedder: null });
        expect(r.places).toHaveLength(6);
        expect(r.provenance.adaptive).toBeUndefined();
    });
    // The narrator's WHY (live 2026-08-29: "I can't confirm any of these are
    // Uzbek" over a deck holding Uzbechka): seats carry the demanded term so
    // the fact line can say how they got there. Non-seats never carry it, and
    // the annotation must not leak into the shared cached pool.
    test('demand seats carry _demandTerm; others do not; the cached pool stays clean', async () => {
        const shared = pool();
        const args = { count: 6, category: 'restaurants', coreQuery: 'sushi restaurant', query: 'sushi restaurant', adaptiveDeck: true };
        const r = await findPlaces(args, { loadCandidates: async () => shared, embedder: null });
        expect(r.places[0]._demandTerm).toBe('sushi');
        expect(r.places[1]._demandTerm).toBeUndefined();
        expect(shared.find(c => c.placeId === 'sushi1')._demandTerm).toBeUndefined();
    });
    test('broad ask → full deck; refill (adaptiveDeck:false) honors the asked count', async () => {
        const broad = await findPlaces(
            { count: 6, category: 'restaurants', coreQuery: 'restaurants', query: 'restaurants', adaptiveDeck: true },
            { loadCandidates: async () => pool(), embedder: null });
        expect(broad.places).toHaveLength(6);
        const refill = await findPlaces(
            { count: 6, coreQuery: 'sushi restaurant', query: 'sushi restaurant', adaptiveDeck: false },
            { loadCandidates: async () => pool(), embedder: null });
        expect(refill.places).toHaveLength(6);
    });
});

describe('paid-tier nudge (Spotlight/Signature only — Arsen 2026-08-22)', () => {
    test('spotlight/signature climb ~3; verified business + plain destination stay on merit', async () => {
        const mk = (n) => Array.from({ length: n }, (_, i) => ({
            placeId: `c${i}`, name: `Cafe ${i}`, text: `Cafe ${i}`, source: 'cache',
        }));
        const pool = mk(8);
        pool[5] = { verifiedId: 'biz1', name: 'Zanzibar', text: 'Zanzibar', source: 'business', tier: 'signature' };
        pool[6] = { verifiedId: 'dst1', name: 'Sirelis', text: 'Sirelis', source: 'destination', tier: null };
        pool[7] = { verifiedId: 'biz2', name: 'PlainBiz', text: 'PlainBiz', source: 'business', tier: 'verified' };
        const r = await findPlaces({ count: 8 }, { loadCandidates: async () => pool.map(c => ({ ...c })), embedder: null });
        const names = r.places.map(p => p.name);
        expect(names[0]).toBe('Cafe 0');                        // never hijacks the leader
        expect(names.indexOf('Zanzibar')).toBeLessThan(5);      // signature climbed ~3
        expect(names.indexOf('Sirelis')).toBe(6);               // plain destination: merit only
        expect(names.indexOf('PlainBiz')).toBe(7);              // verified business: merit only
    });
});

describe('demand-match seats (the Uzbechka spelling lesson)', () => {
    test('a store-fetched demand match gets the seat + adaptive shrink despite zero text overlap', async () => {
        const pool = [
            ...Array.from({ length: 7 }, (_, i) => ({ placeId: `r${i}`, name: `Rest ${i}`, text: `Rest ${i} armenian food`, source: 'cache' })),
            { placeId: 'uzb', name: 'Uzbechka', text: 'Uzbechka restaurant yerevan', source: 'cache', _demandMatch: true },
        ];
        const r = await findPlaces(
            { count: 6, coreQuery: 'uzbek restaurant', query: 'uzbek restaurant', adaptiveDeck: true },
            { loadCandidates: async () => pool.map(c => ({ ...c })), embedder: null });
        expect(r.places[0].placeId).toBe('uzb');    // seat via knowledge, not spelling
        expect(r.places).toHaveLength(3);           // adaptive fired
        expect(r.provenance.adaptive).toBe('specific');
    });
});

describe('cache buckets are window-scoped (the "next week served this-week" live bug)', () => {
    test('same query, different eventWindow label → separate pools, no cross-hit', async () => {
        let loads = 0;
        const d = { loadCandidates: async () => { loads++; return [{ placeId: `p${loads}`, name: `Ev ${loads}`, text: 'event' }]; }, embedder: null };
        const a = await findPlaces({ query: 'events', eventWindow: { label: 'default' } }, d);
        const b = await findPlaces({ query: 'events', eventWindow: { label: 'next-week' } }, d);
        expect(loads).toBe(2);                                    // second window loaded fresh
        expect(b.provenance.cacheHit).toBeFalsy();
        expect(b.places[0].placeId).not.toBe(a.places[0].placeId);
        const c = await findPlaces({ query: 'events', eventWindow: { label: 'next-week' } }, d);
        expect(c.provenance.cacheHit).toBe(true);                 // same window still caches
    });
});

describe('parseRefillAsk (the "10 other results" lesson)', () => {
    const { parseRefillAsk } = require('../engine/retrieval/tuning');
    test('detects refill asks with and without a count', () => {
        expect(parseRefillAsk('can you give 10 other results?')).toEqual({ isRefill: true, count: 10 });
        expect(parseRefillAsk('show me more')).toEqual({ isRefill: true, count: null });
        expect(parseRefillAsk('something else please')).toEqual({ isRefill: true, count: null });
    });
    test('non-Latin refills (no \\b — the Cyrillic lesson)', () => {
        expect(parseRefillAsk('покажи ещё 5').isRefill).toBe(true);
        expect(parseRefillAsk('покажи ещё 5').count).toBe(5);
        expect(parseRefillAsk('другие варианты').isRefill).toBe(true);
    });
    test('all six app languages refill (HY/FR/ZH/AR)', () => {
        expect(parseRefillAsk('ուրիշ տեղեր ցույց տուր').isRefill).toBe(true);          // Armenian
        expect(parseRefillAsk("montre-moi d'autres options").isRefill).toBe(true);      // French
        expect(parseRefillAsk('再推荐几个').isRefill).toBe(true);                        // Chinese
        expect(parseRefillAsk('أعطني المزيد من الأماكن').isRefill).toBe(true);          // Arabic
    });
    test('plain asks are NOT refills; counts outside 2-12 ignored', () => {
        expect(parseRefillAsk('suggest historical places').isRefill).toBe(false);
        expect(parseRefillAsk('best restaurants in Yerevan').isRefill).toBe(false);
        expect(parseRefillAsk('another 50 options').count).toBe(null);
    });
});
