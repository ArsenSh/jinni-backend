// A vague ask deserves a mixed deck.
//
// Live 2026-09-01: "suggest 3 good locations in Dilijan" returned a restaurant,
// a cafe and a restaurant; the run before it returned two hotels and a
// guesthouse. Nothing was wrong with the ranking — every one of those is a
// well-rated Dilijan place. The problem is that ranking alone has no reason to
// vary KIND, so a category-less "what's good here" collapses onto whichever
// family happens to score best, and Dilijan's old town, park and monasteries
// never get a seat.
//
// This RE-ORDERS and never drops: overflow is appended, so the pool downstream
// is identical and the cards stay exactly what retrieval found. Pure.

// Coarse families, not Google's primaryType — hotel / guest_house /
// resort_hotel are three types but one answer to "what kind of place is this".
const FAMILIES = {
    lodging:  ['hotel', 'guest_house', 'guesthouse', 'hostel', 'motel', 'resort_hotel',
               'bed_and_breakfast', 'lodging', 'campground', 'cottage'],
    food:     ['restaurant', 'cafe', 'bar', 'bakery', 'coffee_shop', 'meal_takeaway',
               'meal_delivery', 'pub', 'wine_bar', 'night_club', 'ice_cream_shop', 'food'],
    culture:  ['museum', 'art_gallery', 'church', 'monastery', 'cathedral', 'mosque',
               'synagogue', 'monument', 'historical_landmark', 'historical_place',
               'tourist_attraction', 'cultural_landmark', 'library', 'theater',
               'performing_arts_theater', 'opera_house'],
    nature:   ['park', 'garden', 'natural_feature', 'hiking_area', 'national_park',
               'botanical_garden', 'zoo', 'aquarium', 'viewpoint', 'observation_deck',
               'beach', 'lake', 'waterfall'],
    shopping: ['store', 'shopping_mall', 'market', 'department_store', 'supermarket',
               'clothing_store', 'jewelry_store', 'gift_shop', 'book_store'],
    activity: ['amusement_park', 'water_park', 'spa', 'casino', 'bowling_alley',
               'movie_theater', 'sports_complex', 'ski_resort', 'golf_course',
               'adventure_sports_center', 'gym', 'stadium'],
};

const _INDEX = new Map();
for (const [family, types] of Object.entries(FAMILIES)) {
    for (const t of types) _INDEX.set(t, family);
}

/** Which family does this candidate belong to? Falls back to its own primary
 *  type so unknown kinds still separate from each other rather than all
 *  collapsing into one "other" bucket that the cap would then throttle. */
function familyOf(place) {
    const types = [place?.primaryType, ...(place?.types || [])].filter(Boolean);
    for (const t of types) {
        const hit = _INDEX.get(String(t).toLowerCase());
        if (hit) return hit;
    }
    return String(place?.primaryType || 'other').toLowerCase();
}

/** How many of one family may take a seat. A 6-card deck allows 2 each; a
 *  3-card deck allows 1, so three cards means three different kinds. */
function perBucketFor(want) {
    return Math.max(1, Math.ceil((Number(want) || 6) / 3));
}

/**
 * @param {Array} ordered  candidates, best-first
 * @param {{want?: number, perBucket?: number, keyOf?: Function}} [opts]
 * @returns {Array} the same candidates, re-ordered — nothing is ever dropped
 */
function diversify(ordered, { want = 6, perBucket = null, keyOf = familyOf } = {}) {
    const list = Array.isArray(ordered) ? ordered : [];
    if (list.length <= 1) return list;
    const cap = perBucket || perBucketFor(want);
    const picked = [], overflow = [], counts = new Map();
    for (const c of list) {
        const k = keyOf(c);
        const n = counts.get(k) || 0;
        if (n < cap && picked.length < want) { picked.push(c); counts.set(k, n + 1); }
        else overflow.push(c);
    }
    return [...picked, ...overflow];
}

module.exports = { diversify, familyOf, perBucketFor, FAMILIES };
