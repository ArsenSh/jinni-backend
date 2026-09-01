// Gazetteer + scale tests. No Mongo, no network: every query goes through an
// injected fake model, so these run in the normal jest suite.
const gz = require('../engine/geo/gazetteer');
const { scaleOf, resolveDestination } = require('../engine/context/destination');
const { resolveRegion, _CACHE } = require('../engine/context/region');

// A fake mongoose chain: find().sort().limit().lean() → rows.
const fakeModel = (rows, capture = {}) => ({
    _sel: rows,
    find(q) {
        capture.query = q;
        (capture.queries = capture.queries || []).push(q);
        this._sel = rows.filter(r => {
            if (q.names && !(r.names || []).includes(q.names)) return false;
            if (typeof q.kind === 'string' && r.kind !== q.kind) return false;
            if (q.countryCode && r.countryCode !== q.countryCode) return false;
            if (q.population?.$gte != null && (r.population || 0) < q.population.$gte) return false;
            if (q.featureCode?.$nin && q.featureCode.$nin.includes(r.featureCode)) return false;
            return true;
        });
        return this;
    },
    sort(sp) {
        capture.sort = sp;
        if (sp && sp.population === -1) this._sel = [...this._sel].sort((a, b) => (b.population || 0) - (a.population || 0));
        return this;
    },
    limit(n) { capture.limit = n; this._sel = this._sel.slice(0, n); return this; },
    async lean() { return this._sel; },
    async estimatedDocumentCount() { return rows.length; },
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
        const far = { ...DILIJAN, name: 'Springfield', names: ['springfield'], lat: 0, lng: 0, population: 20000 };
        const near = { ...YEREVAN, name: 'Springfield', names: ['springfield'], population: 18000 };
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
        // Tiered now: country, then city, then region — all on the same key.
        expect(cap.queries[0]).toEqual({ names: 'tbilisi', kind: 'country' });
        expect(cap.queries.every(q => q.names === 'tbilisi')).toBe(true);
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
        await gz.regionAt({ lat: 0, lng: -140 }, {}, { model: fakeModel([], cap) });
        expect(cap.query.location.$near.$maxDistance).toBe(30000);
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


// ── Regressions from the first seeded server (2026-09-01) ────────────────────
describe('gazetteer: regressions found live once real data was in', () => {
    const ARMENIA_CO = {
        kind: 'city', scale: 'town', name: 'Armenia', names: ['armenia'],
        countryCode: 'CO', countryName: 'Colombia', population: 300000,
        lat: 4.53656, lng: -75.67263,
    };

    test('"Armenia" is the COUNTRY, never the 300k city in Colombia', async () => {
        // The country carries population 0, so one population-sorted query put
        // it below every populated namesake and `.limit(10)` could drop it.
        const geo = await gz.lookupPlace('Armenia', {}, { model: fakeModel([ARMENIA_CO, ARMENIA]) });
        expect(geo.countryCode).toBe('AM');
        expect(geo.scale).toBe('country');
        expect(geo.lat).toBeCloseTo(40.18, 1);
    });

    test('a city still resolves when no country shares its name', async () => {
        const geo = await gz.lookupPlace('Yerevan', {}, { model: fakeModel([YEREVAN, ARMENIA]) });
        expect(geo).toMatchObject({ name: 'Yerevan', scale: 'town' });
    });

    test('a CITY outranks a same-named admin REGION (hotels in Yerevan)', async () => {
        const region = { kind: 'region', scale: 'region', name: 'Yerevan', names: ['yerevan'],
                         countryCode: 'AM', population: 0, lat: 40.18, lng: 44.51 };
        const geo = await gz.lookupPlace('Yerevan', {}, { model: fakeModel([region, YEREVAN]) });
        expect(geo.scale).toBe('town');          // town scale keeps radius sizing
        expect(geo.population).toBe(1093485);
    });

    test('a region still answers when nothing else carries the name', async () => {
        const region = { kind: 'region', scale: 'region', name: 'Gegharkunik', names: ['gegharkunik'],
                         countryCode: 'AM', population: 0, lat: 40.3, lng: 45.3 };
        const geo = await gz.lookupPlace('Gegharkunik', {}, { model: fakeModel([region]) });
        expect(geo.scale).toBe('region');
    });

    test('standing in a DISTRICT reports the city, not the district', async () => {
        // Live: centre=here "Avan" — one of Yerevan's own districts, where
        // Google correctly said "Yerevan".
        const avan = { kind: 'city', name: 'Avan', names: ['avan'], featureCode: 'PPL',
                       countryCode: 'AM', countryName: 'Armenia', population: 50000,
                       lat: 40.216, lng: 44.560 };
        const r = await gz.regionAt({ lat: 40.216, lng: 44.560 }, {},
            { model: fakeModel([avan, YEREVAN]) });
        expect(r.city).toBe('Yerevan');
    });

    test('a genuinely separate town is NOT swallowed by a nearby big city', async () => {
        const abovyan = { kind: 'city', name: 'Abovyan', names: ['abovyan'], featureCode: 'PPL',
                          countryCode: 'AM', countryName: 'Armenia', population: 44000,
                          lat: 40.27, lng: 44.63 };
        // Yerevan is ~15 km off — beyond mergeKm, so Abovyan keeps its own name.
        const r = await gz.regionAt({ lat: 40.27, lng: 44.63 }, { mergeKm: 12 },
            { model: fakeModel([abovyan, YEREVAN]) });
        expect(r.city).toBe('Abovyan');
    });

    test('sections of a populated place are excluded from reverse geocoding', async () => {
        const cap = {};
        await gz.regionAt({ lat: 40.2, lng: 44.5 }, {}, { model: fakeModel([], cap) });
        expect(cap.query.featureCode.$nin).toContain('PPLX');
    });
});

// ── A country ask is scoped BY COUNTRY, not by a circle (Arsen 2026-09-01) ──
describe('country-scoped retrieval', () => {
    const { buildCacheQuery } = require('../engine/places/canonicalStore');
    const { rankingWeights } = require('../engine/retrieval/tuning');
    const CENTRE = { lat: 40.18, lng: 44.51 };

    test('a country ask filters on country and drops the bounding box', () => {
        const q = buildCacheQuery({ center: CENTRE, radiusKm: 50, category: 'restaurants', countryScope: 'Armenia' });
        expect(q.country).toBeInstanceOf(RegExp);
        expect(q.country.test('armenia')).toBe(true);      // address-parsed, so case-insensitive
        expect(q.country.test('Armenia Colombia')).toBe(false);
        expect(q['details.geometry.location.lat']).toBeUndefined();
        expect(q.actions).toBe('restaurants');             // category still applies, after country
    });

    test('every other ask keeps the bounding box and no country filter', () => {
        const q = buildCacheQuery({ center: CENTRE, radiusKm: 15, category: 'hotels' });
        expect(q.country).toBeUndefined();
        expect(q['details.geometry.location.lat']).toBeDefined();
        expect(q.actions).toBe('hotels');
    });

    test('a country name with regex characters cannot break the query', () => {
        const q = buildCacheQuery({ center: CENTRE, radiusKm: 50, countryScope: "Cote d'Ivoire (.*)" });
        expect(q.country.test("Cote d'Ivoire (.*)")).toBe(true);
        expect(q.country.test('Cote dIvoire anything')).toBe(false);
    });

    test('distance stops ranking once the scope is a whole country', () => {
        expect(rankingWeights({ countryScope: true }).proximity).toBe(0);
        expect(rankingWeights({}).proximity).toBe(0.5);
        expect(rankingWeights({ nearbyMode: true }).proximity).toBe(1);
    });
});

// ── nearby mode + a place you are NOT in (Arsen's rule + live 2026-09-01) ────
// "suggest 3 good locations in Dilijan" in nearby mode returned at the very
// first line of resolveDestination, so Dilijan was never geocoded: the search
// ran 5 km around the traveler's GPS in Yerevan and the narrator then called
// those Yerevan places Dilijan.
describe('nearby mode switches to discovery for a place you are not in', () => {
    const YER = { lat: 40.216, lng: 44.560 };
    const HERE = { city: 'Yerevan', country: 'Armenia' };
    const geo = (rows) => ({
        gazetteer: null,
        findPlaces: async (q) => {
            const hit = rows[q];
            return hit ? [{ name: hit.name, geometry: { location: { lat: hit.lat, lng: hit.lng } }, types: hit.types }] : [];
        },
    });

    test('naming another town leaves nearby and centres on that town', async () => {
        const d = await resolveDestination(
            { placeNames: ['Dilijan'], gps: YER, nearbyMode: true, currentRegion: HERE },
            geo({ Dilijan: { name: 'Dilijan', lat: 40.7408, lng: 44.8628, types: ['locality'] } }));
        expect(d.source).toBe('named');
        expect(d.switchedFromNearby).toBe(true);
        expect(d.center).toEqual({ lat: 40.7408, lng: 44.8628 });
    });

    test('naming the COUNTRY you are standing in keeps nearby', async () => {
        const d = await resolveDestination(
            { placeNames: ['Armenia'], gps: YER, nearbyMode: true, currentRegion: HERE },
            geo({ Armenia: { name: 'Armenia', lat: 40.18, lng: 44.51, types: ['country'] } }));
        expect(d.source).toBe('nearby');
        expect(d.switchedFromNearby).toBeUndefined();
        expect(d.center).toEqual(YER);
    });

    test('naming the CITY you are standing in keeps nearby', async () => {
        const d = await resolveDestination(
            { placeNames: ['Yerevan'], gps: YER, nearbyMode: true, currentRegion: HERE },
            geo({ Yerevan: { name: 'Yerevan', lat: 40.18, lng: 44.51, types: ['locality'] } }));
        expect(d.source).toBe('nearby');
    });

    test('a VENUE name never leaves nearby — that is not a destination', async () => {
        const d = await resolveDestination(
            { placeNames: ['Nairi'], gps: YER, nearbyMode: true, currentRegion: HERE },
            geo({ Nairi: { name: 'Nairi', lat: 40.19, lng: 44.52, types: ['restaurant'] } }));
        expect(d.source).toBe('nearby');
    });

    test('naming nothing at all still just means nearby', async () => {
        const d = await resolveDestination(
            { placeNames: [], gps: YER, nearbyMode: true, currentRegion: HERE }, geo({}));
        expect(d.source).toBe('nearby');
        expect(d.center).toEqual(YER);
    });

    test('a switched turn is a single named town, so it sizes by population', () => {
        expect(gz.radiusForPopulation(17000)).toBe(10);     // Dilijan, not 5 km
    });
});

// Live 2026-09-01: "your current spot in Arinj" — a village ringing Yerevan.
// Excluding district feature codes was not enough; the city has to survive the
// nearest-N cut before it can win on population.
describe('regionAt: a ring of closer villages must not hide the city', () => {
    const near = (name, pop, lat, lng) => ({
        kind: 'city', name, names: [name.toLowerCase()], featureCode: 'PPL',
        countryCode: 'AM', countryName: 'Armenia', population: pop, lat, lng,
    });
    test('Yerevan wins even when several villages are nearer', async () => {
        const rows = [
            near('Arinj', 5000, 40.216, 44.560),
            near('Jrvezh', 6000, 40.205, 44.575),
            near('Nor Nork', 8000, 40.210, 44.550),
            near('Avan', 9000, 40.212, 44.545),
            near('Zovuni', 4000, 40.220, 44.540),
            near('Yerevan', 1093485, 40.18111, 44.51361),   // 6th nearest
        ];
        const fake = {
            find() { return this; }, sort() { return this; },
            limit(n) { this._n = n; return this; },
            async lean() { return rows.slice(0, this._n); },
        };
        const r = await gz.regionAt({ lat: 40.216, lng: 44.560 }, {}, { model: fake });
        expect(r.city).toBe('Yerevan');
    });
});
