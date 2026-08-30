// Polish batch 2026-08-31, item (b): a PlaceCache row whose photos ALL carry
// null imageData (live 2026-08-30: Heritage of Alluria) made serveImage throw
// "no photo has bytes" on every request, forever. The serve path now re-fetches
// once from the stored Google reference and writes the bytes back — except for
// hidden places, whose image purge must never be undone.

jest.mock('axios');
jest.mock('../models/PlaceCache', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../services/requestContext', () => ({ get: () => ({}) }), { virtual: true });

const axios = require('axios');
const PlaceCache = require('../models/PlaceCache');
const svc = require('../services/imageStorageService');

const BYTES = Buffer.from('jpegbytes');
const REF = 'places/ChIJtest/photos/AawRef1';

/** findOne mock: first call = $slice projection, later calls = full doc. */
function primeFindOne(slicedPhoto, fullDoc) {
    PlaceCache.findOne
        .mockReturnValueOnce({ lean: () => Promise.resolve({ photos: slicedPhoto ? [slicedPhoto] : [] }) })
        .mockReturnValue({ lean: () => Promise.resolve(fullDoc) });
}

beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: BYTES, headers: { 'content-type': 'image/jpeg' } });
});

test('all rows byte-less → re-fetches from the stored reference, stores, serves', async () => {
    const row = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJtest', photos: [row], explore: { status: 'visible' } });

    const out = await svc.serveImage('ChIJtest', 0);
    expect(Buffer.isBuffer(out.data)).toBe(true);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.fallback).toBe(false);                    // healed the asked slot itself
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain(REF);   // fetched by the stored ref
    const upd = PlaceCache.updateOne.mock.calls[0];
    expect(upd[0]).toEqual({ placeId: 'ChIJtest', 'photos.photoReference': REF });
    expect(upd[1].$set['photos.$.imageData']).toBeInstanceOf(Buffer);
    expect(upd[1].$set.imagesStored).toBe(true);
});

test('hidden place is NEVER re-fetched or re-stored — the purge rule holds', async () => {
    const row = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJtest', photos: [row], explore: { status: 'hidden' } });

    await expect(svc.serveImage('ChIJtest', 0)).rejects.toThrow();
    expect(axios.get).not.toHaveBeenCalled();
    expect(PlaceCache.updateOne).not.toHaveBeenCalled();
});

test('re-fetch failure degrades to the original error (no crash loop)', async () => {
    axios.get.mockRejectedValue(new Error('403 from Google'));
    const row = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJtest', photos: [row], explore: { status: 'visible' } });

    await expect(svc.serveImage('ChIJtest', 0)).rejects.toThrow('Invalid image data format');
    expect(PlaceCache.updateOne).not.toHaveBeenCalled();
});

test('no reference anywhere → original throw unchanged', async () => {
    const row = { photoReference: null, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJtest', photos: [row], explore: { status: 'visible' } });

    await expect(svc.serveImage('ChIJtest', 0)).rejects.toThrow('Invalid image data format');
    expect(axios.get).not.toHaveBeenCalled();
});

test('a valid photo in another slot still wins WITHOUT any Google fetch', async () => {
    const bad = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    const good = { photoReference: 'places/ChIJtest/photos/AawRef2', imageData: BYTES, contentType: 'image/jpeg' };
    primeFindOne(bad, { placeId: 'ChIJtest', photos: [bad, good], explore: { status: 'visible' } });

    const out = await svc.serveImage('ChIJtest', 0);
    expect(out.fallback).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
});
