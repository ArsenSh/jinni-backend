// Where the search is centred (Arsen 2026-08-24: destination set to Dubai,
// every card came back Armenian). v1's precedence, restored in the engine.

const { resolveDestination, isGeographic } = require('../engine/context/destination');

const YEREVAN = { lat: 40.18, lng: 44.51 };
const DUBAI = { lat: 25.20, lng: 55.27 };
const SESSION_PAPHOS = { name: 'Paphos', latitude: 34.77, longitude: 32.42 };

// Unique names per test keep the module-level geocode memo from leaking between them.
const geocoder = (byName) => ({
    findPlaces: async (q) => {
        const hit = byName[q];
        return hit ? [{ name: hit.name || q, geometry: { location: { lat: hit.lat, lng: hit.lng } },
            place_id: hit.placeId || 'pid', types: hit.types, primaryType: hit.primaryType }] : [];
    },
});

describe('resolveDestination', () => {
    test('the live failure: a named city beats GPS', async () => {
        const d = await resolveDestination(
            { placeNames: ['dubai'], gps: YEREVAN },
            geocoder({ dubai: { ...DUBAI, name: 'Dubai', types: ['locality', 'political'] } }));
        expect(d.center).toEqual({ lat: DUBAI.lat, lng: DUBAI.lng });
        expect(d.source).toBe('named');
        expect(d.city).toBe('Dubai');
        expect(d.remember).toMatchObject({ name: 'Dubai', latitude: DUBAI.lat, longitude: DUBAI.lng });
    });

    test('remember carries singleTown — one named town true, multi-town false (refill cap)', async () => {
        const one = await resolveDestination(
            { placeNames: ['dilijan1'], gps: YEREVAN },
            geocoder({ dilijan1: { lat: 40.74, lng: 44.86, name: 'Dilijan', types: ['locality', 'political'] } }));
        expect(one.remember.singleTown).toBe(true);
        const two = await resolveDestination(
            { placeNames: ['dilijan2', 'ijevan2'], gps: YEREVAN },
            geocoder({ dilijan2: { lat: 40.74, lng: 44.86, name: 'Dilijan', types: ['locality', 'political'] } }));
        expect(two.remember.singleTown).toBe(false);
    });

    test('a chosen destination beats GPS — the whole point of choosing one', async () => {
        const d = await resolveDestination({ gps: YEREVAN, sessionDestination: SESSION_PAPHOS }, geocoder({}));
        expect(d.center).toEqual({ lat: 34.77, lng: 32.42 });
        expect(d.source).toBe('session');
        expect(d.city).toBe('Paphos');
        expect(d.remember).toBeNull();
    });

    // Rule changed 2026-09-01 (Arsen): nearby means GPS, but naming a place you
    // are NOT in is a request to go there — "suggest 3 good locations in
    // Dilijan" in nearby mode used to answer from 5 km around Yerevan and call
    // those places Dilijan. A chosen destination still loses to nearby; only a
    // place named in THIS message switches the turn to discovery.
    test('nearby mode ignores a chosen destination — that is still GPS', async () => {
        const d = await resolveDestination(
            { placeNames: [], gps: YEREVAN, sessionDestination: SESSION_PAPHOS, nearbyMode: true },
            geocoder({}));
        expect(d.center).toEqual(YEREVAN);
        expect(d.source).toBe('nearby');
    });

    test('nearby mode switches to discovery for a town named in the message', async () => {
        const d = await resolveDestination(
            { placeNames: ['dubai2'], gps: YEREVAN, sessionDestination: SESSION_PAPHOS, nearbyMode: true },
            geocoder({ dubai2: { ...DUBAI, types: ['locality'] } }));
        expect(d.source).toBe('named');
        expect(d.switchedFromNearby).toBe(true);
    });

    test('a VENUE name never re-centres — the Paphos harbour hijack', async () => {
        const d = await resolveDestination(
            { placeNames: ['The Harbour'], gps: YEREVAN, sessionDestination: SESSION_PAPHOS },
            geocoder({ 'The Harbour': { lat: 40.2, lng: 44.5, name: 'Harbour Cafe', types: ['restaurant', 'food'] } }));
        expect(d.source).toBe('session');
        expect(d.center).toEqual({ lat: 34.77, lng: 32.42 });
    });

    test('falls through to the next name when the first is a venue', async () => {
        const d = await resolveDestination(
            { placeNames: ['Some Cafe', 'Batumi'], gps: YEREVAN },
            geocoder({ 'Some Cafe': { lat: 40.2, lng: 44.5, types: ['cafe'] },
                Batumi: { lat: 41.64, lng: 41.64, name: 'Batumi', types: ['locality'] } }));
        expect(d.source).toBe('named');
        expect(d.city).toBe('Batumi');
    });

    test('GPS when nothing else is set; none when there is no GPS either', async () => {
        expect((await resolveDestination({ gps: YEREVAN }, geocoder({}))).source).toBe('gps');
        const empty = await resolveDestination({}, geocoder({}));
        expect(empty.center).toBeNull();
        expect(empty.source).toBe('none');
    });

    test('a geocode failure keeps the previous centre instead of losing the turn', async () => {
        const d = await resolveDestination(
            { placeNames: ['Nowhere'], gps: YEREVAN, sessionDestination: SESSION_PAPHOS },
            { findPlaces: async () => { throw new Error('quota'); } });
        expect(d.source).toBe('session');
    });

    test('an unresolvable name is skipped, not fatal', async () => {
        const d = await resolveDestination({ placeNames: ['Atlantis3'], gps: YEREVAN }, geocoder({}));
        expect(d.source).toBe('gps');
    });

    test('the same city twice costs one geocode call', async () => {
        let calls = 0;
        const counting = { findPlaces: async (q) => { calls++; return [{ name: 'Lisbon', geometry: { location: { lat: 38.7, lng: -9.1 } }, types: ['locality'] }]; } };
        await resolveDestination({ placeNames: ['lisbon'], gps: YEREVAN }, counting);
        await resolveDestination({ placeNames: ['lisbon'], gps: YEREVAN }, counting);
        expect(calls).toBe(1);
    });

    test('isGeographic: legacy results with no types still re-centre', () => {
        expect(isGeographic({ types: [] })).toBe(true);
        expect(isGeographic({ types: ['LOCALITY'] })).toBe(true);
        expect(isGeographic({ types: ['restaurant'] })).toBe(false);
        expect(isGeographic(null)).toBe(false);
    });
});

