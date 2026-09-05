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

const { normalizePlaceName, _sigTokens } = require('./matching');
const { haversineKm } = require('../utils/geo');
const { scheduleToPeriods } = require('../context/contextEngine');
// The CURRENT embedding model — stored vectors from another model are noise
// in the new space and must be IGNORED until the sweep re-embeds them (the
// 2026-08-31 multilingual swap made this gate load-bearing).
const { LOCAL_MODEL: EMBED_MODEL } = require('../retrieval/embedder');
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
// Curated tag → the onboarding interest stem it satisfies. The two
// vocabularies are ALMOST identical but drift ('food&drink' tag vs saved key
// 'food_drink' — founder audit 2026-09-05), so matching goes through stems.
const _TAG_STEMS = { romantic: 'romantic', family: 'famil', nature: 'natur', adventure: 'adventur',
    cultural: 'cultur', history: 'histor', art: 'art', nightlife: 'night', relaxation: 'relax', 'food&drink': 'food' };

function _prefFitScore(types, primaryType, preferences, tags = []) {
    const t = [...(types || []), primaryType].filter(Boolean).map(x => String(x).toLowerCase());
    const interestsRaw = Array.isArray(preferences?.interests) ? preferences.interests.join(' ') : (preferences?.interests || '');
    const interests = String(interestsRaw).toLowerCase();
    // ── Direct curated-tag hit BEATS Google-type inference (founder audit
    //    2026-09-05: a Destination tagged 'romantic' scored ZERO for a
    //    romantic-only user because only Google types were consulted —
    //    the validator's own vocabulary is the most precise signal we own). ──
    if (interests) {
        for (const tag of (tags || []).map(x => String(x).toLowerCase())) {
            const stem = _TAG_STEMS[tag];
            if (stem && interests.includes(stem)) return 1;
        }
    }
    const want = [];
    if (/food|drink|gourmet|culinary/.test(interests)) want.push('restaurant', 'cafe', 'bakery', 'bar', 'food', 'meal_takeaway', 'coffee_shop', 'wine_bar', 'pub');
    if (/nature|outdoor/.test(interests)) want.push('park', 'garden', 'natural_feature', 'national_park', 'botanical_garden');
    if (/relax|wellness|spa/.test(interests)) want.push('spa', 'park', 'garden', 'resort_hotel');
    if (/family|kid/.test(interests)) want.push('zoo', 'aquarium', 'amusement_park', 'park', 'museum');
    // `cultur` not `culture`: the saved interest key is 'cultural', which does
    // NOT contain the substring 'culture' — the branch never fired for users
    // whose only culture-ish interest was 'cultural' (found 2026-08-30, same
    // audit that caught food_drink vs food&drink).
    if (/art|cultur|histor/.test(interests)) want.push('museum', 'art_gallery', 'tourist_attraction', 'historical_landmark');
    // ── The three interests that had NO branch at all (fixed 2026-08-27) ──
    // Live report: travel style luxury + interest romantic returned a deck the
    // preferences had no hand in. The cause was not weak weighting — it was
    // that `romantic`, `nightlife` and `adventure` matched none of the regexes
    // above, so `want` stayed empty, every candidate returned the same 0.5, and
    // the term carried ZERO discriminating power while looking like it worked.
    // A constant is worse than an absent signal: it is invisible in the logs.
    if (/romantic|romance|date/.test(interests)) want.push('wine_bar', 'bar', 'fine_dining_restaurant', 'observation_deck', 'garden', 'spa');
    if (/night|club|party/.test(interests)) want.push('night_club', 'bar', 'pub', 'casino', 'karaoke', 'comedy_club');
    if (/adventure|active|sport/.test(interests)) want.push('hiking_area', 'adventure_sports_center', 'sports_complex', 'ski_resort', 'water_park', 'golf_course', 'marina');
    if (!want.length) return 0.5;                       // no interests → neutral
    return t.some(tt => want.some(w => tt.includes(w))) ? 1 : 0;
}

/** The indexed bounding-box prefilter — v1's query shape, category optional. */
const _rxEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildCacheQuery({ center, radiusKm, category = null, excludePlaceIds = [], countryScope = null, alsoTypes = null }) {
    const freshnessCutoff = new Date(Date.now() - CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180)));
    const query = {
        imagesStored: true,
        aiBlocked: { $ne: true },                      // staff suppression at the SOURCE
        nameAskPending: { $ne: true },                 // name-ask quarantine: invisible until staff admit
        'explore.status': { $ne: 'hidden' },
        lastFetched: { $gte: freshnessCutoff },
    };
    // ── A COUNTRY IS NOT A CIRCLE (Arsen's rule, 2026-09-01: "if user asks in
    //    Armenia then it should see in country, it should filter by country
    //    then should filter by categories") ──
    // No radius centred anywhere can cover a country honestly: centred on the
    // capital it is a Yerevan deck, centred on the centroid it is farmland.
    // PlaceCache.country is indexed and holds the country NAME (parsed from
    // Google's formatted address), so a country ask filters on it directly and
    // the category gate below then applies exactly as it always has.
    // Case-insensitive because the field is address-parsed, not normalized.
    if (countryScope) {
        query.country = new RegExp(`^${_rxEscape(countryScope)}$`, 'i');
    } else {
        query['details.geometry.location.lat'] = { $gte: center.lat - latDelta, $lte: center.lat + latDelta };
        query['details.geometry.location.lng'] = { $gte: center.lng - lngDelta, $lte: center.lng + lngDelta };
    }
    // Ground-truth category match — widened on a broad ask (2026-09-03), where
    // the traveler named no venue type and intent's single guess must not
    // exclude the neighbouring sightseeing tags.
    if (alsoTypes && alsoTypes.length) query.actions = { $in: alsoTypes };
    else if (category) query.actions = category;
    if (excludePlaceIds.length) query.placeId = { $nin: excludePlaceIds };
    return query;
}

