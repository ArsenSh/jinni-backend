// Jinni V2 Engine — narrator tools (the agentic surface, ChatV2 §3).
// v0 ships ONE tool: get_place_details, backed by v1's shared
// getCachedPlaceDetails (cache-first, Google on miss, the same-name guards v1
// trusts — service reuse, not a rewrite). The model may only assert what the
// tool returns; a missing field comes back null and MUST be described as
// "not listed", never guessed (the round-61 honesty rules, now structural).

const { normalizePlaceName, messageNamesPlace, _sigTokens } = require('../places/matching');

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
/* Day-name schedule → human weekday lines for the tool answer. */
function _hoursText(oh) {
    if (!oh) return null;
    if (oh.is24Hours) return ['Open 24 hours daily'];
    const rows = (Array.isArray(oh.days) ? oh.days : [])
        .filter(r => r?.day)
        .map(r => r.closed ? `${r.day}: Closed`
            : (r.open && r.close ? `${r.day}: ${r.open} – ${r.close}` : null))
        .filter(Boolean);
    return rows.length ? rows : null;
}

function makeExecutors(ctx = {}, deps = {}) {
    // ── OWNED DATA FIRST (Arsen 2026-09-04: "user may ask [about a] thing
    //    which is in destination/business databases — before making google
    //    call"). Kamancha's tool answer carried the PlaceCache/Google
    //    identity while a validator-curated Destination row with its own
    //    image existed. The moat is Destination/Business — they answer
    //    first; PlaceCache/Google only when we own nothing by that name.
    //    Fail-open everywhere; jest (no mongoose connection) skips to the
    //    injected lookup untouched. ──
    const ownedLookup = deps.ownedLookup || (async (nm, near) => {
        try {
            const mongoose = require('mongoose');
            if (mongoose.connection?.readyState !== 1) return null;
            const esc = String(nm).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (esc.length < 3) return null;
            const re = new RegExp(`^${esc}$`, 'i');
            const [dests, bizs] = await Promise.all([
                require('../../models/Destination').find({ name: re }).limit(4).lean(),
                require('../../models/Business').find({ name: re }).limit(4).lean(),
            ]);
            const rows = [
                ...bizs.map(d => ({ d, source: 'business' })),
                ...dests.map(d => ({ d, source: 'destination' })),
            ].filter(x => Number.isFinite(x.d?.location?.coordinates?.lat)
                       && Number.isFinite(x.d?.location?.coordinates?.lng));
            if (!rows.length) return null;
            // Namesakes: nearest to the traveler wins (the Republic-Square-
            // in-Texas lesson, applied here too).
            let best = rows[0];
            if (near && Number.isFinite(near.lat) && rows.length > 1) {
                const { haversineKm } = require('../utils/geo');
                best = rows.reduce((a, b) => {
                    const ka = haversineKm(near.lat, near.lng, a.d.location.coordinates.lat, a.d.location.coordinates.lng);
                    const kb = haversineKm(near.lat, near.lng, b.d.location.coordinates.lat, b.d.location.coordinates.lng);
                    return ka <= kb ? a : b;
                });
            }
            const { d, source } = best;
            const img = Array.isArray(d.images) ? d.images[0] : null;
            return {
                name: d.name,
                formatted_address: d.location?.address || null,
                formatted_phone_number: d.contact?.phone || null,
                website: d.contact?.website || null,
                rating: d.rating || d.engagement?.rating || null,
                _weekdayText: _hoursText(d.openingHours),
                place_id: d.placeId || (source === 'destination' ? `dest_${d._id}` : null),
                geometry: { location: { lat: d.location.coordinates.lat, lng: d.location.coordinates.lng } },
                image: typeof img === 'string' ? img : (img && typeof img.url === 'string' ? img.url : null),
                // The curator's type array — without it the card renders as
                // bare "Place" (live 2026-09-04, first owned-card round).
                types: Array.isArray(d.type) ? d.type : (d.type ? [d.type] : []),
                _owned: source,
            };
        } catch { return null; }
    });
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
            //
            // SELECTION must be strict, not plausible (live 2026-08-30: asking
            // about "Dilijan Park Resort & Villas" answered with Tufenkian Old
            // Dilijan Complex's phone and hours — namesPlausiblyMatch accepts
            // ANY one shared token, and both names share the city word
            // "dilijan"; .find() took whichever card came first). Order now:
            //   1. exact normalized-name equality;
            //   2. else cards whose OWN distinctive tokens all appear in the
            //      asked name (messageNamesPlace), preferring the most
            //      specific match — a card that reduces to just the city
            //      token can never beat a fuller name match.
            // namesPlausiblyMatch stays what it was built for: sanity-KEEPING
            // a resolved result, never picking between candidates.
            const cards = ctx.sessionPlaces || [];
            const nameLower = String(name).toLowerCase();
            const nameNorm = normalizePlaceName(name);
            let known = cards.find(p => normalizePlaceName(p.name || '') === nameNorm);
            if (!known) {
                known = cards
                    .filter(p => messageNamesPlace(nameLower, p.name))
                    .sort((a, b) => _sigTokens(b.name || '').length - _sigTokens(a.name || '').length)[0];
            }
            // Our own validated rows answer before PlaceCache/Google.
            const owned = await ownedLookup(name, ctx.center || null);
            if (owned) {
                try { if (typeof ctx.onPlace === 'function') ctx.onPlace(owned); } catch { /* never breaks the tool */ }
                return {
                    name: owned.name,
                    address: owned.formatted_address,
                    phone: owned.formatted_phone_number,
                    website: owned.website,
                    rating: owned.rating,
                    hours: owned._weekdayText,
                    placeId: owned.place_id,
                };
            }
            let d;
            try {
                d = await lookup(name, known?.placeId || null);
            } catch (err) {
                return { error: `lookup_failed: ${err.message}` };
            }
            if (!d || !d.name) return { error: 'not_found' };
            // The route may want the FULL doc (geometry, address) to attach a
            // card — the model still only sees the slim honest projection.
            try { if (typeof ctx.onPlace === 'function') ctx.onPlace(d); } catch { /* never breaks the tool */ }
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
