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
            .toMatchObject({ from: 'Yerevan', to: 'Dilijan' });
        expect(parseCorridorAsk("What's worth stopping at on the way from Yerevan to Tatev?", ['Yerevan', 'Tatev']))
            .toMatchObject({ from: 'Yerevan', to: 'Tatev' });
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

// ── A follow-up keeps the deck it continues (live 2026-09-02) ──
// "What is the closest monastery?" → "other ones?" served restaurants, bars
// and a shopping centre: the follow-up's three words carry no category, and
// the display label ("Place of worship") maps back to no action at all.
describe('lastDeckAction — the action the newest deck actually ran under', () => {
    const { lastDeckAction } = require('../engine/context/session');

    const deck = recs => ([
        { sender: 'user', text: 'What is the closest monastery?' },
        { sender: 'ai', text: 'here', recommendations: recs },
    ]);

    test('majority _action wins', () => {
        expect(lastDeckAction(deck([
            { name: 'Mekhitarist', _action: 'historical' },
            { name: 'Arnjo Vank', _action: 'historical' },
            { name: 'Some cafe', _action: 'restaurants' },
        ]))).toBe('historical');
    });

    test("'general' is not an answer", () => {
        expect(lastDeckAction(deck([{ name: 'X', _action: 'general' }]))).toBeNull();
    });

    test('older cards without _action degrade to null, never throw', () => {
        expect(lastDeckAction(deck([{ name: 'X' }]))).toBeNull();
        expect(lastDeckAction([])).toBeNull();
        expect(lastDeckAction(null)).toBeNull();
    });

    test('reads the NEWEST deck, not the first one found', () => {
        const messages = [
            ...deck([{ name: 'Hotel', _action: 'hotels' }]),
            { sender: 'user', text: 'and monasteries?' },
            { sender: 'ai', text: 'here', recommendations: [{ name: 'Vank', _action: 'historical' }] },
        ];
        expect(lastDeckAction(messages)).toBe('historical');
    });
});

// ── The corridor asked OSRM for a profile it does not name ──
// osrmBaseFor speaks ORS profile names ('driving-car'); 'driving' returned
// null, the URL became "null/route/v1/…", and every "between A and B" since
// silently sampled the straight line instead of the road.
describe('corridor routing provider', () => {
    const { osrmBaseFor } = require('../engine/travel/osrm');

    test("osrmBaseFor answers 'driving-car', not 'driving'", () => {
        const env = { OSRM_CAR_URL: 'http://osrm:5000' };
        expect(osrmBaseFor('driving-car', env)).toBe('http://osrm:5000');
        expect(osrmBaseFor('driving', env)).toBeNull();
    });

    test('an injected route is sampled along the road, endpoints excluded', async () => {
        const { corridorCentres } = require('../engine/geo/corridor');
        // A dog-leg: the straight line from (0,0) to (0,2) never passes lng 1.
        const road = [[0, 0], [1, 0.5], [1, 1], [1, 1.5], [0, 2]];
        const centres = await corridorCentres(
            { from: { lat: 0, lng: 0 }, to: { lat: 2, lng: 0 }, samples: 3 },
            { fetchRoute: async () => road },
        );
        expect(centres).toHaveLength(3);
        expect(centres.every(c => c.source === 'route')).toBe(true);
        expect(centres.some(c => c.lng === 1)).toBe(true);
    });

    test('no routing service → the straight line, never a thrown turn', async () => {
        const { corridorCentres } = require('../engine/geo/corridor');
        const centres = await corridorCentres(
            { from: { lat: 0, lng: 0 }, to: { lat: 0, lng: 4 }, samples: 3 },
            { fetchRoute: async () => [] },
        );
        expect(centres.map(c => c.source)).toEqual(['line', 'line', 'line']);
        expect(centres.map(c => c.lng)).toEqual([1, 2, 3]);
    });
});

