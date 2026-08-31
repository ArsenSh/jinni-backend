// OSRM adapter (2026-08-31, founder: "by app instead of google or other
// service paying") — the pure translation layer that lets the ONE routing
// proxy serve self-hosted OSRM answers in the exact ORS shape the maps
// already speak. ORS stays the automatic fallback; these tests pin the
// translation so a frontend never sees the difference.

const {
    osrmBaseFor, buildOsrmRouteUrl, orsTypeFromOsrmManeuver,
    instructionFromOsrmStep, nearestVertexIndex, normalizeOsrmRoute,
} = require('../engine/travel/osrm');

describe('osrmBaseFor (env-gated, per profile)', () => {
    const env = { OSRM_CAR_URL: 'http://osrm-car:5000', OSRM_FOOT_URL: 'http://osrm-foot:5000' };
    test('maps ORS profile names to their container URLs', () => {
        expect(osrmBaseFor('driving-car', env)).toBe('http://osrm-car:5000');
        expect(osrmBaseFor('foot-walking', env)).toBe('http://osrm-foot:5000');
    });
    test('unconfigured or unsupported profiles stay on ORS (null)', () => {
        expect(osrmBaseFor('cycling-regular', env)).toBe(null);   // no OSRM_BIKE_URL set
        expect(osrmBaseFor('wheelchair', env)).toBe(null);        // OSRM has no wheelchair profile
        expect(osrmBaseFor('driving-car', {})).toBe(null);
    });
});

describe('buildOsrmRouteUrl', () => {
    test('lng,lat order, geojson geometry, optional steps', () => {
        const url = buildOsrmRouteUrl('http://osrm-car:5000/', [
            { lat: 40.74, lng: 44.86 }, { lat: 40.75, lng: 44.87 },
        ], { steps: true });
        expect(url).toBe('http://osrm-car:5000/route/v1/driving/44.86,40.74;44.87,40.75?overview=full&geometries=geojson&steps=true');
    });
});

describe('maneuver translation (OSRM → ORS icon codes)', () => {
    test.each([
        [{ type: 'depart' }, 11],
        [{ type: 'arrive' }, 10],
        [{ type: 'roundabout' }, 7],
        [{ type: 'turn', modifier: 'left' }, 0],
        [{ type: 'turn', modifier: 'sharp right' }, 3],
        [{ type: 'turn', modifier: 'uturn' }, 9],
        [{ type: 'fork', modifier: 'slight left' }, 12],
        [{ type: 'new name', modifier: 'straight' }, 6],
        [{}, 6],                                        // unknown → straight, never crash
    ])('%j → %i', (m, code) => {
        expect(orsTypeFromOsrmManeuver(m)).toBe(code);
    });
    test('instructions read naturally and carry the street name', () => {
        expect(instructionFromOsrmStep({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Myasnikyan St' }))
            .toBe('Turn left onto Myasnikyan St');
        expect(instructionFromOsrmStep({ maneuver: { type: 'arrive' } })).toBe('You have arrived');
        expect(instructionFromOsrmStep({ maneuver: { type: 'turn', modifier: 'right' }, name: '-' }))
            .toBe('Turn right');                        // OSRM's "-" placeholder never leaks
    });
});

describe('normalizeOsrmRoute', () => {
    const COORDS = [[44.86, 40.74], [44.865, 40.742], [44.87, 40.75]];
    const OSRM_JSON = {
        code: 'Ok',
        routes: [{
            geometry: { type: 'LineString', coordinates: COORDS },
            distance: 1234.5, duration: 300.2,
            legs: [{
                steps: [
                    { maneuver: { type: 'depart', location: [44.86, 40.74] }, name: 'Sharambeyan St', distance: 600, duration: 150 },
                    { maneuver: { type: 'turn', modifier: 'right', location: [44.865, 40.742] }, name: 'Kamarini', distance: 634.5, duration: 150.2 },
                    { maneuver: { type: 'arrive', location: [44.87, 40.75] }, name: '', distance: 0, duration: 0 },
                ],
            }],
        }],
    };
    test('overview only: geometry + totals, empty steps', () => {
        const out = normalizeOsrmRoute(OSRM_JSON);
        expect(out.geometry.coordinates).toEqual(COORDS);
        expect(out.distance).toBe(1234.5);
        expect(out.duration).toBe(300.2);
        expect(out.steps).toEqual([]);
    });
    test('withSteps: ORS-shaped steps with way_points located on the line', () => {
        const out = normalizeOsrmRoute(OSRM_JSON, { withSteps: true });
        expect(out.steps).toHaveLength(3);
        expect(out.steps[0]).toMatchObject({ type: 11, name: 'Sharambeyan St', way_points: [0, 0] });
        expect(out.steps[1]).toMatchObject({ type: 1, instruction: 'Turn right onto Kamarini', way_points: [1, 1] });
        expect(out.steps[2]).toMatchObject({ type: 10, way_points: [2, 2] });
    });
    test('unroutable / malformed → null (the proxy falls through to ORS)', () => {
        expect(normalizeOsrmRoute({ code: 'NoRoute' })).toBe(null);
        expect(normalizeOsrmRoute(null)).toBe(null);
        expect(normalizeOsrmRoute({ code: 'Ok', routes: [{}] })).toBe(null);
    });
});

describe('nearestVertexIndex', () => {
    test('locates the closest overview vertex to a maneuver location', () => {
        const coords = [[44.0, 40.0], [44.1, 40.1], [44.2, 40.2]];
        expect(nearestVertexIndex(coords, [44.11, 40.09])).toBe(1);
        expect(nearestVertexIndex(coords, [43.0, 39.0])).toBe(0);
        expect(nearestVertexIndex([], [44, 40])).toBe(0);
    });
});
