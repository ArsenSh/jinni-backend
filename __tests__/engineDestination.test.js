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
