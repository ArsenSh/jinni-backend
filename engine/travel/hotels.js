// Jinni V3 Engine — hotel prices via Travelpayouts' hotel data API (Hotellook).
// Arsen 2026-09-19: "lets add some tool to test the price … almost every
// hotel exists in booking.com" — the agent needs REAL numbers to tell luxury
// from budget and to quote a "from" price, not Google's $–$$$$ guess.
//
// WHY this API and not a scraper: Booking.com is bot-protected and its terms
// forbid scraping; Travelpayouts is the official partner channel — free to
// use, and it PAYS a commission when a traveler books through our link
// (same trade as engine/travel/flights.js).
//
// Two endpoints, both public to every Travelpayouts account:
//   lookup.json — name → location / hotel ids (with coordinates)
//   cache.json  — cached "from" prices for a location + dates (updated by
//                 other users' searches; a hotel nobody searched lately may
//                 be missing — the tool says so instead of guessing)
// Live search for exact dates needs separate approval; not used here.
//
// Setup: TRAVELPAYOUTS_TOKEN + TRAVELPAYOUTS_MARKER in Coolify env. Without
// the token everything fails open — the agent simply gets no hotel_prices
// tool and answers as it does today, minus prices.

const LOOKUP_URL = 'https://engine.hotellook.com/api/v2/lookup.json';
const CACHE_URL = 'https://engine.hotellook.com/api/v2/cache.json';
const BOOK_URL = 'https://search.hotellook.com/hotels';
const TIMEOUT_MS = 6000;
const TTL_MS = 6 * 3600e3;          // cached prices move slowly; 6 h is honest enough
const MAX_MEMO = 300;
const MATCH_KM = 1.2;               // same hotel ⇒ same block; names are the tie-breaker
const _memo = new Map();            // url → { at, value }

function hotelsEnabled(env = process.env) { return !!env.TRAVELPAYOUTS_TOKEN; }

