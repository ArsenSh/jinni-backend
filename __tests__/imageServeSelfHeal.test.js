// Polish batch 2026-08-31, item (b): a PlaceCache row whose photos ALL carry
// null imageData (live 2026-08-30: Heritage of Alluria) made serveImage throw
// "no photo has bytes" on every request, forever. The serve path now heals in
// two stages: (1) re-fetch once from the stored Google reference; (2) when no
// usable reference survives at all (the ChIJf7kh… case, live 2026-08-31), ONE
// Place Details re-resolve fetches fresh photo names and the standard store
// path writes real bytes — bounded to one attempt per place per process.
// Hidden places keep the purge rule: never re-fetched, never re-stored.

jest.mock('axios');
jest.mock('../models/PlaceCache', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(() => Promise.resolve({})),
    updateOne: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../services/requestContext', () => ({ get: () => ({}) }), { virtual: true });
jest.mock('../services/googleService', () => ({ getPlaceDetails: jest.fn() }));

const axios = require('axios');
const PlaceCache = require('../models/PlaceCache');
const googleService = require('../services/googleService');
const svc = require('../services/imageStorageService');

const BYTES = Buffer.from('jpegbytes');
const REF = 'places/ChIJtest/photos/AawRef1';

/** findOne mock: $slice projection first, then full docs; select() serves the
 *  hidden-check inside downloadAndStoreImages. */
function primeFindOne(slicedPhoto, fullDoc) {
    PlaceCache.findOne.mockImplementation((q, proj) => ({
        lean: () => Promise.resolve(proj ? { photos: slicedPhoto ? [slicedPhoto] : [] } : fullDoc),
        select: () => ({ lean: () => Promise.resolve({ explore: fullDoc?.explore || {} }) }),
    }));
}

beforeEach(() => {
    jest.clearAllMocks();
    svc._reResolved.clear();
    axios.get.mockResolvedValue({ data: BYTES, headers: { 'content-type': 'image/jpeg' } });
    googleService.getPlaceDetails.mockResolvedValue(null);
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
    expect(googleService.getPlaceDetails).not.toHaveBeenCalled();  // stage 1 was enough
});

test('hidden place is NEVER re-fetched or re-stored — the purge rule holds', async () => {
    const row = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJhidden', photos: [row], explore: { status: 'hidden' } });

    await expect(svc.serveImage('ChIJhidden', 0)).rejects.toThrow();
    expect(axios.get).not.toHaveBeenCalled();
    expect(googleService.getPlaceDetails).not.toHaveBeenCalled();
    expect(PlaceCache.updateOne).not.toHaveBeenCalled();
});

test('no reference anywhere → deep-heal: Place Details gives fresh names, bytes stored and served', async () => {
    const row = { photoReference: null, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJdeep', photos: [row], explore: { status: 'visible' } });
    googleService.getPlaceDetails.mockResolvedValue({ photos: [{ name: 'places/ChIJdeep/photos/Fresh1' }] });

    const out = await svc.serveImage('ChIJdeep', 0);
    expect(Buffer.isBuffer(out.data)).toBe(true);
    expect(googleService.getPlaceDetails).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain('Fresh1');          // downloaded the fresh ref
    expect(PlaceCache.findOneAndUpdate).toHaveBeenCalled();          // standard store path wrote it
});

test('deep-heal is attempted ONCE per place — no spend loop when Google has no photos', async () => {
    const row = { photoReference: null, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJnone', photos: [row], explore: { status: 'visible' } });
    googleService.getPlaceDetails.mockResolvedValue({ photos: [] });

    await expect(svc.serveImage('ChIJnone', 0)).rejects.toThrow('Invalid image data format');
    await expect(svc.serveImage('ChIJnone', 0)).rejects.toThrow('Invalid image data format');
    expect(googleService.getPlaceDetails).toHaveBeenCalledTimes(1);  // second request skips it
});

test('stale reference: re-fetch fails, deep-heal takes over', async () => {
    const row = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJstale', photos: [row], explore: { status: 'visible' } });
    axios.get
        .mockRejectedValueOnce(new Error('403 from Google'))          // the stale stored ref
        .mockResolvedValue({ data: BYTES, headers: { 'content-type': 'image/jpeg' } });
    googleService.getPlaceDetails.mockResolvedValue({ photos: [{ name: 'places/ChIJstale/photos/Fresh2' }] });

    const out = await svc.serveImage('ChIJstale', 0);
    expect(Buffer.isBuffer(out.data)).toBe(true);
    expect(googleService.getPlaceDetails).toHaveBeenCalledTimes(1);
});

test('both stages dry → the original throw is unchanged', async () => {
    const row = { photoReference: null, imageData: null, contentType: 'image/jpeg' };
    primeFindOne(row, { placeId: 'ChIJdry', photos: [row], explore: { status: 'visible' } });
    googleService.getPlaceDetails.mockResolvedValue(null);

    await expect(svc.serveImage('ChIJdry', 0)).rejects.toThrow('Invalid image data format');
    expect(axios.get).not.toHaveBeenCalled();
});

test('a valid photo in another slot still wins WITHOUT any Google call', async () => {
    const bad = { photoReference: REF, imageData: null, contentType: 'image/jpeg' };
    const good = { photoReference: 'places/ChIJok/photos/AawRef2', imageData: BYTES, contentType: 'image/jpeg' };
    primeFindOne(bad, { placeId: 'ChIJok', photos: [bad, good], explore: { status: 'visible' } });

    const out = await svc.serveImage('ChIJok', 0);
    expect(out.fallback).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
    expect(googleService.getPlaceDetails).not.toHaveBeenCalled();
});
