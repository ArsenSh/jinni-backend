// Live, bookable Nuitee fares ride beside the Aviasales feed in find_flights
// (founder 2026-09-30, after Nuitee enabled flights on the account). The two
// sources are never blended: a live fare is a price Jinni can sell at, a feed
// fare is one other travelers were shown.
const { makeExecutors } = require('../engine/narrator/tools');
const { liteBookUrl } = require('../engine/travel/flightsLite');

const TPL = 'https://stay.jinni.travel/flights?from={origin}&to={destination}&date={date}&ret={return}&adults={adults}';
const JOURNEY = (over = {}) => ({
    source: 'liteapi', offerId: 'of1', price: 212.4, currency: 'USD', airline: 'Air Arabia', flightNumber: 'G9 262',
    departureAt: '2026-10-15T04:10:00', arrivalAt: '2026-10-15T06:40:00', transfers: 0, durationMin: 210,
    seatsRemaining: 4, refundable: false, segments: [{ from: 'EVN', to: 'SHJ' }], ...over,
});
const stubLite = (journeys, { enabled = true, env = { LITE_FLIGHTS_BOOK_URL: TPL } } = {}) => ({
    calls: [],
    liteFlightsEnabled: () => enabled,
    async searchLiteFlights(a) { this.calls.push(a); return { ok: true, journeys, cheapest: journeys[0] || null }; },
    liteBookUrl: (a) => liteBookUrl(a, env),
});
const FEED = async () => ({
    origin: 'EVN', destination: 'SHJ', currency: 'USD', window: { from: '2026-10-15', to: '2026-10-15' },
    offers: [{ price: 150, airline: 'G9', airlineName: 'Air Arabia', departureAt: '2026-10-15T04:10:00+04:00', transfers: 0, bookUrl: 'https://www.aviasales.com/x' }],
    nearest: [],
});
const base = (lite, over = {}) => makeExecutors({}, {
    liteFlights: lite, resolveIata: async (t) => ({ yerevan: 'EVN', sharjah: 'SHJ', dubai: 'DXB' }[String(t).toLowerCase()] || null),
    searchFlightsWindow: FEED, searchFlights: FEED, shortenBookUrl: async (u) => u, today: () => '2026-10-01', ...over,
});

describe('liteBookUrl', () => {
    test('fills the template and encodes every value', () => {
        expect(liteBookUrl({ origin: 'EVN', destination: 'SHJ', date: '2026-10-15', adults: 2 }, { LITE_FLIGHTS_BOOK_URL: TPL }))
            .toBe('https://stay.jinni.travel/flights?from=EVN&to=SHJ&date=2026-10-15&ret=&adults=2');
    });
    test('no template, or a non-https one, means no link — never a guessed URL', () => {
        expect(liteBookUrl({ origin: 'EVN', destination: 'SHJ', date: '2026-10-15' }, {})).toBeNull();
        expect(liteBookUrl({ origin: 'EVN', destination: 'SHJ', date: '2026-10-15' }, { LITE_FLIGHTS_BOOK_URL: 'http://x/{origin}' })).toBeNull();
    });
});

describe('find_flights with live Nuitee fares', () => {
    test('a dated ask carries the feed fares AND a separate live list with a Book link', async () => {
        const lite = stubLite([JOURNEY()]);
        const out = await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.offers).toHaveLength(1);
        expect(out.offers[0].price).toBe(150);                       // the feed price is untouched
        expect(out.live).toHaveLength(1);
        expect(out.live[0]).toMatchObject({ live: true, price: 212.4, source: 'nuitee' });
        expect(out.live[0].bookUrl).toBe('https://stay.jinni.travel/flights?from=EVN&to=SHJ&date=2026-10-15&ret=&adults=1');
        expect(out.live[0].label).toContain('212.4 USD');
        expect(out.note).toMatch(/Never merge a live price with a feed price/);
        expect(lite.calls[0].legs).toEqual([{ origin: 'EVN', destination: 'SHJ', date: '2026-10-15' }]);
    });

    test('a round trip is two legs and its price says it covers both flights', async () => {
        const lite = stubLite([JOURNEY()]);
        const out = await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15', return_date: '2026-10-22' });
        expect(lite.calls[0].legs).toHaveLength(2);
        expect(lite.calls[0].legs[1]).toEqual({ origin: 'SHJ', destination: 'EVN', date: '2026-10-22' });
        expect(out.live[0].label).toContain('round trip');
        expect(out.note).toMatch(/covers BOTH flights/);
    });

    test('a live connection names its connecting airport (the feed cannot)', async () => {
        const lite = stubLite([JOURNEY({ transfers: 1, segments: [{ from: 'EVN', to: 'DXB' }, { from: 'DXB', to: 'SHJ' }] })]);
        const out = await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.live[0].connectingAirports).toEqual(['DXB']);
        expect(out.live[0].label).toContain('1 stop via DXB');
    });

    test('live fares still answer when the feed has none', async () => {
        const empty = async () => ({ origin: 'EVN', destination: 'SHJ', currency: 'USD', offers: [], nearest: [] });
        const out = await base(stubLite([JOURNEY()]), { searchFlightsWindow: empty, searchFlights: empty })
            .find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.offers).toEqual([]);
        expect(out.live).toHaveLength(1);
    });

    test('without a book template the live fare shows its price and no link', async () => {
        const out = await base(stubLite([JOURNEY()], { env: {} })).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.live[0].bookUrl).toBeNull();
        expect(out.note).toMatch(/no booking link yet/);
    });

    test('switched off, nothing live is searched', async () => {
        const off = stubLite([JOURNEY()], { enabled: false });
        const a = await base(off).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(a.live).toBeUndefined();
        expect(off.calls).toHaveLength(0);
    });

    test('a failing live search never breaks the feed answer', async () => {
        const broken = { liteFlightsEnabled: () => true, async searchLiteFlights() { throw new Error('boom'); }, liteBookUrl: () => null };
        const out = await base(broken).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.offers).toHaveLength(1);
        expect(out.live).toBeUndefined();
    });
});