// ── A NAMED PLACE ALWAYS WINS (Arsen's rule, 2026-09-01) ────────────────────
// "asking something in dilijan should work correctly, asking in moscow should
// work correctly, asking in yerevan also can consider yerevan without taking
// my coordinates." The old 'here' branch kept the traveler's GPS whenever they
// named the place they were in — a workaround for the country-CENTROID bug
// (2026-08-24, cards reading "46 km away"), which the gazetteer fixed at the
// source. Naming a place now centres on that place, wherever you are standing.
describe('resolveDestination: a named place always wins', () => {
    const geo = (rows) => ({
        gazetteer: null,                      // force the Google path in these cases
        findPlaces: async (q) => {
            const hit = rows[q];
            return hit ? [{ name: hit.name, geometry: { location: { lat: hit.lat, lng: hit.lng } }, types: hit.types }] : [];
        },
    });
    const HERE = { city: 'Yerevan', country: 'Armenia' };

    test('naming the CITY you are in centres on the city, not on your GPS', async () => {
        const d = await resolveDestination(
            { placeNames: ['Yerevan'], gps: YEREVAN, currentRegion: HERE },
            geo({ Yerevan: { name: 'Yerevan', lat: 40.1772, lng: 44.5035, types: ['locality'] } }));
        expect(d.source).toBe('named');
        expect(d.center).toEqual({ lat: 40.1772, lng: 44.5035 });
        expect(d.scale).toBe('town');
        // Still moves the conversation there — the Dubai bug stays fixed.
        expect(d.remember).toMatchObject({ name: 'Yerevan' });
    });

    test('naming the COUNTRY you are in is a country-scale ask, not a local one', async () => {
        const d = await resolveDestination(
            { placeNames: ['Armenia'], gps: YEREVAN, currentRegion: HERE },
            geo({ Armenia: { name: 'Armenia', lat: 40.1772, lng: 44.5035, types: ['country'] } }));
        expect(d.source).toBe('named');
        expect(d.scale).toBe('country');
        // A country must never be treated as one named town.
        expect(d.remember.singleTown).toBe(false);
    });

    test('a far city works the same way — Moscow from Yerevan', async () => {
        const d = await resolveDestination(
            { placeNames: ['Moscow'], gps: YEREVAN, currentRegion: HERE },
            geo({ Moscow: { name: 'Moscow', lat: 55.75, lng: 37.61, types: ['locality'] } }));
        expect(d.center).toEqual({ lat: 55.75, lng: 37.61 });
        expect(d.remember.singleTown).toBe(true);
    });

    test('a DIFFERENT country re-centres, as it always did', async () => {
        const d = await resolveDestination(
            { placeNames: ['Georgia'], gps: YEREVAN, currentRegion: HERE },
            geo({ Georgia: { name: 'Georgia', lat: 42.31, lng: 43.35, types: ['country'] } }));
        expect(d.source).toBe('named');
        expect(d.center).toEqual({ lat: 42.31, lng: 43.35 });
    });

    test('naming NOTHING falls back to the destination, then to GPS', async () => {
        const none = { gazetteer: null, findPlaces: async () => [] };
        const withDest = await resolveDestination(
            { placeNames: [], gps: YEREVAN, sessionDestination: SESSION_PAPHOS }, none);
        expect(withDest.source).toBe('session');
        const withGps = await resolveDestination({ placeNames: [], gps: YEREVAN }, none);
        expect(withGps.source).toBe('gps');
        expect(withGps.center).toEqual(YEREVAN);
    });
});

