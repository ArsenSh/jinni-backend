// Gazetteer + scale tests. No Mongo, no network: every query goes through an
// injected fake model, so these run in the normal jest suite.
const gz = require('../engine/geo/gazetteer');
const { scaleOf, resolveDestination } = require('../engine/context/destination');
const { resolveRegion, _CACHE } = require('../engine/context/region');

// A fake mongoose chain: find().sort().limit().lean() → rows.
const fakeModel = (rows, capture = {}) => ({
    find(q) { capture.query = q; return this; },
    sort(s) { capture.sort = s; return this; },
    limit(n) { capture.limit = n; return this; },
    lean: async () => rows,
    estimatedDocumentCount: async () => rows.length,
});

const YEREVAN = {
    geonameId: 616052, kind: 'city', scale: 'town', name: 'Yerevan',
    names: ['yerevan'], countryCode: 'AM', countryName: 'Armenia',
    population: 1093485, lat: 40.18111, lng: 44.51361,
};
const ARMENIA = {
    geonameId: 174982, kind: 'country', scale: 'country', name: 'Armenia',
    names: ['armenia', 'am'], countryCode: 'AM', countryName: 'Armenia',
    population: 0, lat: 40.18111, lng: 44.51361,
};
const DILIJAN = {
    geonameId: 616114, kind: 'city', scale: 'town', name: 'Dilijan',
    names: ['dilijan'], countryCode: 'AM', countryName: 'Armenia',
    population: 17000, lat: 40.7408, lng: 44.8628,
};

describe('gazetteer: normalizeName', () => {
    test('folds case, accents and punctuation the same way on both sides', () => {
        expect(gz.normalizeName("T'bilisi")).toBe('tbilisi');
        expect(gz.normalizeName('  YEREVAN ')).toBe('yerevan');
        expect(gz.normalizeName('Ереван')).toBe('ереван');
    });
    test('empty input yields an empty key (never matches anything)', () => {
        expect(gz.normalizeName(null)).toBe('');
    });
});

describe('gazetteer: radiusForPopulation', () => {
    test('scales with the size of the place', () => {
        expect(gz.radiusForPopulation(800)).toBe(5);          // village
        expect(gz.radiusForPopulation(17000)).toBe(10);       // Dilijan
        expect(gz.radiusForPopulation(120000)).toBe(15);      // Gyumri
        expect(gz.radiusForPopulation(1093485)).toBe(20);     // Yerevan
        expect(gz.radiusForPopulation(3600000)).toBe(30);     // Dubai
    });
    test('an unknown population keeps the 15 km status quo', () => {
        expect(gz.radiusForPopulation(0)).toBe(15);
        expect(gz.radiusForPopulation(null)).toBe(15);
    });
});

describe('gazetteer: lookupPlace', () => {
    test('returns a Google-shaped geo carrying scale and population', async () => {
        const geo = await gz.lookupPlace('Yerevan', {}, { model: fakeModel([YEREVAN]) });
        expect(geo).toMatchObject({
            lat: 40.18111, lng: 44.51361, name: 'Yerevan',
            placeId: null, scale: 'town', population: 1093485,
            countryCode: 'AM', source: 'gazetteer',
        });
        expect(geo.types).toContain('locality');
    });

    test('a country resolves as country scale with country types', async () => {
        const geo = await gz.lookupPlace('Armenia', {}, { model: fakeModel([ARMENIA]) });
        expect(geo.scale).toBe('country');
        expect(geo.types).toContain('country');
    });

    test('a country outranks a same-named city however popular', async () => {
        const geo = await gz.lookupPlace('Armenia', {}, { model: fakeModel([YEREVAN, ARMENIA]) });
        expect(geo.name).toBe('Armenia');
        expect(geo.scale).toBe('country');
    });

    test('same-named CITIES disambiguate by proximity to the traveler', async () => {
        const far = { ...DILIJAN, name: 'Springfield', names: ['springfield'], lat: 0, lng: 0 };
        const near = { ...YEREVAN, name: 'Springfield', names: ['springfield'], population: 100 };
        const geo = await gz.lookupPlace('Springfield', { near: { lat: 40.2, lng: 44.5 } },
            { model: fakeModel([far, near]) });
        expect(geo.lat).toBeCloseTo(40.18111, 3);
    });

    test('a miss returns null so the caller falls through to Google', async () => {
        expect(await gz.lookupPlace('Nairi', {}, { model: fakeModel([]) })).toBeNull();
        expect(await gz.lookupPlace('', {}, { model: fakeModel([YEREVAN]) })).toBeNull();
    });

    test('a broken model never throws — it fails open to null', async () => {
        const broken = { find() { throw new Error('no collection'); } };
        expect(await gz.lookupPlace('Yerevan', {}, { model: broken })).toBeNull();
    });

    test('the query matches on the normalized key', async () => {
        const cap = {};
        await gz.lookupPlace("  T'bilisi ", {}, { model: fakeModel([], cap) });
        expect(cap.query).toEqual({ names: 'tbilisi' });
    });
});

describe('gazetteer: regionAt', () => {
    test('names the nearest city and its country', async () => {
        const r = await gz.regionAt({ lat: 40.2, lng: 44.5 }, {}, { model: fakeModel([YEREVAN]) });
        expect(r).toMatchObject({ city: 'Yerevan', country: 'Armenia', countryCode: 'AM' });
        expect(r.distanceKm).toBeLessThan(10);
    });
    test('bounds the search so mid-ocean never gets a confident answer', async () => {
        const cap = {};
        await gz.regionAt({ lat: 0, lng: -140 }, { maxKm: 120 }, { model: fakeModel([], cap) });
        expect(cap.query.location.$near.$maxDistance).toBe(120000);
        expect(cap.query.kind).toBe('city');
    });
    test('bad coordinates return null without querying', async () => {
        expect(await gz.regionAt({}, {}, { model: fakeModel([YEREVAN]) })).toBeNull();
    });
});

