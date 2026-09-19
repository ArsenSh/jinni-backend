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
const GENERIC = new Set(['hotel','hotels','resort','resorts','spa','the','and','by','a','an','of','de','du','des','la','le','les','el','al','apartments','apartment','suites','suite','inn','boutique','collection','luxury','guesthouse','guest','house','hostel','residence','residences','villa','villas','palace','grand','royal','plaza','city','centre','center','central','old','town','marina','beach']);
/** Distinctive name tokens: accent-folded, lower-cased, minus generic hotel words and the city's own words. */
function _tokens(name, cityTokens = new Set()) {
    return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .split(/[^a-z0-9\u0400-\u04ff\u0530-\u058f]+/).filter(t => t.length > 1 && !GENERIC.has(t) && !cityTokens.has(t));
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
        return (Array.isArray(r?.data) ? r.data : []).filter(h => h && h.id);
    }));
    const seen = new Set(pool.map(h => h.id));
    for (const list of byName) for (const h of list) if (!seen.has(h.id)) { seen.add(h.id); pool.push(h); }
    if (!pool.length) return { ok: false, reason: found === null ? `hotels_call_failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : 'no_hotels_in_index_here', area: centre.name || null, ...base };
    const rates = await _call('/hotels/min-rates', { method: 'POST', body: {
        hotelIds: pool.slice(0, 100).map(h => h.id), checkin: stay.checkIn, checkout: stay.checkOut,
        occupancies: [{ adults: 2 }], currency: cur, guestNationality: String(guestNationality || 'US').toUpperCase().slice(0, 2), timeout: 6,
    } }, deps);
    const partnerError = rates && rates.error && typeof rates.error === 'object' ? rates.error : null;   // e.g. {code:2001, message:'no availability found'}
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
        let best = null, bestD = Infinity;
        for (const h of hotels) {
            if (!_sameHotel(a, _tokens(h.name, cityTokens))) continue;
            const d = Number.isFinite(n.lat) && h.lat != null ? haversineKm(n.lat, n.lng, h.lat, h.lng) : null;
            if (d != null && d > 1.5) continue;                 // a namesake across town is not this hotel
            if ((d ?? 0.5) < bestD) { best = h; bestD = d ?? 0.5; }
        }
        if (best) console.log(`[hotels] match "${n.name}" → "${best.name}"${Number.isFinite(bestD) && bestD !== 0.5 ? ` (${bestD.toFixed(2)} km)` : ''}`);
        matched[n.name] = best ? { ...best, partner_name: best.name } : null;
    }
    const diag = { hotels_in_index: pool.length, hotels_priced: priceById.size, rates_call: rates === null ? `failed ${_lastError ? `${_lastError.status} ${_lastError.path}` : ''}`.trim() : (partnerError ? `partner: ${partnerError.message || partnerError.code}` : 'ok') };
    if (rates && !priceById.size && !partnerError) {   // priced nothing — show the shape we got, so a doc/reality mismatch is visible
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

/**
 * Executor for the tool, shared by the deck agent and the answer-path tool
 * loops. Resolves the area to a centre + ISO country via the gazetteer (name →
 * hit; "traveler"/unknown → the settlement around the traveler), prices, and
 * reports matches through `onMatch(nameLower, row)` so cards can carry them.
 */
function makeExecutor({ center = null, sessionCards = [], currency = 'USD', locale = 'en', guestNationality = 'US', fallbackName = null, onMatch = null } = {}, deps = {}) {
    const gaz = deps.gazetteer || require('../geo/gazetteer');
    return async (a = {}) => {
        const names = (Array.isArray(a.hotel_names) ? a.hotel_names : []).slice(0, 8).map(n => {
            const sc = sessionCards.find(c => c?.name && c.name.toLowerCase() === String(n).toLowerCase());
            return sc && Number.isFinite(sc.latitude ?? sc.lat) ? { name: String(n), lat: sc.latitude ?? sc.lat, lng: sc.longitude ?? sc.lng } : { name: String(n) };
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
        const out = await hotelPrices({ centre, names, radiusKm: hit?.waterBody ? 40 : 15, checkIn: a.check_in || null, checkOut: a.check_out || null, currency, locale, guestNationality }, deps);
        console.log(`[hotels] area="${areaName}" centre=${centre ? `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)} ${centre.countryCode} "${centre.name}"` : 'none'} → ${out.ok ? `${out.hotels.length} priced, matched ${Object.values(out.matched || {}).filter(Boolean).length}/${names.length}` : out.reason}`);
        if (!out.ok) return { error: out.reason, centre: centre ? { name: centre.name, country: centre.countryCode } : null };
        if (onMatch) for (const [name, m] of Object.entries(out.matched || {})) if (m) onMatch(name.toLowerCase(), m);
        const pn = out.hotels.map(h => h.price_per_night);
        return {
            area: out.area, stay: `${out.check_in} → ${out.check_out} (${out.nights} night${out.nights > 1 ? 's' : ''})`, currency: out.currency,
            area_range_per_night: pn.length ? { cheapest: pn[0], median: pn[Math.floor(pn.length / 2)], priciest: pn[pn.length - 1], hotels_priced: pn.length } : null,
            matched: Object.fromEntries(Object.entries(out.matched || {}).map(([n, m]) => [n, m ? { price_per_night: m.price_per_night, stars: m.stars } : 'no live price'])),
            priciest_in_area: out.hotels.slice(-3).reverse().map(h => ({ name: h.name, price_per_night: h.price_per_night, stars: h.stars })),
            cheapest_in_area: out.hotels.slice(0, 3).map(h => ({ name: h.name, price_per_night: h.price_per_night, stars: h.stars })),
            note: out.hotels.length ? 'live "from" prices per night for 2 adults; quote only these numbers, and only for the matched hotels. A matched hotel\'s live price is what the card shows — quote IT, not an owner\'s listed price for the same place' : `the booking partner has no availability for this area and stay (${out.diag?.rates_call || 'no rates'}) — say so; do not guess a number`,
            diag: out.diag || null,
        };
    };
}

module.exports = { hotelsEnabled, hotelPrices, bookingUrl, defaultStay, rollForward, makeExecutor, _tokens, _sameHotel, HOTEL_PRICES_TOOL, _memo, _norm };
