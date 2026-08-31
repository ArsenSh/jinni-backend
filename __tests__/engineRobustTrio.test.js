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

// ── Brain-first paid boundary (founder 2026-08-31: "how to fix so it will
//    work in 100% instead of each time adding a new word"). No blacklist
//    arms race: raw chat words never reach Google; only the intent model's
//    own query or code-written category+city do, results must pass the
//    category type gate, and refill chains never eat their own memory. ──

const { isSubstantiveAsk } = require('../engine/places/canonicalStore');
const { lastCardAsk } = require('../engine/context/session');

describe('isSubstantiveAsk (the one substance test)', () => {
    test.each([
        ['hotels in Dilijan', true],
        ['uzbek restaurants', true],
        ['romantic dinner spot', true],
        ['another ones please', false],       // refill phrasing (the live leak)
        ['another results please', false],
        ['give 10 results please', false],    // count + function words only
        ['find 3 more', false],
        ['4 more', false],
        ['tonight', false],                   // vibe-only (the 2026-08-29 leak)
        ['مطعم سوشي', true],                  // unsplittable script passes through
    ])('%j → %s', (text, expected) => {
        expect(isSubstantiveAsk(text)).toBe(expected);
    });
});

describe('paid query is whitelist-by-construction', () => {
    const CENTER = { lat: 40.7404, lng: 44.8655 };
    const deps = () => ({
        coverage: async () => true,
        findPlaces: jest.fn(async () => []),
        resolveDetails: async () => null,
        typeGate: jest.fn(() => true),
    });

    test('raw chat filler NEVER reaches Google — degrades to category+city', async () => {
        const d = deps();
        await googleFallback({
            query: 'another ones please', coreQuery: 'another ones please', category: 'hotels',
            subType: null, center: CENTER, radiusKm: 15, regionCity: 'Dilijan', needed: 3, requestId: null,
        }, d);
        expect(d.findPlaces.mock.calls[0][0]).toBe('hotels Dilijan');
    });
    test("the model's own clean query still wins the pick", async () => {
        const d = deps();
        await googleFallback({
            query: 'uzbek food yerevan cozy', coreQuery: 'uzbek restaurant', category: 'restaurants',
            subType: null, center: CENTER, radiusKm: 15, regionCity: 'Yerevan', needed: 3, requestId: null,
        }, d);
        expect(d.findPlaces.mock.calls[0][0]).toBe('uzbek restaurant Yerevan');
    });
    test('results failing the category type gate are dropped (cafe in a hotels chain)', async () => {
        const d = deps();
        d.findPlaces = jest.fn(async () => [
            { place_id: 'g1', name: 'Real Hotel', geometry: { location: { lat: 40.741, lng: 44.866 } } },
            { place_id: 'g2', name: 'Sneaky Cafe', geometry: { location: { lat: 40.742, lng: 44.867 } } },
        ]);
        d.resolveDetails = async (id) => (id === 'g1'
            ? { name: 'Real Hotel', types: ['hotel', 'lodging'], primaryType: 'hotel' }
            : { name: 'Sneaky Cafe', types: ['cafe'], primaryType: 'cafe' });
        d.typeGate = jest.fn((action, st, types) => types.includes('hotel'));
        const out = await googleFallback({
            query: 'hotels', coreQuery: 'hotels in dilijan', category: 'hotels',
            subType: null, center: CENTER, radiusKm: 15, regionCity: 'Dilijan', needed: 5, requestId: null,
        }, d);
        expect(out.map(p => p.name)).toEqual(['Real Hotel']);
        expect(d.typeGate).toHaveBeenCalledWith('hotels', null, ['cafe'], 'cafe');
    });
});

describe('lastCardAsk: refill chains never eat their own memory', () => {
    const u = (text) => ({ sender: 'user', text });
    const deck = () => ({ sender: 'ai', text: 'here you go', recommendations: [{ title: 'x' }] });

    test('the live degradation: filler asks are walked past to the substantive one', () => {
        const messages = [
            u('hotels in Dilijan'), deck(),
            u('give 10 results please'), deck(),
            u('another ones please'), deck(),
        ];
        expect(lastCardAsk(messages)).toBe('hotels in Dilijan');
    });
    test('window holds only filler → newest filler survives as last resort', () => {
        const messages = [u('another ones please'), deck(), u('4 more'), deck()];
        expect(lastCardAsk(messages)).toBe('4 more');
    });
    test('no decks → null (fresh-ask behavior, unchanged)', () => {
        expect(lastCardAsk([u('hello')])).toBe(null);
    });
});
