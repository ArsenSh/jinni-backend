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
// Partner rate limit: sandbox 5 req/s (live Paris run: 8 parallel name lookups,
// then 429 on the rates call). A process-wide pacer keeps us under it, and a
// 429 is retried once after a short wait.
const MIN_GAP_MS = 250;
let _nextSlot = 0;
async function _pace(deps = {}) {
    if (deps.noPace) return;
    const now = Date.now();
    const slot = Math.max(now, _nextSlot);
    _nextSlot = slot + MIN_GAP_MS;
    if (slot > now) await new Promise(r => setTimeout(r, slot - now));
}
async function _call(path, { method = 'GET', query = null, body = null } = {}, deps = {}) {
    const env = deps.env || process.env;
    const url = `${BASE}${path}${query ? `?${_q(query)}` : ''}`;
    const key = `${method} ${url} ${body ? JSON.stringify(body) : ''}`;
    const hit = _memo.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;
    await _pace(deps);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs || TIMEOUT_MS);
    try {
        const res = await doFetch(url, {
            method, signal: ac.signal,
            headers: { Accept: 'application/json', 'X-API-Key': env.HOTEL_PRICES_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status === 429 && !deps._retried) {
            clearTimeout(timer);
            console.warn(`[hotels] ${method} ${path} → 429, retrying once`);
            await new Promise(r => setTimeout(r, deps.noPace ? 0 : 1200));
            return _call(path, { method, query, body }, { ...deps, _retried: true });
        }
        if (!res.ok) { _lastError = { path, status: res.status }; console.warn(`[hotels] ${method} ${path} → ${res.status}`); return null; }
        return _remember(key, await res.json());
    } catch (err) {
        _lastError = { path, status: err.name === 'AbortError' ? 'timeout' : err.message };
        console.warn(`[hotels] ${method} ${path}: ${err.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

const _q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const _norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(hotel|hotels|resort|spa|the|and|&|de|du|des|la|le)\b/g, ' ').replace(/[^a-z0-9\u0400-\u04ff\u0530-\u058f]+/g, ' ').trim();
/** Amount in one currency → another, via the app's rate table; same currency or unknown rate ⇒ unchanged. */
function _convert(amount, from, to) {
    if (!from || !to || from === to) return amount;
    try {
        const cs = require('../../services/currencyService');
        const usd = cs.convertToUSD(amount, from);
        const outAmt = cs.convertFromUSD(usd, to);
        return Number.isFinite(outAmt) && outAmt > 0 ? Math.round(outAmt) : amount;
    } catch { return amount; }
}
const GENERIC = new Set(['hotel','hotels','resort','resorts','spa','the','and','by','a','an','of','de','du','des','la','le','les','el','al','apartments','apartment','suites','suite','inn','boutique','collection','luxury','guesthouse','guest','house','hostel','residence','residences','villa','villas','palace','grand','royal','plaza','city','centre','center','central','old','town','marina','beach']);
/** Distinctive name tokens: accent-folded, lower-cased, minus generic hotel words and the city's own words. */
function _tokens(name, cityTokens = new Set()) {
    return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .split(/[^a-z0-9\u0400-\u04ff\u0530-\u058f]+/).map(t => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1')).filter(t => t.length > 1 && !GENERIC.has(t) && !cityTokens.has(t));   // "14th" = "14"
}
/** Same hotel? The shorter distinctive set must sit inside the longer, and be worth something on its own. */
function _sameHotel(a, b) {
    if (!a.length || !b.length) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const L = new Set(long);
    if (!short.every(t => L.has(t))) return false;
    return short.length >= 2 || short[0].length >= 5;   // "cygne" counts; "ani" alone does not
}
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
/** A stay in the past keeps its month/day and moves to the next year it is still ahead. Null past 2 years (a typo, not a plan). */
function rollForward({ checkIn, checkOut }, now = new Date()) {
    const today = Date.parse(_iso(now));
    let a = new Date(checkIn + 'T12:00:00Z'), b = new Date(checkOut + 'T12:00:00Z'), tries = 0;
    while (Date.parse(_iso(a)) < today && tries < 2) { a.setUTCFullYear(a.getUTCFullYear() + 1); b.setUTCFullYear(b.getUTCFullYear() + 1); tries++; }
    if (Date.parse(_iso(a)) < today) return null;
    return { checkIn: _iso(a), checkOut: _iso(b) };
}
function _nights(a, b) { return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 864e5)); }
const _validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Rooms for a party (2026-09-23, session 6ab3c2ed: "we are 12 people" was
 *  priced as one room for two). Two adults per room, the odd one alone; no
 *  party ⇒ one double. Capped at 12 rooms — beyond that it is a block booking
 *  no rate API answers. The partner returns NO rate for a hotel that cannot
 *  fit every room, which is the capacity signal the narrator lacked. */
function occupanciesFor(party = null) {
    const n = Number.isFinite(+party) && +party > 0 ? Math.min(24, Math.round(+party)) : 0;
    if (!n) return [{ adults: 2 }];
    const rooms = Math.min(12, Math.ceil(n / 2));
    return Array.from({ length: rooms }, (_, i) => ({ adults: (i === rooms - 1 && n % 2 === 1) ? 1 : 2 }));
}

/** Where a traveler lands from "Check rates" — our whitelabel, so the booking is ours. Null without a domain. */
function bookingUrl({ hotelId, checkIn, checkOut, adults = 2, occupancies = null, currency = 'USD', locale = 'en' } = {}, env = process.env) {
    const domain = String(env.HOTEL_PRICES_WL_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain || !hotelId) return null;
    const occ = Buffer.from(JSON.stringify(Array.isArray(occupancies) && occupancies.length ? occupancies : [{ adults }])).toString('base64');
    return `https://${domain}/hotels/${encodeURIComponent(hotelId)}?${_q({ checkin: checkIn, checkout: checkOut, occupancies: occ, currency: String(currency || 'USD').toUpperCase(), language: String(locale || 'en').slice(0, 2) })}`;
}

/**
 * Live "from" prices around a centre, matched to the agent's candidates by name.
 * @param {{ centre:{lat,lng,countryCode,name}, names?:Array<string|{name,lat,lng}>, radiusKm?, checkIn?, checkOut?, currency?, guestNationality?, locale? }} a
 * @returns {Promise<{ ok:boolean, reason?:string, area?, check_in, check_out, nights, currency, hotels:Array, matched:Object }>}
 */
async function hotelPrices({ centre = null, names = [], radiusKm = 15, checkIn = null, checkOut = null, currency = 'USD', guestNationality = 'US', locale = 'en', party = null } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!hotelsEnabled(env)) return { ok: false, reason: 'hotel_prices_disabled' };
    const now = deps.now ? new Date(deps.now) : new Date();
    let stay = _validDate(checkIn) && _validDate(checkOut) && Date.parse(checkOut) > Date.parse(checkIn) ? { checkIn, checkOut } : null;
    if (stay) stay = rollForward(stay, now);   // the model wrote "2025-10-10" in September 2026 — same day, next occurrence
    if (!stay) stay = defaultStay(now);
    const nights = _nights(stay.checkIn, stay.checkOut);
    const cur = String(currency || 'USD').toUpperCase();
    const base = { check_in: stay.checkIn, check_out: stay.checkOut, nights, currency: cur, hotels: [], matched: {} };
    if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng) || !centre.countryCode) return { ok: false, reason: 'centre_unresolved', ...base };
    const radiusM = Math.round(Math.min(Math.max(Number(radiusKm) || 15, 1), 80) * 1000);
    const found = await _call('/data/hotels', { query: { countryCode: String(centre.countryCode).toUpperCase(), latitude: centre.lat, longitude: centre.lng, radius: Math.max(radiusM, 1000), limit: HOTEL_POOL } }, deps);
    const pool = (Array.isArray(found?.data) ? found.data : []).filter(h => h && h.id);
    // The agent's named picks, looked up by name near the centre — a big city's
    // area pool rarely contains them (Paris: 37 priced, 0 of 8 named matched).
    const inPool = (nm) => { const key = _norm(nm); return !!key && pool.some(h => { const hn = _norm(h.name); return hn && (hn === key || hn.includes(key) || key.includes(hn)); }); };
    const wanted = (Array.isArray(names) ? names : []).map(w => typeof w === 'string' ? { name: w } : (w || {})).filter(w => w.name && !inPool(w.name));   // only the ones the pool lacks
    const byName = await Promise.all(wanted.map(async (w) => {
        const q = String(w.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        const at = Number.isFinite(w.lat) ? { latitude: w.lat, longitude: w.lng, radius: 3000 } : { latitude: centre.lat, longitude: centre.lng, radius: Math.max(radiusM, 1000) * 2 };
        const r = await _call('/data/hotels', { query: { countryCode: String(centre.countryCode).toUpperCase(), hotelName: q, ...at, limit: 5 } }, deps);
        // Tagged with the name WE searched for: the partner's own name index
        // resolved it, which is evidence the strict token rule cannot see
        // ("Tufenkian Heritage Hotels" vs the partner's "Tufenkian Historic
        // Yerevan Hotel"). The match loop below trusts that evidence only
        // within 500 m and only with a real word in common.
        return (Array.isArray(r?.data) ? r.data : []).filter(h => h && h.id).map(h => ({ ...h, _forName: w.name }));
    }));
    const seen = new Set(pool.map(h => h.id));
    for (const list of byName) for (const h of list) if (!seen.has(h.id)) { seen.add(h.id); pool.push(h); }
    if (!pool.length) return { ok: false, reason: found === null ? `hotels_call_failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : 'no_hotels_in_index_here', area: centre.name || null, ...base };
    const { rates, priceById, occupancies, perRoom, groupUnavailable, groupRooms } = await _ratesFor(pool, { party, stay, cur, guestNationality }, deps);
    const partnerError = rates && rates.error && typeof rates.error === 'object' ? rates.error : null;   // e.g. {code:2001, message:'no availability found'}
    const hotels = pool.filter(h => priceById.has(h.id)).map(h => {
        const total = Math.round(priceById.get(h.id));
        const lat = +h.latitude, lng = +h.longitude;
        return {
            hotel_id: h.id, name: h.name || null, _forName: h._forName || null, stars: Number.isFinite(+h.stars) && +h.stars > 0 ? +h.stars : null,
            guest_rating: Number.isFinite(+h.rating) && +h.rating > 0 ? +h.rating : null,
            price_from_total: total, price_per_night: Math.round(total / nights), currency: cur,
            rooms: occupancies.length, per_room: perRoom, group_unavailable: groupUnavailable, group_rooms: groupRooms,
            nights, check_in: stay.checkIn, check_out: stay.checkOut,
            lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
            distance_from_centre_km: Number.isFinite(lat) ? Math.round(haversineKm(centre.lat, centre.lng, lat, lng) * 10) / 10 : null,
            booking_url: bookingUrl({ hotelId: h.id, checkIn: stay.checkIn, checkOut: stay.checkOut, occupancies, currency: cur, locale }, env),
        };
    }).sort((a, b) => a.price_per_night - b.price_per_night);
    // Match the agent's candidates to partner hotels — STRICTLY. Live 2026-09-19
    // (founder): a card's price and "Check rates" opened a different hotel whose
    // name "matched a little". The old rule accepted substring names and a
    // shared word inside 600 m — and "Yerevan" is a shared word in half the
    // city. Now: distinctive tokens only (city words and hotel-generic words
    // removed), the shorter token set must be fully inside the longer one and
    // carry ≥ 2 tokens (or 1 token of ≥ 5 letters), and when both sides have
    // coordinates they must be within 1.5 km. No match ⇒ no price — honest.
    const cityTokens = new Set(_tokens(centre.name || '', new Set()));
    const matched = {};
    for (const want of (Array.isArray(names) ? names : [])) {
        const n = typeof want === 'string' ? { name: want } : (want || {});
        if (!n.name) continue;
        const a = _tokens(n.name, cityTokens);
        let best = null, bestD = Infinity, via = 'tokens', refused = null;
        for (const h of hotels) {
            const b = _tokens(h.name, cityTokens);
            const d = Number.isFinite(n.lat) && h.lat != null ? haversineKm(n.lat, n.lng, h.lat, h.lng) : null;
            const strict = _sameHotel(a, b) && !(d != null && d > 1.5);   // a namesake across town is not this hotel
            // NAME VARIANTS (2026-09-23): the same hotel under two brandings
            // — ours from Google, theirs from the catalogue — fails the token
            // rule, so a cached hotel the partner really sells showed no price
            // and no Book button. Accepted only with THREE pieces of evidence
            // together: the partner's own name index returned it for this very
            // name, the two points are within 500 m, and a distinctive word is
            // shared. Strictly safer than the 600 m shared-word rule that once
            // put one hotel's link on another's card (founder 2026-09-19).
            const shared = b.filter(t => a.includes(t));
            const resolved = h._forName === n.name && d != null && d <= 0.5
                && shared.some(t => t.length >= 5);
            if (!strict && !resolved) {
                if (!refused && (shared.length || (d != null && d <= 0.5))) refused = `${h.name}${d != null ? ` ${d.toFixed(2)}km` : ''}${shared.length ? ` shared:${shared.join('+')}` : ''}`;
                continue;
            }
            if ((d ?? 0.5) < bestD) { best = h; bestD = d ?? 0.5; via = strict ? 'tokens' : 'partner-name'; }
        }
        if (!best && refused) console.log(`[hotels] no match for "${n.name}" — nearest refused: ${refused}`);
        if (best) console.log(`[hotels] match "${n.name}" → "${best.name}"${Number.isFinite(bestD) && bestD !== 0.5 ? ` (${bestD.toFixed(2)} km)` : ''} via ${via}`);
        matched[n.name] = best ? { ...best, partner_name: best.name } : null;
    }
    const diag = { hotels_in_index: pool.length, hotels_priced: priceById.size, rates_call: rates === null ? `failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : (partnerError ? `partner: ${partnerError.message || partnerError.code}` : 'ok') };
    if (rates && !priceById.size && !partnerError) {   // priced nothing — show the shape we got, so a doc/reality mismatch is visible
        const first = Array.isArray(rates.data) ? rates.data[0] : null;
        diag.rates_shape = { keys: Object.keys(rates).slice(0, 8), data_length: Array.isArray(rates.data) ? rates.data.length : null, first_keys: first && typeof first === 'object' ? Object.keys(first).slice(0, 10) : null, sample: JSON.stringify(first || rates).slice(0, 300) };
    }
    return { ok: true, area: centre.name || null, ...base, rooms: occupancies.length, hotels, matched, diag };
}

/** Ask the partner for rates, and when a GROUP cannot be booked as one stay,
 *  fall back to ONE room and say so (2026-09-23, live run: twelve travelers in
 *  Yeghegnadzor priced six rooms, nothing in the town could take them, and the
 *  cards lost every price AND every Book button — the honest capacity answer
 *  cost the traveler the number and the link). The fallback keeps both: a real
 *  per-room price, a per-room booking link, and `group_unavailable` so the card
 *  and the narrator say no single booking holds the whole party. Never invents
 *  a group price by multiplying — that is arithmetic, not a quoted rate. */
async function _ratesFor(pool, { party, stay, cur, guestNationality }, deps = {}) {
    const ask = async (occupancies) => {
        const rates = await _call('/hotels/min-rates', { method: 'POST', body: {
            hotelIds: pool.slice(0, 100).map(h => h.id), checkin: stay.checkIn, checkout: stay.checkOut,
            occupancies, currency: cur, guestNationality: String(guestNationality || 'US').toUpperCase().slice(0, 2), timeout: 6,
        } }, deps);
        const priceById = new Map((Array.isArray(rates?.data) ? rates.data : []).filter(r => r && r.hotelId && Number.isFinite(+r.price) && +r.price > 0).map(r => [r.hotelId, +r.price]));
        return { rates, priceById };
    };
    const occupancies = occupanciesFor(party);
    let out = await ask(occupancies);
    if (occupancies.length > 1 && out.priceById.size === 0) {
        const single = [{ adults: 2 }];
        const retry = await ask(single);
        if (retry.priceById.size) {
            console.log(`[hotels] no hotel here takes ${occupancies.length} rooms for this stay → per-room prices instead (${retry.priceById.size} priced)`);
            return { ...retry, occupancies: single, perRoom: true, groupUnavailable: true, groupRooms: occupancies.length };
        }
    }
    return { ...out, occupancies, perRoom: false, groupUnavailable: false, groupRooms: occupancies.length };
}

/** One partner hotel → the row the canonical store turns into a candidate.
 *  Field names are read defensively: the partner's list endpoint has spelled
 *  them a few ways across versions (main_photo/thumbnail, hotelDescription,
 *  reviewCount). Anything missing is null — never invented. */
function _hotelRow(h, centre, { priced = null, cur = 'USD', nights = 1, occupancies = [{ adults: 2 }], perRoom = false, groupUnavailable = false, groupRooms = 1, stay = {}, locale = 'en', env = process.env } = {}) {
    const lat = +h.latitude, lng = +h.longitude;
    const total = priced != null ? Math.round(priced) : null;
    const img = h.main_photo || h.mainPhoto || h.thumbnail || (Array.isArray(h.hotelImages) && h.hotelImages[0]?.url) || null;
    return {
        hotel_id: h.id, name: h.name || null,
        stars: Number.isFinite(+h.stars) && +h.stars > 0 ? +h.stars : null,
        guest_rating: Number.isFinite(+h.rating) && +h.rating > 0 ? Math.round(+h.rating * 10) / 10 : null,
        review_count: Number.isFinite(+h.reviewCount) ? +h.reviewCount : null,
        address: h.address || null, city: h.city || null, country: h.country || null, zip: h.zip || null,
        image: typeof img === 'string' && /^https?:\/\//.test(img) ? img : null,
        description: typeof h.hotelDescription === 'string' ? h.hotelDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : null,
        available: total != null,
        price_from_total: total, price_per_night: total != null ? Math.round(total / nights) : null, currency: cur,
        rooms: occupancies.length, per_room: perRoom, group_unavailable: groupUnavailable, group_rooms: groupRooms,
        nights, check_in: stay.checkIn || null, check_out: stay.checkOut || null,
        lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
        distance_from_centre_km: Number.isFinite(lat) && centre ? Math.round(haversineKm(centre.lat, centre.lng, lat, lng) * 10) / 10 : null,
        booking_url: bookingUrl({ hotelId: h.id, checkIn: stay.checkIn, checkOut: stay.checkOut, occupancies, currency: cur, locale }, env),
    };
}

/**
 * The partner's inventory around a centre AS A SOURCE (founder 2026-09-23:
 * "can it search from booking initially too? … it will give more results
 * than google"). Until now the partner only priced hotels Google had found;
 * two of three Yeghegnadzor cards had no price because the partner does not
 * sell them, and "give lots of results" stopped at Google's page. This lists
 * every hotel the partner sells within the radius, with photo, address,
 * stars, guest score and — for the party, for the stay — a live "from" price
 * and a Book link. Hotels the partner cannot price for that stay come back
 * with available:false; with a party given they cannot fit the group.
 * Fails open: any partner error → { ok:false } and the store carries on.
 */
async function areaHotels({ centre = null, radiusKm = 15, party = null, checkIn = null, checkOut = null, currency = 'USD', guestNationality = 'US', locale = 'en', limit = HOTEL_POOL } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!hotelsEnabled(env)) return { ok: false, reason: 'hotel_prices_disabled', hotels: [] };
    if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng) || !centre.countryCode) return { ok: false, reason: 'centre_unresolved', hotels: [] };
    const now = deps.now ? new Date(deps.now) : new Date();
    let stay = (_validDate(checkIn) && _validDate(checkOut) && Date.parse(checkOut) > Date.parse(checkIn)) ? { checkIn, checkOut } : null;
    if (stay) stay = rollForward(stay, now);
    if (!stay) stay = defaultStay(now);
    const nights = _nights(stay.checkIn, stay.checkOut);
    const cur = String(currency || 'USD').toUpperCase();
    const radiusM = Math.round(Math.min(Math.max(Number(radiusKm) || 15, 1), 80) * 1000);
    const found = await _call('/data/hotels', { query: { countryCode: String(centre.countryCode).toUpperCase(), latitude: centre.lat, longitude: centre.lng, radius: Math.max(radiusM, 1000), limit: Math.min(Math.max(+limit || HOTEL_POOL, 1), 100) } }, deps);
    const pool = (Array.isArray(found?.data) ? found.data : []).filter(h => h && h.id);
    if (!pool.length) return { ok: found !== null, reason: found === null ? `hotels_call_failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : 'no_hotels_in_index_here', hotels: [], diag: { hotels_in_index: 0, hotels_priced: 0 } };
    const { rates, priceById, occupancies, perRoom, groupUnavailable, groupRooms } = await _ratesFor(pool, { party, stay, cur, guestNationality }, deps);
    const hotels = pool.map(h => _hotelRow(h, centre, { priced: priceById.has(h.id) ? priceById.get(h.id) : null, cur, nights, occupancies, perRoom, groupUnavailable, groupRooms, stay, locale, env }))
        .sort((a, b) => (a.available === b.available ? (a.price_per_night ?? 0) - (b.price_per_night ?? 0) : (a.available ? -1 : 1)));
    return { ok: true, area: centre.name || null, check_in: stay.checkIn, check_out: stay.checkOut, nights, currency: cur, rooms: occupancies.length, per_room: perRoom, group_unavailable: groupUnavailable, party: party || null, hotels,
        diag: { hotels_in_index: pool.length, hotels_priced: hotels.filter(h => h.available).length, rates_call: rates === null ? 'failed' : 'ok' } };
}

/** The agent tool. Registered only when the token exists, so the model never reaches for a dead tool. */
const HOTEL_PRICES_TOOL = {
    type: 'function',
    function: {
        name: 'hotel_prices',
        description: 'Real hotel prices from the booking partner for an area, matched to hotels you have already found. Use it when the traveler cares about cost or style (luxury / budget / "how much"), or to put a "from" price on hotel cards. Returns live "from" prices per night for the stay (default: the coming Saturday night) and the cheapest–median–priciest range of the area, so you can tell what is luxury or budget THERE. When the traveler stated a group size, the price is for enough rooms for the whole group and a hotel with no price could not fit them for that stay. A hotel with no price is otherwise simply unknown — never guess a number. One call per turn, after search_places.',
        parameters: {
            type: 'object',
            properties: {
                area: { type: 'string', description: 'The town or resort area whose prices you want, e.g. "Sevan", "Dilijan", "Dubai Marina" — a place name resolvable by lookup_place, or "traveler" for where they are.' },
                hotel_names: { type: 'array', items: { type: 'string' }, description: 'Names of hotels from search_places results to price (max 8).' },
                check_in: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
                check_out: { type: 'string', description: 'YYYY-MM-DD, only when the traveler gave dates.' },
                budget_per_night: { type: 'number', description: 'The traveler\'s stated budget per night, AS THEY SAID IT (e.g. 50000). Returns the priced hotels closest to it, converted for you.' },
                budget_currency: { type: 'string', description: 'ISO code of that budget as the traveler meant it (AMD, USD, EUR, RUB, AED, GBP). Default: their display currency.' },
            },
            required: ['area'],
        },
    },
};

/**
 * Executor for the tool, shared by the deck agent and the answer-path tool
 * loops. Resolves the area to a centre + ISO country via the gazetteer (name →
 * hit; "traveler"/unknown → the settlement around the traveler), prices, and
 * reports matches through `onMatch(nameLower, row)` so cards can carry them.
 */
function makeExecutor({ center = null, sessionCards = [], currency = 'USD', locale = 'en', guestNationality = 'US', fallbackName = null, onMatch = null, party = null } = {}, deps = {}) {
    const gaz = deps.gazetteer || require('../geo/gazetteer');
    return async (a = {}, ctx = {}) => {
        // Coordinates for the strict matcher: this turn's search results first
        // (the agent names hotels it just found), then earlier cards.
        const pool = [...(Array.isArray(ctx.known) ? ctx.known : []), ...sessionCards];
        const names = (Array.isArray(a.hotel_names) ? a.hotel_names : []).slice(0, 8).map(n => {
            const key = String(n).toLowerCase();
            const sc = pool.find(c => c?.name && c.name.toLowerCase() === key);
            const lat = sc ? (sc.geometry?.lat ?? sc.latitude ?? sc.lat) : null, lng = sc ? (sc.geometry?.lng ?? sc.longitude ?? sc.lng) : null;
            return Number.isFinite(lat) ? { name: String(n), lat, lng } : { name: String(n) };
        });
        const areaName = String(a.area || '').slice(0, 80);
        let hit = null;
        if (areaName && areaName.toLowerCase() !== 'traveler') { try { hit = await gaz.lookupPlace(areaName, { near: center || null }); } catch { hit = null; } }
        let centre = hit && Number.isFinite(hit.lat) ? { lat: hit.lat, lng: hit.lng, countryCode: hit.countryCode || null, name: hit.name } : null;
        if ((!centre || !centre.countryCode) && (centre || center)) {
            const at = { lat: centre?.lat ?? center.lat, lng: centre?.lng ?? center.lng };
            let reg = null; try { reg = await gaz.regionAt(at, { maxKm: 60 }); } catch { reg = null; }
            if (reg?.countryCode) centre = { ...at, countryCode: reg.countryCode, name: centre?.name || reg.city || fallbackName || areaName };
        }
        const out = await hotelPrices({ centre, names, radiusKm: hit?.waterBody ? 40 : 15, checkIn: a.check_in || null, checkOut: a.check_out || null, currency, locale, guestNationality, party }, deps);
        console.log(`[hotels] area="${areaName}" centre=${centre ? `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)} ${centre.countryCode} "${centre.name}"` : 'none'}${party ? ` party=${party} rooms=${out.rooms || '?'}` : ''} → ${out.ok ? `index=${out.diag?.hotels_in_index ?? '?'} ${out.hotels.length} priced, matched ${Object.values(out.matched || {}).filter(Boolean).length}/${names.length}` : out.reason}`);
        if (!out.ok) return { error: out.reason, centre: centre ? { name: centre.name, country: centre.countryCode } : null };
        if (onMatch) for (const [name, m] of Object.entries(out.matched || {})) if (m) onMatch(name.toLowerCase(), m);
        // A stated budget: the priced hotels nearest to it — and, when the loop
        // lets us, FETCHED and REGISTERED as dealable candidates with their price
        // attached (live 2026-09-19: the tool named three $130 hotels, the brain
        // had no search left to bring them in and dealt a five-star instead).
        let nearBudget = null, budgetInCur = null;
        if (Number.isFinite(+a.budget_per_night) && +a.budget_per_night > 0 && out.hotels.length) {
            // The budget in the price currency: "50000" said in AMD is ~130 USD, not
            // 50000 USD (live 2026-09-19: the raw number matched the priciest hotels).
            const convert = deps.convert || _convert;
            const budget = convert(+a.budget_per_night, String(a.budget_currency || out.currency).toUpperCase(), out.currency);
            budgetInCur = budget;
            nearBudget = out.hotels.map(h => ({ ...h, gap: Math.abs(h.price_per_night - budget) })).sort((x, y) => x.gap - y.gap).slice(0, 6)
                .map(h => ({ name: h.name, price_per_night: h.price_per_night, stars: h.stars, guest_rating: h.guest_rating, _row: h }));
            const canFetch = (typeof deps.lookupByName === 'function' || typeof deps.retrieve === 'function') && typeof ctx.register === 'function';
            const fetchLog = [];
            if (canFetch) {
                const knownNames = new Set((Array.isArray(ctx.known) ? ctx.known : []).map(c => String(c?.name || '').toLowerCase()));
                const cityTok = new Set(_tokens(centre.name || '', new Set()));
                let fetches = 0;
                for (const nb of nearBudget) {
                    if (fetches >= 3 || knownNames.has(String(nb.name).toLowerCase())) continue;
                    fetches++;
                    const near = nb._row.lat != null ? { lat: nb._row.lat, lng: nb._row.lng } : { lat: centre.lat, lng: centre.lng };
                    const tok = _tokens(nb.name, cityTok);
                    const exact = (p) => p && p.name && _norm(p.name) === _norm(nb.name);   // full-name hit ⇒ accept even when only a short token survives ("Ani Plaza")
                    const fits = (p) => p && p.name && (exact(p) || _sameHotel(tok, _tokens(p.name, cityTok)))
                        && (nb._row.lat == null || !p.geometry || haversineKm(nb._row.lat, nb._row.lng, p.geometry.lat, p.geometry.lng) <= 1.5);
                    let found = null, returned = [];
                    try {
                        // Exact-name lookup first (owned → cache → Google, one place); the
                        // ranked retrieval only as a fallback — it returns whatever ranks
                        // near the point, not the hotel asked for (live 2026-09-19: 0 of 3).
                        if (typeof deps.lookupByName === 'function') {
                            const p = await deps.lookupByName(nb.name, near);
                            returned = p ? [p.name] : [];
                            if (fits(p)) found = p;
                        }
                        if (!found && typeof deps.retrieve === 'function') {
                            const r = await deps.retrieve({ query: nb.name, category: 'hotels', center: near, radiusKm: 3, count: 3 });
                            returned = returned.concat((r?.places || []).map(p => p.name));
                            found = (r?.places || []).find(fits) || null;
                        }
                    } catch (err) { returned.push(`error: ${err.message}`); }
                    fetchLog.push({ wanted: nb.name, returned, registered: !!found });
                    if (!found) continue;
                    found.hotelPrice = { perNight: nb._row.price_per_night, currency: nb._row.currency, nights: 1, checkIn: null, checkOut: null, stars: nb._row.stars, url: nb._row.booking_url };
                    if (onMatch) onMatch(String(found.name).toLowerCase(), { ...nb._row, partner_name: nb._row.name });
                    const summary = ctx.register(found);
                    if (summary?.id) nb.id = summary.id;
                }
            }
            if (fetchLog.length) out.diag = { ...(out.diag || {}), near_budget_fetch: fetchLog };
            // Dealable ones first, each with an explicit status — the brain named
            // hotels it could not deal (live 2026-09-19: text said Best Western,
            // cards showed DoubleTree).
            nearBudget = nearBudget.map(({ _row, ...h }) => ({ ...h, status: h.id ? 'ready to deal' : 'not in Jinni\'s index — do not name it as a pick' }))
                .sort((x, y) => (y.id ? 1 : 0) - (x.id ? 1 : 0));
        }
        const pn = out.hotels.map(h => h.price_per_night);
        return {
            area: out.area, stay: `${out.check_in} → ${out.check_out} (${out.nights} night${out.nights > 1 ? 's' : ''})`, currency: out.currency,
            area_range_per_night: pn.length ? { cheapest: pn[0], median: pn[Math.floor(pn.length / 2)], priciest: pn[pn.length - 1], hotels_priced: pn.length } : null,
            matched: Object.fromEntries(Object.entries(out.matched || {}).map(([n, m]) => [n, m ? { price_per_night: m.price_per_night, stars: m.stars } : 'no live price'])),
            // The traveler's budget: the priced hotels nearest to it, so the brain can
            // bring them into the deck by name (live 2026-09-19: "50000 per night" got a
            // $591 five-star and a no-price guesthouse).
            ...(nearBudget ? { near_budget: nearBudget, near_budget_note: nearBudget.some(h => h.id) ? `priced hotels closest to ${budgetInCur} ${out.currency} per night — the ones with an id are ready to deal` : `priced hotels closest to ${budgetInCur} ${out.currency} per night — to show one, search_places by its exact name` } : {}),
            priciest_in_area: out.hotels.slice(-3).reverse().map(h => ({ name: h.name, price_per_night: h.price_per_night, stars: h.stars })),
            cheapest_in_area: out.hotels.slice(0, 3).map(h => ({ name: h.name, price_per_night: h.price_per_night, stars: h.stars })),
            note: out.hotels.length ? `live "from" prices per night for ${out.group_unavailable ? 'ONE ROOM — no hotel here can take the whole group in a single booking for this stay, so say that plainly and quote these as per-room prices' : (out.rooms > 1 ? `${out.rooms} rooms (the WHOLE group) — a hotel with no price could not take the group for this stay` : '2 adults')}; quote only these numbers, and only for the matched hotels. A matched hotel's live price is what the card shows — quote IT, not an owner's listed price for the same place` : `the booking partner has no availability for this area and stay (${out.diag?.rates_call || 'no rates'}) — say so; do not guess a number`,
            diag: out.diag || null,
        };
    };
}

module.exports = { hotelsEnabled, hotelPrices, areaHotels, occupanciesFor, bookingUrl, defaultStay, rollForward, makeExecutor, _tokens, _sameHotel, HOTEL_PRICES_TOOL, _memo, _norm, _hotelRow };
