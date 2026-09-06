// ─────────────────────────────────────────────────────────────────────────────
//  flightDealsRoutes.js — "Where to escape this week" (founder 2026-09-06).
//
//  Self-contained & deletable: this file + one mount line in server.js +
//  frontend components/ui/FlightDeals.vue (+ its two wiring lines) are the
//  whole feature. Reuses engine/travel/flights.js (the standing Travelpayouts
//  tool) — that file stays regardless, it powers chat's find_flights.
//
//  Data honesty: prices are Travelpayouts CACHED fares (recently seen, not a
//  live booking guarantee) — the UI carries a caveat line, and every card
//  links to Aviasales with our affiliate marker (the feature EARNS, never
//  costs; API is free). Without TRAVELPAYOUTS_TOKEN everything here answers
//  {enabled:false} and the strip stays invisible — fail dark, like flights.js.
//
//  Endpoints (public, aggressively cached in-process):
//    GET /deals?origin=EVN&currency=amd&locale=en   popular directions + prices
//    GET /week?origin&destination&month=YYYY-MM     cheapest dates for a month
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { flightsEnabled, searchFlights, _bookUrl, AUTOCOMPLETE_URL } = require('../engine/travel/flights');

const DIRECTIONS_URL = 'https://api.travelpayouts.com/v1/city-directions';
const TTL_DEALS = 12 * 3600e3;   // popular-directions feed barely moves
const TTL_WEEK  = 6 * 3600e3;
const cache = new Map();
const hit = (k, ttl) => { const e = cache.get(k); return e && Date.now() - e.at < ttl ? e.data : null; };
const put = (k, d) => { cache.set(k, { at: Date.now(), data: d }); return d; };

async function getJson(url) {
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 7000);
        const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
        clearTimeout(t);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

// IATA → display name via Travelpayouts autocomplete; tiny process-lifetime
// cache (one hit per code+locale, ever). Unsupported locales fall back to en.
const AUTOCOMPLETE_LOCALES = new Set(['en', 'ru', 'fr', 'de', 'it', 'es', 'pl']);
const NAME_CACHE = new Map();
async function cityName(code, locale) {
    const loc = AUTOCOMPLETE_LOCALES.has(locale) ? locale : 'en';
    const key = `${code}:${loc}`;
    if (NAME_CACHE.has(key)) return NAME_CACHE.get(key);
    const json = await getJson(`${AUTOCOMPLETE_URL}?term=${encodeURIComponent(code)}&locale=${loc}&types[]=city&types[]=airport`);
    const row = Array.isArray(json) ? json.find(r => (r.code || '').toUpperCase() === code) : null;
    const name = (row && (row.city_name || row.name)) || code;
    NAME_CACHE.set(key, name);
    return name;
}

const iata = (v, dflt) => (/^[A-Za-z]{3}$/.test(String(v || '')) ? String(v).toUpperCase() : dflt);
const CURRENCIES = new Set(['amd', 'usd', 'eur', 'rub']);

router.get('/deals', async (req, res) => {
    try {
        if (!flightsEnabled()) return res.json({ enabled: false });
        const origin = iata(req.query.origin, 'EVN');
        const currency = CURRENCIES.has(String(req.query.currency || '').toLowerCase()) ? String(req.query.currency).toLowerCase() : 'amd';
        const locale = String(req.query.locale || 'en').slice(0, 2);
        const key = `deals:${origin}:${currency}:${locale}`;
        const c = hit(key, TTL_DEALS);
        if (c) return res.json(c);

        const json = await getJson(`${DIRECTIONS_URL}?origin=${origin}&currency=${currency}&token=${process.env.TRAVELPAYOUTS_TOKEN}`);
        const rows = Object.values(json?.data || {})
            .filter(r => r && r.price && r.destination)
            .sort((a, b) => a.price - b.price)
            .slice(0, 14);
        if (!rows.length) return res.json(put(key, { enabled: true, currency: currency.toUpperCase(), deals: [] }));

        const deals = [];
        for (const r of rows) {
            const name = await cityName(String(r.destination).toUpperCase(), locale);
            // Aviasales deep link: ORIGIN + DDMM + DEST + 1 passenger.
            const d = r.departure_at ? new Date(r.departure_at) : null;
            const ddmm = d ? `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}` : '';
            deals.push({
                destination: String(r.destination).toUpperCase(), name,
                price: r.price, airline: r.airline || null,
                departureAt: r.departure_at || null, returnAt: r.return_at || null,
                transfers: typeof r.transfers === 'number' ? r.transfers : null,
                bookUrl: _bookUrl(`/search/${origin}${ddmm}${String(r.destination).toUpperCase()}1`),
            });
        }
        res.json(put(key, { enabled: true, currency: currency.toUpperCase(), deals }));
    } catch (err) {
        console.error('[flightdeals] deals error:', err);
        res.status(500).json({ error: 'Failed to load deals' });
    }
});

router.get('/week', async (req, res) => {
    try {
        if (!flightsEnabled()) return res.json({ enabled: false });
        const origin = iata(req.query.origin, 'EVN');
        const destination = iata(req.query.destination, null);
        if (!destination) return res.status(400).json({ error: 'destination required' });
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : new Date().toISOString().slice(0, 7);
        const currency = CURRENCIES.has(String(req.query.currency || '').toLowerCase()) ? String(req.query.currency).toLowerCase() : 'amd';
        const key = `week:${origin}:${destination}:${month}:${currency}`;
        const c = hit(key, TTL_WEEK);
        if (c) return res.json(c);

        // Whole-month query, price-sorted — the strip shows the cheapest dates.
        const found = await searchFlights({ origin, destination, departDate: month, currency, limit: 8 });
        const days = (found?.offers || [])
            .filter(o => o.price && o.departureAt)
            .map(o => ({ date: o.departureAt, price: o.price, transfers: o.transfers, bookUrl: o.bookUrl }))
            .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        res.json(put(key, { enabled: true, currency: (found?.currency || currency).toUpperCase(), days }));
    } catch (err) {
        console.error('[flightdeals] week error:', err);
        res.status(500).json({ error: 'Failed to load dates' });
    }
});

module.exports = router;
