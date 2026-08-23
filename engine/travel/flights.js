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
    return {
        origin: from,
        destination: to,
        currency: String(currency).toUpperCase(),
        offers: rows.slice(0, limit).map(r => ({
            price: r.price ?? null,
            airline: r.airline || null,
            flightNumber: r.flight_number ? `${r.airline || ''}${r.flight_number}` : null,
            departureAt: r.departure_at || null,
            returnAt: r.return_at || null,
            transfers: typeof r.transfers === 'number' ? r.transfers : null,
            durationMin: typeof r.duration === 'number' ? r.duration : null,
            bookUrl: _bookUrl(r.link, env),
        })),
    };
}

module.exports = { searchFlights, resolveIata, flightsEnabled, _bookUrl, PRICES_URL, AUTOCOMPLETE_URL };
