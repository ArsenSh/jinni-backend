const Business = require('../models/Business');
const Destination = require('../models/Destination');
const googleService = require('./googleService');
const currencyService = require('./currencyService');

/**
 * Mongo filter clauses that gate which Business documents are eligible to be
 * surfaced to travelers (AI chat, quick actions, public discovery, etc.).
 *
 * Two layers, combined into an `$and` block by the caller:
 *
 *   1. status === 'active'
 *      Excludes pending, frozen, waitlisted, rejected, and expired listings.
 *      These statuses each carry their own meaning that travelers shouldn't
 *      see: pending isn't approved yet, frozen lost its zone slot, expired
 *      events have already happened, etc.
 *
 *   2. Event freshness
 *      A defense-in-depth check for events specifically. Even an event with
 *      `status: 'active'` should be hidden if its end-time has passed —
 *      because lazy-expire only fires when someone GETs the listing, an
 *      event could sit at `active` in Mongo for days after it ended if its
 *      owner doesn't open the dashboard. The clauses:
 *        • non-events             → always pass
 *        • recurring events       → always pass (perpetually relevant)
 *        • events with endDate    → endDate must be in the future
 *        • events without endDate → startDate must be in the future
 *
 * Returns the clauses as an object so callers can merge into a larger query
 * with their own `$and` constraints (region filter, type filter, etc.).
 */
/**
 * The event-freshness half of the filter above, on its own.
 *
 * Split out because Destination documents need the SAME date gate but have no
 * `status` field to check — they are editorial content with an `isActive`
 * soft-delete flag and nothing else. A validator-curated event destination
 * (a city concert added from the Verifier page) must stop being served the
 * moment it ends, exactly like an owner-registered event business.
 *
 * Model-agnostic: it only touches `type` and `eventSchedule.*`, which both
 * Business and Destination now carry in the same shape.
 *
 * Note the difference in enforcement between the two models. A Business also
 * gets lazily flipped to status:'expired' when someone GETs it, so there are
 * two overlapping defenses. A Destination has no status to flip, so THIS
 * clause is the only thing standing between an ended event and a traveler —
 * every destination query that can surface events must include it.
 */
function eventFreshnessClause() {
    const now = new Date();
    return {
        $or: [
            // Non-events: nothing to check
            { type: { $nin: ['events'] } },
            // Recurring events are perpetually relevant
            { 'eventSchedule.isRecurring': true },
            // One-time events with an endDate that's still in the future
            { 'eventSchedule.endDate': { $gte: now } },
            // One-time events with only a startDate (no end), still upcoming
            { $and: [
                { 'eventSchedule.endDate':   { $in: [null, undefined] } },
                { 'eventSchedule.startDate': { $gte: now } }
            ]},
            // Events carrying NO schedule at all. These are pre-feature docs —
            // chiefly destinations that were tagged 'events' back when the tag
            // was the only thing an event had. There is no date to compare, so
            // date-gating them would silently delete existing content from
            // discovery. Treated as evergreen, which is also exactly what
            // isEventExpired() reports for them (no end/start → not expired),
            // so the query and the model method agree.
            { $and: [
                { 'eventSchedule.startDate': { $in: [null, undefined] } },
                { 'eventSchedule.endDate':   { $in: [null, undefined] } }
            ]}
        ]
    };
}

function discoverabilityFilter() {
    return {
        status: 'active',
        $and: [eventFreshnessClause()]
    };
}

/**
 * ── Effective price ──────────────────────────────────────────────────────────
 *
 * One number standing in for "what this place costs", derived from whichever
 * pricing fields the owner or validator actually filled in. Listings are rarely
 * fully specified — plenty carry only a minimum ("from $12") and nothing else —
 * and before this, anything other than a complete min+max pair was invisible to
 * budget matching.
 *
 * Priority, most specific first:
 *   isFree        → 0        (free entry is inside every budget)
 *   average       → average  (the owner's own answer; trust it over derived)
 *   min AND max   → midpoint (the representative point of the stated range)
 *   min only      → min      ← "from $12": the cheapest way in, so it is what
 *                              decides whether the place is reachable at all
 *   max only      → max      (symmetric; a ceiling is better than nothing)
 *   nothing set   → null     → NOT filtered. An unpriced listing must never be
 *                              hidden just for being unpriced; silence about
 *                              price is not evidence of being expensive.
 *
 * NOTE: this replaces reads of `pricing.averagePrice`, a field that exists in
 * neither the Business nor the Destination schema. Every document therefore
 * matched the old `$exists: false` escape hatch, which meant budget filtering
 * had been silently doing nothing at all.
 */
