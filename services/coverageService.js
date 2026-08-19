// services/coverageService.js
//
// Cache-warmth Google gate ("Coverage"). Answers one question per request:
// given this quick-action category and this location, is the local place cache
// warm enough that Google should NOT be called?
//
// Warmth is measured per CITY × CATEGORY, not per country — "Armenia has 500
// restaurants" really means "Yerevan has 460", and a country ratio would either
// starve the small cities or overspend in the capital. City = the `city` field
// PlaceCache already carries; a request is assigned to the nearest known city
// centroid (computed from the cached places themselves — no geocode call).
//
// warmth% = cached count ÷ target for that city+category. Targets come from
// AppConfig (per-category defaults, optional per-city overrides), and each
// city×category cell can be forced 'on'/'off' regardless of warmth. The whole
// gate sits behind a master switch (coverageGate, default OFF) so deploying
// this changes nothing until the admin enables it.
//
// Fail-open by design: any error, unknown city, missing location, or unknown
// category → Google stays allowed. The gate may only ever SAVE money, never
// break a cold-area request.
//
// 'events' here means cached event VENUES (halls, theaters — places where
// events happen), i.e. the Google place lookups behind event cards. The Claude
// web search that finds fresh event LISTINGS is a different pipe and is never
// touched by this gate.

const PlaceCache = require('../models/PlaceCache');
const Destination = require('../models/Destination');
const Business = require('../models/Business');
const AppConfig = require('../models/AppConfig');

const CATEGORIES = ['restaurants', 'hotels', 'historical', 'hidden_gems', 'photo_spots', 'shopping', 'events'];
const DEFAULT_TARGETS = { restaurants: 300, hotels: 80, historical: 60, hidden_gems: 30, photo_spots: 30, shopping: 80, events: 30 };

const TABLE_TTL_MS = 10 * 60 * 1000;
const CITY_MATCH_KM = 40;   // request further than this from every known city = cold area
const CITY_MERGE_KM = 15;   // rows whose centroids sit this close are ONE city (name language varies)

