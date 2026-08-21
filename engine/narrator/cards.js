// Jinni V2 Engine — card emission: retrieval candidates → v1's EXACT
// `recommendation` payload shape (copied from processStreamCompletion,
// aiRoutes ~3330–3372), so JinniChat renders v2 cards with ZERO frontend
// changes — photos, map coords, save/vote hydration and all.
//
// The v2 difference is upstream: every card here started as a retrieval
// candidate (owned corpus / cache), so a fake card is structurally impossible
// — no verification pass needed after the fact.

const CATEGORY_LABELS = {
    restaurants: 'Restaurant', hotels: 'Hotel', historical: 'Historical Site',
    hidden_gems: 'Hidden Gem', events: 'Event', photo_spots: 'Photo Spot',
    shopping: 'Shop', activities: 'Activity',
};

function categoryFor(place, action) {
    if (action && CATEGORY_LABELS[action]) return CATEGORY_LABELS[action];
    const t = String(place.primaryType || (place.types || [])[0] || '').toLowerCase();
    if (t.includes('restaurant') || t.includes('cafe') || t.includes('food')) return 'Restaurant';
    if (t.includes('lodging') || t.includes('hotel')) return 'Hotel';
    if (t.includes('museum') || t.includes('gallery')) return 'Museum';
    if (t.includes('park') || t.includes('garden')) return 'Park';
    return 'Attraction';
}

/** Factual one-liner card description — only facts the candidate carries. */
function factDescription(place, category) {
    return [
        category,
        place.distanceKm != null ? `${place.distanceKm.toFixed(1)} km away` : null,
        place.rating ? `rated ${place.rating}` : null,
        place._openNow === true ? 'open now' : (place._openNow === false ? 'closed right now' : null),
    ].filter(Boolean).join(' · ');
}

/**
 * Candidate → v1 card payload. Field set mirrors v1's chat rec verbatim.
 * @param {object} place  retrieval candidate (canonicalStore shape)
 * @param {number} i      position (stable ids + originalPosition)
 * @param {object} opts   { action, nearbyMode }
 */
function toRecommendation(place, i, { action = 'general', nearbyMode = false } = {}) {
    const category = categoryFor(place, action);
    const description = factDescription(place, category);
    const cachedImageUrl = place.placeId ? `/api/ai/place-image/${place.placeId}/0` : null;
    return {
        id: `chat-rec-${Date.now()}-${i}`,
        name: place.name,
        category,
        type: category.toLowerCase().replace(' ', '_'),
        description,
        region: place.city || 'Unknown',
        location: [place.city, place.country].filter(Boolean).join(', ') || 'Location not specified',
        image: place.image || cachedImageUrl,
        cachedImageUrl,
        source: place.source === 'cache' ? 'cache' : 'database',
        verifiedId: place.verifiedId || null,
        isPartner: false,
        partnerTier: place.tier || null,
        _verifiedModel: place.source === 'business' ? 'business'
                      : place.source === 'destination' ? 'destination' : null,
        placeId: place.placeId || null,
        // coords for the recommendation map
        latitude: place.geometry?.lat ?? null,
        longitude: place.geometry?.lng ?? null,
        website: null,
        phone: null,
        isChatRecommendation: true,
        isLargeCard: true,
        appearsInline: true,
        isStreaming: false,
        ...(nearbyMode && place.distanceKm != null && { distance: `${place.distanceKm.toFixed(1)} km` }),
        eventSchedule: null,
        _isExpired: false,
        _action: action || 'general',
        metadata: {
            hasAIDescription: true,
            sourceDescription: 'v2_grounded',
            originalName: place.name,
            originalDescription: description,
            hasViewImagesText: true,
            usedPrefetchedData: place.source !== 'cache',
            originalPosition: i,
            detectedActionType: action || 'general',
        },
    };
}

/** v1's complete-event shape: prose first, then one part per card by index. */
function buildContentParts(prose, recCount) {
    const parts = [{ type: 'text', content: prose }];
    for (let i = 0; i < recCount; i++) parts.push({ type: 'recommendation', index: i });
    return parts;
}

module.exports = { toRecommendation, buildContentParts, categoryFor, factDescription };