describe('gazetteer: mainCities', () => {
    test('returns population-ordered centres, each with its own radius', async () => {
        const cities = await gz.mainCities('am', { limit: 2 }, { model: fakeModel([YEREVAN, DILIJAN]) });
        expect(cities).toHaveLength(2);
        expect(cities[0]).toMatchObject({ name: 'Yerevan', radiusKm: 20 });
        expect(cities[1]).toMatchObject({ name: 'Dilijan', radiusKm: 10 });
    });
    test('uppercases the country code and asks for cities only', async () => {
        const cap = {};
        await gz.mainCities('am', {}, { model: fakeModel([], cap) });
        expect(cap.query).toMatchObject({ countryCode: 'AM', kind: 'city' });
    });
    test('no country code, or a broken model, yields an empty list', async () => {
        expect(await gz.mainCities(null)).toEqual([]);
        expect(await gz.mainCities('AM', {}, { model: { find() { throw new Error('x'); } } })).toEqual([]);
    });
});

describe('destination: scaleOf', () => {
    test('reads a country and a region out of Google types', () => {
        expect(scaleOf({ types: ['country', 'political'] })).toBe('country');
        expect(scaleOf({ types: ['administrative_area_level_1', 'political'] })).toBe('region');
    });
    test('a city is town scale, and generic "political" alone decides nothing', () => {
        expect(scaleOf({ types: ['locality', 'political'] })).toBe('town');
        expect(scaleOf({ types: ['political'] })).toBe('town');
        expect(scaleOf({ types: [] })).toBe('town');
        expect(scaleOf(null)).toBe('town');
    });
    test('an explicit gazetteer scale wins over type inference', () => {
        expect(scaleOf({ scale: 'country', types: ['locality'] })).toBe('country');
    });
});

describe('destination: country scale no longer poisons the session cap', () => {
    const gazStub = (geo) => ({ lookupPlace: async () => geo });

    test('naming a COUNTRY reports country scale and does NOT set singleTown', async () => {
        const dest = await resolveDestination(
            { placeNames: ['Armenia'], gps: { lat: 40.18, lng: 44.51 } },
            { findPlaces: async () => { throw new Error('Google must not be called'); },
              gazetteer: gazStub({ lat: 40.18, lng: 44.51, name: 'Armenia', placeId: null,
                                   types: ['country', 'political'], scale: 'country', population: 0 }) },
        );
        expect(dest.source).toBe('named');
        expect(dest.scale).toBe('country');
        expect(dest.remember.singleTown).toBe(false);
    });

    test('naming ONE TOWN still sets singleTown — the Dilijan cap is preserved', async () => {
        const dest = await resolveDestination(
            { placeNames: ['Dilijan'], gps: null },
            { findPlaces: async () => { throw new Error('Google must not be called'); },
              gazetteer: gazStub({ lat: 40.74, lng: 44.86, name: 'Dilijan', placeId: null,
                                   types: ['locality', 'political'], scale: 'town', population: 17000 }) },
        );
        expect(dest.scale).toBe('town');
        expect(dest.remember.singleTown).toBe(true);
        expect(dest.population).toBe(17000);
    });

    test('a gazetteer miss falls through to Google unchanged', async () => {
        let asked = null;
        const dest = await resolveDestination(
            { placeNames: ['Nairi'], gps: null },
            { findPlaces: async (q) => { asked = q; return [{ name: 'Nairi', place_id: 'p1', types: ['restaurant'],
                                                              geometry: { location: { lat: 40.1, lng: 44.5 } } }]; },
              gazetteer: gazStub(null) },
        );
        expect(asked).toBe('Nairi');
        // A restaurant is not geographic, so the centre must not move.
        expect(dest.source).not.toBe('named');
    });
});

describe('region: gazetteer first, Google as fallback', () => {
    beforeEach(() => _CACHE.clear());

    test('a gazetteer hit answers without calling Google', async () => {
        let googleCalls = 0;
        const r = await resolveRegion({ center: { lat: 40.2, lng: 44.5 } }, {
            gazetteer: { regionAt: async () => ({ city: 'Yerevan', country: 'Armenia' }) },
            detectUserRegion: async () => { googleCalls++; return { city: 'X', country: 'Y' }; },
        });
        expect(r).toMatchObject({ city: 'Yerevan', country: 'Armenia' });
        expect(googleCalls).toBe(0);
    });

    test('an unseeded gazetteer falls back to Google — todays behaviour', async () => {
        const r = await resolveRegion({ center: { lat: 40.2, lng: 44.5 } }, {
            gazetteer: { regionAt: async () => null },
            detectUserRegion: async () => ({ city: 'Yerevan', country: 'Armenia' }),
        });
        expect(r).toMatchObject({ city: 'Yerevan', country: 'Armenia' });
    });

    test('a throwing gazetteer still yields Googles answer', async () => {
        const r = await resolveRegion({ center: { lat: 40.2, lng: 44.5 } }, {
            gazetteer: { regionAt: async () => { throw new Error('boom'); } },
            detectUserRegion: async () => ({ city: 'Tbilisi', country: 'Georgia' }),
        });
        expect(r.city).toBe('Tbilisi');
    });
});
