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

/** Which city the events hunt is about.
 *
 *  The reverse-geocoded region comes FIRST. Deriving the name from the events
 *  we already held made a city with none unhuntable — the only source of the
 *  name was the thing we could not have yet, so Dubai returned "no listings"
 *  in 1.7s having never looked (Arsen 2026-08-24: "why i have not received
 *  events for dubai?").
 *
 *  Dirty rows still carry address fragments ("10/9") in the city field, so the
 *  shape check stays: letters, spaces and simple punctuation only.
 */
function huntCity(params = {}, evs = []) {
    const looksReal = (c) => c && /^[\p{L}][\p{L}\s.'’-]{1,40}$/u.test(String(c).trim());
    const found = [params.regionCity, params.center?.city, ...(evs || []).map(e => e?.city)].find(looksReal);
    // Google reverse-geocodes Tbilisi as "T'bilisi" — a transliteration mark,
    // not punctuation anyone types or any site prints. Only an apostrophe right
    // after a single leading letter is dropped, so "Coeur d'Alene" survives.
    return found ? String(found).trim().replace(/^([\p{L}])['’](?=\p{L})/u, '$1') : null;
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
        // Partner tier drives the card badge + glow color (Verified /
        // Spotlight / Signature) — v1 reads business.partnership.tier; without
        // this every partner rendered as "Jinni Verified" (live find 2026-08-22).
        tier: source === 'business' ? (d.partnership?.tier || 'verified') : null,
        isPartner: source === 'business' ? !!d.partnership?.isPartner : false,
        // Contact for the map popup (v1 parity — businesses carry their own).
        website: d.contact?.website || null,
        phone: d.contact?.phone || null,
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
        // Semantic vector (battery fix #3 — curated rows used to carry none
        // and systematically LOST to cache rows under vector ranking).
        vector: Array.isArray(d.embedding) ? d.embedding : undefined,
        // Business.description is an OBJECT ({short, detailed}) — joining it
        // raw put "[object Object]" into the BM25 text (found 2026-08-22).
        text: [d.name, ...(Array.isArray(d.type) ? d.type : []), d.location?.city, _descText(d.description)]
            .filter(Boolean).join(' ').slice(0, 300),
    };
}

/** Description → plain words, whatever shape the collection stores. */
function _descText(desc) {
    if (!desc) return null;
    if (typeof desc === 'string') return desc;
    return [desc.short, desc.detailed].filter(Boolean).join(' ') || null;
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
    // dated event) — the OWNED events tier serves them instead: validator
    // Destinations typed 'events' + moderated AiFoundEvent pipeline finds
    // (battery fix #1, 2026-08-22 — this used to `return []` and every
    // events ask hit the empty-scaffold error).
    if (category === 'events') {
        let evs = await require('./eventStore').loadEventCandidates(params, deps);
        // ── Fresh-tier HUNT (Arsen sign-off 2026-08-22): thin shelf for the
        //    ASKED window + admin web-search permission ⇒ search that window,
        //    extract JSON-LD-verified events, STORE them (AiFoundEvent, 'new',
        //    validator-moderatable), serve as honest cards. One hunt fills
        //    the shelf for every later asker — cost amortizes toward zero. ──
        // Thin means thin FOR THIS USER: count events they haven't already
        // seen (2026-08-23 live: a refill excluded all 3 shelf events and the
        // hunt never fired because the raw count looked healthy). An explicit
        // user order to search (eventsHunt.force) overrides the threshold.
        const _exIds = new Set((params.excludes?.placeIds || []).filter(Boolean));
        const _exNames = new Set((params.excludes?.names || []).map(n => normalizePlaceName(n)).filter(Boolean));
        const unseenEvents = evs.filter(c => c
            && !_exIds.has(c.placeId) && !_exIds.has(c.verifiedId)
            && !_exNames.has(normalizePlaceName(c.name || ''))).length;
        if ((unseenEvents < 3 || params.eventsHunt?.force) && params.eventsHunt && params.eventWindow) {
            // The longest wait in the whole engine (8–24s of reading listing
            // pages). Say so, or the app looks frozen.
            params.onStage?.('listings', 'Reading the city\'s event listings…');
            try {
                // First candidate whose city LOOKS like a city — dirty rows
                // carry address fragments ("10/9") in the city field.
                const city = huntCity(params, evs);
                const extra = await (deps.huntEvents || require('../events/hunt').huntEvents)({
                    city,
                    country: params.regionCountry || params.center?.country || null,
                    center: params.center,
                    window: params.eventWindow,
                }, { webSearchCfg: params.eventsHunt.webSearch || null });
                if (extra.length) evs = mergeAndDedupe(evs, extra);
            } catch (err) {
                console.warn(`[canonicalStore] events hunt failed: ${err.message} — serving owned events only`);
            }
        }
        return evs;
    }

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
    // THIN is two-dimensional (the Uzbek lesson, 2026-08-22): too FEW candidates,
    // OR zero candidates matching a demanded term — 25 generic restaurants are
    // "covered" by count while being empty for "uzbek". The demand check runs on
    // the intent's CLEAN coreQuery only, never the enriched chat tokens
    // ("girlfriend", "acquainted" must not trigger paid searches).
    const wanted = Math.min(Math.max(Number(params.count) || 8, 1), 20);
    // Category words never justify a PAID search: on a cat=historical request
    // the token "historical" is already answered by the category filter itself
    // (caught live 2026-08-22: fallback bought 3 places for "uncovered:
    // historical" while 22 owned historical candidates sat in the pool).
    const missing = uncoveredQueryTokens(params.coreQuery, merged)
        .filter(t => !(category && (category.includes(t) || t.includes(category.slice(0, -1)))));
    if ((merged.length < wanted || missing.length) && (params.query || category)) {
        params.onStage?.('map', 'Asking the map for fresh spots…');
        try {
            const extra = await googleFallback({
                query: params.query, coreQuery: params.coreQuery, category, subType, center, radiusKm,
                needed: Math.max(wanted - merged.length, missing.length ? 3 : 0), requestId,
            }, deps);
            if (extra.length) {
                console.log(`[canonicalStore] google fallback: +${extra.length} (owned had ${merged.length}${missing.length ? `, uncovered: ${missing.join(',')}` : ''})`);
                merged = mergeAndDedupe(merged, extra);
                // Demand-fetched marking (the Uzbechka lesson, 2026-08-22
                // evening): "uzbek" is not a substring of "Uzbechka", so
                // string matching downstream can't recognize the fetched
                // match. The fallback KNOWS these places answer the demanded
                // term — mark the surviving twins (dedupe may have kept the
                // owned copy) so demand seats + the adaptive deck key off
                // knowledge, not spelling.
                if (missing.length) {
                    const fetchedKeys = new Set(extra
                        .flatMap(e => [e.placeId, normalizePlaceName(e.name || '')])
                        .filter(Boolean));
                    for (const c of merged) {
                        if (fetchedKeys.has(c.placeId) || fetchedKeys.has(normalizePlaceName(c.name || ''))) {
                            c._demandMatch = true;
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`[canonicalStore] google fallback failed: ${err.message} — serving owned data only`);
        }
    }
    return merged;
}

/** Which clean-query tokens (≥4 chars) match ZERO owned candidates? A non-empty
 *  answer means the corpus can't truthfully serve this ask — count is
 *  irrelevant. VIBE words never count as demands (first live day bought Google
 *  searches for "cozy,quiet" and "talk,evening" — adjectives are the
 *  embeddings' job; only concrete demands like sushi/uzbek/vegan justify paid
 *  fetches). maxShare>0 relaxes "zero matches" to "rare" (≤ that share of the
 *  pool) — findPlaces uses it to guarantee seats for demanded-term matches.
 *  Pure; exported for tests. */
const VIBE_TOKENS = new Set([
    'cozy', 'quiet', 'romantic', 'talk', 'chat', 'evening', 'tonight', 'night',
    'hours', 'near', 'nearby', 'place', 'places', 'good', 'best', 'nice',
    'cheap', 'authentic', 'local', 'open', 'beautiful', 'view', 'views',
    'lively', 'relax', 'relaxing', 'social', 'today', 'meet', 'date',
    // Function/request words (2026-08-23 live leak: a misread meta-question
    // bought 3 Google fetches for "make,search,suggest,more,results" and
    // carded WEB DESIGN AGENCIES as date spots). Imperatives and meta words
    // are never a DEMAND for a kind of place — only concrete nouns are.
    'make', 'search', 'suggest', 'suggestion', 'suggestions', 'more', 'results',
    'result', 'show', 'give', 'find', 'want', 'need', 'please', 'other',
    'another', 'internet', 'check', 'look', 'tell', 'list', 'recommend',
    'recommendation', 'recommendations', 'sources', 'searched', 'options',
    // Time and filler words (2026-08-23): "events next week" must not read as
    // a demand for places whose NAME contains "week" — no paid fetch for it,
    // and no false "nothing matches your ask" from the relevance brake.
    'next', 'week', 'weeks', 'weekend', 'tomorrow', 'days', 'time', 'times',
    'when', 'morning', 'afternoon', 'later', 'soon', 'this', 'that', 'with',
    'from', 'about', 'around', 'also', 'just', 'like', 'some', 'they',
]);
function uncoveredQueryTokens(coreQuery, candidates, maxShare = 0) {
    const tokens = String(coreQuery || '').toLowerCase().split(/[^a-zЀ-ӿ԰-֏]+/)
        .filter(t => t.length >= 4 && !VIBE_TOKENS.has(t));
    if (!tokens.length || !candidates.length) return [];
    const texts = candidates.map(c => String(c.text || c.name || '').toLowerCase());
    return tokens.filter(t => {
        const share = texts.filter(x => x.includes(t)).length / texts.length;
        return share <= maxShare;
    });
}

/** Thin-corpus seeding: coverage-gated, one search, ≤needed details resolves. */
async function googleFallback({ query, coreQuery, category, subType, center, radiusKm, needed, requestId }, deps = {}) {
    const coverageAllowed = deps.coverage
        || ((action, loc) => { try { return require('../../services/coverageService').googleAllowed(action, loc); } catch { return false; } });
    if (!(await coverageAllowed(category || 'general', { lat: center.lat, lng: center.lng }))) return [];

    const findPlaces = deps.findPlaces
        || ((q, loc, rid, opts) => require('../../services/googleService').findPlaces(q, loc, rid, opts));
    // The CLEAN intent query makes the best paid search — the enriched one
    // drags raw chat tokens into Google ("...место можно спокоино", live find).
    const q = [coreQuery, query, subType, category].filter(Boolean)[0] || 'places to visit';
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
    huntCity,
    googleFallback,
    uncoveredQueryTokens,
    buildCacheQuery,
    cacheDocToCandidate,
    dbDocToCandidate,
    scoreCachedDoc,
    mergeAndDedupe,
    isCommunityRejected,
};
