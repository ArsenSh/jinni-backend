// Jinni V3 Engine — real hotel prices via liteAPI (Nuitee Connect).
// Arsen 2026-09-19: "lets add some tool to test the price … almost every
// hotel exists in booking.com" — the agent needs REAL numbers to tell luxury
// from budget and to quote a "from" price, not Google's $–$$$$ guess.
//
// History: first written against Travelpayouts' Hotellook data API the same
// day — Hotellook had been SHUT DOWN on 2025-10-20 (every path 404s), and
// Travelpayouts now offers hotels as commission links only. liteAPI is the
// replacement: an official partner API (never a scraper), free for the
// rates → prebook → book flow under a reasonable look-to-book ratio, and it
// PAYS a commission on bookings made through our whitelabel link.
//
// Two calls per priced turn, both memoised 6 h:
//   GET  /data/hotels     — hotels around a centre (id, name, stars, coords)
//   POST /hotels/min-rates — the cheapest live rate per hotel for a stay
//
// Setup (Coolify backend env):
//   HOTEL_PRICES_TOKEN      liteAPI key — sandbox key first, production later
//   HOTEL_PRICES_WL_DOMAIN  the account's whitelabel booking domain (optional;
//                           without it cards show the price row but no link)
// Without the token everything fails open — the agent gets no hotel_prices
// tool and answers exactly as it does today, minus prices.

const BASE = 'https://api.liteapi.travel/v3.0';
const TIMEOUT_MS = 8000;
const TTL_MS = 6 * 3600e3;          // "from" prices move slowly; 6 h is honest enough
const MAX_MEMO = 300;
const MATCH_KM = 0.6;               // same hotel ⇒ same block; the name is the tie-breaker
const HOTEL_POOL = 50;              // hotels priced per area call
let _lastError = null;              // { path, status } of the last failed call — surfaced in diag
const _memo = new Map();            // key → { at, value }

function hotelsEnabled(env = process.env) { return !!env.HOTEL_PRICES_TOKEN; }