let _table = null;
let _tableAt = 0;

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// City-level cache counts + centroids, aggregated from PlaceCache. Cached in
// memory: the table only moves when new places are cached, and a 10-minute lag
// on "the city just became warm" costs at most a few extra Google calls.
async function getTable() {
    if (_table && (Date.now() - _tableAt) < TABLE_TTL_MS) return _table;
    // Warmth counts everything retrieval can actually serve, from all three
    // sources: the Google place cache, validator-curated Destinations, and
    // active Businesses. Counting only PlaceCache hid whole cities — Dilijan
    // is covered almost entirely by curated Destinations. All three share the
    // same category vocabulary. PlaceCache rows with city:null stay invisible
    // until POST /api/admin/places/backfill-regions re-parses them.
    const [cacheRows, destRows, bizRows] = await Promise.all([
        PlaceCache.aggregate([
            // Only what can actually be SERVED counts as warmth: places a staff
            // member or admin hid (explore.status 'hidden') and AI-blocked ones
            // are excluded. Legacy docs without the fields count as visible.
            { $match: { city: { $nin: [null, ''] }, 'explore.status': { $ne: 'hidden' }, aiBlocked: { $ne: true } } },
            { $unwind: '$actions' },
            { $match: { actions: { $in: CATEGORIES } } },
            { $group: {
                _id: { country: '$country', city: '$city', action: '$actions' },
                count: { $sum: 1 },
                latSum: { $sum: { $ifNull: ['$details.geometry.location.lat', 0] } },
                lngSum: { $sum: { $ifNull: ['$details.geometry.location.lng', 0] } },
                geoN: { $sum: { $cond: [{ $isNumber: '$details.geometry.location.lat' }, 1, 0] } },
            } },
        ]),
        Destination.aggregate([
            { $match: { isActive: { $ne: false }, 'location.city': { $nin: [null, ''] } } },
            { $unwind: '$type' },
            { $match: { type: { $in: CATEGORIES } } },
            { $group: {
                _id: { country: '$location.country', city: '$location.city', action: '$type' },
                count: { $sum: 1 },
                latSum: { $sum: { $ifNull: ['$location.coordinates.lat', 0] } },
                lngSum: { $sum: { $ifNull: ['$location.coordinates.lng', 0] } },
                geoN: { $sum: { $cond: [{ $isNumber: '$location.coordinates.lat' }, 1, 0] } },
            } },
        ]),
        Business.aggregate([
            { $match: { status: 'active', 'location.city': { $nin: [null, ''] } } },
            { $unwind: '$type' },
            { $match: { type: { $in: CATEGORIES } } },
            { $group: {
                _id: { country: '$location.country', city: '$location.city', action: '$type' },
                count: { $sum: 1 },
                latSum: { $sum: { $ifNull: ['$location.coordinates.lat', 0] } },
                lngSum: { $sum: { $ifNull: ['$location.coordinates.lng', 0] } },
                geoN: { $sum: { $cond: [{ $isNumber: '$location.coordinates.lat' }, 1, 0] } },
            } },
        ]),
    ]);
    const rows = [...cacheRows, ...destRows, ...bizRows];
    const cities = new Map();
    for (const r of rows) {
        const key = `${r._id.city}|${r._id.country || ''}`;
        let c = cities.get(key);
        if (!c) { c = { key, city: r._id.city, country: r._id.country || null, latSum: 0, lngSum: 0, geoN: 0, counts: {} }; cities.set(key, c); }
        c.counts[r._id.action] = (c.counts[r._id.action] || 0) + r.count;
        c.latSum += r.latSum; c.lngSum += r.lngSum; c.geoN += r.geoN;
    }
    const list = [];
    for (const c of cities.values()) {
        c.lat = c.geoN > 0 ? c.latSum / c.geoN : null;
        c.lng = c.geoN > 0 ? c.lngSum / c.geoN : null;
        delete c.latSum; delete c.lngSum;
        list.push(c);
    }
    // ── Language merge ──────────────────────────────────────────────────────
    // Google addresses are requested in English, but legacy cache rows (and the
    // occasional local-script response) can name the same city as "Yerevan",
    // "Երևան" or "Ереван" — splitting one city into rows that each undercount
    // warmth. Names lie; coordinates don't: rows whose centroids sit within
    // CITY_MERGE_KM are folded into one city. Display name prefers the
    // Latin-script variant of the LARGEST member; the others become aliases.
    const isAscii = (v) => /^[\x00-\x7F]*$/.test(v || '');
    const totalOf = (c) => Object.values(c.counts).reduce((sum, n) => sum + n, 0);
    list.sort((a, b) => totalOf(b) - totalOf(a));
    const merged = [];
    for (const c of list) {
        c.aliases = c.aliases || [];
        const host = merged.find(m => Number.isFinite(m.lat) && Number.isFinite(c.lat) && haversineKm(m.lat, m.lng, c.lat, c.lng) <= CITY_MERGE_KM);
        if (!host) { merged.push(c); continue; }
        for (const [a, n] of Object.entries(c.counts)) host.counts[a] = (host.counts[a] || 0) + n;
        if (host.geoN + c.geoN > 0) {
            host.lat = (host.lat * host.geoN + c.lat * c.geoN) / (host.geoN + c.geoN);
            host.lng = (host.lng * host.geoN + c.lng * c.geoN) / (host.geoN + c.geoN);
            host.geoN += c.geoN;
        }
        if (!isAscii(host.city) && isAscii(c.city)) {
            host.aliases.push(host.city);
            host.city = c.city;
            if (isAscii(c.country)) host.country = c.country;
            host.key = c.key;
        } else if (c.city !== host.city) {
            host.aliases.push(c.city);
        }
    }
    for (const c of merged) delete c.geoN;
    _table = merged;
    _tableAt = Date.now();
    return merged;
}

function nearestCity(table, lat, lng) {
    let best = null, bestKm = Infinity;
    for (const c of table) {
        if (!Number.isFinite(c.lat)) continue;
        const km = haversineKm(lat, lng, c.lat, c.lng);
        if (km < bestKm) { bestKm = km; best = c; }
    }
    return (best && bestKm <= CITY_MATCH_KM) ? best : null;
}

