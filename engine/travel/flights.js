// Jinni V2 Engine — flight prices via Travelpayouts (Aviasales/Hotellook).
// Arsen 2026-08-23: "can it check airport or trips? … build it now so it is
// ready".
//
// WHY an affiliate API and not a scraper: flight prices are personalized,
// JS-rendered and bot-protected, so scraping them is brittle, blockable and
// against those sites' terms. Travelpayouts is the opposite trade — an
// official API that PAYS a commission when a traveler books through the link,
// so flights become a feature that earns instead of costing (monetization doc:
// pay-per-lead). Numbers shown to travelers come from THIS call, never from
// model memory — the cards' honesty rule, applied to prose.
//
// Setup: TRAVELPAYOUTS_TOKEN (API token) and TRAVELPAYOUTS_MARKER (affiliate
// id) in Coolify env. Without the token every function fails open — Jinni
// answers transport questions exactly as it does today, minus prices.

const PRICES_URL = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';
const AUTOCOMPLETE_URL = 'https://autocomplete.travelpayouts.com/places2';
const BOOK_HOST = 'https://www.aviasales.com';
const TIMEOUT_MS = 6000;
const IATA_CACHE = new Map();       // 'dubai' → 'DXB'; process-lifetime, tiny

// ── Airline code → display name ("W6" → "Wizz Air") ─────────────────────────
// Travelpayouts ships a free static airlines.json; fetched once per process
// per day, with a bundled fallback of carriers common out of EVN so cards
// stay readable even when the fetch fails. Unknown codes fall back to the
// code itself — an honest label, never a guessed name.
const AIRLINES_URL = 'https://api.travelpayouts.com/data/en/airlines.json';
const AIRLINE_FALLBACK = {
    W6: 'Wizz Air', W4: 'Wizz Air Malta', FZ: 'flydubai', G9: 'Air Arabia',
    A3: 'Aegean Airlines', QR: 'Qatar Airways', EK: 'Emirates', TK: 'Turkish Airlines',
    PC: 'Pegasus', LO: 'LOT', BT: 'airBaltic', OS: 'Austrian', LH: 'Lufthansa',
    AF: 'Air France', KL: 'KLM', BA: 'British Airways', LX: 'SWISS',
    SU: 'Aeroflot', S7: 'S7 Airlines', U6: 'Ural Airlines', WZ: 'Red Wings',
    A4: 'Azimuth', UT: 'Utair', N4: 'Nordwind', DP: 'Pobeda',
    '3F': 'FlyOne Armenia', '5F': 'FlyOne', RM: 'Armenia Airways',
    B2: 'Belavia', HY: 'Uzbekistan Airways', KC: 'Air Astana', J2: 'AZAL',
    EY: 'Etihad', WY: 'Oman Air', ME: 'MEA', RJ: 'Royal Jordanian',
    AZ: 'ITA Airways', IB: 'Iberia', VY: 'Vueling', FR: 'Ryanair', U2: 'easyJet',
};
let AIRLINE_NAMES = null;
let _airlinesTriedAt = 0;
async function airlineName(code, deps = {}) {
    if (!code) return null;
    const c = String(code).toUpperCase();
    if (!AIRLINE_NAMES && Date.now() - _airlinesTriedAt > 24 * 3600e3) {
        _airlinesTriedAt = Date.now();
        const json = await _getJson(AIRLINES_URL, deps);
        if (Array.isArray(json)) {
            AIRLINE_NAMES = Object.fromEntries(
                json.filter(a => a && a.code && a.name).map(a => [String(a.code).toUpperCase(), a.name])
            );
        }
    }
    return (AIRLINE_NAMES && AIRLINE_NAMES[c]) || AIRLINE_FALLBACK[c] || c;
}

function flightsEnabled(env = process.env) {
    return !!env.TRAVELPAYOUTS_TOKEN;
}

