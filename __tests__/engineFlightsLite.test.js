// Bookable flights via liteAPI (founder 2026-09-23). Response shapes come from
// their published schema; the key is fake and nothing here touches the network.
// The Travelpayouts module is untouched and still answers today's flight turns
// — this one is dark until LITE_FLIGHTS=true.
const lite = require('../engine/travel/flightsLite');

const ENV = { HOTEL_PRICES_TOKEN: 'sand_x', LITE_FLIGHTS: 'true' };
// Expiries are RELATIVE: an offer's own expiry kills the cache entry, so a
// fixture pinned to a wall-clock time would start failing the moment that
// time passed (it did, an hour after this file was written).
const EXP = new Date(Date.now() + 60 * 60e3).toISOString();        // the later of the two
const EXP_SOON = new Date(Date.now() + 30 * 60e3).toISOString();   // the soonest in the payload

const JOURNEY = {
    journeyKey: 'jk1',
    isCheapest: true,
    cheapestOffer: {
        offerId: 'of1', expiration: EXP,
        pricing: { total: 212.4, currency: 'USD' },
        terms: { refundable: false },
        segmentFares: [{ cabin: 'Economy', seatsRemaining: 3, bookingCode: 'W' }],
    },
    offers: [{ offerId: 'of1', expiration: EXP, pricing: { total: 212.4, currency: 'USD' } }],
    segments: [
        {
            segmentKey: 's1', originCode: 'EVN', destinationCode: 'DXB',
            departureTime: '2026-10-02T05:20:00Z', arrivalTime: '2026-10-02T09:05:00Z',
            carrier: { marketing: { code: 'FZ', name: 'flydubai' } },
            flight: { marketing: 'FZ1804' }, duration: { minutes: 225 }, stopCount: 0,
        },
    ],
    totalDuration: { minutes: 225 },
};
// Two segments = one transfer; the second also has a technical stop, which is
// NOT a transfer (same flight number, no plane change, no bag re-check).
const JOURNEY_2 = {
    journeyKey: 'jk2',
    cheapestOffer: { offerId: 'of2', expiration: EXP_SOON, pricing: { total: 168, currency: 'USD' } },
    segments: [
        { originCode: 'EVN', destinationCode: 'IST', departureTime: '2026-10-02T02:00:00Z', arrivalTime: '2026-10-02T04:00:00Z', carrier: { marketing: { code: 'TK', name: 'Turkish Airlines' } }, flight: { marketing: 'TK379' }, duration: { minutes: 120 }, stopCount: 0 },
        { originCode: 'IST', destinationCode: 'DXB', departureTime: '2026-10-02T07:00:00Z', arrivalTime: '2026-10-02T12:30:00Z', carrier: { marketing: { code: 'TK', name: 'Turkish Airlines' } }, flight: { marketing: 'TK760' }, duration: { minutes: 270 }, stopCount: 1 },
    ],
    totalDuration: { minutes: 630 },
};
const RATES = { data: [{ journeys: [JOURNEY, JOURNEY_2] }] };
const AIRPORTS = { data: [{ airports: [{ iata: 'DXB', icao: 'OMDB', name: 'Dubai International', city: 'Dubai', country: 'United Arab Emirates', lat: 25.25, lon: 55.36, tz: 'Asia/Dubai' }], count: 1 }] };

const fake = (log = [], over = {}) => async (url, init = {}) => {
    log.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (over.status) return { ok: false, status: over.status, json: async () => ({}) };
    if (url.includes('/flights/rates')) return ok(over.rates || RATES);
    if (url.includes('/data/flights/airports')) return ok(AIRPORTS);
    if (url.includes('/flights/verify')) return ok(over.verify || { data: [{ journey: JOURNEY }] });
    return { ok: false, status: 404, json: async () => ({}) };
};

beforeEach(() => lite._memo.clear());

describe('the switch', () => {
    test('dark without the flag, even with the hotel key present', async () => {
        expect(lite.liteFlightsEnabled({ HOTEL_PRICES_TOKEN: 'k' })).toBe(false);
        expect(lite.liteFlightsEnabled({ LITE_FLIGHTS: 'true' })).toBe(false);
        expect(lite.liteFlightsEnabled(ENV)).toBe(true);
        const out = await lite.searchLiteFlights({ legs: [{ origin: 'EVN', destination: 'DXB', date: '2026-10-02' }] }, { env: {}, fetch: fake() });
        expect(out).toMatchObject({ ok: false, reason: 'lite_flights_disabled', journeys: [] });
    });
});