// ── A follow-up must not lose the road (live 2026-09-02) ──
// "…from Yerevan to Tatev?" → "other ones?" ran as a plain hotels ask, bought
// a paid Google search for the raw question, and answered with Yerevan hotels.
describe('parseCorridorAsk on a follow-up', () => {
    const { parseCorridorAsk } = require('../engine/retrieval/tuning');

    test('intent place names win when it has them', () => {
        expect(parseCorridorAsk('places between Yerevan and Dilijan', ['Yerevan', 'Dilijan']))
            .toEqual({ from: 'Yerevan', to: 'Dilijan', source: 'intent' });
    });

    test('the sentence stands in when the follow-up carries no names', () => {
        expect(parseCorridorAsk("What's worth stopping at on the way from Yerevan to Tatev? other ones?", []))
            .toEqual({ from: 'Yerevan', to: 'Tatev', source: 'text' });
    });

    test('a follow-up alone is not a corridor', () => {
        expect(parseCorridorAsk('other ones?', [])).toBeNull();
    });

    test('pronoun endpoints are not places', () => {
        expect(parseCorridorAsk('take me from here to there', [])).toBeNull();
        expect(parseCorridorAsk('from it to me', [])).toBeNull();
    });
});

// ── The paid reverse geocode on every search (live 2026-09-03) ──
// proximityService called googleService.detectUserRegion directly, and that
// function has no cache: one live Geocoding request per deck turn, four on a
// corridor turn. The gazetteer answers it for free.
describe('detectRegion — gazetteer first, Google as the fallback, cached either way', () => {
    const { detectRegion, _CACHE } = require('../engine/context/region');
    const YEREVAN = { lat: 40.1866, lng: 44.5157 };

    beforeEach(() => _CACHE.clear());

    test('the gazetteer answers in detectUserRegion\'s shape, no API call', async () => {
        const detectUserRegion = jest.fn(async () => { throw new Error('must not be reached'); });
        const gazetteer = { regionAt: async () => ({ city: 'Yerevan', region: 'Yerevan', country: 'Armenia' }) };
        const r = await detectRegion(YEREVAN, null, { gazetteer, detectUserRegion });
        expect(r).toMatchObject({ city: 'Yerevan', region: 'Yerevan', country: 'Armenia', source: 'gazetteer' });
        expect(r.formatted).toBe('Yerevan, Yerevan, Armenia');
        expect(detectUserRegion).not.toHaveBeenCalled();
    });

    test('a coordinate the gazetteer cannot place still goes to Google, unchanged', async () => {
        const detectUserRegion = jest.fn(async () => ({ country: 'Armenia', region: 'Kotayk Province', city: 'Ptghni', formatted: 'Ptghni, Kotayk Province, Armenia' }));
        const gazetteer = { regionAt: async () => null };
        const r = await detectRegion({ lat: 40.3, lng: 44.6 }, null, { gazetteer, detectUserRegion });
        expect(r).toMatchObject({ city: 'Ptghni', region: 'Kotayk Province', source: 'google' });
        expect(detectUserRegion).toHaveBeenCalledTimes(1);
    });

    test('the ~1km grid answers the second call for free — the corridor bought four', async () => {
        const detectUserRegion = jest.fn(async () => ({ country: 'Armenia', region: null, city: 'Ptghni' }));
        const deps = { gazetteer: { regionAt: async () => null }, detectUserRegion };
        await detectRegion({ lat: 40.3000, lng: 44.6000 }, null, deps);
        await detectRegion({ lat: 40.3009, lng: 44.6004 }, null, deps);
        expect(detectUserRegion).toHaveBeenCalledTimes(1);
    });

    test('a broken gazetteer falls through rather than failing the search', async () => {
        const detectUserRegion = jest.fn(async () => ({ country: 'Armenia', city: 'Yerevan' }));
        const gazetteer = { regionAt: async () => { throw new Error('mongo down'); } };
        const r = await detectRegion(YEREVAN, null, { gazetteer, detectUserRegion });
        expect(r).toMatchObject({ city: 'Yerevan', source: 'google' });
    });

    test('a transient Google failure is not cached', async () => {
        const detectUserRegion = jest.fn()
            .mockRejectedValueOnce(new Error('ETIMEDOUT'))
            .mockResolvedValueOnce({ country: 'Armenia', city: 'Yerevan' });
        const deps = { gazetteer: { regionAt: async () => null }, detectUserRegion };
        expect(await detectRegion(YEREVAN, null, deps)).toBeNull();
        expect(await detectRegion(YEREVAN, null, deps)).toMatchObject({ city: 'Yerevan' });
    });

    test('junk coordinates cost nothing', async () => {
        const detectUserRegion = jest.fn();
        expect(await detectRegion(null, null, { detectUserRegion })).toBeNull();
        expect(await detectRegion({ lat: 'x', lng: 2 }, null, { detectUserRegion })).toBeNull();
        expect(detectUserRegion).not.toHaveBeenCalled();
    });
});
