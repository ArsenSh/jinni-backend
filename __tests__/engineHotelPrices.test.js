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
const EXTRA = [{ id: 'lp9', name: 'Hotel du Cygne Paris', stars: 3, latitude: 40.57, longitude: 44.97 }];   // outside the area pool, found by name
const RATES = { data: [{ hotelId: 'lp1', price: 180 }, { hotelId: 'lp2', price: 320 }, { hotelId: 'lp3', price: 60 }, { hotelId: 'lp4', price: 0 }, { hotelId: 'lp9', price: 150 }], sandbox: true };
const fakeFetch = (log = []) => async (url, init = {}) => {   // tests pass noPace to skip the 250 ms pacer
    log.push({ url, init });
    const ok = (body) => ({ ok: true, json: async () => body });
    if (url.includes('/data/hotels') && url.includes('hotelName=')) {
        const q = decodeURIComponent(url.split('hotelName=')[1].split('&')[0]).toLowerCase();
        return ok({ data: EXTRA.filter(h => h.name.toLowerCase().includes(q.split(' ')[0])) });
    }
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
            { env: ENV, fetch: fakeFetch(log), noPace: true });
        expect(out.ok).toBe(true);
        expect(log[0].url).toContain('/data/hotels?countryCode=AM&latitude=40.55&longitude=44.95&radius=15000');
        expect(log[0].init.headers['X-API-Key']).toBe('sand_x');
        expect(log.some(l => l.url.includes('hotelName=Nowhere'))).toBe(true);   // the pool lacks it → looked up by name
        const body = JSON.parse(log.find(l => l.url.includes('/hotels/min-rates')).init.body);
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
        const deps = { env: { HOTEL_PRICES_TOKEN: 'k' }, fetch: fakeFetch(log), now: '2026-09-19T10:00:00Z', noPace: true };
        const a = await hotels.hotelPrices({ centre: SEVAN, names: ['Harsnaqar'] }, deps);
        expect(a.check_in).toBe('2026-09-26'); expect(a.check_out).toBe('2026-09-27'); expect(a.nights).toBe(1);
        expect(a.matched['Harsnaqar'].price_per_night).toBe(60);
        expect(a.matched['Harsnaqar'].booking_url).toBeNull();
        await hotels.hotelPrices({ centre: SEVAN }, deps);
        expect(log).toHaveLength(2);                         // second call served from memory
    });
    test('an unresolved centre or an empty index is reported, never invented', async () => {
        const a = await hotels.hotelPrices({ centre: { lat: 1, lng: 2 } }, { env: ENV, fetch: fakeFetch(), noPace: true });
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
            extraExec: { hotel_prices: async (a) => { const r = await hotels.hotelPrices({ centre: SEVAN, names: a.hotel_names }, { env: ENV, fetch: fakeFetch(), noPace: true }); return { matched: r.matched }; } },
        });
        expect(seen[0]).toContain('hotel_prices');
        expect(out.kind).toBe('deal');
        expect(out.toolCalls[1].name).toBe('hotel_prices');
        expect(out.toolCalls[1].result.matched['Noy Land'].price_per_night).toBe(180);
    });
});

describe('named hotels outside the area pool', () => {
    test('are looked up by name (accent-folded) and priced; the pool stays first', async () => {
        const log = [];
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Hôtel du Cygne Paris', 'Noy Land'] }, { env: ENV, fetch: fakeFetch(log), now: '2026-09-18T21:00:00Z', noPace: true });
        const nameCalls = log.filter(l => l.url.includes('hotelName='));
        expect(nameCalls).toHaveLength(1);                   // Noy Land is already in the pool — no lookup for it
        expect(decodeURIComponent(nameCalls[0].url)).toContain('hotelName=Hotel du Cygne Paris');
        expect(JSON.parse(log[log.length - 1].init.body).hotelIds).toEqual(['lp1', 'lp2', 'lp3', 'lp4', 'lp9']);
        expect(out.matched['Hôtel du Cygne Paris'].hotel_id).toBe('lp9');
        expect(out.matched['Hôtel du Cygne Paris'].price_per_night).toBe(150);
        expect(out.matched['Noy Land'].hotel_id).toBe('lp1');
        expect(hotels._norm('Hôtel Louvre Richelieu')).toBe('louvre richelieu');
    });
});