function effectivePrice(pricing) {
    if (!pricing) return null;
    if (pricing.isFree === true) return 0;
    if (pricing.average != null) return pricing.average;
    if (pricing.min != null && pricing.max != null) return (pricing.min + pricing.max) / 2;
    if (pricing.min != null) return pricing.min;
    if (pricing.max != null) return pricing.max;
    return null;
}

/**
 * The same rule as a Mongo clause, so filtering happens in the database rather
 * than after the fact. `$expr` is required because the effective price is
 * derived from several fields rather than stored — the trade-off is that this
 * clause can't be index-served, which is acceptable since it only applies when
 * the user actually set a budget, and the query is already narrowed by type,
 * region and status by the time it runs.
 *
 * Matches when the price is unknown (keep the listing) OR the effective price
 * falls inside the budget band. Note the band is two-sided, matching how
 * `average` has always been treated: a place far below the budget floor is
 * filtered out too, on the assumption that a stated budget expresses a
 * preferred bracket rather than a ceiling alone.
 */
function budgetMatchClause(budget) {
    const nn = (field) => ({ $gt: [field, null] });   // non-null AND present
    return {
        $expr: {
            $let: {
                vars: {
                    eff: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$pricing.isFree', true] }, then: 0 },
                                { case: nn('$pricing.average'), then: '$pricing.average' },
                                { case: { $and: [nn('$pricing.min'), nn('$pricing.max')] },
                                  then: { $divide: [{ $add: ['$pricing.min', '$pricing.max'] }, 2] } },
                                { case: nn('$pricing.min'), then: '$pricing.min' },
                                { case: nn('$pricing.max'), then: '$pricing.max' }
                            ],
                            default: null
                        }
                    }
                },
                in: {
                    $or: [
                        { $eq: ['$$eff', null] },
                        // Free is affordable at every budget. It must bypass
                        // the band, not just sit at 0 — the band has a FLOOR,
                        // so a $30–$60 budget would otherwise hide free places
                        // for being "too cheap", which is never what a traveler
                        // means when they name a price range.
                        { $eq: ['$$eff', 0] },
                        { $and: [
                            { $gte: ['$$eff', budget.min] },
                            { $lte: ['$$eff', budget.max] }
                        ]}
                    ]
                }
            }
        }
    };
}

/**
 * Smart proximity-based place finder with preference matching (NO Google enrichment)
 * @param {Object} userLocation - { lat: number, lng: number }
 * @param {Object} preferences - { interests: string[], travelStyle: string }
 * @param {string} actionType - 'restaurants', 'hotels', 'historical', 'hidden_gems', 'events', 'shopping', 'photo_spots'
 *        Note on the two newer actions:
 *          • 'shopping'   → gated on the chosen sub-type tag (souvenirs/clothing/
 *                           market/mall/jewelry/food). There is no 'shopping'
 *                           tag — the button always resolves to a sub-type before
 *                           a search runs. Sub-type comes in via the subType arg.
 *          • 'photo_spots'→ usually has no tagged businesses, so the business
 *                           $all filter returns nothing and results come from
 *                           region-bound scenic destinations (parks, viewpoints,
 *                           monuments) plus AI-suggested places. An optional
 *                           'photo_spots' tag also exists for hand-curated spots,
 *                           which then surface (and rank highest) under it.
 * @param {number} radiusKm - Search radius in kilometers (default: 50)
 * @param {number} maxResults - Maximum results to return (default: 10)
 * @param {string|null} subType - Shopping sub-category when actionType==='shopping'
 *        (one of: souvenirs | clothing | market | mall | jewelry | food).
 *        When set, the business AND destination type filters tighten to that
 *        sub-type tag instead of the generic 'shopping' umbrella, so "Jewelry"
 *        returns only jewelry-tagged listings. Ignored for every other action.
 * @returns {Promise<Object>} { businesses: Array, destinations: Array, metadata: Object }
 */