function _remember(key, value) {
    if (_memo.size >= MAX_MEMO) _memo.delete(_memo.keys().next().value);
    _memo.set(key, { at: Date.now(), value });
    return value;
}
async function _call(path, { method = 'GET', query = null, body = null } = {}, deps = {}) {
    const env = deps.env || process.env;
    const url = `${BASE}${path}${query ? `?${_q(query)}` : ''}`;
    const key = `${method} ${url} ${body ? JSON.stringify(body) : ''}`;
    const hit = _memo.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs || TIMEOUT_MS);
    try {
        const res = await doFetch(url, {
            method, signal: ac.signal,
            headers: { Accept: 'application/json', 'X-API-Key': env.HOTEL_PRICES_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) { _lastError = { path, status: res.status }; console.warn(`[hotels] ${method} ${path} → ${res.status}`); return null; }
        return _remember(key, await res.json());
    } catch (err) {
        _lastError = { path, status: err.name === 'AbortError' ? 'timeout' : err.message };
        console.warn(`[hotels] ${method} ${path}: ${err.message}`);
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

/** Where a traveler lands from "Check rates" — our whitelabel, so the booking is ours. Null without a domain. */
function bookingUrl({ hotelId, checkIn, checkOut, adults = 2, currency = 'USD', locale = 'en' } = {}, env = process.env) {
    const domain = String(env.HOTEL_PRICES_WL_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain || !hotelId) return null;
    const occ = Buffer.from(JSON.stringify([{ adults }])).toString('base64');
    return `https://${domain}/hotels/${encodeURIComponent(hotelId)}?${_q({ checkin: checkIn, checkout: checkOut, occupancies: occ, currency: String(currency || 'USD').toUpperCase(), language: String(locale || 'en').slice(0, 2) })}`;
}

/**
 * Live "from" prices around a centre, matched to the agent's candidates by name.
 * @param {{ centre:{lat,lng,countryCode,name}, names?:Array<string|{name,lat,lng}>, radiusKm?, checkIn?, checkOut?, currency?, guestNationality?, locale? }} a
 * @returns {Promise<{ ok:boolean, reason?:string, area?, check_in, check_out, nights, currency, hotels:Array, matched:Object }>}
 */
async function hotelPrices({ centre = null, names = [], radiusKm = 15, checkIn = null, checkOut = null, currency = 'USD', guestNationality = 'US', locale = 'en' } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!hotelsEnabled(env)) return { ok: false, reason: 'hotel_prices_disabled' };
    const stay = _validDate(checkIn) && _validDate(checkOut) && Date.parse(checkOut) > Date.parse(checkIn) ? { checkIn, checkOut } : defaultStay(deps.now ? new Date(deps.now) : new Date());
    const nights = _nights(stay.checkIn, stay.checkOut);
    const cur = String(currency || 'USD').toUpperCase();
    const base = { check_in: stay.checkIn, check_out: stay.checkOut, nights, currency: cur, hotels: [], matched: {} };
    if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng) || !centre.countryCode) return { ok: false, reason: 'centre_unresolved', ...base };
    const radiusM = Math.round(Math.min(Math.max(Number(radiusKm) || 15, 1), 80) * 1000);
    const found = await _call('/data/hotels', { query: { countryCode: String(centre.countryCode).toUpperCase(), latitude: centre.lat, longitude: centre.lng, radius: Math.max(radiusM, 1000), limit: HOTEL_POOL } }, deps);
    const pool = (Array.isArray(found?.data) ? found.data : []).filter(h => h && h.id);
    if (!pool.length) return { ok: false, reason: found === null ? `hotels_call_failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : 'no_hotels_in_index_here', area: centre.name || null, ...base };
    const rates = await _call('/hotels/min-rates', { method: 'POST', body: {
        hotelIds: pool.map(h => h.id), checkin: stay.checkIn, checkout: stay.checkOut,
        occupancies: [{ adults: 2 }], currency: cur, guestNationality: String(guestNationality || 'US').toUpperCase().slice(0, 2), timeout: 6,
    } }, deps);
    const priceById = new Map((Array.isArray(rates?.data) ? rates.data : []).filter(r => r && r.hotelId && Number.isFinite(+r.price) && +r.price > 0).map(r => [r.hotelId, +r.price]));
    const hotels = pool.filter(h => priceById.has(h.id)).map(h => {
        const total = Math.round(priceById.get(h.id));
        const lat = +h.latitude, lng = +h.longitude;
        return {
            hotel_id: h.id, name: h.name || null, stars: Number.isFinite(+h.stars) && +h.stars > 0 ? +h.stars : null,
            guest_rating: Number.isFinite(+h.rating) && +h.rating > 0 ? +h.rating : null,
            price_from_total: total, price_per_night: Math.round(total / nights), currency: cur,
            lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
            distance_from_centre_km: Number.isFinite(lat) ? Math.round(haversineKm(centre.lat, centre.lng, lat, lng) * 10) / 10 : null,
            booking_url: bookingUrl({ hotelId: h.id, checkIn: stay.checkIn, checkOut: stay.checkOut, currency: cur, locale }, env),
        };
    }).sort((a, b) => a.price_per_night - b.price_per_night);
    // Match the agent's candidates by name (normalised, either way round), then by block + a shared word.
    const matched = {};
    for (const want of (Array.isArray(names) ? names : [])) {
        const n = typeof want === 'string' ? { name: want } : (want || {});
        const key = _norm(n.name); if (!key) continue;
        let best = hotels.find(h => { const hn = _norm(h.name); return hn && (hn === key || hn.includes(key) || key.includes(hn)); }) || null;
        if (!best && Number.isFinite(n.lat) && Number.isFinite(n.lng)) {
            best = hotels.filter(h => h.lat != null && haversineKm(n.lat, n.lng, h.lat, h.lng) <= MATCH_KM)
                .sort((a, b) => haversineKm(n.lat, n.lng, a.lat, a.lng) - haversineKm(n.lat, n.lng, b.lat, b.lng))[0] || null;
            if (best && !_norm(best.name).split(' ').some(w => w.length > 3 && key.includes(w))) best = null;
        }
        matched[n.name] = best ? { ...best } : null;
    }
    const diag = { hotels_in_index: pool.length, hotels_priced: priceById.size, rates_call: rates === null ? `failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : 'ok' };
    if (rates && !priceById.size) {   // priced nothing — show the shape we got, so a doc/reality mismatch is visible
        const first = Array.isArray(rates.data) ? rates.data[0] : null;
        diag.rates_shape = { keys: Object.keys(rates).slice(0, 8), data_length: Array.isArray(rates.data) ? rates.data.length : null, first_keys: first && typeof first === 'object' ? Object.keys(first).slice(0, 10) : null, sample: JSON.stringify(first || rates).slice(0, 300) };
    }
    return { ok: true, area: centre.name || null, ...base, hotels, matched, diag };
}

/** The agent tool. Registered only when the token exists, so the model never reaches for a dead tool. */
const HOTEL_PRICES_TOOL = {
    type: 'function',
    function: {
        name: 'hotel_prices',
        description: 'Real hotel prices from the booking partner for an area, matched to hotels you have already found. Use it when the traveler cares about cost or style (luxury / budget / "how much"), or to put a "from" price on hotel cards. Returns live "from" prices per night for the stay (default: the coming Saturday night) and the cheapest–median–priciest range of the area, so you can tell what is luxury or budget THERE. A hotel with no price is simply unknown — never guess a number. One call per turn, after search_places.',
        parameters: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'The town or resort area whose prices you want, e.g. "Sevan", "Dilijan", "Dubai Marina" — a place name resolvable by lookup_place, or "traveler" for where they are.' },
                hotel_names: { type: 'array', items: { type: 'string' }, description: 'Names of hotels from search_places results to price (max 8).' },
                check_in: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
                check_out: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
            },
            required: ['area'],
        },
    },
};

module.exports = { hotelsEnabled, hotelPrices, bookingUrl, defaultStay, HOTEL_PRICES_TOOL, _memo, _norm };