describe('rate limit', () => {
    test('a 429 on the rates call is retried once and then priced', async () => {
        let ratesHits = 0;
        const f = async (url, init) => {
            if (url.includes('/hotels/min-rates')) { ratesHits++; return ratesHits === 1 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, json: async () => RATES }; }
            return { ok: true, json: async () => HOTELS };
        };
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Harsnaqar'] }, { env: ENV, fetch: f, noPace: true });
        expect(ratesHits).toBe(2);
        expect(out.matched['Harsnaqar'].price_per_night).toBe(60);
        expect(out.diag.rates_call).toBe('ok');
    });
});

describe('dates and partner errors', () => {
    test('a past stay keeps its day and rolls to the next year; a stay 2+ years back is dropped', () => {
        expect(hotels.rollForward({ checkIn: '2025-10-10', checkOut: '2025-10-12' }, new Date('2026-09-18T21:00:00Z'))).toEqual({ checkIn: '2026-10-10', checkOut: '2026-10-12' });
        expect(hotels.rollForward({ checkIn: '2026-10-10', checkOut: '2026-10-12' }, new Date('2026-09-18T21:00:00Z'))).toEqual({ checkIn: '2026-10-10', checkOut: '2026-10-12' });
        expect(hotels.rollForward({ checkIn: '2020-01-01', checkOut: '2020-01-02' }, new Date('2026-09-18T21:00:00Z'))).toBeNull();
    });
    test('the partner "no availability" error is named in diag, and nothing is priced', async () => {
        const fetchNoAvail = async (url) => ({ ok: true, json: async () => url.includes('/data/hotels') ? HOTELS : { error: { code: 2001, message: 'no availability found' } } });
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Harsnaqar'], checkIn: '2025-10-10', checkOut: '2025-10-11' }, { env: ENV, fetch: fetchNoAvail, now: '2026-09-18T21:00:00Z', noPace: true });
        expect(out.ok).toBe(true);
        expect(out.check_in).toBe('2026-10-10');
        expect(out.hotels).toEqual([]);
        expect(out.matched['Harsnaqar']).toBeNull();
        expect(out.diag.rates_call).toBe('partner: no availability found');
        expect(out.diag.rates_shape).toBeUndefined();
    });
});

describe("owner's listed price (Destination/Business pricing)", () => {
    const { summarize } = require('../engine/agent/deckAgent');
    const { toRecommendation } = require('../engine/narrator/cards');
    const store = require('../engine/places/canonicalStore');
    const doc = { _id: 'd1', name: 'Black Diamond Sevan', type: ['hotel'], location: { coordinates: { lat: 40.56, lng: 44.99 }, city: 'Sevan' }, pricing: { isFree: false, min: 120, max: 260, average: 180, currency: 'USD' } };
    test('rides from the record to the agent facts and the card', () => {
        const c = store.dbDocToCandidate(doc, 'destination', null);
        expect(c.ownedPrice).toEqual({ min: 120, max: 260, average: 180, currency: 'USD' });
        expect(store.dbDocToCandidate({ ...doc, pricing: { isFree: true, average: 5 } }, 'destination', null).ownedPrice).toBeNull();
        expect(store.dbDocToCandidate({ ...doc, pricing: { isFree: false, average: 300, currency: 'usd' } }, 'business', null).ownedPrice).toEqual({ min: null, max: null, average: 300, currency: 'USD' });
    });
    test('agent sees a quotable number; free or empty pricing stays silent', () => {
        // Wording updated 2026-09-23: an unsourced row takes the CAUTIOUS
        // attribution — it may not claim the venue quoted the number.
        expect(summarize({ name: 'x', ownedPrice: { min: 120, max: 260, average: 180, currency: 'USD' } }).price).toContain('from 120 to 260 USD');
        expect(summarize({ name: 'x', ownedPrice: { min: null, max: null, average: 180, currency: 'AMD' } }).price).toContain('about 180 AMD');
        expect(summarize({ name: 'x', ownedPrice: { min: 120, currency: 'USD' } }).price).toContain('recorded by Jinni');
        expect(summarize({ name: 'x' }).price).toBeNull();
    });
    test('card carries listedPrice, and never a partner hotelPrice it did not get', () => {
        const rec = toRecommendation({ name: 'x', source: 'destination', ownedPrice: { min: 120, max: 260, average: 180, currency: 'USD' } }, 0, {});
        expect(rec.listedPrice).toEqual({ min: 120, max: 260, average: 180, currency: 'USD' });
        expect(rec.hotelPrice).toBeNull();
        expect(rec.bookingUrl).toBeNull();
    });
});

