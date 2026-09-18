// Hotel prices tool plumbing (founder 2026-09-19). The Hotellook provider it
// was written against is DEAD (closed 2025-10-20) — these tests pin the
// provider-agnostic parts: gating, matching, per-night maths, agent wiring.
// Recorded response shapes; the token is fake — nothing touches the network.
const hotels = require('../engine/travel/hotels');
const { runDeckAgent } = require('../engine/agent/deckAgent');

const ENV = { HOTEL_PRICES_TOKEN: 'tok', HOTEL_PRICES_MARKER: '123456' };
const LOOKUP = { status: 'ok', results: {
    locations: [
        { id: 1001, type: 'City', countryName: 'Armenia', name: 'Sevan', fullName: 'Sevan, Armenia', location: { lat: 40.55, lon: 44.95 }, hotelsCount: 40 },
        { id: 2002, type: 'City', countryName: 'Australia', name: 'Sea Lake', fullName: 'Sea Lake, Australia', location: { lat: -35.5, lon: 142.85 }, hotelsCount: 2 },
    ],
    hotels: [],
} };
const CACHE = [
    { hotelId: 7, hotelName: 'Noy Land Resort', stars: 4, priceFrom: 180, location: { geo: { lat: 40.60, lon: 45.00 }, name: 'Sevan' } },
    { hotelId: 8, hotelName: 'Black Diamond Hotel & Spa', stars: 5, priceFrom: 320, location: { geo: { lat: 40.58, lon: 44.98 } } },
    { hotelId: 9, hotelName: 'Harsnaqar', stars: 3, priceFrom: 60, location: { geo: { lat: 40.56, lon: 44.96 } } },
    { hotelId: 10, hotelName: 'Broken Row', priceFrom: 0 },
];
const fakeFetch = (log = []) => async (url) => {
    log.push(url);
    const ok = (body) => ({ ok: true, json: async () => body });
    if (url.startsWith('https://engine.hotellook.com/api/v2/lookup.json')) return ok(LOOKUP);
    if (url.startsWith('https://engine.hotellook.com/api/v2/cache.json')) return ok(CACHE);
    return { ok: false, status: 404, json: async () => ({}) };
};

beforeEach(() => hotels._memo.clear());

describe('hotel prices', () => {
    test('disabled without the token — fails open, no tool for the agent', async () => {
        expect(hotels.hotelsEnabled({})).toBe(false);
        const out = await hotels.hotelPrices({ area: 'Sevan' }, { env: {}, fetch: fakeFetch() });
        expect(out).toEqual({ ok: false, reason: 'hotel_prices_disabled' });
    });
    test('resolves the NEAR namesake, prices the stay per night, matches names, links with the marker', async () => {
        const log = [];
        const out = await hotels.hotelPrices(
            { area: 'Sevan', near: { lat: 40.2, lng: 44.5 }, names: ['Noy Land', { name: 'Black Diamond', lat: 40.58, lng: 44.98 }, 'Nowhere Inn'], checkIn: '2026-10-02', checkOut: '2026-10-04', currency: 'USD' },
            { env: ENV, fetch: fakeFetch(log) });
        expect(out.ok).toBe(true);
        expect(out.area).toBe('Sevan, Armenia');
        expect(log[1]).toContain('locationId=1001');         // not Sea Lake, Australia
        expect(log[1]).toContain('checkIn=2026-10-02');
        expect(out.nights).toBe(2);
        expect(out.hotels.map(h => h.name)).toEqual(['Harsnaqar', 'Noy Land Resort', 'Black Diamond Hotel & Spa']);   // zero-price row dropped, cheapest first
        expect(out.hotels[1].price_per_night).toBe(90);      // 180 for 2 nights
        expect(out.matched['Noy Land'].hotel_id).toBe(7);
        expect(out.matched['Black Diamond'].hotel_id).toBe(8);
        expect(out.matched['Nowhere Inn']).toBeNull();
        expect(out.matched['Noy Land'].booking_url).toMatch(/^https:\/\/search\.hotellook\.com\/hotels\?/);
        expect(out.matched['Noy Land'].booking_url).toContain('marker=123456');
        expect(out.matched['Noy Land'].booking_url).toContain('hotelId=7');
    });
    test('no dates ⇒ the coming Saturday night; results are memoised', async () => {
        const log = [];
        const deps = { env: ENV, fetch: fakeFetch(log), now: '2026-09-19T10:00:00Z' };
        const a = await hotels.hotelPrices({ area: 'Sevan' }, deps);
        expect(a.check_in).toBe('2026-09-26'); expect(a.check_out).toBe('2026-09-27'); expect(a.nights).toBe(1);
        await hotels.hotelPrices({ area: 'Sevan' }, deps);
        expect(log).toHaveLength(2);                         // second call served from memory
    });
    test('an area the index does not know is reported, not invented', async () => {
        const out = await hotels.hotelPrices({ area: 'Xyzzy' }, { env: ENV, fetch: async () => ({ ok: true, json: async () => ({ results: { locations: [], hotels: [] } }) }) });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('area_unknown_to_hotel_index');
    });
    test('the agent can call it as an extra tool and the result reaches the model', async () => {
        const call = (name, args, id = 'c1') => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const script = [
            [call('search_places', { query: 'lakeside hotel', category: 'hotels' })],
            [call('hotel_prices', { area: 'Sevan', hotel_names: ['Noy Land'] }, 'c2')],
            [call('deal', { intro: 'x', cards: [{ id: 'p1', blurb: 'From $90 a night.' }] }, 'c3')],
        ];
        let i = 0;
        const seen = [];
        const provider = { completeWithTools: async ({ tools }) => { seen.push(tools.map(t => t.function.name)); return { message: { content: null, tool_calls: script[i++] || [] }, usage: {} }; } };
        const out = await runDeckAgent({ message: 'hotel near Sevan, how much?', traveler: { lat: 40.2, lng: 44.5 } }, {
            provider, lookup: async () => null,
            retrieve: async () => ({ places: [{ placeId: 'g1', name: 'Noy Land', source: 'cache', distanceKm: 3 }] }),
            extraTools: [hotels.HOTEL_PRICES_TOOL],
            extraExec: { hotel_prices: async (a) => { const r = await hotels.hotelPrices({ area: a.area, names: a.hotel_names }, { env: ENV, fetch: fakeFetch() }); return { matched: r.matched }; } },
        });
        expect(seen[0]).toContain('hotel_prices');
        expect(out.kind).toBe('deal');
        expect(out.toolCalls[1].name).toBe('hotel_prices');
        expect(out.toolCalls[1].result.matched['Noy Land'].price_per_night).toBe(180);
    });
});
