// Engine events tier (battery fix #1) — owned-data events candidates.
// Fake models, fixed clock — no DB, no network.

const { loadEventCandidates, aiEventToCandidate, EVENT_HORIZON_DAYS } = require('../engine/places/eventStore');
const { toRecommendation } = require('../engine/narrator/cards');
const { placeFactLine } = require('../engine/narrator/prompts/grounded');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);   // Sat Aug 22 2026 12:00 UTC
const CENTER = { lat: 40.18, lng: 44.51 };     // Yerevan

const destModel = (rows) => ({ find: () => ({ lean: () => Promise.resolve(rows) }) });
const aiModel = (rows) => ({ find: (q) => { aiModel.lastQuery = q; return { limit: () => ({ lean: () => Promise.resolve(rows) }) }; } });

const aiEvent = (over = {}) => ({
    name: 'Jazz Night', description: 'Live jazz', placeId: 'gv1',
    lat: 40.19, lng: 44.52, venueName: 'Mezzo Club', address: '28 Isahakyan St',
    city: 'Yerevan', country: 'Armenia', image: 'https://cdn/poster.jpg',
    startDate: new Date(NOW + 2 * DAY), endDate: null, isRecurring: false, status: 'new',
    ...over,
});

const destEvent = (over = {}) => ({
    _id: 'dst1', name: 'Wine Days Festival', description: 'City festival', type: ['events'],
    location: { city: 'Yerevan', country: 'Armenia', address: 'Saryan St', coordinates: { lat: 40.185, lng: 44.505 } },
    images: ['https://cdn/wine.jpg'], rating: 4.8,
    eventSchedule: { startDate: new Date(NOW + 1 * DAY), endDate: new Date(NOW + 3 * DAY), isRecurring: false, timezone: 'Asia/Yerevan' },
    ...over,
});

const deps = (destRows = [], aiRows = []) => ({
    Destination: destModel(destRows), AiFoundEvent: aiModel(aiRows), nowFn: () => NOW,
});

describe('loadEventCandidates', () => {
    test('merges validator destinations + pipeline finds, soonest first', async () => {
        const out = await loadEventCandidates({ center: CENTER }, deps([destEvent()], [aiEvent()]));
        expect(out.map(c => c.name)).toEqual(['Wine Days Festival', 'Jazz Night']);   // +1d before +2d
        expect(out[0].source).toBe('destination');
        expect(out[0].verifiedId).toBe('dst1');
        expect(out[1].source).toBe('event');
        expect(out[1].image).toBe('https://cdn/poster.jpg');                          // poster survives
    });

    test('ended and beyond-horizon destination events are skipped; recurring survives', async () => {
        const out = await loadEventCandidates({ center: CENTER }, deps([
            destEvent({ _id: 'past', eventSchedule: { startDate: new Date(NOW - 5 * DAY), endDate: new Date(NOW - 2 * DAY), isRecurring: false } }),
            destEvent({ _id: 'far', eventSchedule: { startDate: new Date(NOW + (EVENT_HORIZON_DAYS + 5) * DAY), isRecurring: false } }),
            destEvent({ _id: 'rec', name: 'Vernissage Market', eventSchedule: { isRecurring: true } }),
            destEvent({ _id: 'bare', eventSchedule: undefined }),
        ], []));
        expect(out.map(c => c.name)).toEqual(['Vernissage Market']);
    });

    test('pipeline query only serves status new, upcoming-window rows', async () => {
        await loadEventCandidates({ center: CENTER }, deps([], []));
        expect(aiModel.lastQuery.status).toBe('new');                 // hidden/approved never queried
        expect(aiModel.lastQuery.startDate.$lte).toBeInstanceOf(Date);
    });

    test('radius filters coord rows; coordless survive ONLY on an in-radius city match', async () => {
        const out = await loadEventCandidates({ center: CENTER, radiusKm: 10 }, deps([], [
            aiEvent({ name: 'Near', lat: 40.19, lng: 44.52 }),
            aiEvent({ name: 'Gyumri Fest', lat: 40.79, lng: 43.85 }),                    // ~120 km
            aiEvent({ name: 'City-wide', lat: null, lng: null }),                        // city Yerevan → kept
            aiEvent({ name: 'Dubai Comedy', lat: null, lng: null, city: 'Dubai' }),      // the live bug → dropped
        ]));
        expect(out.map(c => c.name)).toEqual(['Near', 'City-wide']);
    });

    test('no in-radius city evidence → coordless rows drop too', async () => {
        const out = await loadEventCandidates({ center: CENTER, radiusKm: 10 }, deps([], [
            aiEvent({ name: 'Orphan City-wide', lat: null, lng: null }),
        ]));
        expect(out).toEqual([]);
    });

    test('no center → no candidates (events need a where)', async () => {
        expect(await loadEventCandidates({ center: null }, deps([destEvent()], [aiEvent()]))).toEqual([]);
    });
});

describe('event cards + facts', () => {
    test('toRecommendation passes eventSchedule through (frontend date row)', () => {
        const rec = toRecommendation(aiEventToCandidate(aiEvent(), CENTER), 0, { action: 'events' });
        expect(rec.eventSchedule.startDate).toEqual(new Date(NOW + 2 * DAY));
        expect(rec.category).toBe('Event');
        expect(rec.image).toBe('https://cdn/poster.jpg');
        const place = toRecommendation({ name: 'Garni', placeId: 'g' }, 0, { action: 'historical' });
        expect(place.eventSchedule).toBeNull();
    });

    test('placeFactLine states the event date, nothing else invented', () => {
        const line = placeFactLine(aiEventToCandidate(aiEvent(), CENTER));
        expect(line).toContain('event on Mon, 24 Aug 2026');
        expect(placeFactLine({ name: 'Garni' })).not.toContain('event on');
    });
});
