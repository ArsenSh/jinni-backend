// services/priceTier.js
//
// Single source of truth for a place's luxury↔budget "tier" (1 = budget … 4 =
// luxury). Shared by the recommendation ranking (travelStyle fit, Step 3) and by
// the admin cache view, so both judge tier identically and can never drift.
//
// Two signals, in priority order:
//   1. Google `priceLevel` — reliable for restaurants / food / shopping, but
//      usually ABSENT for lodging & attractions (Google simply omits it there).
//   2. Lodging subtype in `types` — the real luxury/budget signal for HOTELS,
//      where priceLevel is typically missing. hostel / guest_house / motel = budget;
//      resort_hotel / extended_stay_hotel = upscale.
//
// Returns tier=null when neither applies (a monument, viewpoint, or plain
// 'hotel'/'lodging' with no subtype has no price axis). Callers MUST treat null as
// neutral — never as a hard filter — so thin-inventory categories aren't emptied.

const PRICE_LEVEL_TIER = {
    // FREE is deliberately ABSENT (founder 2026-09-05: "free can be for both
    // of them"): a free viewpoint or park belongs in a luxury traveler's day
    // as much as a budget one's. Leaving it out of the map sends FREE places
    // down the tier=null path — neutral: never dropped, never ranked by price.
    // (Before this, FREE was tier 1, so the luxury filter DROPPED free places.)
    PRICE_LEVEL_INEXPENSIVE:    1,
    PRICE_LEVEL_MODERATE:       2,
    PRICE_LEVEL_EXPENSIVE:      3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// Lodging subtypes → tier. Plain 'hotel' / 'lodging' deliberately stay UNKNOWN:
// on their own they say nothing about luxury vs budget.
const LODGING_BUDGET = new Set([
    'hostel', 'guest_house', 'motel', 'bed_and_breakfast', 'campground',
    'cottage', 'farmstay', 'private_guest_room', 'budget_japanese_inn',
]);
const LODGING_UPSCALE = new Set(['resort_hotel', 'extended_stay_hotel']);

/**
 * @returns {{ tier: 1|2|3|4|null, source: 'price'|'lodging'|null }}
 */
function priceTier(types = [], primaryType = null, priceLevel = null) {
    // 1. Google price bucket — best signal when present.
    if (priceLevel && PRICE_LEVEL_TIER[priceLevel]) {
        return { tier: PRICE_LEVEL_TIER[priceLevel], source: 'price' };
    }
    // 2. Lodging subtype fallback — the hotel signal.
    const all = [primaryType, ...(Array.isArray(types) ? types : [])]
        .filter(Boolean).map(t => String(t).toLowerCase());
    if (all.some(t => LODGING_UPSCALE.has(t))) return { tier: 4, source: 'lodging' };
    if (all.some(t => LODGING_BUDGET.has(t)))  return { tier: 1, source: 'lodging' };
    return { tier: null, source: null };
}

const TIER_LABEL = { 1: 'Budget', 2: 'Mid-range', 3: 'Upscale', 4: 'Luxury' };
function priceTierLabel(tier) { return TIER_LABEL[tier] || '—'; }

// ── travelStyle → tier preference (Step 3) ───────────────────────────────────
// Only the price axis: 'luxury' wants the high tiers, 'budget' the low ones.
// Anything else (mid-range / unset / legacy) → null = no price preference, so tier
// neither ranks nor filters.
function styleTarget(travelStyle) {
    const s = String(travelStyle || '').toLowerCase();
    if (s === 'luxury') return 'high';
    if (s === 'budget') return 'low';
    return null;
}

// Soft ranking nudge in [-1, +1]. Unknown tier OR no style preference → 0 (neutral),
// so a place we can't price is never penalised.
function tierFit(tier, travelStyle) {
    const t = styleTarget(travelStyle);
    if (!t || !tier) return 0;
    return t === 'high' ? (tier - 2.5) / 1.5 : (2.5 - tier) / 1.5;
}

// HARD filter — the two styles now split the priced range cleanly (founder
// 2026-09-05: "expensive and very expensive for Luxury, inexpensive and
// moderate for budget, free can be for both"):
//   luxury  → drop tiers 1-2 (INEXPENSIVE, MODERATE)
//   budget  → drop tiers 3-4 (EXPENSIVE, VERY_EXPENSIVE)
// Unknown tier (null) — which now includes FREE — is NEVER a mismatch, so free
// places, plain hotels and unpriced places are kept for both styles and
// thin-inventory grids don't empty. Calibration caveat worth knowing: Google
// rarely marks Armenian venues EXPENSIVE, so the luxury style leans on the
// backfill/shortfall machinery more than before; if luxury grids run thin in
// practice, the first dial is letting MODERATE back in as ranked-not-dropped.
function tierMismatch(tier, travelStyle) {
    const t = styleTarget(travelStyle);
    if (!t || !tier) return false;
    return t === 'high' ? tier <= 2 : tier >= 3;
}

// Actions that have a real luxury↔budget axis. Others (events, historical,
// photo_spots) are matched by interests, not price, so tier logic is skipped.
// hidden_gems is included: a hidden gem that resolves to a restaurant/hotel gets a
// tier and is filtered; a hidden-gem viewpoint has tier=null and stays neutral.
// Shop sub-type tags included: Explore gates rows by their own action tags
// (jewelry/souvenirs/…), not the 'shopping' umbrella the chat action uses.
const PRICE_ACTIONS = new Set(['restaurants', 'hotels', 'shopping', 'hidden_gems', 'activities', 'souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food']);
function isPriceAction(action) { return PRICE_ACTIONS.has(action); }

// '$'..'$$$$' for display straight from a raw Google priceLevel ('' when absent).
const PRICE_LEVEL_DOLLARS = {
    PRICE_LEVEL_FREE:           'Free',
    PRICE_LEVEL_INEXPENSIVE:    '$',
    PRICE_LEVEL_MODERATE:       '$$',
    PRICE_LEVEL_EXPENSIVE:      '$$$',
    PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};
function priceLevelDollars(priceLevel) { return PRICE_LEVEL_DOLLARS[priceLevel] || ''; }

module.exports = { priceTier, priceTierLabel, priceLevelDollars, styleTarget, tierFit, tierMismatch, isPriceAction };