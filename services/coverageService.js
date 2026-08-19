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
const AppConfig = require('../models/AppConfig');

const CATEGORIES = ['restaurants', 'hotels', 'historical', 'hidden_gems', 'photo_spots', 'shopping', 'events'];
const DEFAULT_TARGETS = { restaurants: 300, hotels: 80, historical: 60, hidden_gems: 30, photo_spots: 30, shopping: 80, events: 30 };

const TABLE_TTL_MS = 10 * 60 * 1000;
const CITY_MATCH_KM = 40;   // request further than this from every known city = cold area

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
    const rows = await PlaceCache.aggregate([
        { $match: { city: { $nin: [null, ''] } } },
        { $unwind: '$actions' },
        { $match: { actions: { $in: CATEGORIES } } },
        { $group: {
            _id: { country: '$country', city: '$city', action: '$actions' },
            count: { $sum: 1 },
            latSum: { $sum: { $ifNull: ['$details.geometry.location.lat', 0] } },
            lngSum: { $sum: { $ifNull: ['$details.geometry.location.lng', 0] } },
            geoN: { $sum: { $cond: [{ $isNumber: '$details.geometry.location.lat' }, 1, 0] } },
        } },
    ]);
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
        delete c.latSum; delete c.lngSum; delete c.geoN;
        list.push(c);
    }
    _table = list;
    _tableAt = Date.now();
    return list;
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
        return { key: c.key, city: c.city, country: c.country, total, categories: cats };
    }).sort((a, b) => b.total - a.total);
    return {
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
