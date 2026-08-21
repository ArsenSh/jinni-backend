// Tests for the V2 Retrieval Core (plain-Mongo path): BM25, RRF, cosine,
// semantic cache, and the findPlaces orchestration with injected deps.
// Everything is offline: fake candidates, fake embedder, injected clocks.

const { fuseRankings } = require('../engine/retrieval/rrf');
const { rankLexical, tokenize } = require('../engine/retrieval/lexical');
const { cosineSimilarity, rankByVector } = require('../engine/retrieval/vector');
const { SemanticCache } = require('../engine/retrieval/semanticCache');
const { findPlaces } = require('../engine/retrieval/index');

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