/**
 * The validator's style verdict on a row: true = staff said it fits, false =
 * staff said the opposite, null = staff said nothing (caller decides).
 *
 * The traveler's OWN tag is checked FIRST. A row carrying BOTH `luxury` and
 * `budget` serves both audiences — the validator's chip grid lets staff tick
 * both, and it is legitimate data — but testing the opposite first threw such
 * a row away for everyone (live 2026-09-03: a curated restaurant near Khor
 * Virap, tagged luxury AND budget, was invisible to a luxury traveler).
 * Pure; exported for tests. proximityService's Mongo clause mirrors this.
 */
function styleVerdict(interests = [], style = null) {
    if (!['luxury', 'budget'].includes(style)) return null;
    const ints = (interests || []).map(s => String(s).toLowerCase());
    if (ints.includes(style)) return true;
    if (ints.includes(style === 'luxury' ? 'budget' : 'luxury')) return false;
    return null;
}

// ── Community feedback, BOUNDED (2026-08-26) ─────────────────────────────────
//
// v1 scored this `net >= 0 ? 3*net : 8*net` — unbounded, and the only term in
// the formula that was. Every other signal is normalised: `hits` is capped at
// HIT_CAP and divided down to 0..1, `pref` is 0..1, `closeness` is 0..1, rating
// is 0..5. Feedback alone grew without limit.
//
// Measured on the live Yerevan pool (scripts/explainRetrieval.js):
//
//     one like ................................. 3.00 points
//     a perfect 5.0 Google rating .............. 5.00 points
//     the whole 0 → 50 km distance range ....... 1.00 point
//
// A single vote outweighed proximity three times over. On a corpus where almost
// nothing has votes, the few places that do became the answer to every ask
// carrying no other evidence — and since PlaceCache.likes is the SHARED counter,
// those were usually the asker's OWN votes handed back as community quality.
// Live 2026-08-26: a jewellery shop, a diamond gallery, a dried-fruit shop and a
// mall, ranked above everything, for "where can I meet someone".
//
// The asymmetry stays — it is deliberate and right: a disliked place should sink
// faster than a liked one climbs. What changes is that feedback now behaves like
// every other signal in the formula:
//
//   • a SHARE (net/votes, -1..+1) rather than a raw count, so 1-of-1 and 50-of-50
//     are the same opinion at different confidence, not different scores;
//   • CONFIDENCE ramps over the first few votes — one vote is a hint, three are
//     a verdict;
//   • BOUNDED: at most +2 for a loved place, down to -4 for a rejected one.
//
// Recalibrated, not replaced. v1 carries the same unbounded term and the same
// behaviour, so this is worth porting there too.
const FEEDBACK_TRUST_VOTES = 3;   // votes before feedback counts at full strength
const FEEDBACK_REWARD = 2;        // most a well-liked place may gain
const FEEDBACK_PENALTY = 4;       // negatives bite twice as hard as praise rewards

function feedbackScoreFor(likes = 0, dislikes = 0) {
    const votes = (likes || 0) + (dislikes || 0);
    if (!votes) return 0;
    const share = ((likes || 0) - (dislikes || 0)) / votes;          // -1 .. +1
    const confidence = Math.min(1, votes / FEEDBACK_TRUST_VOTES);    //  0 .. 1
    return share * confidence * (share >= 0 ? FEEDBACK_REWARD : FEEDBACK_PENALTY);
}

