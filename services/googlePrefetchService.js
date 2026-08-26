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
    // 'things to do and attractions' used to live here, on EVENTS — which is
    // what ACTIVITIES means. Events are dated happenings; the phrase moved with
    // the meaning, or the two prefetch pools would be near-identical.
    events:       'upcoming events and festivals',
    photo_spots:  'scenic viewpoints and photo spots',
    activities:   'things to do — spas, nightlife, bowling, cinemas and activity centers',
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

// ── Photo-spot lens sweep ───────────────────────────────────────────────────
// One broad "scenic viewpoints" query kept re-finding the same canon places:
// photo spots have no Google category, so depth comes from sweeping several
// angles ("lenses"). The user's interests decide which lenses are eligible and
// in what order, but every lens pool is cached per-area and shared by ALL
// users — cost is per-city, never per-user. A lens runs at most once per area
// per PHOTO_LENS_TTL_MIN; refills page the cached pools (via excludePlaceIds)
// before any new lens is paid for, and at most MAX_NEW_LENSES_PER_CALL new
// Text Searches run in one tap. Lenses "street art" and "historic streets"
// are deliberately absent (founder-excluded).
const PHOTO_LENS_TTL_MIN = 7 * 24 * 60;
const PHOTO_BASE_LENSES = ['scenic viewpoints', 'famous tourist attractions'];
const PHOTO_INTEREST_LENSES = {
    nature:     ['lakes and waterfalls', 'hiking trail viewpoints'],
    adventure:  ['gorges and cliffs', 'panoramic mountain trails'],
    romantic:   ['sunset viewpoints', 'beautiful gardens and parks'],
    family:     ['parks and playgrounds', 'family friendly attractions'],
    cultural:   ['monuments and striking architecture'],
    history:    ['monuments and striking architecture'],
    art:        ['monuments and striking architecture'],
};
const MAX_NEW_LENSES_PER_CALL = 2;

function photoLensList(interests = []) {
    const lenses = [...PHOTO_BASE_LENSES];
    for (const i of interests || []) {
        const extra = PHOTO_INTEREST_LENSES[String(i).toLowerCase().trim()];
        if (extra) for (const l of extra) if (!lenses.includes(l)) lenses.push(l);
    }
    return lenses;
}

function kmBetween(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

async function getPhotoSpotCandidates({ location, radiusKm, limit, take, requestId, interests }) {
    const lenses = photoLensList(interests);
    const pool = [];
    const seen = new Set();
    // Text Search uses locationBias (soft), so a "lakes and waterfalls" lens can
    // surface famous spots half a country away — hard-filter to the radius
    // (small slack for edge results) before anything reaches the pool.
    const maxKm = Math.max(radiusKm || 50, 5) * 1.25;
    const merge = (arr) => {
        for (const c of arr || []) {
            if (!c || !c.placeId || seen.has(c.placeId)) continue;
            seen.add(c.placeId);
            if (Number.isFinite(c.lat) && Number.isFinite(c.lng)
                && kmBetween(location.lat, location.lng, c.lat, c.lng) > maxKm) continue;
            pool.push(c);
        }
    };

    // 1. Gather every already-run lens pool for this area from the cache.
    const missing = [];
    for (const lens of lenses) {
        const key = cacheKey('photo_spots', 'lens:' + lens.replace(/\s+/g, '_'), location.lat, location.lng, radiusKm);
        let hit = null;
        try { hit = await PlaceSearchCache.findOne({ key }).lean(); }
        catch (e) { console.warn('[googlePrefetch] lens cache read failed:', e.message); }
        if (hit && Array.isArray(hit.candidates) && hit.candidates.length
            && (!hit.expireAt || hit.expireAt > new Date())) merge(hit.candidates);
        else missing.push({ lens, key });
    }

    // 2. Only when the cached pools can't fill the page, run new lenses.
    let ran = 0;
    for (const { lens, key } of missing) {
        if (ran >= MAX_NEW_LENSES_PER_CALL || take(pool).length >= limit) break;
        try {
            const found = await googleService.searchPlacesText(lens, location, radiusKm, 20, requestId);
            ran++;
            merge(found);
            const expireAt = new Date(Date.now() + PHOTO_LENS_TTL_MIN * 60 * 1000);
            PlaceSearchCache.findOneAndUpdate(
                { key },
                { $set: { key, action: 'photo_spots', subType: 'lens', candidates: found, expireAt } },
                { upsert: true }
            ).catch(e => console.warn('[googlePrefetch] lens cache write failed:', e.message));
        } catch (e) {
            console.warn(`[googlePrefetch] lens "${lens}" search failed:`, e.message);
        }
    }
    if (ran || pool.length) {
        console.log(`[googlePrefetch] photo lens sweep: ${lenses.length} eligible lens(es), ${missing.length - ran} still unswept, ${ran} ran now, pool=${pool.length}`);
    }
    return take(pool);
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
 * @param {string[]} opts.interests user preference interests — photo_spots only:
 *        picks which sweep lenses are eligible (see PHOTO_INTEREST_LENSES).
 */
async function getCandidates({ action, subType = null, location, radiusKm = 50, limit = 12, excludePlaceIds = [], ttlMin = 1440, requestId = null, interests = [] } = {}) {
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

    // photo_spots uses the multi-lens sweep instead of the single broad query.
    if (action === 'photo_spots') {
        return getPhotoSpotCandidates({ location, radiusKm, limit, take, requestId, interests });
    }

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