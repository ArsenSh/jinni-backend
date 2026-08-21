// Jinni V2 Engine — Canonical Place Store: the Mongo candidate loader behind
// retrieval's deps.loadCandidates (V3 blueprint §3.1). Plain-Mongo decision:
// bounding-box prefilter + JS haversine, no Atlas features.
//
// The HARD GATES are copied from v1's findCachedBackfill (aiRoutes ~2049–2199)
// — category ground truth via `actions`, staff suppression (aiBlocked /
// explore.status), freshness, must-render-a-card, community hard-hide, the
// sub-type and landmark type gates, and the price-tier mismatch drop. The soft
// prior score keeps v1's shape (asymmetric feedback, rating, preference fit,
// tier fit, capped popularity, closeness). Deviations from v1, both deliberate:
//   1. category may be NULL (free chat query) — then the `actions` filter and
//      type gates are skipped; suppression/freshness/community gates still hold.
//   2. Validator tier comes from proximityService (service reuse per blueprint),
//      defensively mapped and fail-open — a broken tier degrades to [].
// Models/services are required LAZILY so jest imports without booting Mongoose.

const { normalizePlaceName } = require('./matching');
const { haversineKm } = require('../utils/geo');
const { scheduleToPeriods } = require('../context/contextEngine');
const { priceTier, tierFit, tierMismatch, isPriceAction } = require('../../services/priceTier');

const CACHE_VALIDITY_DAYS = 30;
const CACHE_SCAN_LIMIT = 200;      // hard ceiling so a big cache never blows up the scan
const HIT_CAP = 25;                // cap popularity so a few places can't ossify the list
const SHOP_SUBTYPE_TAGS = ['souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food'];

// ── Community hard-hide gate — byte-identical rules to v1 (aiRoutes ~2017) ──
const COMMUNITY_HIDE_MARGIN = 3;     // net ≤ −3
const COMMUNITY_MIN_VOTES   = 3;     // need at least this many total votes to judge
const COMMUNITY_HIDE_RATIO  = 0.6;   // dislikes must be ≥60% of all feedback
function isCommunityRejected(likes = 0, dislikes = 0) {
    const net = (likes || 0) - (dislikes || 0);
    const totalVotes = (likes || 0) + (dislikes || 0);
    const dislikeShare = totalVotes > 0 ? (dislikes || 0) / totalVotes : 0;
    return net <= -COMMUNITY_HIDE_MARGIN
        && totalVotes >= COMMUNITY_MIN_VOTES
        && dislikeShare >= COMMUNITY_HIDE_RATIO;
}

// Preference fit (0..1) — copied from v1 (aiRoutes ~1993). Query-time only,
// never stored on the shared place doc.
function _prefFitScore(types, primaryType, preferences) {
    const t = [...(types || []), primaryType].filter(Boolean).map(x => String(x).toLowerCase());
    const interestsRaw = Array.isArray(preferences?.interests) ? preferences.interests.join(' ') : (preferences?.interests || '');
    const interests = String(interestsRaw).toLowerCase();
    const want = [];
    if (/food|drink|gourmet|culinary/.test(interests)) want.push('restaurant', 'cafe', 'bakery', 'bar', 'food', 'meal_takeaway', 'coffee_shop', 'wine_bar', 'pub');
    if (/nature|outdoor/.test(interests)) want.push('park', 'garden', 'natural_feature', 'national_park', 'botanical_garden');
    if (/relax|wellness|spa/.test(interests)) want.push('spa', 'park', 'garden', 'resort_hotel');
    if (/family|kid/.test(interests)) want.push('zoo', 'aquarium', 'amusement_park', 'park', 'museum');
    if (/art|culture|histor/.test(interests)) want.push('museum', 'art_gallery', 'tourist_attraction', 'historical_landmark');
    if (!want.length) return 0.5;                       // no interests → neutral
    return t.some(tt => want.some(w => tt.includes(w))) ? 1 : 0;
}