// Arsen 2026-08-24: "destination is set dubai, it always starts from armenia,
// and always same scenario". A destination chosen in Settings was invisible to
// the engine, so it only took effect once the traveler typed the city out loud.
describe('the destination saved in Settings', () => {
    const { resolveDestination, _savedCentre } = require('../engine/context/destination');
    const YEREVAN = { lat: 40.1814, lng: 44.5102 };
    const DUBAI = { country: 'AE', countryName: 'United Arab Emirates', city: 'Dubai',
        coordinates: { lat: 25.205, lng: 55.271 } };

    test('beats GPS — that is the point of choosing one', async () => {
        const d = await resolveDestination({ gps: YEREVAN, savedDestination: DUBAI });
        expect(d.source).toBe('saved');
        expect(d.city).toBe('Dubai');
        expect(d.center.lat).toBeCloseTo(25.205, 2);
    });

    test('a city named in the message still wins over it', async () => {
        const findPlaces = async () => ([{
            name: 'Tbilisi', place_id: 'p1', primaryType: 'locality',
            geometry: { location: { lat: 41.7, lng: 44.8 } },
        }]);
        const d = await resolveDestination(
            { placeNames: ['Tbilisi'], gps: YEREVAN, savedDestination: DUBAI }, { findPlaces });
        expect(d.source).toBe('named');
        expect(d.city).toBe('Tbilisi');
    });

    test('the conversation\'s own destination still wins over it', async () => {
        const d = await resolveDestination({
            gps: YEREVAN, savedDestination: DUBAI,
            sessionDestination: { name: 'Paphos', latitude: 34.77, longitude: 32.42 },
        });
        expect(d.source).toBe('session');
        expect(d.city).toBe('Paphos');
    });

    test('"near me" still means GPS', async () => {
        const d = await resolveDestination({ gps: YEREVAN, savedDestination: DUBAI, nearbyMode: true });
        expect(d.source).toBe('nearby');
        expect(d.center.lat).toBeCloseTo(40.1814, 3);
    });

    test('an unset destination is not the Gulf of Guinea', () => {
        expect(_savedCentre({ city: '', coordinates: { lat: 0, lng: 0 } })).toBeNull();
        expect(_savedCentre(null)).toBeNull();
        expect(_savedCentre({ coordinates: { lat: null, lng: null } })).toBeNull();
    });

    test('an unset destination falls through to GPS', async () => {
        const d = await resolveDestination({
            gps: YEREVAN,
            savedDestination: { city: '', countryName: '', coordinates: { lat: 0, lng: 0 } },
        });
        expect(d.source).toBe('gps');
    });
});