function _remember(key, value) {
    if (_memo.size >= MAX_MEMO) _memo.delete(_memo.keys().next().value);
    _memo.set(key, { at: Date.now(), value });
    return value;
}
async function _getJson(url, deps = {}) {
    const hit = _memo.get(url);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs || TIMEOUT_MS);
    try {
        const res = await doFetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) { console.warn(`[hotels] ${url.split('?')[0]} → ${res.status}`); return null; }
        return _remember(url, await res.json());
    } catch (err) {
        console.warn(`[hotels] ${url.split('?')[0]}: ${err.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

const _q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const _norm = (s) => String(s || '').toLowerCase().replace(/\b(hotel|resort|spa|the|and|&)\b/g, ' ').replace(/[^a-z0-9Ѐ-ӿ԰-֏]+/g, ' ').trim();
const haversineKm = (a, b, c, d) => { const R = 6371, t = x => x * Math.PI / 180; const dl = t(c - a), dn = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const _iso = (d) => d.toISOString().slice(0, 10);

/** Default stay when the traveler named no dates: the coming Saturday night. */
function defaultStay(now = new Date()) {
    const d = new Date(now); d.setUTCHours(12, 0, 0, 0);
    const toSat = (6 - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + toSat);
    const out = new Date(d); out.setUTCDate(out.getUTCDate() + 1);
    return { checkIn: _iso(d), checkOut: _iso(out) };
}
function _nights(a, b) { return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 864e5)); }
const _validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Where a traveler lands when they click "check rates". Marker = our commission. */
function bookingUrl({ destination, hotelId = null, checkIn, checkOut, adults = 2, currency = 'usd', locale = 'en' } = {}, env = process.env) {
    const q = _q({ destination, hotelId, checkIn, checkOut, adults, currency: String(currency || 'usd').toLowerCase(), language: locale, marker: env.TRAVELPAYOUTS_MARKER || null });
    return `${BOOK_URL}?${q}`;
}

/** Name → the best location (city/region) or hotel Hotellook knows, nearest to `near` when given. */
async function lookupLocation(query, { near = null, lang = 'en' } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!hotelsEnabled(env) || !query) return null;
    const json = await _getJson(`${LOOKUP_URL}?${_q({ query, lang, lookFor: 'both', limit: 10, token: env.TRAVELPAYOUTS_TOKEN })}`, deps);
    const locs = Array.isArray(json?.results?.locations) ? json.results.locations : [];
    const hotels = Array.isArray(json?.results?.hotels) ? json.results.hotels : [];
    const dist = (x) => near && x?.location && Number.isFinite(+x.location.lat) ? haversineKm(near.lat, near.lng, +x.location.lat, +x.location.lon) : Infinity;
    const pick = (arr) => arr.slice().sort((a, b) => dist(a) - dist(b))[0] || null;
    const loc = pick(locs);
    // A far-away namesake is not the traveler's place (Sea Lake, Australia).
    if (loc && near && dist(loc) > 300) return hotels.length ? { kind: 'hotel', hit: pick(hotels) } : null;
    if (loc) return { kind: 'location', hit: loc };
    return hotels.length ? { kind: 'hotel', hit: pick(hotels) } : null;
}

/**
 * Cached "from" prices around an area, optionally matched to named hotels.
 * @returns {{ ok:boolean, reason?:string, area?:string, check_in, check_out, nights, currency, hotels:Array, matched:Object }}
 */
async function hotelPrices({ area, near = null, names = [], checkIn = null, checkOut = null, currency = 'USD', limit = 30, locale = 'en' } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!hotelsEnabled(env)) return { ok: false, reason: 'hotel_prices_disabled' };
    const stay = _validDate(checkIn) && _validDate(checkOut) && Date.parse(checkOut) > Date.parse(checkIn) ? { checkIn, checkOut } : defaultStay(deps.now ? new Date(deps.now) : new Date());
    const nights = _nights(stay.checkIn, stay.checkOut);
    const cur = String(currency || 'USD').toLowerCase();
    const found = await lookupLocation(area, { near, lang: locale }, deps);
    if (!found) return { ok: false, reason: 'area_unknown_to_hotel_index', check_in: stay.checkIn, check_out: stay.checkOut, nights, currency: cur.toUpperCase(), hotels: [], matched: {} };
    const params = found.kind === 'location'
        ? { locationId: found.hit.id }
        : { locationId: found.hit.locationId, hotelId: found.hit.id };
    const rows = await _getJson(`${CACHE_URL}?${_q({ ...params, checkIn: stay.checkIn, checkOut: stay.checkOut, currency: cur, limit: Math.min(Math.max(limit, 5), 100), token: env.TRAVELPAYOUTS_TOKEN })}`, deps);
    const list = Array.isArray(rows) ? rows : [];
    const areaName = found.kind === 'location' ? (found.hit.fullName || found.hit.name) : (found.hit.locationName || area);
    const centre = near || (found.hit.location && Number.isFinite(+found.hit.location.lat) ? { lat: +found.hit.location.lat, lng: +found.hit.location.lon } : null);
    const hotels = list.filter(r => r && Number.isFinite(+r.priceFrom) && +r.priceFrom > 0).map(r => {
        const lat = +(r.location?.geo?.lat ?? r.location?.lat), lng = +(r.location?.geo?.lon ?? r.location?.lon);
        const total = Math.round(+r.priceFrom);
        return {
            hotel_id: r.hotelId, name: r.hotelName || null, stars: Number.isFinite(+r.stars) ? +r.stars : null,
            price_from_total: total, price_per_night: Math.round(total / nights), currency: cur.toUpperCase(),
            lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
            distance_from_centre_km: centre && Number.isFinite(lat) ? Math.round(haversineKm(centre.lat, centre.lng, lat, lng) * 10) / 10 : null,
            booking_url: bookingUrl({ destination: areaName, hotelId: r.hotelId, checkIn: stay.checkIn, checkOut: stay.checkOut, currency: cur, locale }, env),
        };
    }).sort((a, b) => a.price_per_night - b.price_per_night);
    // Match the agent's candidates by name (normalised, either way round), then by block.
    const matched = {};
    for (const want of (Array.isArray(names) ? names : [])) {
        const n = typeof want === 'string' ? { name: want } : (want || {});
        const key = _norm(n.name); if (!key) continue;
        let best = hotels.find(h => { const hn = _norm(h.name); return hn && (hn === key || hn.includes(key) || key.includes(hn)); }) || null;
        if (!best && Number.isFinite(n.lat) && Number.isFinite(n.lng)) {
            best = hotels.filter(h => h.lat != null && haversineKm(n.lat, n.lng, h.lat, h.lng) <= MATCH_KM)
                .sort((a, b) => haversineKm(n.lat, n.lng, a.lat, a.lng) - haversineKm(n.lat, n.lng, b.lat, b.lng))[0] || null;
            if (best && _norm(best.name) && key && !(_norm(best.name).split(' ').some(w => w.length > 3 && key.includes(w)))) best = null; // same block, different name → no
        }
        matched[n.name] = best ? { ...best } : null;
    }
    return { ok: true, area: areaName, check_in: stay.checkIn, check_out: stay.checkOut, nights, currency: cur.toUpperCase(), hotels, matched };
}

/** The agent tool. Registered only when the token exists, so the model never reaches for a dead tool. */
const HOTEL_PRICES_TOOL = {
    type: 'function',
    function: {
        name: 'hotel_prices',
        description: 'Real hotel prices from the booking partner for an area, matched to hotels you have already found. Use it when the traveler cares about cost or style (luxury / budget / "how much"), or to put a "from" price on hotel cards. Returns cached "from" prices per night for the stay (default: the coming Saturday night) and the cheapest–priciest range of the area, so you can tell what is luxury or budget THERE. A hotel with no cached price is simply unknown — never guess a number. Costs one call; use it once per turn, after search_places.',
        parameters: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'The town or resort area whose prices you want, e.g. "Sevan", "Dilijan", "Dubai Marina". A place name, not a sentence.' },
                hotel_names: { type: 'array', items: { type: 'string' }, description: 'Names of hotels from search_places results to price (max 8).' },
                check_in: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
                check_out: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
            },
            required: ['area'],
        },
    },
};

module.exports = { hotelsEnabled, hotelPrices, lookupLocation, bookingUrl, defaultStay, HOTEL_PRICES_TOOL, _memo, _norm };