// Every way a traveler asks (founder 2026-10-01: "today, a specific day, next
// week, … even how much it costs to visit some country — then the return flight
// price too, approximately").
describe('find_flights — which days are searched live', () => {
    const days = (lite) => lite.calls.map(c => c.legs.map(l => l.date).join('+'));

    test('today is searched as today', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-01' });
        expect(days(lite)).toEqual(['2026-10-01']);
    });

    test('a past day is never searched live', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-09-20' });
        expect(lite.calls).toHaveLength(0);
    });

    test('a short range (this weekend) searches every day in it', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_from: '2026-10-03', depart_to: '2026-10-04' });
        expect(days(lite).sort()).toEqual(['2026-10-03', '2026-10-04']);
    });

    test('next week searches its first, middle and last day', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_from: '2026-10-05', depart_to: '2026-10-11' });
        expect(days(lite).sort()).toEqual(['2026-10-05', '2026-10-08', '2026-10-11']);
    });

    test('this month starts from today, never from a day already gone', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite, { today: () => '2026-10-20' }).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10' });
        expect(days(lite).sort()).toEqual(['2026-10-20', '2026-10-26', '2026-10-31']);
    });

    test('a range of live fares is shown at most two per day, in date order', async () => {
        const lite = stubLite([JOURNEY({ price: 300 }), JOURNEY({ price: 200 }), JOURNEY({ price: 250 })]);
        const out = await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_from: '2026-10-05', depart_to: '2026-10-11' });
        expect(out.live.length).toBeLessThanOrEqual(6);
    });

    test('no dates at all = an approximate ROUND TRIP: live sample 3 weeks out for 7 nights + the feed round trips', async () => {
        const lite = stubLite([JOURNEY()]);
        const rounds = [];
        const searchFlights = async (a) => { if (a.roundTrip) { rounds.push(a); return { currency: 'USD', offers: [{ price: 380, airlineName: 'flydubai', departureAt: '2026-10-20T15:15:00+04:00', returnAt: '2026-10-27T07:30:00+04:00', transfers: 0, bookUrl: 'https://www.aviasales.com/r' }] }; } return FEED(); };
        const out = await base(lite, { searchFlights }).find_flights({ origin: 'Yerevan', destination: 'Dubai' });
        expect(lite.calls[0].legs.map(l => l.date)).toEqual(['2026-10-22', '2026-10-29']);
        expect(rounds).toHaveLength(1);
        expect(out.roundTrips[0].label).toContain('380 USD round trip');
        expect(out.roundTrips[0].label).toContain('back 2026-10-27');
        expect(out.note).toMatch(/APPROXIMATE/);
        expect(out.note).toMatch(/2026-10-22 for 7 nights/);
        expect(out.note).toMatch(/never invent hotel/);
    });

    test('"for a week in Japan" style asks pass nights; one_way keeps it one way', async () => {
        const lite = stubLite([JOURNEY()]);
        await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', nights: 10 });
        expect(lite.calls[0].legs.map(l => l.date)).toEqual(['2026-10-22', '2026-11-01']);
        const ow = stubLite([JOURNEY()]);
        const out = await base(ow).find_flights({ origin: 'Yerevan', destination: 'Sharjah', one_way: true });
        expect(ow.calls[0].legs).toHaveLength(1);
        expect(out.roundTrips).toBeUndefined();
    });

    test('a live fare without a price or airline is dropped, never narrated', async () => {
        const lite = stubLite([JOURNEY({ price: null }), JOURNEY({ airline: null }), JOURNEY({ price: 99 })]);
        const out = await base(lite).find_flights({ origin: 'Yerevan', destination: 'Sharjah', depart_date: '2026-10-15' });
        expect(out.live).toHaveLength(1);
        expect(out.live[0].price).toBe(99);
    });
});
