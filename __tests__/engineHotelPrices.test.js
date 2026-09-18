// Hotel prices tool via liteAPI (founder 2026-09-19). Recorded response
// shapes; the key is fake — nothing here touches the network.
const hotels = require('../engine/travel/hotels');
const { runDeckAgent } = require('../engine/agent/deckAgent');

const ENV = { HOTEL_PRICES_TOKEN: 'sand_x', HOTEL_PRICES_WL_DOMAIN: 'https://jinni.nuitee.link/' };
const SEVAN = { lat: 40.55, lng: 44.95, countryCode: 'AM', name: 'Sevan' };
const HOTELS = { data: [
    { id: 'lp1', name: 'Noy Land Resort', stars: 4, rating: 8.7, latitude: 40.60, longitude: 45.00, city: 'Sevan', country: 'AM' },
    { id: 'lp2', name: 'Black Diamond Hotel & Spa', stars: 5, rating: 9.1, latitude: 40.58, longitude: 44.98 },
    { id: 'lp3', name: 'Harsnaqar', stars: 3, rating: 7.4, latitude: 40.56, longitude: 44.96 },
    { id: 'lp4', name: 'Unpriced Inn', stars: 2, latitude: 40.57, longitude: 44.97 },
], total: 4 };
const RATES = { data: [{ hotelId: 'lp1', price: 180 }, { hotelId: 'lp2', price: 320 }, { hotelId: 'lp3', price: 60 }, { hotelId: 'lp4', price: 0 }], sandbox: true };
const fakeFetch = (log = []) => async (url, init = {}) => {
    log.push({ url, init });
    const ok = (body) => ({ ok: true, json: async () => body });
    if (url.includes('/data/hotels')) return ok(HOTELS);
    if (url.includes('/hotels/min-rates')) return ok(RATES);
    return { ok: false, status: 404, json: async () => ({}) };
};

beforeEach(() => hotels._memo.clear());

describe('hotel prices (liteAPI)', () => {
    test('disabled without the key — fails open, no tool for the agent', async () => {
        expect(hotels.hotelsEnabled({})).toBe(false);
        expect(hotels.hotelsEnabled({ TRAVELPAYOUTS_TOKEN: 'flights-only' })).toBe(false);
        const out = await hotels.hotelPrices({ centre: SEVAN }, { env: {}, fetch: fakeFetch() });
        expect(out).toEqual({ ok: false, reason: 'hotel_prices_disabled' });
    });
    test('hotels around the centre → live min rates per night, matched by name, linked to our whitelabel', async () => {
        const log = [];
        const out = await hotels.hotelPrices(
            { centre: SEVAN, names: ['Noy Land', { name: 'Black Diamond', lat: 40.58, lng: 44.98 }, 'Nowhere Inn'], checkIn: '2026-10-02', checkOut: '2026-10-04', currency: 'usd', guestNationality: 'am' },
            { env: ENV, fetch: fakeFetch(log) });
        expect(out.ok).toBe(true);
        expect(log[0].url).toContain('/data/hotels?countryCode=AM&latitude=40.55&longitude=44.95&radius=15000');
        expect(log[0].init.headers['X-API-Key']).toBe('sand_x');
        const body = JSON.parse(log[1].init.body);
        expect(body).toMatchObject({ hotelIds: ['lp1', 'lp2', 'lp3', 'lp4'], checkin: '2026-10-02', checkout: '2026-10-04', currency: 'USD', guestNationality: 'AM', occupancies: [{ adults: 2 }] });
        expect(out.nights).toBe(2);
        expect(out.hotels.map(h => h.name)).toEqual(['Harsnaqar', 'Noy Land Resort', 'Black Diamond Hotel & Spa']);   // unpriced dropped, cheapest first
        expect(out.hotels[1].price_per_night).toBe(90);      // 180 for 2 nights
        expect(out.matched['Noy Land'].hotel_id).toBe('lp1');
        expect(out.matched['Black Diamond'].hotel_id).toBe('lp2');
        expect(out.matched['Nowhere Inn']).toBeNull();
        expect(out.matched['Noy Land'].booking_url).toBe(`https://jinni.nuitee.link/hotels/lp1?checkin=2026-10-02&checkout=2026-10-04&occupancies=${encodeURIComponent(Buffer.from('[{"adults":2}]').toString('base64'))}&currency=USD&language=en`);
    });
    test('no whitelabel domain ⇒ price without a link; no dates ⇒ the coming Saturday night; memoised', async () => {
        const log = [];
        const deps = { env: { HOTEL_PRICES_TOKEN: 'k' }, fetch: fakeFetch(log), now: '2026-09-19T10:00:00Z' };
        const a = await hotels.hotelPrices({ centre: SEVAN, names: ['Harsnaqar'] }, deps);
        expect(a.check_in).toBe('2026-09-26'); expect(a.check_out).toBe('2026-09-27'); expect(a.nights).toBe(1);
        expect(a.matched['Harsnaqar'].price_per_night).toBe(60);
        expect(a.matched['Harsnaqar'].booking_url).toBeNull();
        await hotels.hotelPrices({ centre: SEVAN }, deps);
        expect(log).toHaveLength(2);                         // second call served from memory
    });
    test('an unresolved centre or an empty index is reported, never invented', async () => {
        const a = await hotels.hotelPrices({ centre: { lat: 1, lng: 2 } }, { env: ENV, fetch: fakeFetch() });
        expect(a.reason).toBe('centre_unresolved');
        const b = await hotels.hotelPrices({ centre: SEVAN }, { env: ENV, fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
        expect(b.reason).toBe('no_hotels_in_index_here');
    });
    test('the agent can call it as an extra tool and the result reaches the model', async () => {
        const call = (name, args, id = 'c1') => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const script = [
            [call('search_places', { query: 'lakeside hotel', category: 'hotels' })],
            [call('hotel_prices', { area: 'Sevan', hotel_names: ['Noy Land'] }, 'c2')],
            [call('deal', { intro: 'x', cards: [{ id: 'p1', blurb: 'From $180 a night.' }] }, 'c3')],
        ];
        let i = 0;
        const seen = [];
        const provider = { completeWithTools: async ({ tools }) => { seen.push(tools.map(t => t.function.name)); return { message: { content: null, tool_calls: script[i++] || [] }, usage: {} }; } };
        const out = await runDeckAgent({ message: 'hotel near Sevan, how much?', traveler: { lat: 40.2, lng: 44.5 } }, {
            provider, lookup: async () => null,
            retrieve: async () => ({ places: [{ placeId: 'g1', name: 'Noy Land', source: 'cache', distanceKm: 3 }] }),
            extraTools: [hotels.HOTEL_PRICES_TOOL],
            extraExec: { hotel_prices: async (a) => { const r = await hotels.hotelPrices({ centre: SEVAN, names: a.hotel_names }, { env: ENV, fetch: fakeFetch() }); return { matched: r.matched }; } },
        });
        expect(seen[0]).toContain('hotel_prices');
        expect(out.kind).toBe('deal');
        expect(out.toolCalls[1].name).toBe('hotel_prices');
        expect(out.toolCalls[1].result.matched['Noy Land'].price_per_night).toBe(180);
    });
});
