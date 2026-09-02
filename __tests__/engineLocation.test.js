// The seven location questions from Arsen's 2026-09-02 list. Six of them were
// answered from a stale session centre or from the first of two named places;
// each case below is one of those live failures.
const { parseAtLocation, parseRadiusKm, isClosestAsk, isNearbyAsk, parseCorridorAsk } = require('../engine/retrieval/tuning');
const { resolveStatedLocation } = require('../engine/geo/whereAmI');
const { corridorCentres, sampleRouteCentres, interpolateCentres, _fractions } = require('../engine/geo/corridor');
const { resolveDestination } = require('../engine/context/destination');
const { loadCandidates } = require('../engine/places/canonicalStore');

describe('parseAtLocation — "I\'m at Khor Virap"', () => {
    test('pulls the place out of several phrasings', () => {
        expect(parseAtLocation("I'm at Khor Virap. What should I visit next?")).toBe('Khor Virap');
        expect(parseAtLocation('I am currently in Dilijan')).toBe('Dilijan');
        expect(parseAtLocation("we're at Lake Sevan")).toBe('Lake Sevan');
        expect(parseAtLocation('я в Дилижане, что посмотреть')).toBe('Дилижане');
    });
    test('cuts at a joining word, not at the end of the sentence', () => {
        expect(parseAtLocation("I'm at Khor Virap and want food")).toBe('Khor Virap');
    });
    test('a pronoun or an ordinary ask is not a position', () => {
        for (const m of ["I'm here", 'restaurants near me', 'best places in Armenia', ''])
            expect(parseAtLocation(m)).toBeNull();
    });
});

describe('parseRadiusKm — "within 10 km"', () => {
    test('reads the number and the unit', () => {
        expect(parseRadiusKm('What can I do within 10 km?')).toBe(10);
        expect(parseRadiusKm('anything under 5 miles')).toBe(8);        // converted
        expect(parseRadiusKm('в радиусе 10 км')).toBe(10);
        expect(parseRadiusKm('20 km radius please')).toBe(20);
    });
    test('nothing to read means nothing is forced', () => {
        expect(parseRadiusKm('best places in Armenia')).toBeNull();
    });
    test('an absurd number is clamped, never obeyed', () => {
        expect(parseRadiusKm('within 999 km')).toBe(100);
    });
});

describe('closest is a SORT, nearby is a LIMIT', () => {
    test('they are separate signals', () => {
        expect(isClosestAsk('What is the closest monastery?')).toBe(true);
        expect(isNearbyAsk('What is the closest monastery?')).toBe(false);
        expect(isNearbyAsk('restaurants near me')).toBe(true);
        expect(isClosestAsk('restaurants near me')).toBe(false);
    });
    test('non-Latin superlatives count', () => {
        expect(isClosestAsk('ближайший монастырь')).toBe(true);
        expect(isClosestAsk('ամենամոտ վանքը')).toBe(true);
    });
});

describe('parseCorridorAsk', () => {
    test('needs a route shape AND two resolved endpoints', () => {
        expect(parseCorridorAsk('Give me places between Yerevan and Dilijan.', ['Yerevan', 'Dilijan']))
            .toEqual({ from: 'Yerevan', to: 'Dilijan' });
        expect(parseCorridorAsk("What's worth stopping at on the way from Yerevan to Tatev?", ['Yerevan', 'Tatev']))
            .toEqual({ from: 'Yerevan', to: 'Tatev' });
    });
    test('one place, or no route shape, is not a corridor', () => {
        expect(parseCorridorAsk('hotels in Dilijan', ['Dilijan'])).toBeNull();
        expect(parseCorridorAsk('Yerevan and Dilijan are both nice', ['Yerevan', 'Dilijan'])).toBeNull();
    });
});

describe('whereAmI — cheapest source first', () => {
    const KV = { name: 'Khor Virap', latitude: 39.878, longitude: 44.577 };
    test('a card from this conversation costs nothing', async () => {
        const r = await resolveStatedLocation('Khor Virap', { sessionCards: [KV] },
            { gazetteer: null, placeCache: async () => { throw new Error('must not be reached'); } });
        expect(r).toMatchObject({ source: 'session', lat: 39.878 });
    });
    test('falls to our own corpus before Google', async () => {
        let googleCalled = false;
        const r = await resolveStatedLocation('Khor Virap', {}, {
            gazetteer: null,
            placeCache: async () => ({ name: 'Khor Virap', details: { geometry: { location: { lat: 39.878, lng: 44.577 } } } }),
            findPlaces: async () => { googleCalled = true; return []; },
        });
        expect(r.source).toBe('cache');
        expect(googleCalled).toBe(false);
    });
    test('Google is the last resort, and a total miss is null', async () => {
        const deps = { gazetteer: null, placeCache: async () => null };
        expect(await resolveStatedLocation('Nowhere', {}, deps)).toBeNull();
        const r = await resolveStatedLocation('Nowhere', {}, {
            ...deps, findPlaces: async () => [{ name: 'Nowhere', geometry: { location: { lat: 1, lng: 2 } } }],
        });
        expect(r.source).toBe('google');
    });
    test('a broken tier never throws', async () => {
        const r = await resolveStatedLocation('X Place', {}, {
            gazetteer: { lookupPlace: async () => { throw new Error('db down'); } },
            placeCache: async () => { throw new Error('db down'); },
        });
        expect(r).toBeNull();
    });
});

