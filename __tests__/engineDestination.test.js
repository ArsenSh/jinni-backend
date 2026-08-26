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

    test('a chosen destination beats GPS — the whole point of choosing one', async () => {
        const d = await resolveDestination({ gps: YEREVAN, sessionDestination: SESSION_PAPHOS }, geocoder({}));
        expect(d.center).toEqual({ lat: 34.77, lng: 32.42 });
        expect(d.source).toBe('session');
        expect(d.city).toBe('Paphos');
        expect(d.remember).toBeNull();
    });

    test('nearby mode always means GPS, whatever is chosen or named', async () => {
        const d = await resolveDestination(
            { placeNames: ['dubai2'], gps: YEREVAN, sessionDestination: SESSION_PAPHOS, nearbyMode: true },
            geocoder({ dubai2: { ...DUBAI, types: ['locality'] } }));
        expect(d.center).toEqual(YEREVAN);
        expect(d.source).toBe('nearby');
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

// ── Naming where you already are is not a move (Arsen 2026-08-24) ────────────
// "ok, find in armenia, but other events" from Yerevan re-centred on the
// country's centroid in Ararat Province, and every card then read "46 km away"
// from a traveler who could have walked to them.
describe('resolveDestination: "here"', () => {
    const geo = (rows) => ({
        findPlaces: async (q) => {
            const hit = rows[q];
            return hit ? [{ name: hit.name, geometry: { location: { lat: hit.lat, lng: hit.lng } }, types: hit.types }] : [];
        },
    });
    const HERE = { city: 'Yerevan', country: 'Armenia' };

    test('naming the country you are in keeps the street you are on', async () => {
        const d = await resolveDestination(
            { placeNames: ['Armenia'], gps: YEREVAN, currentRegion: HERE },
            geo({ Armenia: { name: 'Armenia', lat: 40.069, lng: 45.038, types: ['country'] } }));
        expect(d.center).toEqual(YEREVAN);          // not the centroid
        expect(d.source).toBe('here');
        // It DOES remember — this expectation used to be toBeNull(), and that
        // was the bug: "find events in yerevan armenia" answered about Yerevan,
        // then "another ones" fell back to the saved Dubai and said "every
        // upcoming event I have in Dubai" (live 2026-08-24). Naming where you
        // already are still moves the conversation there. What is stored is the
        // CURRENT position, never the country centroid.
        expect(d.remember).toMatchObject({ name: 'Yerevan', latitude: YEREVAN.lat, longitude: YEREVAN.lng });
    });

    test('naming the city you are in also keeps precise coordinates', async () => {
        const d = await resolveDestination(
            { placeNames: ['Yerevan'], gps: YEREVAN, currentRegion: HERE },
            geo({ Yerevan: { name: 'Yerevan', lat: 40.1772, lng: 44.5035, types: ['locality'] } }));
        expect(d.center).toEqual(YEREVAN);
        expect(d.source).toBe('here');
    });

    test('spelling and accents do not defeat it', async () => {
        const d = await resolveDestination(
            { placeNames: ['tbilisi'], gps: { lat: 41.7, lng: 44.8 }, currentRegion: { city: "T'bilisi", country: 'Georgia' } },
            geo({ tbilisi: { name: 'Tbilisi', lat: 41.69, lng: 44.80, types: ['locality'] } }));
        expect(d.source).toBe('here');
    });

    test('a DIFFERENT country still re-centres — that is a real move', async () => {
        const d = await resolveDestination(
            { placeNames: ['Georgia'], gps: YEREVAN, currentRegion: HERE },
            geo({ Georgia: { name: 'Georgia', lat: 42.31, lng: 43.35, types: ['country'] } }));
        expect(d.source).toBe('named');
        expect(d.center).toEqual({ lat: 42.31, lng: 43.35 });
    });

    test('with no idea where we are, the old behaviour stands', async () => {
        const d = await resolveDestination(
            { placeNames: ['Armenia'], gps: YEREVAN },
            geo({ Armenia: { name: 'Armenia', lat: 40.069, lng: 45.038, types: ['country'] } }));
        expect(d.source).toBe('named');
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