/** The indexed bounding-box prefilter — v1's query shape, category optional. */
function buildCacheQuery({ center, radiusKm, category = null, excludePlaceIds = [] }) {
    const freshnessCutoff = new Date(Date.now() - CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180)));
    const query = {
        imagesStored: true,
        aiBlocked: { $ne: true },                      // staff suppression at the SOURCE
        'explore.status': { $ne: 'hidden' },
        lastFetched: { $gte: freshnessCutoff },
        'details.geometry.location.lat': { $gte: center.lat - latDelta, $lte: center.lat + latDelta },
        'details.geometry.location.lng': { $gte: center.lng - lngDelta, $lte: center.lng + lngDelta },
    };
    if (category) query.actions = category;            // ground-truth category match
    if (excludePlaceIds.length) query.placeId = { $nin: excludePlaceIds };
    return query;
}

/** v1's backfill prior, same weights (aiRoutes ~2179–2195). */
function scoreCachedDoc(d, distanceKm, radiusKm, category, preferences = {}) {
    const net = (d.likes || 0) - (d.dislikes || 0);
    const rating = d.rating || 0;
    const pref = _prefFitScore(d.types, d.primaryType, preferences);
    const hits = Math.min(d.useCount || 0, HIT_CAP) / HIT_CAP;
    const closeness = 1 - (distanceKm / radiusKm);
    // Negative feedback bites HARDER than positive rewards (asymmetric).
    const feedbackScore = net >= 0 ? (3 * net) : (8 * net);
    const dTier = category && isPriceAction(category) ? priceTier(d.types, d.primaryType, d.priceLevel).tier : null;
    const tierScore = category && isPriceAction(category) ? tierFit(dTier, preferences.travelStyle) : 0;
    return feedbackScore + (1 * rating) + (2 * pref) + (2 * tierScore) + (1 * hits) + (1 * closeness);
}

function cacheDocToCandidate(d, center) {
    const lat = d?.details?.geometry?.location?.lat;
    const lng = d?.details?.geometry?.location?.lng;
    const distanceKm = (center && lat != null && lng != null)
        ? haversineKm(center.lat, center.lng, lat, lng) : null;
    return {
        placeId: d.placeId,
        name: d.name,
        source: 'cache',
        rating: d.rating || null,
        types: d.types || [],
        primaryType: d.primaryType || null,
        priceLevel: d.priceLevel || null,
        opening_hours: d.opening_hours || null,        // Google periods shape → context engine
        geometry: (lat != null && lng != null) ? { lat, lng } : null,
        distanceKm,
        address: d.details?.formatted_address || null,   // full street address for the card
        city: d.city || null,
        country: d.country || null,
        // imagesStored:true is part of the cache query, so the stored-image
        // endpoint is always valid for these rows.
        image: d.placeId ? `/api/ai/place-image/${d.placeId}/0` : null,
        likes: d.likes || 0,
        dislikes: d.dislikes || 0,
        vector: Array.isArray(d.embedding) ? d.embedding : undefined,
        // BM25 document: name + kind words + place words the user might type.
        text: [d.name, d.primaryType, ...(d.types || []).slice(0, 6), ...(d.interests || []), d.city]
            .filter(Boolean).join(' '),
    };
}

/** Defensive mapping for proximityService rows (Business/Destination). Their
 *  hours use a day-name schedule (not Google periods) — left null here, so the
 *  context engine treats them as UNKNOWN (kept, never dropped). Converter TODO. */
function dbDocToCandidate(d, source, center) {
    if (!d || !d.name) return null;
    const lat = d?.location?.coordinates?.lat;
    const lng = d?.location?.coordinates?.lng;
    const distanceKm = (center && lat != null && lng != null)
        ? haversineKm(center.lat, center.lng, lat, lng) : null;
    return {
        placeId: d.placeId || null,
        verifiedId: String(d._id || ''),
        name: d.name,
        source,                                        // 'destination' | 'business'
        rating: d.rating || d.engagement?.rating || null,
        types: Array.isArray(d.type) ? d.type : [],
        primaryType: null,
        priceLevel: null,
        // Validator/business hours (day-name schedule) converted to Google
        // periods so the SAME open-now math covers all three sources; null
        // when no valid schedule (unknown → kept).
        opening_hours: scheduleToPeriods(d.openingHours),
        geometry: (lat != null && lng != null) ? { lat, lng } : null,
        distanceKm,
        address: d.location?.address || null,
        city: d.location?.city || null,
        country: d.location?.country || null,
        // Validator/partner rows carry their own images (string URL or {url}).
        image: (() => {
            const first = Array.isArray(d.images) ? d.images[0] : null;
            if (typeof first === 'string') return first;
            if (first && typeof first.url === 'string') return first.url;
            return null;
        })(),
        tier: d.subscription?.tier || null,
        text: [d.name, ...(Array.isArray(d.type) ? d.type : []), d.location?.city, d.description]
            .filter(Boolean).join(' ').slice(0, 300),
    };
}

