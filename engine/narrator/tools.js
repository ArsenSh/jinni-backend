// Jinni V2 Engine — narrator tools (the agentic surface, ChatV2 §3).
// v0 ships ONE tool: get_place_details, backed by v1's shared
// getCachedPlaceDetails (cache-first, Google on miss, the same-name guards v1
// trusts — service reuse, not a rewrite). The model may only assert what the
// tool returns; a missing field comes back null and MUST be described as
// "not listed", never guessed (the round-61 honesty rules, now structural).

const { namesPlausiblyMatch } = require('../places/matching');

const PLACE_DETAILS_TOOL = {
    type: 'function',
    function: {
        name: 'get_place_details',
        description:
            'Verified details for ONE specific place: address, phone, website, rating, opening hours. '
          + 'Use when the traveler asks about a specific place\'s contact info, hours, rating or address. '
          + 'Fields can be null — that means the detail is not listed; say so honestly.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The place name, exactly as the traveler referred to it.' },
            },
            required: ['name'],
        },
    },
};

/**
 * Build the executor map for one request.
 * @param {object} ctx  { center, sessionPlaces: [{name, placeId}], requestId }
 * @param {object} [deps]  { lookup } — injected in tests; defaults to v1's shared resolver
 */
function makeExecutors(ctx = {}, deps = {}) {
    const lookup = deps.lookup || (async (nameOrId, knownPlaceId) => {
        // Lazy: pulls v1's shared export only at execution time (jest never loads it).
        const { getCachedPlaceDetails } = require('../../routes/aiRoutes').shared;
        return getCachedPlaceDetails(nameOrId, true, ctx.requestId || null, ctx.center || null, knownPlaceId || null, null, true);
    });

    return {
        get_place_details: async ({ name } = {}) => {
            if (!name || typeof name !== 'string') return { error: 'name_required' };
            // Session-first identity: if this name matches a card the traveler
            // ALREADY SAW, use that card's placeId — zero ambiguity, no
            // same-name-in-another-city risk (v1's round-61 concern).
            const known = (ctx.sessionPlaces || []).find(p => namesPlausiblyMatch(name, p.name));
            let d;
            try {
                d = await lookup(name, known?.placeId || null);
            } catch (err) {
                return { error: `lookup_failed: ${err.message}` };
            }
            if (!d || !d.name) return { error: 'not_found' };
            return {
                name: d.name,
                address: d.formatted_address || null,
                phone: d.formatted_phone_number || d.international_phone_number || null,
                website: d.website || null,
                rating: d.rating || null,
                hours: Array.isArray(d.opening_hours?.weekday_text) && d.opening_hours.weekday_text.length
                    ? d.opening_hours.weekday_text : null,
                placeId: d.place_id || null,
            };
        },
    };
}

module.exports = { PLACE_DETAILS_TOOL, makeExecutors };