/** v1's backfill prior (aiRoutes ~2179–2195), with feedback bounded — see above. */
function scoreCachedDoc(d, distanceKm, radiusKm, category, preferences = {}) {
    const rating = d.rating || 0;
    const pref = _prefFitScore(d.types, d.primaryType, preferences, d.interests);
    const hits = Math.min(d.useCount || 0, HIT_CAP) / HIT_CAP;
    const closeness = 1 - (distanceKm / radiusKm);
    const feedbackScore = feedbackScoreFor(d.likes, d.dislikes);
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
        // Validator interest tags — read by the retrieval interest nudge.
        interests: Array.isArray(d.interests) ? d.interests : [],
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
        interests: d.interests || [],   // staff chips on the CACHE row — the style gate reads them
        likes: d.likes || 0,
        dislikes: d.dislikes || 0,
        vector: (Array.isArray(d.embedding) && d.embeddingModel === EMBED_MODEL) ? d.embedding : undefined,
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
 *  day-name hour schedules are converted to Google periods below
 *  (scheduleToPeriods), so validator-entered hours feed the same open-now
 *  math as PlaceCache rows; no valid schedule → null → UNKNOWN (kept). */
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
        // Curator's season window ("June-August") — advice for ranking +
        // narration, never a drop (founder feature 2026-09-05).
        bestTime: d.bestTimeToVisit || null,
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
        vector: (Array.isArray(d.embedding) && d.embeddingModel === EMBED_MODEL) ? d.embedding : undefined,
        // Curator's description, normalized to plain words — carried so the
        // narrator can UNDERSTAND the place (fed as an 'about' context note,
        // never copy material; see placeFactLine). Founder 2026-08-30:
        // validator-written descriptions were invisible to v2 narration.
        description: _descText(d.description) || null,
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
// Street signature for the twin pass below: house number + first distinctive
// street word, diacritics folded. "14 Abovyan St," and "14 Abovyan poxoc,
// Yerevan 0001, Armenia" both → "14 abovyan"; missing either part → null
// (no signature, never merged on address alone).
const _ADDR_GENERIC = new Set(['street', 'st', 'ave', 'avenue', 'blvd', 'boulevard', 'road', 'rd', 'lane', 'poxoc', 'pokhots', 'yerevan', 'armenia', 'tbilisi', 'georgia', 'dubai', 'united', 'arab', 'emirates']);
function _addrSig(addr) {
    if (!addr) return null;
    const toks = String(addr).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const num = toks.find(t => /\d/.test(t));
    const street = toks.find(t => /^\p{L}{4,}$/u.test(t) && !_ADDR_GENERIC.has(t));
    return num && street ? `${num} ${street}` : null;
}

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
    // Same place under DIFFERENT names — "Grand Hotel Yerevan" (curated) and
    // "Grand Hotel Yerevan, an SLH Hotel" (Google cache twin), both at
    // 14 Abovyan (live 2026-08-31): the name keys differ, so a second pass
    // uses street evidence. Drop a candidate when an already-kept one shares
    // its street signature AND one name's distinctive tokens are a SUBSET of
    // the other's (protects different venues at one address — a café and a
    // gallery in the same building share the street, never the name tokens).
    // Curated tiers arrive first in `lists`, so the curated twin always wins.
    const kept = [];
    for (const c of out) {
        const sig = _addrSig(c.address);
        const dup = sig && kept.some(k => _addrSig(k.address) === sig && (() => {
            const a = _sigTokens(c.name || ''), b = _sigTokens(k.name || '');
            if (!a.length || !b.length) return false;
            const A = new Set(a), B = new Set(b);
            return a.every(t => B.has(t)) || b.every(t => A.has(t));
        })());
        if (dup) { console.log(`[canonicalStore] street-twin dropped "${c.name}" (${sig})`); continue; }
        kept.push(c);
    }
    return kept;
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

    // ── CORRIDOR: several centres along a route (2026-09-02) ──
    // "on the way from Yerevan to Tatev" returned six Yerevan nightclubs,
    // because resolveDestination returns on the FIRST name it resolves. A
    // corridor is answered by searching SEVERAL points along the real road and
    // merging — and the cleanest way to do that is to recurse, so every gate
    // above (actions, freshness, community hide, style, price tier) applies to
    // each segment exactly as it does to a single-centre search.
    //
    // Each segment is capped so the biggest city cannot flood the deck, and the
    // Google fallback is DISABLED for corridor turns: four segments would mean
    // up to four paid Text Searches per question. Owned data answers, or the
    // narrator says plainly there is nothing along that route.
    if (Array.isArray(params.centres) && params.centres.length) {
        const wantTotal = Math.min(Math.max(Number(params.count) || 8, 1), 20);
        const perSegment = Math.max(2, Math.ceil(wantTotal / params.centres.length) + 1);
        const lists = [];
        for (const c of params.centres) {
            if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lng)) continue;
            const seg = await loadCandidates({
                ...params,
                centres: null,                       // stop the recursion
                corridor: true,                      // no paid fallback per segment
                center: { lat: c.lat, lng: c.lng },
                radiusKm: c.radiusKm || radiusKm,
            }, deps).catch(() => []);
            if (seg.length) lists.push(seg.slice(0, perSegment));
        }
        const merged = mergeAndDedupe(...lists);
        console.log(`[canonicalStore] corridor: ${params.centres.length} segment(s) → ${merged.length} candidate(s)`);
        return merged;
    }

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
            params.onSpend?.('hunt', 1);
            try {
                // First candidate whose city LOOKS like a city — dirty rows
                // carry address fragments ("10/9") in the city field.
                const city = huntCity(params, evs);
                const extra = await (deps.huntEvents || require('../events/hunt').huntEvents)({
                    city,
                    country: params.regionCountry || params.center?.country || null,
                    center: params.center,
                    window: params.eventWindow,
                    // The user's explicit search order also overrides the
                    // hunt's own source-freshness skip, not just this
                    // threshold — "see in internet" means READ, now.
                    force: !!params.eventsHunt.force,
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
        const query = buildCacheQuery({ center, radiusKm, category,
            excludePlaceIds: excludes.placeIds || [], countryScope: params.countryScope || null,
            alsoTypes: params.alsoTypes || null });
        if (deps.cacheFind) {
            cacheDocs = await deps.cacheFind(query);
        } else {
            const PlaceCache = require('../../models/PlaceCache');
            cacheDocs = await PlaceCache.find(query)
                .select('placeId name rating likes dislikes useCount types primaryType priceLevel details photos opening_hours interests actions city country embedding embeddingModel')
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
    // On a broad ask any of the admissible sightseeing tags counts as a match.
    const matchesAnyType = (action, sub, types, primaryType) =>
        (params.alsoTypes && params.alsoTypes.length)
            ? params.alsoTypes.some(t => placeMatches(t, sub, types, primaryType))
            : placeMatches(action, sub, types, primaryType);

    // Why did the cache tier come back empty? (2026-09-03) Live, "I'm at Khor
    // Virap. What should I visit next?" reported `owned had 0` and paid Google,
    // while four rows a few hundred metres away carried `historical`, real
    // photo bytes and passing types — every gate we could inspect from outside
    // said they should have been served. The DB query and the JS loop are two
    // different filters; only the loop can say which of its own rules fired.
    const dropped = { coords: 0, photos: 0, distance: 0, votes: 0, subtype: 0, types: 0, tier: 0 };
    const scoredCache = [];
    for (const d of cacheDocs) {
        const lat = d?.details?.geometry?.location?.lat;
        const lng = d?.details?.geometry?.location?.lng;
        if (lat == null || lng == null) { dropped.coords++; continue; }
        if (!d.photos || !d.photos[0]) { dropped.photos++; continue; }   // must render a card
        const distanceKm = haversineKm(center.lat, center.lng, lat, lng);
        if (distanceKm > radiusKm) { dropped.distance++; continue; }     // exact circular cap
        if (isCommunityRejected(d.likes, d.dislikes)) { dropped.votes++; continue; }
        if (category) {
            // v1's sub-type + landmark/type gates, verbatim semantics.
            if (subType) {
                const rowSubTags = Array.isArray(d.actions) ? d.actions.filter(a => SHOP_SUBTYPE_TAGS.includes(a)) : [];
                if (rowSubTags.length) {
                    if (!rowSubTags.includes(subType)) continue;
                } else if (!placeMatches(category, subType, d.types, d.primaryType)) {
                    dropped.subtype++; continue;
                }
            } else if (!matchesAnyType(category, null, d.types, d.primaryType)) {
                dropped.types++; continue;
            }
            const dTier = isPriceAction(category) ? priceTier(d.types, d.primaryType, d.priceLevel).tier : null;
            if (isPriceAction(category) && tierMismatch(dTier, preferences.travelStyle)) { dropped.tier++; continue; }
        }
        scoredCache.push({ d, distanceKm, score: scoreCachedDoc(d, distanceKm, radiusKm, category, preferences) });
    }
    // Only when it matters: a full pool needs no explanation, an empty one does.
    if (!scoredCache.length && cacheDocs.length) {
        const why = Object.entries(dropped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
        console.log(`[canonicalStore] cache tier: ${cacheDocs.length} row(s) matched the query, 0 survived — dropped by ${why || 'nothing (check the query itself)'}`);
    }
    scoredCache.sort((a, b) => b.score - a.score);
    // A parking lot is nobody's evening out (live 2026-09-06: "Aeon / ԷՕՆ —
    // Parking" carded as a romantic option). Service types are excluded from
    // recommendation pools by TYPE — a closed Google taxonomy, algorithmic,
    // not a phrase list.
    const SERVICE_TYPES = new Set(['parking', 'gas_station', 'car_wash', 'car_repair', 'car_dealer',
        'atm', 'bank', 'insurance_agency', 'real_estate_agency', 'storage', 'moving_company',
        'plumber', 'electrician', 'locksmith', 'laundry', 'funeral_home', 'local_government_office']);
    const _isServiceRow = (d) => {
        const ts = [d.primaryType, ...(d.types || d.details?.types || [])].filter(Boolean).map(t => String(t).toLowerCase());
        return ts.length > 0 && ts.some(t => SERVICE_TYPES.has(t)) && !ts.some(t => /tourist|park\b|attraction/.test(t) && t !== 'parking');
    };
    const _svcDropped = scoredCache.filter(({ d }) => _isServiceRow(d));
    if (_svcDropped.length) console.log(`[canonicalStore] service-type row(s) dropped: ${_svcDropped.map(({ d }) => d.name).join(', ')}`);
    const cacheCandidates = scoredCache.filter(({ d }) => !_isServiceRow(d)).slice(0, 40).map(({ d }) => cacheDocToCandidate(d, center));

    // ── Validator/partner tier (fail-open service reuse) ──
    let destinations = [], businesses = [];
    try {
        const proximity = deps.proximity || require('../../services/proximityService').findSmartProximityPlaces;
        const res = await proximity(center, preferences, category || 'general', radiusKm, 12, null, requestId, subType, null, { alsoTypes: params.alsoTypes || null });
        destinations = (res?.destinations || []).map(d => dbDocToCandidate(d, 'destination', center)).filter(Boolean);
        businesses = (res?.businesses || []).map(b => dbDocToCandidate(b, 'business', center)).filter(Boolean);
    } catch (err) {
        console.warn(`[canonicalStore] validator tier failed: ${err.message} — continuing with cache only`);
    }

    // ── VALIDATOR VERDICT SUPPRESSION (live 2026-08-31: Aero Hotel was
    //    curated + set to BUDGET by staff, yet appeared in a LUXURY user's
    //    deck — the style gate removed the curated Destination while its
    //    Google cache TWIN sailed through; the cache tier check above judges
    //    by GOOGLE's guess, which must never override the validator). A
    //    staff style judgment applies to the PLACE, not the row: curated docs
    //    tagged with the OPPOSITE gating style contribute a suppress set
    //    (placeId + googlePlaceId + normalized name) applied to cache rows
    //    and Google fallback finds. Docs with neither tag were never gated
    //    and suppress nothing. Fail-open on any load error. ──
    let suppress = null;
    {
        const rawStyle = String(preferences?.travelStyle || '').toLowerCase();
        const opposite = rawStyle === 'luxury' ? 'budget' : rawStyle === 'budget' ? 'luxury' : null;
        if (opposite) {
            try {
                const loadMismatched = deps.styleMismatched || (async (tag) => {
                    const Destination = require('../../models/Destination');
                    const Business = require('../../models/Business');
                    const [d1, d2] = await Promise.all([
                        Destination.find({ type: tag }).select('name placeId googlePlaceId').lean(),
                        Business.find({ type: tag }).select('name placeId googlePlaceId').lean(),
                    ]);
                    return [...d1, ...d2];
                });
                const rows = await loadMismatched(opposite);
                if (rows.length) {
                    suppress = { ids: new Set(), names: new Set() };
                    for (const r of rows) {
                        if (r.placeId) suppress.ids.add(r.placeId);
                        if (r.googlePlaceId) suppress.ids.add(r.googlePlaceId);
                        if (r.name) suppress.names.add(normalizePlaceName(r.name));
                    }
                }
            } catch (err) {
                console.warn(`[canonicalStore] style-suppress load failed (fail-open): ${err.message}`);
            }
        }
    }
    const suppressHit = (c) => !!suppress && (
        (c.placeId && suppress.ids.has(c.placeId))
        || suppress.names.has(normalizePlaceName(c.name || '')));
    const keptCache = suppress ? cacheCandidates.filter(c => !suppressHit(c)) : cacheCandidates;
    if (keptCache.length < cacheCandidates.length) {
        console.log(`[canonicalStore] validator style verdict suppressed ${cacheCandidates.length - keptCache.length} cache twin(s) for style=${preferences.travelStyle}`);
    }

    // ── Staff verdict lives on CACHE rows too (founder 2026-09-01, FOURTH
    //    report of budget-in-luxury): the validator tags cached places via
    //    the INTERESTS chips ('budget' / 'luxury' — Yerevan Boutique Hotel,
    //    Pushkin Hotel) — a different field from curated `type` tags, and
    //    nothing ever read it as a gate. Opposite-tagged rows are OUT, both
    //    directions. LUXURY additionally demands EVIDENCE from untagged
    //    rows: Google tier 'budget' is out, and unknown tier needs rating
    //    ≥ 4.2 — luxury is a promise; unknown must not impersonate it.
    //    (Budget style keeps unknowns: nothing wrong with a hidden gem.)
    const rawStyleG = String(preferences?.travelStyle || '').toLowerCase();
    const styleGate = (c) => {
        if (!['luxury', 'budget'].includes(rawStyleG)) return true;
        const ints = (c.interests || []).map(s2 => String(s2).toLowerCase());
        const verdict = styleVerdict(ints, rawStyleG);
        if (verdict !== null) return verdict;
        if (isPriceAction(category)) {
            // BUG FIX (2026-09-05): this compared the tier to the STRINGS
            // 'budget'/'luxury', but priceTier() returns 1-4 or null — so the
            // tier never gated anything and every cache row, $$$$ included,
            // lived or died on rating alone for luxury users. Now the shared
            // tierMismatch applies (founder buckets: luxury drops $/$$, budget
            // drops $$$/$$$$, FREE/unknown neutral), and the rating>=4.2 gate
            // remains only as luxury's quality proxy for UNPRICED rows.
            const t = priceTier(c.types, c.primaryType, c.priceLevel).tier;
            if (tierMismatch(t, rawStyleG)) return false;
            if (rawStyleG === 'luxury' && t === null && (c.rating || 0) < 4.2) return false;
        }
        return true;
    };
    const gatedCache = keptCache.filter(styleGate);
    if (gatedCache.length !== keptCache.length) {
        console.log(`[canonicalStore] style gate dropped ${keptCache.length - gatedCache.length} cache row(s) for style=${rawStyleG}: ${keptCache.filter(c => !styleGate(c)).map(c => c.name).join(', ')}`);
    }
    let merged = mergeAndDedupe(destinations, businesses, gatedCache);

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
    // Places this session ALREADY SAW will be excluded downstream — a pool
    // that merely re-finds them cannot fill the asked count ("give me 10
    // examples" after a 6-card deck: Google's page of 10 minus the 6 shown
    // left 4 cards, live 2026-08-30). The thinness target grows by the
    // exclude count so the fallback buys enough genuinely NEW places.
    const excludedCount = ((params.excludes?.placeIds || []).length
        + (params.excludes?.names || []).length);
    const wantedFresh = Math.min(20, wanted + Math.min(excludedCount, 12));
    // Category words never justify a PAID search: on a cat=historical request
    // the token "historical" is already answered by the category filter itself
    // (caught live 2026-08-22: fallback bought 3 places for "uncovered:
    // historical" while 22 owned historical candidates sat in the pool).
    // A DESTINATION NAME is never an unmet demand (live 2026-09-01: the
    // Armenia ask bought a Text Search for "uncovered: visit", and "armenia"
    // would have kept buying one every turn once "visit" was fixed). No cache
    // row's text carries its country, so the token can never be "covered" —
    // and it does not need to be: it is the search CENTRE, already applied as
    // coordinates. findPlaces has excluded geo tokens from the adaptive deck
    // since the tuning round; the paid path was simply never given the list.
    const geoTokens = new Set((params.geoTokens || []).map(t => String(t).toLowerCase()));
    // Nor does a FILLER word (live 2026-09-03: "What is the closest monastery?"
    // bought a Text Search reporting `uncovered: closest,monastery` — "closest"
    // is stripped from BM25 precisely because it describes no venue, yet it was
    // still counted as unmet demand on the paid path). One stoplist, both uses.
    let chatStop = new Set();
    try { chatStop = require('../retrieval/tuning').CHAT_STOPWORDS || new Set(); } catch { /* keep the old behaviour */ }
    const missing = uncoveredQueryTokens(params.coreQuery, merged)
        .filter(t => !geoTokens.has(t))
        .filter(t => !chatStop.has(t))
        .filter(t => !(category && (category.includes(t) || t.includes(category.slice(0, -1)))));
    if (!params.corridor && (merged.length < wantedFresh || missing.length) && (params.query || category)) {
        params.onStage?.('map', 'Asking the map for fresh spots…');
        try {
            let extra = await googleFallback({
                query: params.query, coreQuery: params.coreQuery, category, subType, center, radiusKm,
                regionCity: params.regionCity || null, alsoTypes: params.alsoTypes || null,
                needed: Math.max(wantedFresh - merged.length, missing.length ? 3 : 0), requestId,
            }, deps);
            if (suppress && extra.length) {
                const before = extra.length;
                extra = extra.filter(c => !suppressHit(c)).filter(styleGate);
                if (extra.length < before) console.log(`[canonicalStore] validator style verdict suppressed ${before - extra.length} Google find(s)`);
            }
            if (extra.length) {
                // Report the spend to whoever is measuring this turn. Same
                // shape as onStage: optional, ignored when nobody listens.
                params.onSpend?.('google', extra.length);
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
    // WHAT reached the ranker (2026-09-03). "Noah's Garden should have
    // appeared" is unanswerable from the summary line alone: `3/7 candidates`
    // says how many were cut, never which — so a curated row that arrived and
    // lost on score looks identical to one that never arrived at all.
    if (merged.length) {
        const names = merged.slice(0, 12).map(c => `${c.name}(${c.source || '?'})`).join(' · ');
        console.log(`[canonicalStore] pool: ${names}${merged.length > 12 ? ` …+${merged.length - 12}` : ''}`);
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
    // ── Generic TRAVEL verbs and nouns (live 2026-09-01) ──
    // "What are the best places to visit in Armenia?" treated "visit" as an
    // unmet demand: it bought a paid Google Text Search ("uncovered: visit")
    // AND tripped the adaptive-deck brake, so the traveler got 3 cards instead
    // of 6 for the most ordinary question in travel. No place's text contains
    // the word "visit" — these describe the ASK, never a venue, exactly like
    // the adjectives above. Only concrete demands (sushi, uzbek, vegan) may
    // justify a paid fetch or shrink a deck.
    'visit', 'visiting', 'see', 'seeing', 'sights', 'sightseeing', 'attraction',
    'attractions', 'explore', 'exploring', 'tour', 'touring', 'trip', 'travel',
    'things', 'todo', 'worth', 'must', 'famous', 'popular', 'top', 'recommend',
    'recommended', 'suggest', 'interesting', 'beautiful', 'amazing',
    'location', 'locations', 'spot', 'spots', 'area', 'around', 'city', 'town',
    'somewhere', 'anything', 'something', 'options',
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
/** The ONE substance test (founder doctrine 2026-08-31). A text is a
 *  SUBSTANTIVE ask when it is not refill phrasing (tuning's own multilingual
 *  regex — the same brain the refill path trusts) AND carries at least one
 *  ≥4-char token outside the vibe/function stoplist. Nothing failing this
 *  test may reach a paid search or stand as a remembered "ask" — it degrades
 *  to category+city / the earlier substantive ask instead. Scripts the
 *  tokenizer can't split (Arabic, Chinese) pass through untouched, same as
 *  the old junk rule. Reuses the TWO existing brains; no new word lists. */
function isSubstantiveAsk(text) {
    const s = String(text || '');
    try {
        if (require('../retrieval/tuning').parseRefillAsk(s).isRefill) return false;
    } catch { /* regex unavailable → token test alone decides */ }
    const toks = s.toLowerCase().split(/[^a-z0-9Ѐ-ӿ԰-֏]+/u).filter(Boolean);
    if (!toks.length) return true;   // unsplittable scripts pass through
    return toks.some(t => t.length >= 4 && !VIBE_TOKENS.has(t) && !/^\d+$/.test(t));
}

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
async function googleFallback({ query, coreQuery, category, subType, center, radiusKm, regionCity = null, needed, requestId, alsoTypes = null }, deps = {}) {
    const coverageAllowed = deps.coverage
        || ((action, loc) => { try { return require('../../services/coverageService').googleAllowed(action, loc); } catch { return false; } });
    if (!(await coverageAllowed(category || 'general', { lat: center.lat, lng: center.lng }))) {
        // Say WHY nothing was bought — a silent [] here made the Dilijan
        // empty-deck (2026-08-30) unreadable from the logs alone.
        console.log(`[canonicalStore] google fallback skipped — coverage gate (cat=${category || 'general'})`);
        return [];
    }

    const findPlaces = deps.findPlaces
        || ((q, loc, rid, opts) => require('../../services/googleService').findPlaces(q, loc, rid, opts));
    // ── WHITELIST BY CONSTRUCTION (founder doctrine 2026-08-31: "how to fix
    //    so it will work in 100% instead of each time adding a new word").
    //    Blacklisting junk words was an arms race — "results" leaked, then
    //    "make", then "ones" ("another ones please Dilijan" bought a paid
    //    search that carded a cafe and a wine bar in a hotels chain). The
    //    paid query is now never assembled from raw chat text at all: only
    //    the intent model's OWN clean query (the AI decides what to search)
    //    or code-written subType/category may reach Google. The enriched
    //    chat query stays in free BM25 where raw words belong. ──
    let q = (coreQuery && isSubstantiveAsk(coreQuery) ? coreQuery : null)
        || subType || category || 'places to visit';
    // The WHERE must survive in the TEXT: locationBias is only a bias, and a
    // bare subject biased to a town can return nothing — q="villas" biased to
    // Dilijan got 0 results while "villas Dilijan" finds them (live
    // 2026-08-31: the refill chain's subject change dropped the city). Append
    // the region city whenever the query text doesn't already carry it.
    if (regionCity && !q.toLowerCase().includes(String(regionCity).toLowerCase())) {
        q = `${q} ${regionCity}`;
    }
    // HARD SPEND CAP (founder 2026-09-05: "searches correctly, not the whole
    // message user gave"): a refill recycled an entire chat sentence into a
    // paid Text Search. Whatever slipped through above, a paid query is at
    // most 8 words — a search string, never prose.
    {
        const words = q.split(/\s+/).filter(Boolean);
        if (words.length > 8) {
            q = [...words.slice(0, 7), ...(regionCity && !words.slice(0, 7).join(' ').toLowerCase().includes(String(regionCity).toLowerCase()) ? [regionCity] : [])].join(' ');
            console.log(`[canonicalStore] paid query capped to "${q}"`);
        }
    }
    // ── SAME SEARCH, BOUGHT ONCE (2026-09-04) ──
    // Live 2026-09-03: the restaurant QA chain POSTed the identical Text
    // Search ("armenian restaurant near Republic Square Yerevan", same centre)
    // three times in five minutes — the token-coverage check can never be
    // satisfied by owned rows ("republic square" is nobody's NAME), so every
    // follow-up turn re-bought the same shortlist. Memoised here by
    // (normalised query, ~1km grid centre) in PlaceSearchCache, the same
    // collection and TTL discipline the quick-action prefetch already uses.
    // Only the shortlist is stored (ids + the fields the loop below reads);
    // details still resolve through the ordinary owned-data path.
    const SEARCH_TTL_MIN = 7 * 24 * 60;
    const searchKey = `text:${q.toLowerCase().trim().replace(/\s+/g, ' ')}`
        + `:${center.lat.toFixed(2)}:${center.lng.toFixed(2)}`;
    const searchCache = deps.searchCache || {
        get: async (key) => {
            const mongoose = require('mongoose');
            if (mongoose.connection?.readyState !== 1) return null;
            const hit = await require('../../models/PlaceSearchCache')
                .findOne({ key, expireAt: { $gt: new Date() } }).lean();
            return hit?.candidates?.length ? hit.candidates : null;
        },
        set: async (key, candidates) => {
            const mongoose = require('mongoose');
            if (mongoose.connection?.readyState !== 1) return;
            await require('../../models/PlaceSearchCache').updateOne(
                { key },
                { $set: { key, action: category || null, subType: subType || null, candidates,
                          expireAt: new Date(Date.now() + SEARCH_TTL_MIN * 60 * 1000) } },
                { upsert: true });
        },
    };
    let found = null;
    try {
        const cached = await searchCache.get(searchKey);
        if (cached) {
            found = cached.map(c => ({
                place_id: c.placeId, name: c.name, types: c.types || [],
                primaryType: c.primaryType || null, rating: c.rating ?? null,
                geometry: { location: { lat: c.lat, lng: c.lng } },
            }));
            console.log(`[canonicalStore] search-cache hit "${q}" — ${found.length} candidate(s), 0 paid`);
        }
    } catch (err) { console.warn(`[canonicalStore] search-cache read failed: ${err.message}`); }
    if (!found) {
        found = await findPlaces(q, center, requestId, { maxResultCount: Math.min(Math.max(needed, 6) + 4, 20) }) || [];
        try {
            if (found.length) {
                await searchCache.set(searchKey, found.map(p => ({
                    placeId: p.place_id, name: p.name,
                    lat: p.geometry?.location?.lat ?? null, lng: p.geometry?.location?.lng ?? null,
                    types: p.types || [], primaryType: p.primaryType || null, rating: p.rating ?? null,
                })).filter(c => c.placeId && c.name));
            }
        } catch (err) { console.warn(`[canonicalStore] search-cache write failed: ${err.message}`); }
    }

    // Resolve at most `needed` through v1's shared resolver — it caches details
    // AND stores images, so the card's place-image endpoint is valid and the
    // place is owned data from now on. Failures skip the place, never the turn.
    const resolveDetails = deps.resolveDetails || (async (placeId) => {
        const { getCachedPlaceDetails } = require('../../routes/aiRoutes').shared;
        return getCachedPlaceDetails(placeId, false, requestId, center, placeId, null, true);
    });
    // Same type test the cache gates and prefetch trust — one gate, no copy.
    const typeGate = deps.typeGate || ((action, st, types, pt) => {
        try { return require('../../services/googleService').placeMatchesActionType(action, st, types, pt); }
        catch { return true; /* gate unavailable → lenient, never drop the turn */ }
    });
    // ── A HIDDEN PLACE STAYS HIDDEN, INCLUDING WHEN GOOGLE RE-SELLS IT ──
    // Founder, 2026-09-03: "i have set hide from admin page some locations in
    // placecache but it shows". buildCacheQuery honours `explore.status` and
    // `aiBlocked`, so the CACHE tier dropped the row correctly — and then this
    // fallback bought the same place back from Google and carded it, because
    // nothing here ever consulted the staff verdict. Live proof in the same
    // turn: "[images] ChIJoZkc… is hidden — downloaded photos NOT stored",
    // immediately followed by that place in the pool as source 'google'.
    // Hide means gone from EVERY surface (CLAUDE.md invariant); one indexed
    // query over the ids we just fetched enforces it.
    let suppressed = new Set();
    try {
        const ids = found.map(p => p?.place_id).filter(Boolean);
        // Injectable, and skipped entirely when Mongo is not connected — an
        // unconnected mongoose BUFFERS for 10s before throwing, which would
        // park the turn rather than fail it (the lesson gazetteer._ready records).
        const hiddenLookup = deps.hiddenIds || (async (idList) => {
            const mongoose = require('mongoose');
            if (mongoose.connection?.readyState !== 1) return [];
            return require('../../models/PlaceCache').find({
                placeId: { $in: idList },
                $or: [{ 'explore.status': 'hidden' }, { aiBlocked: true }],
            }).select('placeId name').lean();
        });
        if (ids.length) {
            const rows = (await hiddenLookup(ids)) || [];
            suppressed = new Set(rows.map(r => r.placeId));
            if (suppressed.size) {
                console.log(`[canonicalStore] staff-hidden, not re-bought: ${rows.map(r => r.name).join(', ')}`);
            }
        }
    } catch (err) {
        console.warn(`[canonicalStore] hidden-check failed: ${err.message} — serving without it`);
    }

    const out = [];
    for (const p of found) {
        if (out.length >= needed) break;
        if (!p?.place_id || !p?.name) continue;
        if (suppressed.has(p.place_id)) continue;      // staff said no, everywhere
        const lat = p.geometry?.location?.lat, lng = p.geometry?.location?.lng;
        if (lat == null || lng == null) continue;
        const distanceKm = haversineKm(center.lat, center.lng, lat, lng);
        if (distanceKm > radiusKm) continue;
        let d = null;
        try { d = await resolveDetails(p.place_id); } catch { /* d stays null → skipped below */ }
        // Details are REQUIRED. A place whose resolve failed has no cache row
        // and no stored image — it carded as "Location not specified" with a
        // dead image (Sunny Lodge ECONNRESET, live 2026-08-31). The old
        // comment promised "failures skip the place"; now the code does.
        if (!d) {
            console.log(`[canonicalStore] fallback skip "${p.name}" — details unresolved`);
            continue;
        }
        // The asked CATEGORY is a hard gate on paid rows: mixed text-search
        // results once carded a CAFE and a WINE BAR in a hotels chain (live
        // 2026-08-31). Unknown types stay lenient inside the gate itself.
        // On a BROAD ask the admissible set is wider (live 2026-09-03: "what
        // can I do within 10 km" dropped the Museum of Illusions and a park as
        // "not activities", then reported the deck as thin).
        const gateTypes = (alsoTypes && alsoTypes.length) ? alsoTypes : (category ? [category] : []);
        if (gateTypes.length && !gateTypes.some(t => typeGate(t, subType, d.types, d.primaryType))) {
            console.log(`[canonicalStore] fallback skip "${p.name}" — not ${gateTypes.join('/')} (${d.primaryType || (d.types || []).slice(0, 2).join('/') || 'unknown types'})`);
            continue;
        }
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
    styleVerdict,
    cacheDocToCandidate,
    dbDocToCandidate,
    scoreCachedDoc,
    _prefFitScore,
    mergeAndDedupe,
    isCommunityRejected,
    feedbackScoreFor,
    // The repo's ONE vibe/function-word stoplist — session.js's narrowing
    // detector reads it too (a second hand-typed copy is the repo's oldest
    // recurring bug).
    VIBE_TOKENS,
    isSubstantiveAsk,
};