describe('strict hotel matching (founder 2026-09-19: the link opened a different hotel)', () => {
    const { _tokens, _sameHotel } = hotels;
    const same = (a, b, city = 'Yerevan') => { const c = new Set(_tokens(city)); return _sameHotel(_tokens(a, c), _tokens(b, c)); };
    test('a shared city word or a generic word is not a match', () => {
        expect(same('Yerevan Place', 'Republica Hotel Yerevan')).toBe(false);
        expect(same('Grand Hotel Yerevan', 'Grand Yerevan Apartments')).toBe(false);   // only "grand" left, generic
        expect(same('Ani Plaza Hotel', 'Ani Central Inn')).toBe(false);                 // "ani" is 3 letters, alone
        expect(same('Hotel Alexander', 'Alexander Marina Hotel', 'Dubai')).toBe(true);  // one distinctive 9-letter token
        expect(same('Hotel Alexander', 'Alex Hotel')).toBe(false);
        expect(same('14th Floor Hotel', '14 Floor Hotel')).toBe(true);                   // ordinal = number                      // live 2026-09-19: Alexander's card opened Alex Hotel at $91
    });
    test('the real pairs still match', () => {
        expect(same('Black Diamond', 'Black Diamond Hotel & Spa', 'Sevan')).toBe(true);
        expect(same('Hôtel du Cygne Paris', 'Hotel du Cygne', 'Paris')).toBe(true);
        expect(same('Noy Land', 'Noy Land Resort', 'Sevan')).toBe(true);
        expect(same('Armenia Marriott Hotel Yerevan', 'Armenia Marriott Hotel Yerevan')).toBe(true);
        expect(same('Paragraph Freedom Square, a Luxury Collection Hotel', 'Paragraph Freedom Square', 'Tbilisi')).toBe(true);
    });
    test('a namesake more than 1.5 km away is refused even when the name fits', async () => {
        const far = { data: [{ id: 'lpX', name: 'Noy Land Resort', stars: 4, latitude: 40.80, longitude: 45.20 }] };
        const f = async (url) => ({ ok: true, json: async () => url.includes('/data/hotels') ? far : { data: [{ hotelId: 'lpX', price: 100 }] } });
        const out = await hotels.hotelPrices({ centre: SEVAN, names: [{ name: 'Noy Land', lat: 40.60, lng: 45.00 }] }, { env: ENV, fetch: f, noPace: true });
        expect(out.matched['Noy Land']).toBeNull();
    });
});

describe('budget and coordinates through the executor', () => {
    test('near_budget lists the priced hotels closest to the budget; this turn\'s candidates supply coordinates', async () => {
        const exec = hotels.makeExecutor({ center: { lat: 40.55, lng: 44.95 }, sessionCards: [] }, {
            env: ENV, fetch: fakeFetch(), noPace: true,
            gazetteer: { lookupPlace: async () => ({ name: 'Sevan', lat: 40.55, lng: 44.95, countryCode: 'AM' }), regionAt: async () => null },
        });
        const out = await exec({ area: 'Sevan', hotel_names: ['Noy Land'], budget_per_night: 100 }, { known: [{ name: 'Noy Land', geometry: { lat: 40.60, lng: 45.00 } }] });
        expect(out.near_budget.map(h => h.name)).toEqual(['Harsnaqar', 'Noy Land Resort', 'Black Diamond Hotel & Spa']);   // 60, 180, 320 vs 100 (1 night)
        expect(out.matched['Noy Land'].price_per_night).toBe(180);
    });
});

