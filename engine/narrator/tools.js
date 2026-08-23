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

// Flights (Arsen 2026-08-23: "can it check airport or trips?"). Prices are
// FACTS — they may only come from the API, never from the model's memory,
// which is the same rule that keeps cards honest. The tool is offered to the
// model only when Travelpayouts is configured; otherwise transport questions
// are answered in prose exactly as before.
const FIND_FLIGHTS_TOOL = {
    type: 'function',
    function: {
        name: 'find_flights',
        description:
            'Real cheapest-fare data for a flight route, with a booking link. '
          + 'Use whenever the traveler asks about flying between cities, flight prices, or when to fly. '
          + 'Returns an empty list when no fares are known — say so honestly and NEVER state a price the tool did not return.',
        parameters: {
            type: 'object',
            properties: {
                origin: { type: 'string', description: 'Departure city name or IATA code (e.g. "Dubai" or "DXB").' },
                destination: { type: 'string', description: 'Arrival city name or IATA code (e.g. "Yerevan" or "EVN").' },
                depart_date: { type: 'string', description: 'YYYY-MM-DD for a specific day, or YYYY-MM for the cheapest day that month. Omit if the traveler gave no date.' },
                return_date: { type: 'string', description: 'YYYY-MM-DD for a round trip. Omit for one-way.' },
                currency: { type: 'string', description: 'ISO currency the traveler thinks in, e.g. usd, eur, amd, aed. Default usd.' },
            },
            required: ['origin', 'destination'],
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

        find_flights: async ({ origin, destination, depart_date: departDate, return_date: returnDate, currency } = {}) => {
            if (!origin || !destination) return { error: 'origin_and_destination_required' };
            const search = deps.searchFlights || require('../travel/flights').searchFlights;
            let r;
            try {
                r = await search({ origin, destination, departDate, returnDate, currency: currency || 'usd' });
            } catch (err) {
                return { error: `flight_search_failed: ${err.message}` };
            }
            // No data is an ANSWER ("I don't have fares for that route"), not a
            // licence to quote a remembered price.
            if (!r || !r.offers?.length) return { offers: [], note: 'no fares returned — do not state any price' };
            return r;
        },
    };
}

module.exports = { PLACE_DETAILS_TOOL, FIND_FLIGHTS_TOOL, makeExecutors };