async function _getJson(url, deps = {}) {
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs || TIMEOUT_MS);
    try {
        const res = await doFetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn(`[flights] ${String(url).split('?')[0]}: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** City name → IATA code. Already-IATA input passes through untouched. */
async function resolveIata(term, deps = {}) {
    const t = String(term || '').trim();
    if (!t) return null;
    if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();       // already a code
    const key = t.toLowerCase();
    if (IATA_CACHE.has(key)) return IATA_CACHE.get(key);
    const json = await _getJson(
        `${AUTOCOMPLETE_URL}?term=${encodeURIComponent(t)}&locale=en&types[]=city&types[]=airport`, deps);
    const code = Array.isArray(json) ? (json.find(p => p?.code)?.code || null) : null;
    if (code) IATA_CACHE.set(key, code);
    return code;
}

/** Affiliate-tagged booking URL for one offer. */
function _bookUrl(link, env = process.env) {
    if (!link) return null;
    const marker = env.TRAVELPAYOUTS_MARKER;
    const abs = /^https?:\/\//i.test(link) ? link : `${BOOK_HOST}${link}`;
    if (!marker) return abs;
    return `${abs}${abs.includes('?') ? '&' : '?'}marker=${encodeURIComponent(marker)}`;
}

/**
 * Cheapest known fares for a route. null when the feature is off or the API
 * gave nothing — callers must degrade to prose, never to invented prices.
 * @param {object} args { origin, destination, departDate?, returnDate?, currency?, limit? }
 * @returns {Promise<{origin,destination,currency,offers:[]}|null>}
 */
async function searchFlights({ origin, destination, departDate = null, returnDate = null, currency = 'usd', limit = 4 } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!flightsEnabled(env)) return null;
    const [from, to] = await Promise.all([resolveIata(origin, deps), resolveIata(destination, deps)]);
    if (!from || !to) return null;

    const q = new URLSearchParams({
        origin: from, destination: to, currency: String(currency).toLowerCase(),
        sorting: 'price', limit: String(Math.min(10, Math.max(1, limit))),
        one_way: returnDate ? 'false' : 'true', token: env.TRAVELPAYOUTS_TOKEN,
    });
    // Travelpayouts accepts YYYY-MM-DD (one day) or YYYY-MM (a whole month —
    // so "cheapest in September" answers itself).
    if (departDate) q.set('departure_at', departDate);
    if (returnDate) q.set('return_at', returnDate);

    const json = await _getJson(`${PRICES_URL}?${q}`, deps);
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) return null;
    const out = {
        origin: from,
        destination: to,
        currency: String(currency).toUpperCase(),
        offers: rows.slice(0, limit).map(r => _rowToOffer(r, env)),
    };
    // Enrich with display names (codes repeat; the lookup is cached).
    for (const o of out.offers) o.airlineName = await airlineName(o.airline, deps);
    return out;
}

function _rowToOffer(r, env) {
    return {
        price: r.price ?? null,
        airline: r.airline || null,
        flightNumber: r.flight_number ? `${r.airline || ''}${r.flight_number}` : null,
        departureAt: r.departure_at || null,
        returnAt: r.return_at || null,
        transfers: typeof r.transfers === 'number' ? r.transfers : null,
        durationMin: typeof r.duration === 'number' ? r.duration : null,
        bookUrl: _bookUrl(r.link, env),
    };
}

// ── A date WINDOW, and the nearest fares when the window has none ────────────
//
//  The fare feed is a CACHE of prices other travelers were recently shown, not
//  a schedule: on Yerevan–Moscow it held one dated fare (15 Sep) and nothing
//  for the 14th (live 2026-09-13). Asked for one day, the day query answers
//  "no fares" and the traveler learns nothing; asked for "this week", a day
//  query cannot even be formed. So a window is served from the MONTH queries
//  that cover it: everything inside the window is the answer, and when that
//  is empty the closest dated fares the route DOES have are handed back,
//  labeled as such — "nothing on the 14th; the nearest I have is the 15th".
//  Never a price the feed did not return.

const _isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const _isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const _dayOf = (s) => String(s || '').slice(0, 10);

/** The YYYY-MM strings that cover [from, to] — usually one, two across a month end. */
function monthsCovering(from, to) {
    const out = [];
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const end = to.slice(0, 7);
    for (let i = 0; i < 12; i++) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        out.push(ym);
        if (ym >= end) break;
        m++; if (m > 12) { m = 1; y++; }
    }
    return out;
}

/** Split fare rows into those inside the window (cheapest first) and, for the
 *  rest, the closest to it (nearest first, then cheapest). Rows without a
 *  usable date belong to neither — an undated fare cannot answer a dated ask. */
function pickWindow(rows, from, to) {
    const dayMs = 86400000;
    const t = (s) => Date.parse(`${s}T00:00:00Z`);
    const lo = t(from), hi = t(to);
    const inWindow = [], outside = [];
    for (const r of rows || []) {
        const d = _dayOf(r?.departure_at);
        if (!_isDay(d)) continue;
        const x = t(d);
        if (x >= lo && x <= hi) inWindow.push(r);
        else outside.push({ r, dist: Math.round((x < lo ? lo - x : x - hi) / dayMs) });
    }
    const price = (r) => (Number.isFinite(r?.price) ? r.price : Infinity);
    inWindow.sort((a, b) => price(a) - price(b));
    outside.sort((a, b) => a.dist - b.dist || price(a.r) - price(b.r));
    return { inWindow, nearest: outside.map(o => o.r) };
}

/** Last calendar day of a YYYY-MM. */
const _monthEnd = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * Fares inside a departure window, or the nearest dated fares when it holds
 * none. `from`/`to` are YYYY-MM-DD (a single day when equal). Returns null only
 * when the feature is off or a city cannot be resolved — an EMPTY window is an
 * answer and comes back as { offers: [], nearest: [...] }.
 */
async function searchFlightsWindow({ origin, destination, from, to = from, currency = 'usd', limit = 4, nearestLimit = 3 } = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!flightsEnabled(env)) return null;
    if (!_isDay(from) || !_isDay(to)) return null;
    if (to < from) [from, to] = [to, from];
    const [f, t] = await Promise.all([resolveIata(origin, deps), resolveIata(destination, deps)]);
    if (!f || !t) return null;

    const rows = [];
    for (const ym of monthsCovering(from, to)) {
        const q = new URLSearchParams({
            origin: f, destination: t, currency: String(currency).toLowerCase(),
            sorting: 'price', limit: '100', one_way: 'true', departure_at: ym, token: env.TRAVELPAYOUTS_TOKEN,
        });
        const json = await _getJson(`${PRICES_URL}?${q}`, deps);
        if (Array.isArray(json?.data)) rows.push(...json.data);
    }
    const { inWindow, nearest } = pickWindow(rows, from, to);
    const out = {
        origin: f, destination: t, currency: String(currency).toUpperCase(),
        window: { from, to },
        offers: inWindow.slice(0, limit).map(r => _rowToOffer(r, env)),
        // Only offered when the window itself is empty — otherwise a fare from
        // another week would sit beside the real answer and blur it.
        nearest: inWindow.length ? [] : nearest.slice(0, nearestLimit).map(r => _rowToOffer(r, env)),
    };
    for (const o of [...out.offers, ...out.nearest]) o.airlineName = await airlineName(o.airline, deps);
    return out;
}

/** A tool argument → a [from, to] window: a day, or a whole YYYY-MM month. */
function windowFor({ departDate = null, departFrom = null, departTo = null } = {}) {
    if (_isDay(departFrom) || _isDay(departTo)) {
        const a = _isDay(departFrom) ? departFrom : departTo;
        const b = _isDay(departTo) ? departTo : departFrom;
        return { from: a < b ? a : b, to: a < b ? b : a };
    }
    if (_isDay(departDate)) return { from: departDate, to: departDate };
    if (_isMonth(departDate)) return { from: `${departDate}-01`, to: _monthEnd(departDate) };
    return null;
}

module.exports = { searchFlights, searchFlightsWindow, windowFor, monthsCovering, pickWindow, resolveIata, flightsEnabled, airlineName, _bookUrl, PRICES_URL, AUTOCOMPLETE_URL };