test('near-budget hotels are fetched and registered as dealable, price attached', async () => {
    const registered = [];
    const lookupByName = async (name) => ({ name: name === 'Harsnaqar' ? 'Harsnaqar Hotel' : name, geometry: { lat: 40.56, lng: 44.96 }, source: 'cache' });
    const retrieve = async () => ({ places: [] });
    const exec = hotels.makeExecutor({ center: { lat: 40.55, lng: 44.95 }, sessionCards: [] }, {
        env: ENV, fetch: fakeFetch(), noPace: true, retrieve, lookupByName,
        gazetteer: { lookupPlace: async () => ({ name: 'Sevan', lat: 40.55, lng: 44.95, countryCode: 'AM' }), regionAt: async () => null },
    });
    const out = await exec({ area: 'Sevan', budget_per_night: 70 }, { known: [], register: (p) => { registered.push(p); return { id: `p${registered.length}` }; } });
    expect(out.near_budget[0]).toMatchObject({ name: 'Harsnaqar', price_per_night: 60, id: 'p1' });
    expect(registered[0].hotelPrice.perNight).toBe(60);
    expect(out.near_budget_note).toMatch(/ready to deal/);
    expect(out.diag.near_budget_fetch[0]).toMatchObject({ wanted: 'Harsnaqar', registered: true });
});

test('a budget said in AMD is converted before ranking', async () => {
    const exec = hotels.makeExecutor({ center: { lat: 40.55, lng: 44.95 }, sessionCards: [], currency: 'USD' }, {
        env: ENV, fetch: fakeFetch(), noPace: true, convert: (amt, from, to) => from === 'AMD' && to === 'USD' ? Math.round(amt / 385) : amt,
        gazetteer: { lookupPlace: async () => ({ name: 'Sevan', lat: 40.55, lng: 44.95, countryCode: 'AM' }), regionAt: async () => null },
    });
    const out = await exec({ area: 'Sevan', budget_per_night: 25000, budget_currency: 'AMD' }, { known: [] });   // ≈ 65 USD
    expect(out.near_budget[0].name).toBe('Harsnaqar');                                   // 60, the nearest to 65
    expect(out.near_budget_note).toMatch(/closest to 65 USD/);
});

// ── Group occupancy + the partner as a SOURCE (founder 2026-09-23: "can it
//    search from booking initially too? … it will give more results than
//    google"; live session 6ab3c2ed priced "we are 12 people" as one double) ──
describe('group occupancy', () => {
    test('rooms are sized from the party; the odd traveler gets a single', () => {
        expect(hotels.occupanciesFor(null)).toEqual([{ adults: 2 }]);
        expect(hotels.occupanciesFor(0)).toEqual([{ adults: 2 }]);
        expect(hotels.occupanciesFor(2)).toEqual([{ adults: 2 }]);
        expect(hotels.occupanciesFor(12)).toHaveLength(6);
        expect(hotels.occupanciesFor(12).every(o => o.adults === 2)).toBe(true);
        expect(hotels.occupanciesFor(5)).toEqual([{ adults: 2 }, { adults: 2 }, { adults: 1 }]);
        expect(hotels.occupanciesFor(99)).toHaveLength(12);              // a block booking no rate API answers
    });
    test('the party reaches the rate call AND the booking link', async () => {
        const log = [];
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Noy Land'], party: 12, currency: 'USD' },
            { env: ENV, fetch: fakeFetch(log), noPace: true });
        const rates = log.find(l => l.url.includes('/hotels/min-rates'));
        expect(JSON.parse(rates.init.body).occupancies).toHaveLength(6);
        expect(out.rooms).toBe(6);
        const row = out.matched['Noy Land'];
        expect(row.rooms).toBe(6);
        const occ = JSON.parse(Buffer.from(decodeURIComponent(row.booking_url.split('occupancies=')[1].split('&')[0]), 'base64').toString());
        expect(occ).toHaveLength(6);
    });
});