describe('search', () => {
    test('sends a legs-only body and normalizes journeys cheapest first', async () => {
        const log = [];
        const out = await lite.searchLiteFlights({
            legs: [{ origin: 'evn', destination: 'dxb', date: '2026-10-02' }, { origin: 'DXB', destination: 'EVN', date: '2026-10-09', direction: 'INBOUND' }],
            adults: 2, children: 1, childrenAges: [7], cabinClass: 'ECONOMY', currency: 'usd', country: 'am',
        }, { env: ENV, fetch: fake(log) });
        const body = log[0].body;
        expect(log[0].url).toBe('https://api.liteapi.travel/v3.0/flights/rates');
        expect(log[0].init.headers['X-API-Key']).toBe('sand_x');
        expect(body.legs).toEqual([
            { origin: 'EVN', destination: 'DXB', date: '2026-10-02' },
            { origin: 'DXB', destination: 'EVN', date: '2026-10-09', direction: 'INBOUND' },
        ]);
        expect(body.adults).toBe(2);
        expect(body.children).toBe(1);
        expect(body.childrenAges).toEqual([7]);
        expect(body.currency).toBe('USD');
        expect(body.country).toBe('AM');
        // Their API rejects these outright; we must never send them.
        expect(body.origin).toBeUndefined();
        expect(body.departureDate).toBeUndefined();
        expect(body.returnDate).toBeUndefined();
        expect(out.ok).toBe(true);
        expect(out.journeys.map(j => j.price)).toEqual([168, 212.4]);
        expect(out.cheapest.offerId).toBe('of2');
    });
    test('a journey carries what a card needs, and a transfer is not a technical stop', () => {
        const direct = lite.normalizeJourney(JOURNEY);
        expect(direct).toMatchObject({
            source: 'liteapi', offerId: 'of1', price: 212.4, currency: 'USD',
            airline: 'flydubai', airlineCode: 'FZ', flightNumber: 'FZ1804',
            originCode: 'EVN', destinationCode: 'DXB', transfers: 0, technicalStops: 0,
            durationMin: 225, seatsRemaining: 3, cabin: 'Economy', refundable: false, bookable: true,
        });
        expect(direct.expiration).toBe(EXP);
        const oneStop = lite.normalizeJourney(JOURNEY_2);
        expect(oneStop.transfers).toBe(1);          // a change of aircraft
        expect(oneStop.technicalStops).toBe(1);     // same flight number, not a transfer
        expect(oneStop.segments).toHaveLength(2);
        expect(oneStop.destinationCode).toBe('DXB');
    });
    test('bad legs never reach the network; a failed call is a reason, not a throw', async () => {
        const log = [];
        expect(await lite.searchLiteFlights({ legs: [{ origin: 'EVN', destination: 'DXB', date: 'soon' }] }, { env: ENV, fetch: fake(log) }))
            .toMatchObject({ ok: false, reason: 'no_valid_legs' });
        expect(await lite.searchLiteFlights({ legs: [] }, { env: ENV, fetch: fake(log) })).toMatchObject({ ok: false, reason: 'no_valid_legs' });
        expect(log).toHaveLength(0);
        const denied = await lite.searchLiteFlights({ legs: [{ origin: 'EVN', destination: 'DXB', date: '2026-10-02' }] },
            { env: ENV, fetch: fake([], { status: 403 }) });
        expect(denied).toMatchObject({ ok: false, journeys: [], cheapest: null });
        expect(denied.reason).toContain('403');     // flights not enabled on the account yet
    });
});

describe('the cache never outlives the fare', () => {
    test('a repeat search is served from memo, but only while the offers are valid', async () => {
        const log = [];
        const args = { legs: [{ origin: 'EVN', destination: 'DXB', date: '2026-10-02' }], adults: 1 };
        await lite.searchLiteFlights(args, { env: ENV, fetch: fake(log) });
        await lite.searchLiteFlights(args, { env: ENV, fetch: fake(log) });
        expect(log).toHaveLength(1);                                  // the second came from memo
        expect(lite._earliestExpiry(RATES)).toBe(Date.parse(EXP_SOON));   // the SOONEST offer wins, and it lives only on cheapestOffer
        // Past its own expiry the entry is dead even inside the TTL window.
        expect(lite._stillFresh({ at: Date.now(), ttlMs: 5 * 60e3, expiresAt: Date.now() - 1 })).toBe(false);
        expect(lite._stillFresh({ at: Date.now(), ttlMs: 5 * 60e3, expiresAt: Date.now() + 60e3 })).toBe(true);
        expect(lite._stillFresh({ at: Date.now() - 6 * 60e3, ttlMs: 5 * 60e3, expiresAt: null })).toBe(false);
    });
});

describe('airports', () => {
    test('a city name resolves to an IATA code and is memoised', async () => {
        const log = [];
        const a = await lite.searchAirports('Dubai', { env: ENV, fetch: fake(log) });
        expect(a[0]).toMatchObject({ iata: 'DXB', city: 'Dubai', lat: 25.25, lng: 55.36, tz: 'Asia/Dubai' });
        await lite.searchAirports('Dubai', { env: ENV, fetch: fake(log) });
        expect(log).toHaveLength(1);
        expect(await lite.searchAirports('D', { env: ENV, fetch: fake(log) })).toEqual([]);   // under 2 chars, no call
        expect(log).toHaveLength(1);
    });
});

describe('verify before any money is discussed', () => {
    test('an unchanged offer verifies clean', async () => {
        const out = await lite.verifyOffer('of1', { env: ENV, fetch: fake() });
        expect(out).toMatchObject({ ok: true, changed: false, changeNote: null });
        expect(out.journey.price).toBe(212.4);
    });
    test('a moved fare reports the change in words the traveler can be told', async () => {
        const moved = { data: [{ journey: JOURNEY, changes: { messages: ['Price increased from 212.40 to 240.00 USD.'] } }] };
        const out = await lite.verifyOffer('of1', { env: ENV, fetch: fake([], { verify: moved }) });
        expect(out.changed).toBe(true);
        expect(out.changeNote).toContain('240.00');
    });
    test('an expired offer is an answer, never a silent re-quote', async () => {
        const out = await lite.verifyOffer('gone', { env: ENV, fetch: fake([], { status: 404 }) });
        expect(out).toEqual({ ok: false, reason: 'offer_expired' });
        expect(await lite.verifyOffer('', { env: ENV })).toEqual({ ok: false, reason: 'no_offer_id' });
    });
});
