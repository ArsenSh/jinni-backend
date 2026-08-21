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
    if (t.includes('bar') || t.includes('night_club') || t.includes('pub')) return 'Bar';
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
function toRecommendation(place, i, { action = 'general', nearbyMode = false, description = null } = {}) {
    const category = categoryFor(place, action);
    // Narrator blurb when provided (v1's hasAIDescription spirit); factual
    // one-liner as the fallback so a failed narration never blanks the card.
    const desc = description || factDescription(place, category);
    const cachedImageUrl = place.placeId ? `/api/ai/place-image/${place.placeId}/0` : null;
    return {
        id: `chat-rec-${Date.now()}-${i}`,
        name: place.name,
        category,
        type: category.toLowerCase().replace(' ', '_'),
        description: desc,
        region: place.city || 'Unknown',
        // Full street address when the candidate carries one (cache rows do);
        // city/country only as the fallback.
        location: place.address || [place.city, place.country].filter(Boolean).join(', ') || 'Location not specified',
        image: place.image || cachedImageUrl,
        cachedImageUrl,
        source: place.source === 'cache' ? 'cache' : 'database',
        verifiedId: place.verifiedId || null,
        isPartner: !!place.isPartner,
        partnerTier: place.tier || null,
        _verifiedModel: place.source === 'business' ? 'business'
                      : place.source === 'destination' ? 'destination' : null,
        placeId: place.placeId || null,
        // coords for the recommendation map
        latitude: place.geometry?.lat ?? null,
        longitude: place.geometry?.lng ?? null,
        website: place.website || null,
        phone: place.phone || null,
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
            originalDescription: desc,
            hasViewImagesText: true,
            usedPrefetchedData: place.source !== 'cache',
            originalPosition: i,
            detectedActionType: action || 'general',
        },
    };
}

/** The prose and the deck must AGREE: places the intro names by exact-ish name
 *  get hoisted to the front of the cards (stable order otherwise), blurbs
 *  riding along. Born from the live test where the narration starred DABOO and
 *  COBA while the cards led with an equestrian center. */
const { namesPlausiblyMatch } = require('../places/matching');
function hoistNarrated(intro, places, blurbs = []) {
    const text = String(intro || '');
    if (!text || !places?.length) return { places: places || [], blurbs };
    const paired = places.map((p, i) => ({ p, b: blurbs[i] ?? null, mentioned: false }));
    for (const item of paired) {
        // Cheap contains-check first, similarity guard second (word order,
        // native-script suffixes like "(Teryan) Պանդոկ Երևան" tolerated).
        const name = String(item.p.name || '');
        item.mentioned = !!name && (text.toLowerCase().includes(name.toLowerCase())
            || text.split(/[.!?\n]/).some(s => s.length > 6 && namesPlausiblyMatch(name, s) && s.toLowerCase().includes(name.split(' ')[0].toLowerCase())));
    }
    const ordered = [...paired.filter(x => x.mentioned), ...paired.filter(x => !x.mentioned)];
    return { places: ordered.map(x => x.p), blurbs: ordered.map(x => x.b) };
}

/** v1's complete-event shape: prose first, one part per card by index, and an
 *  optional trailing text part (v1's follow-up-question habit). */
function buildContentParts(prose, recCount, trailingText = null) {
    const parts = [{ type: 'text', content: prose }];
    for (let i = 0; i < recCount; i++) parts.push({ type: 'recommendation', index: i });
    if (trailingText) parts.push({ type: 'text', content: trailingText });
    return parts;
}

module.exports = { toRecommendation, buildContentParts, hoistNarrated, categoryFor, factDescription };
