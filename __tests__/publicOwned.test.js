const { ownedRow, cardOf } = require('../routes/publicRoutes')._test;

const base = (over = {}) => ({ _id: '6512a0c0c0c0c0c0c0c0c0c0', name: 'Paragliding', type: ['activities', 'adventure'], images: ['https://img/x.jpg'],
    location: { coordinates: { lat: 40.18, lng: 44.51 }, address: 'Yerevan' }, ...over });
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

describe('public discovery: curated rows and events (2026-10-09)', () => {
    test('a curated place becomes a card with its own photo and interests', () => {
        const r = ownedRow(base(), 'destination');
        expect(r.actions).toEqual(['activities']);
        const c = cardOf(r, 2.3);
        expect(c).toMatchObject({ placeId: 'dest_6512a0c0c0c0c0c0c0c0c0c0', source: 'destination', image: 'https://img/x.jpg', interests: ['adventure'], verified: true });
        expect(c.eventDates).toBeUndefined();
    });
    test('an upcoming event gets the Events section and its dates', () => {
        const r = ownedRow(base({ name: 'Tango night', type: ['events'], eventSchedule: { startDate: day(2), endDate: day(2) } }), 'destination');
        expect(r.actions).toEqual(['events']);
        expect(cardOf(r, 1).eventDates.start).toBe(day(2).slice(0, 0) + r._owned.eventDates.start);
    });
    test('an ENDED one-off event is dropped, even when it also carries a place tag', () => {
        expect(ownedRow(base({ type: ['events'], eventSchedule: { startDate: day(-5), endDate: day(-4) } }), 'destination')).toBeNull();
        expect(ownedRow(base({ type: ['events', 'activities'], eventSchedule: { startDate: day(-5) } }), 'destination')).toBeNull();
    });
    test('a recurring event always shows; an events tag without any schedule is not treated as a dated event', () => {
        expect(ownedRow(base({ type: ['events'], eventSchedule: { isRecurring: true } }), 'destination').actions).toEqual(['events']);
        expect(ownedRow(base({ type: ['events'] }), 'destination')).toBeNull();
        expect(ownedRow(base({ type: ['events', 'activities'] }), 'destination').actions).toEqual(['activities']);
    });
});
