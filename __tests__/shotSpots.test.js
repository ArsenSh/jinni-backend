// Locks the Shot Spots validation core: sensor honesty (null stays null,
// never fabricated) and photo payload safety limits.
const { __testables } = require('../routes/shotSpotRoutes');
const { decodePhoto, shapeFields, haversineM } = __testables;

describe('decodePhoto', () => {
    const px = Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64');
    test('accepts a jpeg data URL', () => {
        const r = decodePhoto(`data:image/jpeg;base64,${px}`);
        expect(r.error).toBeUndefined();
        expect(r.contentType).toBe('image/jpeg');
        expect(r.buf.length).toBe(4);
    });
    test('rejects non-image and malformed payloads', () => {
        expect(decodePhoto(`data:text/html;base64,${px}`).error).toBeTruthy();
        expect(decodePhoto('not a data url').error).toBeTruthy();
        expect(decodePhoto(null).error).toBeTruthy();
        expect(decodePhoto('data:image/jpeg;base64,').error).toBeTruthy();
    });
    test('rejects photos over the 8MB decoded cap', () => {
        const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
        expect(decodePhoto(`data:image/jpeg;base64,${big}`).error).toMatch(/too large/);
    });
});

describe('shapeFields', () => {
    test('missing sensors stay null — never invented', () => {
        const f = shapeFields({ camera: { lat: 40.1, lng: 44.5 } });
        expect(f.camera).toEqual({ lat: 40.1, lng: 44.5, accuracyMeters: null, heading: null, pitch: null, orientation: 'portrait' });
    });
    test('out-of-range values become null, not clamped lies', () => {
        const f = shapeFields({ camera: { lat: 40.1, lng: 44.5, heading: 400, pitch: -200, accuracyMeters: 12 } });
        expect(f.camera.heading).toBeNull();
        expect(f.camera.pitch).toBeNull();
        expect(f.camera.accuracyMeters).toBe(12);
    });
    test('only whitelisted fields pass; status restricted to draft/active', () => {
        const f = shapeFields({ title: 'x', evil: 'y', status: 'admin', photo: { data: 'z' } });
        expect(f).toEqual({ title: 'x' });
        expect(shapeFields({ status: 'active' })).toEqual({ status: 'active' });
    });
    test('bad bestTime falls back to any; strings are trimmed and capped', () => {
        const f = shapeFields({ shooting: { bestTime: 'noon-ish', notes: '  hi  ' }, title: 'a'.repeat(200) });
        expect(f.shooting.bestTime).toBe('any');
        expect(f.shooting.notes).toBe('hi');
        expect(f.title.length).toBe(120);
    });
});

describe('haversineM (recreation presence gate)', () => {
    const cascade = { lat: 40.19206, lng: 44.51573 };
    test('same point is 0, nearby is meters not degrees', () => {
        expect(haversineM(cascade, cascade)).toBe(0);
        const d = haversineM(cascade, { lat: 40.19296, lng: 44.51573 }); // ~100m north
        expect(d).toBeGreaterThan(95); expect(d).toBeLessThan(105);
    });
    test('across town is far beyond the 200m gate', () => {
        expect(haversineM(cascade, { lat: 40.1776, lng: 44.5126 })).toBeGreaterThan(1000);
    });
});