/** First occurrence wins (validator word beats cache duplicate). A candidate
 *  registers BOTH identities — placeId AND normalized name — because a
 *  validator row (no placeId) and a cache row (with one) must still collide
 *  on the name, or the same place ships twice. */
function mergeAndDedupe(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const c of list || []) {
            if (!c) continue;
            const keys = [];
            if (c.placeId) keys.push(`id:${c.placeId}`);
            const n = normalizePlaceName(c.name || '');
            if (n) keys.push(`name:${n}`);
            if (!keys.length || keys.some(k => seen.has(k))) continue;
            keys.forEach(k => seen.add(k));
            out.push(c);
        }
    }
    return out;
}

/**
 * The retrieval core's data source (deps.loadCandidates). Prior order:
 * validator destinations → partner businesses → cache by v1's backfill score.
 * @param {object} params  findPlaces params (category, subType, center, radiusKm, preferences, excludes…)
 * @param {object} [deps]  injectable for tests: { cacheFind, proximity, placeMatches }
 */
async function loadCandidates(params = {}, deps = {}) {
    const {
        category = null, subType = null, center = null,
        radiusKm = 50, preferences = {}, excludes = {}, requestId = null,
    } = params;
    if (!center || center.lat == null || center.lng == null) return [];
    // Events are never served from the place cache (a cached venue is not a
    // dated event) — the events pipeline owns that category end to end.
    if (category === 'events') return [];

    // ── Cache tier ──
    let cacheDocs = [];
    try {
        const query = buildCacheQuery({ center, radiusKm, category, excludePlaceIds: excludes.placeIds || [] });
        if (deps.cacheFind) {
            cacheDocs = await deps.cacheFind(query);
        } else {
            const PlaceCache = require('../../models/PlaceCache');
            cacheDocs = await PlaceCache.find(query)
                .select('placeId name rating likes dislikes useCount types primaryType priceLevel details photos opening_hours interests actions city country embedding')
                .limit(CACHE_SCAN_LIMIT)
                .lean();
        }
    } catch (err) {
        console.warn(`[canonicalStore] cache tier failed: ${err.message} — continuing without it`);
        cacheDocs = [];
    }

    const placeMatches = deps.placeMatches || ((action, sub, types, primaryType) => {
        try { return require('../../services/googleService').placeMatchesActionType(action, sub, types, primaryType); }
        catch { return true; }                          // comparator unavailable → lenient
    });

    const scoredCache = [];
    for (const d of cacheDocs) {
        const lat = d?.details?.geometry?.location?.lat;
        const lng = d?.details?.geometry?.location?.lng;
        if (lat == null || lng == null) continue;
        if (!d.photos || !d.photos[0]) continue;        // must render a card
        const distanceKm = haversineKm(center.lat, center.lng, lat, lng);
        if (distanceKm > radiusKm) continue;            // exact circular cap
        if (isCommunityRejected(d.likes, d.dislikes)) continue;
        if (category) {
            // v1's sub-type + landmark/type gates, verbatim semantics.
            if (subType) {
                const rowSubTags = Array.isArray(d.actions) ? d.actions.filter(a => SHOP_SUBTYPE_TAGS.includes(a)) : [];
                if (rowSubTags.length) {
                    if (!rowSubTags.includes(subType)) continue;
                } else if (!placeMatches(category, subType, d.types, d.primaryType)) {
                    continue;
                }
            } else if (!placeMatches(category, null, d.types, d.primaryType)) {
                continue;
            }
            const dTier = isPriceAction(category) ? priceTier(d.types, d.primaryType, d.priceLevel).tier : null;
            if (isPriceAction(category) && tierMismatch(dTier, preferences.travelStyle)) continue;
        }
        scoredCache.push({ d, distanceKm, score: scoreCachedDoc(d, distanceKm, radiusKm, category, preferences) });
    }
    scoredCache.sort((a, b) => b.score - a.score);
    const cacheCandidates = scoredCache.slice(0, 40).map(({ d }) => cacheDocToCandidate(d, center));

    // ── Validator/partner tier (fail-open service reuse) ──
    let destinations = [], businesses = [];
    try {
        const proximity = deps.proximity || require('../../services/proximityService').findSmartProximityPlaces;
        const res = await proximity(center, preferences, category || 'general', radiusKm, 12, null, requestId, subType);
        destinations = (res?.destinations || []).map(d => dbDocToCandidate(d, 'destination', center)).filter(Boolean);
        businesses = (res?.businesses || []).map(b => dbDocToCandidate(b, 'business', center)).filter(Boolean);
    } catch (err) {
        console.warn(`[canonicalStore] validator tier failed: ${err.message} — continuing with cache only`);
    }

    let merged = mergeAndDedupe(destinations, businesses, cacheCandidates);

    // ── Google fallback tier (bootstrap, not the engine — V3 §8e) ──
    // Only when the owned corpus is THIN, only through the coverage gates, and
    // bounded: one Text Search + details for at most `count` new places. Every
    // resolved place caches permanently (the standard warming path), so a cold
    // city pays this once and then answers from owned data like Yerevan does.
    const wanted = Math.min(Math.max(Number(params.count) || 8, 1), 20);
    if (merged.length < wanted && (params.query || category)) {
        try {
            const extra = await googleFallback({
                query: params.query, category, subType, center, radiusKm,
                needed: wanted - merged.length, requestId,
            }, deps);
            if (extra.length) {
                console.log(`[canonicalStore] google fallback: +${extra.length} (owned corpus had ${merged.length})`);
                merged = mergeAndDedupe(merged, extra);
            }
        } catch (err) {
            console.warn(`[canonicalStore] google fallback failed: ${err.message} — serving owned data only`);
        }
    }
    return merged;
}

