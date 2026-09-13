// Jinni V3 — the controller's lane decision, applied to the route's flags.
//
// The v2 route computes a dozen booleans from keyword rules before its branch
// chain (transportAsk, placeQuestion, deckAsk, namedCard, …). In v3 the
// conversation controller has already decided what the traveler MEANT; this
// maps its lane onto those same flags so every branch downstream runs
// unchanged. Pure, so the mapping is testable without a request.
//
// Lanes the route detects deterministically and reliably on its own —
// settings commands, currency conversion, clarify — leave the flags alone.

function resolveLaneFlags(lane, f = {}) {
    const out = { ...f };
    switch (String(lane || '')) {
        case 'flights':
        case 'transport':
            Object.assign(out, { transportAsk: true, placeQuestion: false, referentClarify: false, contextualQ: false, isTravel: true, infoAsk: 'transport' });
            break;
        case 'place_question':
            Object.assign(out, { transportAsk: false, placeQuestion: true, referentClarify: false, contextualQ: false, isTravel: true, infoAsk: 'place' });
            break;
        case 'deck':
            Object.assign(out, { transportAsk: false, placeQuestion: false, namedCard: null, referentClarify: false, contextualQ: false, isTravel: true, infoAsk: null, destinationScope: false });
            break;
        case 'destinations':
            Object.assign(out, { transportAsk: false, placeQuestion: false, namedCard: null, referentClarify: false, contextualQ: false, isTravel: true, infoAsk: null, destinationScope: true });
            break;
        case 'itinerary':
            Object.assign(out, { transportAsk: false, placeQuestion: false, namedCard: null, referentClarify: false, contextualQ: false, isTravel: true, actionType: 'itinerary' });
            break;
        case 'chitchat':
            Object.assign(out, { transportAsk: false, placeQuestion: false, namedCard: null, referentClarify: false, contextualQ: false, isTravel: false });
            break;
        default:
            break;
    }
    return out;
}

module.exports = { resolveLaneFlags };
