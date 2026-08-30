// Robustness trio 2026-08-31 (post-launch-eve night session):
// (1) embedder failures are transient — warm-up reports state loudly;
// (2) the Google fallback query never loses the WHERE ("villas" → 0 results
//     while "villas Dilijan" finds them);
// (3) subtype narrowing — a message token naming something already shown
//     re-serves the matching subset instead of the exhausted reply.

const { narrowingMatches } = require('../engine/context/session');
const { googleFallback } = require('../engine/places/canonicalStore');
const { warmEmbedder, setEmbedder } = require('../engine/retrieval/embedder');
const g = require('../engine/narrator/prompts/grounded');

describe('narrowingMatches (subtype narrowing detector)', () => {
    const SHOWN = [
        'Dilijan Park Resort & Villas', 'DiliDream Villa resort',
        'Tufenkian Old Dilijan Complex', 'ASINE Guest House', 'Hover Boutique Hotel',
    ];
    const opts = { excludeTokens: ['dilijan', 'hotels'] };

    test('the live case: "villas please" matches the two shown villa cards', () => {
        expect(narrowingMatches('villas please', SHOWN, opts)).toEqual(['villa']);
    });
    test('guesthouse ask matches the shown guest house', () => {
        expect(narrowingMatches('any guest houses?', SHOWN, opts)).toContain('guest');
    });
    test('the deck category noun NEVER reads as narrowing ("hotels please")', () => {
        expect(narrowingMatches('hotels please', SHOWN, opts)).toEqual([]);
    });
    test('city words NEVER read as narrowing ("in Dilijan please")', () => {
        expect(narrowingMatches('in Dilijan please', SHOWN, opts)).toEqual([]);
    });
    test('pure more-asks carry no matching token ("find 3 more", "4 more")', () => {
        expect(narrowingMatches('find 3 more', SHOWN, opts)).toEqual([]);
        expect(narrowingMatches('4 more', SHOWN, opts)).toEqual([]);
    });
    test('no shown cards → never a narrowing ask', () => {
        expect(narrowingMatches('villas please', [], opts)).toEqual([]);
    });
    test('vibe/function words are ignored even when a name contains them', () => {
        expect(narrowingMatches('show me the best places', SHOWN, opts)).toEqual([]);
    });
});

describe('googleFallback keeps the WHERE in the paid query', () => {
    const CENTER = { lat: 40.7404, lng: 44.8655 };
    const deps = () => ({
        coverage: async () => true,
        findPlaces: jest.fn(async () => []),
        resolveDetails: async () => null,
    });

    test('bare subject gains the region city: "villas" → "villas Dilijan"', async () => {
        const d = deps();
        await googleFallback({
            query: 'villas', coreQuery: 'villas', category: null, subType: null,
            center: CENTER, radiusKm: 15, regionCity: 'Dilijan', needed: 3, requestId: null,
        }, d);
        expect(d.findPlaces).toHaveBeenCalledTimes(1);
        expect(d.findPlaces.mock.calls[0][0]).toBe('villas Dilijan');
    });
    test('query already carrying the city stays untouched', async () => {
        const d = deps();
        await googleFallback({
            query: 'hotels in Dilijan', coreQuery: 'hotels in Dilijan', category: 'hotels', subType: null,
            center: CENTER, radiusKm: 15, regionCity: 'Dilijan', needed: 3, requestId: null,
        }, d);
        expect(d.findPlaces.mock.calls[0][0]).toBe('hotels in Dilijan');
    });
    test('city match is case-insensitive; no regionCity → no append', async () => {
        const d = deps();
        await googleFallback({
            query: 'cafes in DILIJAN', coreQuery: 'cafes in DILIJAN', category: null, subType: null,
            center: CENTER, radiusKm: 15, regionCity: 'Dilijan', needed: 3, requestId: null,
        }, d);
        expect(d.findPlaces.mock.calls[0][0]).toBe('cafes in DILIJAN');
        const d2 = deps();
        await googleFallback({
            query: 'villas', coreQuery: 'villas', category: null, subType: null,
            center: CENTER, radiusKm: 15, regionCity: null, needed: 3, requestId: null,
        }, d2);
        expect(d2.findPlaces.mock.calls[0][0]).toBe('villas');
    });
});

describe('warmEmbedder', () => {
    afterEach(() => setEmbedder(null));
    test('reports vectors LIVE when an embedder is available', async () => {
        setEmbedder({ model: 'test-model', embed: async (t) => (Array.isArray(t) ? t : [t]).map(() => [0.1, 0.2]) });
        await expect(warmEmbedder()).resolves.toBe(true);
    });
});

describe('narration prompt: reServed + servable follow-ups', () => {
    const places = [{ name: 'Dilijan Park Resort & Villas' }, { name: 'DiliDream Villa resort' }];
    test('streamed builder owns the re-serve ("already shown … matching subset")', () => {
        const sys = g.buildStreamedNarrationMessages({ query: 'villas', places, reServed: true })[0].content;
        expect(sys).toContain('ALREADY SHOWN');
        expect(sys).toContain('never as new discoveries');
    });
    test('one-shot JSON builder carries the same rule', () => {
        const sys = g.buildNarrationJson({ query: 'villas', places, reServed: true })[0].content;
        expect(sys).toContain('ALREADY SHOWN');
    });
    test('silent when nothing was re-served', () => {
        expect(g.buildStreamedNarrationMessages({ query: 'villas', places })[0].content)
            .not.toContain('ALREADY SHOWN');
    });
    test('follow-up question rule demands servable offers only', () => {
        const sys = g.buildStreamedNarrationMessages({ query: 'hotels', places })[0].content;
        expect(sys).toContain('never propose a category or place type that is not');
    });
});