/** Thin-corpus seeding: coverage-gated, one search, ≤needed details resolves. */
async function googleFallback({ query, category, subType, center, radiusKm, needed, requestId }, deps = {}) {
    const coverageAllowed = deps.coverage
        || ((action, loc) => { try { return require('../../services/coverageService').googleAllowed(action, loc); } catch { return false; } });
    if (!(await coverageAllowed(category || 'general', { lat: center.lat, lng: center.lng }))) return [];

    const findPlaces = deps.findPlaces
        || ((q, loc, rid, opts) => require('../../services/googleService').findPlaces(q, loc, rid, opts));
    const q = [query, subType, category].filter(Boolean)[0] || 'places to visit';
    const found = await findPlaces(q, center, requestId, { maxResultCount: Math.min(needed * 2, 10) }) || [];

    // Resolve at most `needed` through v1's shared resolver — it caches details
    // AND stores images, so the card's place-image endpoint is valid and the
    // place is owned data from now on. Failures skip the place, never the turn.
    const resolveDetails = deps.resolveDetails || (async (placeId) => {
        const { getCachedPlaceDetails } = require('../../routes/aiRoutes').shared;
        return getCachedPlaceDetails(placeId, false, requestId, center, placeId, null, true);
    });
    const out = [];
    for (const p of found) {
        if (out.length >= needed) break;
        if (!p?.place_id || !p?.name) continue;
        const lat = p.geometry?.location?.lat, lng = p.geometry?.location?.lng;
        if (lat == null || lng == null) continue;
        const distanceKm = haversineKm(center.lat, center.lng, lat, lng);
        if (distanceKm > radiusKm) continue;
        let d = null;
        try { d = await resolveDetails(p.place_id); } catch { /* skip this place */ }
        out.push({
            placeId: p.place_id,
            name: d?.name || p.name,
            source: 'google',
            rating: d?.rating || null,
            types: p.types || [],
            primaryType: p.primaryType || null,
            priceLevel: d?.priceLevel || null,
            opening_hours: d?.opening_hours || null,
            geometry: { lat, lng },
            distanceKm,
            address: d?.formatted_address || null,
            city: null,
            country: null,
            image: (d?.imagesStored || d?.photoUrls?.length) ? `/api/ai/place-image/${p.place_id}/0` : null,
            text: [p.name, p.primaryType, ...(p.types || []).slice(0, 6)].filter(Boolean).join(' '),
        });
    }
    return out;
}

module.exports = {
    loadCandidates,
    googleFallback,
    buildCacheQuery,
    cacheDocToCandidate,
    dbDocToCandidate,
    scoreCachedDoc,
    mergeAndDedupe,
    isCommunityRejected,
};