function targetFor(cfg, cityKey, action) {
    const cityT = cfg.coverageCityTargets && cfg.coverageCityTargets[cityKey];
    const t = (cityT && Number(cityT[action])) || (cfg.coverageTargets && Number(cfg.coverageTargets[action])) || DEFAULT_TARGETS[action];
    return t > 0 ? t : DEFAULT_TARGETS[action];
}

async function decide(action, loc) {
    const cfg = await AppConfig.getConfig();
    if (!cfg.coverageGate) return { allowed: true, reason: 'gate_off' };
    if (!CATEGORIES.includes(action)) return { allowed: true, reason: 'exempt' };
    const lat = Number(loc && loc.lat), lng = Number(loc && loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { allowed: true, reason: 'no_location' };
    const city = nearestCity(await getTable(), lat, lng);
    if (!city) return { allowed: true, reason: 'cold_area' };
    const ov = cfg.coverageOverrides && cfg.coverageOverrides[city.key] && cfg.coverageOverrides[city.key][action];
    if (ov === 'on') return { allowed: true, reason: 'forced_on', city: city.key };
    if (ov === 'off') return { allowed: false, reason: 'forced_off', city: city.key };
    const target = targetFor(cfg, city.key, action);
    const warmth = ((city.counts[action] || 0) / target) * 100;
    const cutoff = Number(cfg.coverageCutoffPct) || 90;
    return { allowed: warmth < cutoff, reason: warmth < cutoff ? 'cold' : 'warm', city: city.key, warmth: Math.round(warmth) };
}

// The one call the request paths use. Never throws.
async function googleAllowed(action, loc) {
    try {
        const d = await decide(action, loc);
        if (!d.allowed) console.log(`[coverage] Google OFF for action=${action} @ ${d.city} (${d.reason}${d.warmth != null ? ` ${d.warmth}%` : ''})`);
        return d.allowed;
    } catch (e) {
        console.warn('[coverage] decide failed, allowing Google:', e.message);
        return true;
    }
}

// Full table for the admin Coverage tab: every known city × category with
// count, target, warmth% and the effective state under current config.
async function adminView() {
    const cfg = await AppConfig.getConfig();
    const table = await getTable();
    const cutoff = Number(cfg.coverageCutoffPct) || 90;
    const rows = table.map(c => {
        const cats = {};
        for (const a of CATEGORIES) {
            const count = c.counts[a] || 0;
            const target = targetFor(cfg, c.key, a);
            const warmth = Math.round((count / target) * 100);
            const ov = (cfg.coverageOverrides && cfg.coverageOverrides[c.key] && cfg.coverageOverrides[c.key][a]) || 'auto';
            const effective = !cfg.coverageGate ? 'gate_off'
                : ov === 'on' ? 'forced_on'
                : ov === 'off' ? 'forced_off'
                : warmth >= cutoff ? 'auto_off' : 'auto_on';
            cats[a] = { count, target, warmth, override: ov, effective };
        }
        const total = Object.values(c.counts).reduce((s, n) => s + n, 0);
        return { key: c.key, city: c.city, country: c.country, aliases: c.aliases || [], total, categories: cats };
    }).sort((a, b) => b.total - a.total);
    // Diagnostics for the admin card: how much of the cache the table can
    // actually attribute (city parsed + category-tagged) — the gap is what a
    // region re-parse can recover.
    const [placeCacheTotal, withCity, tagged] = await Promise.all([
        PlaceCache.countDocuments({}),
        PlaceCache.countDocuments({ city: { $nin: [null, ''] } }),
        PlaceCache.countDocuments({ city: { $nin: [null, ''] }, actions: { $in: CATEGORIES } }),
    ]);
    return {
        meta: { placeCacheTotal, withCity, tagged },
        categories: CATEGORIES,
        defaultTargets: { ...DEFAULT_TARGETS, ...(cfg.coverageTargets || {}) },
        config: {
            coverageGate: !!cfg.coverageGate,
            coverageCutoffPct: cutoff,
            coverageTargets: cfg.coverageTargets || {},
            coverageCityTargets: cfg.coverageCityTargets || {},
            coverageOverrides: cfg.coverageOverrides || {},
        },
        rows,
    };
}

function invalidate() { _table = null; _tableAt = 0; }

module.exports = { CATEGORIES, DEFAULT_TARGETS, googleAllowed, decide, adminView, invalidate };
