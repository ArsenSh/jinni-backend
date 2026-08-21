// Jinni V2 Engine — event source registries (data, not code paths).
// COPIED from routes/aiRoutes.js (v1, lines ~4812–4841 + ~5245–5247) per the
// copy-not-cut rule (engine/ENGINE.md).

/* A source declares WHICH COUNTRIES IT COVERS. Nothing here is special-cased
 * to one city, and no coordinates are hardcoded: the app is used worldwide, so
 * the pipeline asks "is there a source for where this user is?" and gets no
 * feed — falling back to the AI exactly as before — anywhere there isn't one.
 * Adding Paris or Tbilisi later is one more row in this array.
 *
 * The country must come from `userRegion` (googleService.detectUserRegion),
 * NOT from `effectiveLocation`. That was the bug that silently disabled the
 * whole feed in production: resolveEffectiveLocation()'s real-time GPS branch —
 * the common path — returns only { lat, lng, source, privacyMode, nearbyRadius,
 * discoveryRadius }, with no city and no country. `effectiveLocation.country`
 * was undefined, nothing matched, and the feed never ran: no `[feed]` line and
 * refills still paying for web search. userRegion is already resolved once per
 * request for the search context, so this costs nothing extra. */
const EVENT_FEED_SOURCES = [
    {
        label: 'ticket-am',
        // /en/ is the same JSON-LD with English names and venues.
        url: 'https://ticket-am.com/en/',
        countries: ['armenia']
    },
    {
        label: 'tomsarkgh',
        // Server-rendered, no JSON-LD — read via page-text extraction. Carries
        // the near-term events (13/15/23/25 Aug) that ticket-am's window lacked.
        url: 'https://www.tomsarkgh.am/en',
        countries: ['armenia'],
        mode: 'extract'
    }
];

/* Fixed 28-word list — interest matching is code, language-free (round 47). */
const EVENT_TAG_VOCABULARY = ['music','concert','festival','theater','opera','ballet','dance','comedy','standup','circus','cinema','exhibition','art','museum','sports','food','wine','nightlife','club','family','kids','education','literature','poetry','tech','outdoor','market','holiday','religious'];

/* Domains KNOWN to be good for a country — verified by hand, not by a model.
 * Discovery asks the model each week and gets a different answer each time:
 * one Armenian run proposed tickets.am/iyerevan.am/yerevan.am/kassir.am and
 * CACHED it for 7 days, locking the search out of ticket-am.com and
 * tomsarkgh.am — the two sources this project has actually verified against
 * the live web. A registry row per known market fixes the floor; discovery
 * still fills every country that has no row. Same pattern as
 * EVENT_FEED_SOURCES, and rows are data, not code paths. */
const KNOWN_EVENT_SEARCH_DOMAINS = [
    { countries: ['armenia'], domains: ['ticket-am.com', 'tomsarkgh.am', 'tkt.am'] }
];

module.exports = { EVENT_FEED_SOURCES, EVENT_TAG_VOCABULARY, KNOWN_EVENT_SEARCH_DOMAINS };
