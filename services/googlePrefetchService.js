// services/googlePrefetchService.js
//
// Quick-action "candidate prefetch": runs ONE Google Text Search per request to
// hand the model a shortlist of real, currently-operating places near the user,
// so the model RANKS/FILTERS real places instead of recalling (and frequently
// hallucinating) local names. The names the model keeps come back carrying a
// real placeId, which lets enrichment skip the per-name findPlaces resolution
// call downstream.
//
// All quota protection lives here: the result set is memoised in
// PlaceSearchCache by (action, sub-type, rounded area, radius bucket) for a
// TTL, so a busy neighbourhood reuses one Text Search call across many users.
//
// This module is intentionally self-contained — it knows about Google + the
// cache only, never about the route, the AI provider, or recommendation shape.

const PlaceSearchCache = require('../models/PlaceSearchCache');
const googleService = require('./googleService');

// ── Query templates ─────────────────────────────────────────────────────────
// Text Search takes a natural-language query; we keep them broad on purpose.
// Rich preference matching (luxury / romantic / "boutique heritage") is NOT
// expressible in Places and is left to the model, which filters the shortlist.
const ACTION_QUERY = {
    restaurants:  'popular restaurants',
    hotels:       'hotels',
    historical:   'historical landmarks and monuments',
    hidden_gems:  'local hidden gem spots',
    events:       'things to do and attractions',
    photo_spots:  'scenic viewpoints and photo spots',
};

const SHOPPING_QUERY = {
    souvenirs: 'souvenir and gift shops',
    clothing:  'clothing and fashion stores',
    market:    'markets and bazaars',
    mall:      'shopping malls',
    jewelry:   'jewelry stores',
    food:      'gourmet food and specialty shops',
};

function buildQuery(action, subType = null) {
    if (action === 'shopping') return SHOPPING_QUERY[subType] || 'shops and markets';
    return ACTION_QUERY[action] || action;
}

// ── Cache key helpers ───────────────────────────────────────────────────────
// Round coords to 2 dp (~1.1 km grid) and bucket the radius to the nearest 5 km
// so near-identical searches collapse onto one cache entry.
function roundCoord(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function bucketRadius(km) { return Math.max(5, Math.round((Number(km) || 50) / 5) * 5); }

function cacheKey(action, subType, lat, lng, radiusKm) {
    return [action, subType || '', roundCoord(lat), roundCoord(lng), bucketRadius(radiusKm)].join(':');
}

/**
 * Return up to `limit` real place candidates for an action near `location`.
 * Shape: [{ placeId, name, lat, lng, types, rating }]
 * Never throws — returns [] on any failure so the caller falls back cleanly to
 * the pure-AI naming path.
 *
 * @param {Object}  opts
 * @param {string}  opts.action     e.g. 'restaurants' | 'hotels' | 'shopping'
 * @param {string?} opts.subType    shopping sub-type (jewelry|mall|…) or null
 * @param {Object}  opts.location   { lat, lng }
 * @param {number}  opts.radiusKm   search radius (nearby vs discovery)
 * @param {number}  opts.limit      max candidates to RETURN (default 12)
 * @param {string[]} opts.excludePlaceIds  placeIds already shown (View More) —
 *        filtered out of the (cached) pool so successive pages return fresh
 *        places without another Google call until the pool is exhausted.
 * @param {number}  opts.ttlMin     cache TTL in minutes (default 1440 = 24h)
 * @param {string?} opts.requestId  for Google API stat attribution
 */
async function getCandidates({ action, subType = null, location, radiusKm = 50, limit = 12, excludePlaceIds = [], ttlMin = 1440, requestId = null } = {}) {
    if (!location || !location.lat || !location.lng) return [];

    const key = cacheKey(action, subType, location.lat, location.lng, radiusKm);
    const exclude = new Set((excludePlaceIds || []).filter(Boolean));
    // Fetch a full page (up to 20) so "View More" has spare candidates to page
    // through from the SAME cached set — no extra Text Search per page.
    const poolSize = Math.min(20, Math.max(limit, 20));
    // Drop already-shown places AND anything whose real Google types don't match
    // the action (a "restaurants" search shouldn't hand the model a brandy house),
    // then cap to `limit`.
    const take = (arr) => arr
        .filter(c => !exclude.has(c.placeId))
        .filter(c => googleService.placeMatchesActionType(action, subType, c.types, null))
        .slice(0, limit);

    // 1. Serve from the result-set cache when fresh.
    try {
        const hit = await PlaceSearchCache.findOne({ key }).lean();
        if (hit && Array.isArray(hit.candidates) && hit.candidates.length
            && (!hit.expireAt || hit.expireAt > new Date())) {
            return take(hit.candidates);
        }
    } catch (e) {
        console.warn('[googlePrefetch] cache read failed:', e.message);
    }

    // 2. Miss → one Text Search (full page).
    const query = buildQuery(action, subType);
    let candidates = [];
    try {
        candidates = await googleService.searchPlacesText(query, location, radiusKm, poolSize, requestId);
    } catch (e) {
        console.warn('[googlePrefetch] search failed:', e.message);
        return [];
    }

    // 3. Memoise the full pool (best-effort, non-blocking) and return a fresh slice.
    if (candidates.length) {
        const expireAt = new Date(Date.now() + (ttlMin || 1440) * 60 * 1000);
        PlaceSearchCache.findOneAndUpdate(
            { key },
            { $set: { key, action, subType, candidates, expireAt } },
            { upsert: true }
        ).catch(e => console.warn('[googlePrefetch] cache write failed:', e.message));
    }
    return take(candidates);
}

module.exports = { getCandidates, buildQuery, cacheKey };