describe('areaHotels — the partner as a source', () => {
    test('every hotel it sells comes back with photo, address and a live group price', async () => {
        const log = [];
        const out = await hotels.areaHotels({ centre: SEVAN, radiusKm: 30, party: 4, currency: 'USD' },
            { env: ENV, fetch: fakeFetch(log), noPace: true });
        expect(out.ok).toBe(true);
        expect(out.rooms).toBe(2);
        expect(out.hotels).toHaveLength(4);                              // the whole index, not only the priced ones
        expect(out.diag).toMatchObject({ hotels_in_index: 4, hotels_priced: 3 });
        const noy = out.hotels.find(h => h.name === 'Noy Land Resort');
        expect(noy).toMatchObject({ hotel_id: 'lp1', stars: 4, guest_rating: 8.7, city: 'Sevan', available: true, rooms: 2 });
        expect(noy.price_per_night).toBeGreaterThan(0);
        expect(noy.booking_url).toContain('jinni.nuitee.link/hotels/lp1');
        expect(Number.isFinite(noy.distance_from_centre_km)).toBe(true);
        // A hotel the partner could not price for this stay says so — it is
        // never given a number, and with a party it could not take the group.
        expect(out.hotels.find(h => h.name === 'Unpriced Inn')).toMatchObject({ available: false, price_per_night: null });
        // Bookable rows sort first.
        expect(out.hotels[out.hotels.length - 1].available).toBe(false);
    });
    test('no key, no centre country, no index → fails open with a reason, never a throw', async () => {
        expect(await hotels.areaHotels({ centre: SEVAN }, { env: {} })).toMatchObject({ ok: false, reason: 'hotel_prices_disabled', hotels: [] });
        expect(await hotels.areaHotels({ centre: { lat: 40, lng: 44 } }, { env: ENV })).toMatchObject({ ok: false, reason: 'centre_unresolved' });
        const empty = await hotels.areaHotels({ centre: SEVAN }, { env: ENV, noPace: true, fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
        expect(empty).toMatchObject({ reason: 'no_hotels_in_index_here', hotels: [] });
    });
});

describe('per-room fallback when the group cannot be booked as one stay (2026-09-23)', () => {
    // Twelve travelers in a small town: six rooms, nothing available — the old
    // behaviour lost every price AND every Book button, so the traveler got
    // neither the number nor the link.
    const NO_GROUP_RATES = (occ) => occ.length > 1 ? { data: [] } : { data: [{ hotelId: 'lp1', price: 180 }, { hotelId: 'lp3', price: 60 }] };
    const fetchGroupAware = (log = []) => async (url, init = {}) => {
        log.push({ url, init });
        const ok = (b) => ({ ok: true, json: async () => b });
        if (url.includes('/data/hotels')) return ok(HOTELS);
        if (url.includes('/hotels/min-rates')) return ok(NO_GROUP_RATES(JSON.parse(init.body).occupancies));
        return { ok: false, status: 404, json: async () => ({}) };
    };
    test('falls back to ONE room, says the group cannot be held, and the link matches the price', async () => {
        const log = [];
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Noy Land'], party: 12 }, { env: ENV, fetch: fetchGroupAware(log), noPace: true });
        const asked = log.filter(l => l.url.includes('min-rates')).map(l => JSON.parse(l.init.body).occupancies.length);
        expect(asked).toEqual([6, 1]);                                   // group first, then one room
        expect(out.rooms).toBe(1);
        const row = out.matched['Noy Land'];
        expect(row).toMatchObject({ per_room: true, group_unavailable: true, group_rooms: 6, rooms: 1 });
        expect(row.price_per_night).toBe(180);
        const occ = JSON.parse(Buffer.from(decodeURIComponent(row.booking_url.split('occupancies=')[1].split('&')[0]), 'base64').toString());
        expect(occ).toEqual([{ adults: 2 }]);                            // the link books what the price quoted
    });
    test('a group that CAN be housed is never downgraded', async () => {
        const out = await hotels.hotelPrices({ centre: SEVAN, names: ['Noy Land'], party: 4 }, { env: ENV, fetch: fakeFetch(), noPace: true });
        expect(out.matched['Noy Land']).toMatchObject({ rooms: 2, per_room: false, group_unavailable: false });
    });
    test('areaHotels falls back the same way', async () => {
        const out = await hotels.areaHotels({ centre: SEVAN, party: 12 }, { env: ENV, fetch: fetchGroupAware(), noPace: true });
        expect(out).toMatchObject({ rooms: 1, per_room: true, group_unavailable: true });
        expect(out.hotels.find(h => h.hotel_id === 'lp1')).toMatchObject({ available: true, per_room: true, group_rooms: 6 });
    });
});

describe('name variants: the partner sells it under another branding (2026-09-23)', () => {
    // "Tufenkian Heritage Hotels" (ours, from Google) vs the partner's
    // "Tufenkian Historic Yerevan Hotel" — the token rule refuses it, so a
    // hotel the partner really sells showed no price and no Book button.
    const TWIN = { id: 'lpT', name: 'Tufenkian Historic Yerevan Hotel', stars: 4, latitude: 40.5503, longitude: 44.9503 };
    const f = async (url) => {
        const ok = (b) => ({ ok: true, json: async () => b });
        if (url.includes('hotelName=')) return ok({ data: [TWIN] });
        if (url.includes('/data/hotels')) return ok({ data: [] });
        if (url.includes('/hotels/min-rates')) return ok({ data: [{ hotelId: 'lpT', price: 140 }] });
        return { ok: false, status: 404, json: async () => ({}) };
    };
    test('accepted when the partner resolved THAT name, within 500 m, sharing a real word', async () => {
        const out = await hotels.hotelPrices({ centre: SEVAN, names: [{ name: 'Tufenkian Heritage Hotels', lat: 40.5500, lng: 44.9500 }] },
            { env: ENV, fetch: f, noPace: true });
        expect(out.matched['Tufenkian Heritage Hotels']).toMatchObject({ hotel_id: 'lpT', price_per_night: 140 });
        expect(out.matched['Tufenkian Heritage Hotels'].booking_url).toContain('/hotels/lpT');
    });
    test('refused when it is far away, or when nothing distinctive is shared', async () => {
        const far = await hotels.hotelPrices({ centre: SEVAN, names: [{ name: 'Tufenkian Heritage Hotels', lat: 40.60, lng: 45.00 }] },
            { env: ENV, fetch: f, noPace: true });
        expect(far.matched['Tufenkian Heritage Hotels']).toBeNull();     // 5+ km away is a different property
        const other = await hotels.hotelPrices({ centre: SEVAN, names: [{ name: 'Sevan Plaza Hotel', lat: 40.5500, lng: 44.9500 }] },
            { env: ENV, fetch: f, noPace: true });
        expect(other.matched['Sevan Plaza Hotel']).toBeNull();           // the partner's name search is not a licence
    });
});

describe('whose price is it (founder 2026-09-23: "hotel owner or app owner?")', () => {
    const { summarize } = require('../engine/agent/deckAgent');
    const priced = { name: 'X', ownedPrice: { min: null, max: null, average: 70000, currency: 'AMD' } };
    test('a venue-entered price is the venue\'s; a curated one is Jinni\'s own reference', () => {
        expect(summarize({ ...priced, source: 'business' }).price).toBe("about 70000 AMD (the venue's own listed price, per night)");
        const curated = summarize({ ...priced, source: 'destination' }).price;
        expect(curated).toContain('recorded by Jinni');
        expect(curated).toContain('NOT a quote from the venue');
    });
});