describe('corridor centres', () => {
    const YER = { lat: 40.178, lng: 44.513 }, DIL = { lat: 40.740, lng: 44.863 };
    test('the endpoints themselves are excluded — they are not "between"', () => {
        expect(_fractions(4)).toEqual([0.2, 0.4, 0.6, 0.8]);
        const pts = interpolateCentres(YER, DIL, 4);
        expect(pts.every(p => p.lat > YER.lat && p.lat < DIL.lat)).toBe(true);
    });
    test('samples follow the ROAD when a geometry is available', async () => {
        const bend = [[44.513, 40.178], [44.9, 40.25], [45.0, 40.45], [44.9, 40.65], [44.863, 40.740]];
        const pts = await corridorCentres({ from: YER, to: DIL }, { fetchRoute: async () => bend });
        expect(pts.every(p => p.source === 'route')).toBe(true);
        expect(pts.some(p => p.lng > 44.87)).toBe(true);          // off the straight line
    });
    test('a dead router degrades to the straight line, never to a failure', async () => {
        const pts = await corridorCentres({ from: YER, to: DIL }, { fetchRoute: async () => { throw new Error('down'); } });
        expect(pts).toHaveLength(4);
        expect(pts[0].source).toBe('line');
    });
    test('missing endpoints yield nothing rather than a bad corridor', async () => {
        expect(await corridorCentres({ from: YER, to: null })).toEqual([]);
    });
});

describe('loadCandidates: corridor searches every segment and buys nothing', () => {
    test('one query per centre, and the paid fallback never fires', async () => {
        const seen = [];
        const deps = {
            cacheFind: async (q) => { seen.push(q); return []; },
            proximity: async () => [],
            findPlaces: async () => { throw new Error('Google must not be called on a corridor'); },
        };
        const out = await loadCandidates({
            centres: [{ lat: 40.3, lng: 44.6, radiusKm: 15 }, { lat: 40.5, lng: 44.7, radiusKm: 15 },
                      { lat: 40.65, lng: 44.8, radiusKm: 15 }],
            count: 6, category: null, query: 'places', center: { lat: 40.3, lng: 44.6 },
        }, deps);
        expect(seen).toHaveLength(3);
        expect(Array.isArray(out)).toBe(true);
    });
});

describe('the precedence chain', () => {
    const geo = (rows) => ({ gazetteer: null, findPlaces: async (q) => {
        const h = rows[q]; return h ? [{ name: h.name, geometry: { location: { lat: h.lat, lng: h.lng } }, types: h.types }] : [];
    } });
    const YER = { lat: 40.18, lng: 44.51 };
    const HERE = { city: 'Yerevan', country: 'Armenia' };
    const DIL = { Dilijan: { name: 'Dilijan', lat: 40.74, lng: 44.86, types: ['locality'] } };
    const GYUMRI = { name: 'Gyumri', latitude: 40.79, longitude: 43.85 };
    const KV = { lat: 39.878, lng: 44.577, name: 'Khor Virap' };

    test('a named place beats a stated position', async () => {
        const d = await resolveDestination({ placeNames: ['Dilijan'], gps: YER, statedPosition: KV }, geo(DIL));
        expect(d.city).toBe('Dilijan');
    });
    test('a stated position beats a stale session centre — the Khor Virap bug', async () => {
        const d = await resolveDestination(
            { placeNames: [], gps: YER, statedPosition: KV, sessionDestination: GYUMRI }, geo({}));
        expect(d.source).toBe('stated');
        expect(d.center).toEqual({ lat: 39.878, lng: 44.577 });
        expect(d.remember).toMatchObject({ name: 'Khor Virap', singleTown: true });
    });
    test('nearby still means GPS when nothing is named', async () => {
        const d = await resolveDestination({ placeNames: [], gps: YER, nearbyMode: true, sessionDestination: GYUMRI }, geo({}));
        expect(d.source).toBe('nearby');
    });
    test('nearby + another town switches to discovery', async () => {
        const d = await resolveDestination(
            { placeNames: ['Dilijan'], gps: YER, nearbyMode: true, currentRegion: HERE }, geo(DIL));
        expect(d.source).toBe('named');
        expect(d.switchedFromNearby).toBe(true);
    });
    test('nearby + the country you are standing in stays nearby', async () => {
        const d = await resolveDestination(
            { placeNames: ['Armenia'], gps: YER, nearbyMode: true, currentRegion: HERE },
            geo({ Armenia: { name: 'Armenia', lat: 40.18, lng: 44.51, types: ['country'] } }));
        expect(d.source).toBe('nearby');
    });
    test('with nothing else, the session still answers', async () => {
        const d = await resolveDestination({ placeNames: [], gps: YER, sessionDestination: GYUMRI }, geo({}));
        expect(d.source).toBe('session');
    });
});