async function findSmartProximityPlaces(userLocation, preferences, actionType, radiusKm = 50, maxResults = 10, userRegion = null, requestId = null, subType = null, seenPenalty = null) {
    // Novelty bias: `seenPenalty` is a Map (identity → penalty) the caller
    // precomputes from the user's PlaceView history. A place already seen loses
    // a little score so fresh ones rise — SOFT (subtracted before the top-N cut,
    // never a filter), so a thin market still fills. Applied by _seenPen below.
    const _seenPen = (p) => seenPenalty ? (seenPenalty.get(p.placeId) || seenPenalty.get(p.googlePlaceId) || seenPenalty.get(String(p._id)) || 0) : 0;
    const startTime = Date.now();
    try {
        if (!userLocation?.lat || !userLocation?.lng) { throw new Error('Valid user location required'); }
        const userInterests = preferences?.interests || [];
        // travelStyle now carries the PRICE axis only (luxury | budget). Those are
        // the only style values that exist as type tags on Business/Destination,
        // so they're the only ones we hard-gate on. family/romantic moved to
        // interests and are handled as soft scoring (calculatePreferenceScore).
        // Anything else (empty, legacy 'solo', or a not-yet-migrated
        // 'romantic'/'family') is treated as "no price gate" — otherwise an
        // empty/unknown style would $all-match a tag no document has and return
        // zero results.
        const GATING_STYLE_TAGS = ['luxury', 'budget'];
        const rawStyle = (preferences?.travelStyle || '').toLowerCase();
        const userStyle = GATING_STYLE_TAGS.includes(rawStyle) ? rawStyle : null;
        const userBudget = preferences?.budget || null;

        // For shopping, the real category is the sub-type the user picked
        // ('jewelry', 'mall', …). There is no 'shopping' tag in the schema —
        // "Shopping" is just the button — so the UI always sends a sub-type. If
        // one is somehow missing, effectiveTag stays 'shopping', which matches no
        // document on purpose (the DB simply contributes nothing and the AI
        // prompt's general-shopping fallback carries the result). Other actions
        // ignore subType entirely.
        const SHOPPING_SUBTYPES = ['souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food'];
        const effectiveTag = (actionType === 'shopping' && SHOPPING_SUBTYPES.includes(subType))
            ? subType
            : actionType;
        
        // Normalize user budget to USD for database comparison
        let normalizedBudget = null;
        const shouldFilterBudget = userBudget?.min && userBudget?.max && !(userBudget.min === 0 && userBudget.max === 0);
        
        if (shouldFilterBudget) {
            normalizedBudget = currencyService.normalizeBudgetToUSD(userBudget);
            // console.log(`Budget conversion: ${userBudget.min}-${userBudget.max} ${userBudget.currency} → ${normalizedBudget.min}-${normalizedBudget.max} USD`);
        }
        
        //console.log(`Proximity search: action = ${actionType}, radius = ${radiusKm}km, interests = [${userInterests.join(',')}], style = ${userStyle}`);

        if (!userRegion) {
            try { userRegion = await googleService.detectUserRegion(userLocation, requestId) } 
            catch (error) { console.warn('Region detection failed, using global search') }
        } else {
            //console.log('✅ Using pre-detected region (no API call)');
        }
        // ── Base business query ──────────────────────────────────────────────
        // `isActive` is the soft-delete flag (false = owner-deleted listing).
        // The status+freshness gate is added via discoverabilityFilter() so
        // we don't surface pending/frozen/rejected/expired listings, and so
        // events that have ended but haven't been lazy-expired yet still
        // get hidden. The helper writes its own `$and` clause; we merge
        // rather than overwrite so the budget/region clauses below still
        // layer cleanly on top.
        const discFilter = discoverabilityFilter();
        const baseQuery = {
            isActive: true,
            type: userStyle ? { $all: [effectiveTag, userStyle] } : { $all: [effectiveTag] },
            status: discFilter.status,
            $and: [...discFilter.$and]
        };
        if (shouldFilterBudget && normalizedBudget) {
            // Derives one representative price from whatever pricing fields are
            // filled in, so a listing carrying only a minimum ("from $12") is
            // budget-matched instead of ignored. See effectivePrice().
            baseQuery.$and.push(budgetMatchClause(normalizedBudget));
        }
        if (userRegion?.country) {
            const countryVariations = [userRegion.country, userRegion.region, userRegion.city].filter(Boolean);
            const regionFilter = {
                $or: [
                    { 'location.region': { $in: countryVariations } },
                    { 'location.city': { $in: countryVariations } },
                    { 'location.coordinates.lat': { $gte: userLocation.lat - 2, $lte: userLocation.lat + 2 }, 'location.coordinates.lng': { $gte: userLocation.lng - 2, $lte: userLocation.lng + 2 } }
                ]
            };
            // baseQuery.$and always exists now (seeded by discoverabilityFilter),
            // so we just push the region clause. The old `if (baseQuery.$and)`
            // / `else` branch is no longer needed.
            baseQuery.$and.push(regionFilter);
        }
        // ── Destination query ────────────────────────────────────────────────
        //   Destinations are public sites (parks, monuments, viewpoints, museums).
        //   They are almost never tagged with `restaurants` or `hotels`, so the
        //   old strict filter `type: { $all: [actionType, userStyle] }` returned
        //   zero rows whenever the user message was about food or lodging — even
        //   though nearby cultural/historical sites would be relevant context.
        //
        //   New rule:
        //     - For `historical`, `hidden_gems`, `events`, `shopping` keep the
        //       strict $all filter — those action types are first-class tags a
        //       destination genuinely carries (e.g. a covered bazaar tagged
        //       'shopping'). This is what stops, say, a 'restaurants'-tagged
        //       destination from leaking into a Shopping search.
        //     - For `photo_spots` gate on a set of *visually relevant* tags via
        //       $in (parks, viewpoints, heritage, art) so a 'restaurants'-only
        //       destination is excluded while scenic sites still surface. We use
        //       $in (not $all) because photo-worthiness comes from ANY of these.
        //     - For `restaurants` and `hotels` we still surface nearby
        //       destinations as complementary context, bounded by region +
        //       radius and ranked by interest scoring — no type gate.
        //
        //   IMPORTANT: destinations are public sites (parks, monuments,
        //   viewpoints) that almost never carry a price tier, so we do NOT gate
        //   them on luxury/budget — doing so would filter out almost everything.
        // NOTE: 'restaurants' and 'hotels' are included so a destination must
        // actually carry that tag to surface under those actions. Without them
        // the query falls through to region-only and pulls EVERY active
        // destination in the area — e.g. a 'restaurants'-tagged destination
        // ("Master Class") showing up as the lone result under a Hotels search,
        // then mislabeled "Hotel" by getCategoryFromAction. If you want nearby
        // destinations as complementary context again, do it as a separate,
        // clearly-labeled section rather than mixing them into the typed results.
        const destinationActionFirstClass = ['restaurants', 'hotels', 'historical', 'hidden_gems', 'events', 'shopping'];
        const PHOTO_DEST_TAGS = ['photo_spots', 'nature', 'art', 'cultural', 'history', 'historical', 'hidden_gems'];
        // Event freshness applies here too. Destinations tagged 'events' are
        // validator-curated concerts/festivals with a real date, and once that
        // date passes they must stop surfacing — same rule as event businesses.
        // Unlike Business there is no status to lazily flip, so this clause is
        // the sole enforcement point (see eventFreshnessClause's comment).
        // 'general' = a travel turn with no specific category ("best places to
        // visit"). It used to fall through to REGION-ONLY here, which dumped a
        // city's ENTIRE destination pool into the model's context — restaurant
        // listings included (2026-08-20 prod log: 56 destinations on a general
        // turn; $20 cafés carded against a $5–10 budget). General means
        // sightseeing: gate to visit-worthy tags. Dining/lodging destinations
        // still surface on their own action turns.
        const GENERAL_DEST_TAGS = [...PHOTO_DEST_TAGS, 'events'];
        const destinationQuery = { isActive: true, $and: [eventFreshnessClause()] };
        if (actionType === 'photo_spots') {
            // Only visually-relevant destinations — excludes e.g. a destination
            // tagged solely 'restaurants', includes parks/viewpoints/heritage/art.
            destinationQuery.type = { $in: PHOTO_DEST_TAGS };
        } else if (actionType === 'general') {
            destinationQuery.type = { $in: GENERAL_DEST_TAGS };
        } else if (destinationActionFirstClass.includes(actionType)) {
            // First-class action types are real destination tags → match strictly.
            // For shopping this is the chosen sub-type (effectiveTag), e.g. a
            // covered bazaar tagged 'market' surfaces under the Markets chip.
            destinationQuery.type = { $all: [effectiveTag] };
        }
        // else: no type gate — region/distance bound the set
        // and calculatePreferenceScore ranks by the user's interests.
        // ── Budget gates destinations too ─────────────────────────────────────
        // Destination.pricing mirrors Business.pricing (validator-entered entry
        // fees / average meal prices), yet the budget clause only ever applied
        // to businesses — a $20/person café entered as a Destination sailed
        // through a $5–10 budget (2026-08-20 prod report). Same rule as
        // businesses: KNOWN price must fit the band; unknown/free stays (never
        // punish missing data — parks and viewpoints carry no price).
        if (shouldFilterBudget && normalizedBudget) {
            destinationQuery.$and.push(budgetMatchClause(normalizedBudget));
        }
        // Same region/coordinate filter as businesses, so we don't pull
        // destinations from across the world when the user is in a specific city.
        if (userRegion?.country) {
            const countryVariations = [userRegion.country, userRegion.region, userRegion.city].filter(Boolean);
            destinationQuery.$or = [
                { 'location.region': { $in: countryVariations } },
                { 'location.city':   { $in: countryVariations } },
                { 'location.coordinates.lat': { $gte: userLocation.lat - 2, $lte: userLocation.lat + 2 }, 'location.coordinates.lng': { $gte: userLocation.lng - 2, $lte: userLocation.lng + 2 } }
            ];
        }
        const [candidateBusinesses, candidateDestinations] = await Promise.all([
            Business.find(baseQuery).lean().exec(),
            Destination.find(destinationQuery).lean().exec()
        ]);
        const destFilterMode = actionType === 'photo_spots'
            ? 'photogenic-$in'
            : (actionType === 'general'
                ? 'general-visitworthy-$in'
                : (destinationActionFirstClass.includes(actionType) ? 'action-strict' : 'region-only'));
        console.log(`Proximity DB query: action=${actionType}${effectiveTag !== actionType ? ' subType='+effectiveTag : ''}, style=${userStyle || 'none'}${shouldFilterBudget ? ' budget=on(dest too)' : ''} → ${candidateBusinesses.length} businesses, ${candidateDestinations.length} destinations (destination filter: ${destFilterMode})`);

        function hasValidCoords(place) { return place.location?.coordinates?.lat && place.location?.coordinates?.lng; }
        const validBusinesses = candidateBusinesses.filter(hasValidCoords);
        const validDestinations = candidateDestinations.filter(hasValidCoords);
        const businessesForDistance = validBusinesses.map(business => ({ ...business, lat: business.location.coordinates.lat, lng: business.location.coordinates.lng, name: business.name }));
        const destinationsForDistance = validDestinations.map(dest => ({ ...dest, lat: dest.location.coordinates.lat, lng: dest.location.coordinates.lng, name: dest.name }));
        const [businessDistances, destinationDistances] = await Promise.all([businessesForDistance.length > 0 ? googleService.calculateDistances(userLocation, businessesForDistance, requestId) : [], destinationsForDistance.length > 0 ? googleService.calculateDistances(userLocation, destinationsForDistance, requestId) : []]);
        const businessesWithDistance = businessDistances.filter(result => result.distance.km <= radiusKm).map(result => ({...result.destination, distance: result.distance.km, distanceText: result.distance.text, duration: result.duration.text}));
        const destinationsWithDistance = destinationDistances.filter(result => result.distance.km <= radiusKm).map(result => ({...result.destination, distance: result.distance.km, distanceText: result.distance.text, duration: result.duration.text}));
        //console.log(`Distance filtered: ${businessesWithDistance.length} businesses, ${destinationsWithDistance.length} destinations`);

        function calculatePreferenceScore(placeTypes, userInterests, averagePrice = null, normalizedBudget = null) {
            let score = 5;    
            userInterests.forEach(interest => { if (placeTypes.includes(interest)) { score += 2 } });    
            // Photo-spot bias: most photogenic destinations aren't tagged
            // 'photo_spots' explicitly, so beyond the strong boost for an
            // explicit tag (above) we softly boost destinations whose tags tend
            // to be visually striking (scenic nature, landmarks, art, heritage)
            // so viewpoints/monuments float above, say, an admin office tagged
            // only 'cultural'. Pure ranking nudge — nothing is excluded.
            if (actionType === 'photo_spots') {
                // An explicit 'photo_spots' tag is the strongest signal (admin
                // hand-picked it), so weight it above the merely photogenic tags.
                if (placeTypes.includes('photo_spots')) { score += 4; }
                const PHOTOGENIC_TAGS = ['nature', 'art', 'cultural', 'history', 'historical', 'hidden_gems'];
                PHOTOGENIC_TAGS.forEach(tag => { if (placeTypes.includes(tag)) { score += 1.5 } });
            }
            if (shouldFilterBudget && averagePrice && normalizedBudget) {
                const budgetMid = (normalizedBudget.min + normalizedBudget.max) / 2;
                const priceDeviation = Math.abs(averagePrice - budgetMid);
                const maxDeviation = (normalizedBudget.max - normalizedBudget.min) / 2;
                const budgetScore = 1 - (priceDeviation / maxDeviation);
                score += budgetScore * 3;
            }
            return score;
        }
        const finalBusinesses = businessesWithDistance
            .map(business => {
                // Same derived price the Mongo filter used, so scoring and
                // filtering can never disagree about what a listing costs.
                const price = effectivePrice(business.pricing);
                const prefScore = calculatePreferenceScore(business.type || [], userInterests, price, normalizedBudget);
                return {
                    ...business,
                    preferenceScore: prefScore,
                    totalScore: prefScore + (radiusKm - business.distance) / 10 - _seenPen(business),
                    // null when the price is unknown or no budget was given —
                    // "not applicable", distinct from "outside the budget".
                    // `price != null` rather than a truthiness test so a free
                    // listing (0) reports withinBudget instead of null.
                    withinBudget: shouldFilterBudget && price != null && normalizedBudget
                        ? (price === 0 || (price >= normalizedBudget.min && price <= normalizedBudget.max))
                        : null
                };
            }).sort((a, b) => b.totalScore - a.totalScore).slice(0, maxResults);
        const finalDestinations = destinationsWithDistance
            .map(dest => ({
                ...dest,
                preferenceScore: calculatePreferenceScore(dest.type || [], userInterests),
                totalScore: calculatePreferenceScore(dest.type || [], userInterests) + (radiusKm - dest.distance) / 10 - _seenPen(dest)
            })).sort((a, b) => b.totalScore - a.totalScore).slice(0, maxResults);
        //console.log(`Final candidates: ${finalBusinesses.length} businesses, ${finalDestinations.length} destinations`);
        //console.log(`All results match action type: ${actionType} and style: ${userStyle}`);
        const processingTime = Date.now() - startTime;
        const result = {
            businesses: finalBusinesses,
            destinations: finalDestinations,
            metadata: {
                processingTimeMs: processingTime,
                userRegion: userRegion,
                searchRadius: radiusKm,
                actionTypeFilter: actionType,
                subTypeFilter: (actionType === 'shopping' && effectiveTag !== actionType) ? effectiveTag : null,
                styleFilter: userStyle,
                budgetFilter: shouldFilterBudget ? { 
                    original: { min: userBudget.min, max: userBudget.max, currency: userBudget.currency },
                    normalized: { min: normalizedBudget.min, max: normalizedBudget.max, currency: 'USD' }
                } : null,
                totalCandidates: candidateBusinesses.length + candidateDestinations.length,
                finalResults: finalBusinesses.length + finalDestinations.length,
                performanceMetrics: {
                    dbQueryCount: candidateBusinesses.length + candidateDestinations.length,
                    localDistanceCalculations: businessesWithDistance.length + destinationsWithDistance.length,
                    googleApiCalls: 0,
                    readyForEnrichment: finalBusinesses.length + finalDestinations.length
                }
            }
        };
        // console.log(`Smart proximity completed in ${processingTime}ms (NO Google distance API calls)`);
        return result;
    } catch (error) {
        console.error('Smart proximity search failed:', error);
        return {businesses: [], destinations: [], metadata: { error: error.message, processingTimeMs: Date.now() - startTime }};
    }
}

function deriveCategoryFromType(types) {
    if (!types || !Array.isArray(types)) return 'Business';    
    if (types.includes('restaurants')) return 'Restaurant';
    if (types.includes('hotels')) return 'Hotel';
    if (types.includes('historical')) return 'Historical Site';
    if (types.includes('events')) return 'Event';
    if (types.includes('hidden_gems')) return 'Hidden Gem';
    if (types.includes('jewelry'))   return 'Jewelry';
    if (types.includes('mall'))      return 'Mall';
    if (types.includes('market'))    return 'Market';
    if (types.includes('clothing'))  return 'Clothing Store';
    if (types.includes('souvenirs')) return 'Souvenir Shop';
    if (types.includes('food'))      return 'Food & Gourmet';
    if (types.includes('food&drink')) return 'Restaurant';
    if (types.includes('nightlife')) return 'Bar';
    if (types.includes('cultural')) return 'Cultural Site';
    if (types.includes('nature')) return 'Natural Attraction';
    if (types.includes('adventure')) return 'Adventure';
    return 'Business';
}

module.exports = { findSmartProximityPlaces, deriveCategoryFromType, discoverabilityFilter, eventFreshnessClause, effectivePrice, budgetMatchClause };