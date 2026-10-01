// Jinni V2 Engine — narrator tools (the agentic surface, ChatV2 §3).
// v0 ships ONE tool: get_place_details, backed by v1's shared
// getCachedPlaceDetails (cache-first, Google on miss, the same-name guards v1
// trusts — service reuse, not a rewrite). The model may only assert what the
// tool returns; a missing field comes back null and MUST be described as
// "not listed", never guessed (the round-61 honesty rules, now structural).

const { normalizePlaceName, messageNamesPlace, _sigTokens, namesPlausiblyMatch, transliterate, _tokensSimilar } = require('../places/matching');

const PLACE_DETAILS_TOOL = {
    type: 'function',
    function: {
        name: 'get_place_details',
        description:
            'Verified details for ONE specific place: address, phone, website, rating, opening hours. '
          + 'Use when the traveler asks about a specific place\'s contact info, hours, rating or address. '
          + 'Keep any city or area the traveler attached to the name IN the name ("Yasaman in Sevan" → '
          + 'name: "Yasaman Sevan") — chains have branches and the location picks the right one. '
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

// REAL road distance & drive time — the Reality Check engine (founder
// 2026-09-05: "visit Tatev, Noravank, return by 20:00" opened a generic
// clarifier instead of saying it is impossible). Distances and durations
// are FACTS: they reach the traveler only from the routing engine (self-
// hosted OSRM, $0/call), never from model memory.
const GET_ROUTE_TOOL = {
    type: 'function',
    function: {
        name: 'get_route',
        description:
            'REAL road distance and driving time between two named places, from the routing engine. '
          + 'Use for ANY "how far", travel-time or feasibility judgement ("can I visit X and be back by 20:00?") — '
          + 'NEVER estimate a distance or drive time yourself. Works for towns, villages, monasteries, landmarks.',
        parameters: {
            type: 'object',
            properties: {
                origin: { type: 'string', description: 'Starting place name (the traveler\'s city if not stated).' },
                destination: { type: 'string', description: 'Destination place name.' },
            },
            required: ['origin', 'destination'],
        },
    },
};

// AI-DRIVEN SEARCH (founder 2026-09-05: "ai should decide how to search
// correctly in google, after seeing databases; if nothing found then it
// searches google — and searches correctly, not the whole message"). The
// MODEL composes a short clean query; the EXECUTOR guarantees the ladder —
// own Destinations/Businesses first, PlaceCache second, Google only when
// those come back thin — and caps what a query may look like. Intelligence
// in the model, discipline in the pipeline.
const FIND_PLACES_TOOL = {
    type: 'function',
    function: {
        name: 'find_places',
        description:
            'Search for places when the conversation needs options you do not already have. '
          + 'COMPOSE the query yourself — a short venue-type-plus-area string like "restaurants Dsegh" or '
          + '"waterfalls near Dilijan" — NEVER the traveler\'s whole sentence and NEVER reference phrases '
          + 'like "hotel I saved". Results come from the verified databases first, the wider index only on a miss.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Short search: what + where. Max ~6 words.' },
            },
            required: ['query'],
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
            'Real fare data for a flight route — the fares currently known for it, each with a booking link. '
          + 'Use whenever the traveler asks about flying between cities, flight prices, or when to fly. '
          + 'Every fare comes with its departure date/time, airline and price — ALWAYS give the traveler all three '
          + 'for each fare you mention (each offer has a ready `label`). '
          + 'Returns an empty list when no fares are known — say so honestly and NEVER state a price the tool did not return. '
          + 'A question about what a TRIP to a place costs ("how much would a trip to Georgia cost", "is Japan expensive to visit") IS a flight question: '
          + 'call this tool FIRST, and never answer it with a budget, a range or "typically costs" figure from your own knowledge — '
          + 'the only numbers you may give are ones a tool returned. '
          + 'For "how much does a trip to <country> cost", "roughly how much are flights to X", or any flight question WITHOUT dates, '
          + 'call it with NO dates: it returns an APPROXIMATE round-trip price (outbound + return) on sample dates. For a country, '
          + 'pass its main city or airport as destination (Japan → Tokyo, Georgia → Tbilisi). Origin = the city the traveler flies from; '
          + 'if you do not know it, use the city they are in (from your instructions) — never guess a different one.',
        parameters: {
            type: 'object',
            properties: {
                origin: { type: 'string', description: 'Departure city name or IATA code (e.g. "Dubai" or "DXB").' },
                destination: { type: 'string', description: 'Arrival city name or IATA code (e.g. "Yerevan" or "EVN").' },
                depart_date: { type: 'string', description: 'YYYY-MM-DD for ONE specific day, or YYYY-MM for a whole month ("in October"). Omit if the traveler gave no date at all.' },
                depart_from: { type: 'string', description: 'YYYY-MM-DD start of a date RANGE — "this week", "next week", "in the next ten days", "this weekend". Give depart_to with it. Resolve the dates from the DATE line in your instructions, never from memory.' },
                depart_to: { type: 'string', description: 'YYYY-MM-DD end of the range (inclusive).' },
                return_date: { type: 'string', description: 'YYYY-MM-DD for a round trip. Omit for one-way.' },
                currency: { type: 'string', description: 'ISO currency the traveler thinks in, e.g. usd, eur, amd, aed. Default usd.' },
                nights: { type: 'integer', description: 'Trip length in nights when the traveler said it ("for a week" = 7) and gave no return date. Used for the approximate round trip. Default 7.' },
                one_way: { type: 'boolean', description: 'true ONLY when the traveler explicitly wants a one-way ticket. Otherwise a no-date ask is priced as a round trip.' },
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
/* Every significant token of the asked name must match SOME token of the
 * row name — with the repo's 1-edit tolerance for long tokens, because
 * transliteration is not 1:1: Russian х → "kh" while the stored spelling is
 * "gh" ("Цахкадзор" → tsaKHkadzor vs TsaGHkadzor missed the owned row and
 * the reply denied the branch exists, live 2026-09-05). */
function ownedNameMatches(askTokens, rowName) {
    const rowToks = String(rowName || '').toLowerCase().normalize('NFKD')
        .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return askTokens.length > 0
        && askTokens.every(t => rowToks.some(rt => _tokensSimilar(t, rt)));
}

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
            nm = transliterate(String(nm).trim());   // "Ясаман" → "yasaman"
            const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (esc.length < 3) return null;
            const re = new RegExp(`^${esc}$`, 'i');
            const Destination = require('../../models/Destination');
            const Business = require('../../models/Business');
            const _fetch = async (q) => {
                const [dests, bizs] = await Promise.all([
                    Destination.find(q).limit(6).lean(),
                    Business.find(q).limit(6).lean(),
                ]);
                return [
                    ...bizs.map(d => ({ d, source: 'business' })),
                    ...dests.map(d => ({ d, source: 'destination' })),
                ].filter(x => Number.isFinite(x.d?.location?.coordinates?.lat)
                           && Number.isFinite(x.d?.location?.coordinates?.lng));
            };
            let rows = await _fetch({ name: re });
            if (!rows.length) {
                // Shorthand tier ("Yasaman Tsaghkadzor" for "Yasaman
                // Tsaghkadzor's Restaurant", live 2026-09-04): every
                // significant token of the ASKED name must appear in the row
                // name. Generic venue nouns don't count as evidence, so
                // "restaurant" alone can never claim a row. Collections are
                // tiny (dozens of rows) — the substring query is cheap.
                const askTokens = String(nm).toLowerCase().split(/[^\p{L}\p{N}]+/u)
                    .filter(t => t.length >= 3
                        && !['the', 'and', 'restaurant', 'restoran', 'cafe', 'bar', 'hotel', 'club', 'lounge', 'ресторан', 'кафе'].includes(t));
                if (askTokens.length) {
                    // Anchor query: try each token, then its 4- and 3-char
                    // prefixes — a fuzzy token ("tsakhkadzor") still needs
                    // SOME substring to fetch candidates by; the tolerant
                    // filter below does the real matching.
                    const anchors = [];
                    for (const tk of askTokens) {
                        for (const a of [tk, tk.slice(0, 4), tk.slice(0, 3)]) {
                            if (a.length >= 3 && !anchors.includes(a)) anchors.push(a);
                        }
                    }
                    let loose = [];
                    for (const a of anchors) {
                        loose = await _fetch({ name: new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
                        if (loose.length && (rows = loose.filter(x => ownedNameMatches(askTokens, x.d.name))).length) break;
                        rows = [];
                    }
                }
            }
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
                _bestTime: d.bestTimeToVisit || null,
                _pricing: d.pricing || null,
                place_id: d.placeId || (source === 'destination' ? `dest_${d._id}` : null),
                geometry: { location: { lat: d.location.coordinates.lat, lng: d.location.coordinates.lng } },
                image: typeof img === 'string' ? img : (img && typeof img.url === 'string' ? img.url : null),
                // The curator's type array — without it the card renders as
                // bare "Place" (live 2026-09-04, first owned-card round).
                types: Array.isArray(d.type) ? d.type : (d.type ? [d.type] : []),
                // Owned type arrays hold JINNI category words ("restaurants")
                // plus vibe tags — labelForTypes (Google vocabulary) maps
                // none of them, so the card said bare "Place" (live
                // 2026-09-05). The category vocabulary answers directly.
                _kind: (() => {
                    const { CATEGORY_LABELS } = require('./cards');
                    const arr = Array.isArray(d.type) ? d.type : (d.type ? [d.type] : []);
                    for (const t of arr) { if (CATEGORY_LABELS[t]) return CATEGORY_LABELS[t]; }
                    return null;
                })(),
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
            // "The restaurant says 50,000 AMD…" made the model call this with
            // name="restaurant", which resolved to Ani Plaza Hotel and CARDED
            // it (live 2026-09-05). A name with zero distinctive tokens can
            // never identify one place — honest ask-back instead.
            const _allToks = normalizePlaceName(transliterate(name)).split(' ').filter(t => t.length >= 3);
            if (_allToks.length && !_sigTokens(transliterate(name)).length) {
                return { error: 'name_too_generic — ask the traveler which specific place they mean' };
            }
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
                    best_time_to_visit: owned._bestTime || null,
                    // Pricing speaks with the confidence of its SOURCE
                    // (founder 2026-09-05): a business owner sets their own
                    // prices → stated plainly; a staff estimate on a
                    // destination → hedged ("approximately, not verified").
                    // Destination isFree DEFAULTS to true, so a bare isFree
                    // with no numbers is a default, not a fact — silence.
                    price: (() => {
                        const p = owned._pricing;
                        if (!p) return null;
                        const cur = p.currency || 'USD';
                        const range = (p.min != null && p.max != null) ? `${p.min}-${p.max} ${cur}`
                            : (p.average != null ? `around ${p.average} ${cur}`
                                : (p.min != null ? `from ${p.min} ${cur}`
                                    : (p.max != null ? `up to ${p.max} ${cur}` : null)));
                        if (!range) return null;
                        return owned._owned === 'business'
                            ? `${range} per person — set by the venue itself, state it plainly`
                            : `approximately ${range} — a staff estimate, NOT venue-verified: hedge it ("I couldn't verify exact prices, but approximately…")`;
                    })(),
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
            // The resolver's rescue can hand back a stranger ("Ясаман" →
            // Matenadaran, live 2026-09-05) — and the first-mention card
            // then AMPLIFIES the error into a wrong photo on screen. An
            // implausible name is an honest miss, never an answer.
            if (!namesPlausiblyMatch(name, d.name)) {
                console.log(`[tool] rejected implausible resolution "${name}" → "${d.name}"`);
                return { error: 'not_found' };
            }
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

        find_places: async ({ query } = {}) => {
            const q = String(query || '').trim();
            if (!q) return { error: 'query_required' };
            // Spend cap, not understanding: the model was told to compose a
            // short query; a long one is a raw sentence leaking through.
            if (q.length > 64 || q.split(/\s+/).length > 8) {
                return { error: 'query_too_long', hint: 'compose a short search: venue type + area, e.g. "restaurants Dsegh"' };
            }
            const toks = _sigTokens(transliterate(q));
            if (!toks.length) return { error: 'query_too_generic' };
            const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const results = [];
            const seen = new Set();
            const push = (name, extra) => {
                const k = String(name || '').toLowerCase().trim();
                if (k && !seen.has(k)) { seen.add(k); results.push({ name, ...extra }); }
            };
            // 1. OWN corpus — validated data answers before anything paid.
            try {
                const searchOwned = deps.searchFindOwned || (async () => {
                    const cond = toks.map(t => ({ $or: [
                        { name: new RegExp(esc(t), 'i') },
                        { address: new RegExp(esc(t), 'i') },
                        { description: new RegExp(esc(t), 'i') },
                    ] }));
                    const Destination = require('../../models/Destination');
                    const ds = await Destination.find({ $and: cond }).limit(5).lean().catch(() => []);
                    return ds.map(d => ({ name: d.name, kind: d.type || null, rating: d.rating ?? null, address: d.address || null, source: 'verified' }));
                });
                for (const r of await searchOwned()) push(r.name, { ...r, name: undefined });
            } catch { /* next tier */ }
            // 2. PlaceCache — already-bought knowledge, $0.
            try {
                const searchCache = deps.searchFindCache || (async () => {
                    const PlaceCache = require('../../models/PlaceCache');
                    const cond = toks.map(t => ({ $or: [
                        { name: new RegExp(esc(t), 'i') },
                        { 'details.formatted_address': new RegExp(esc(t), 'i') },
                    ] }));
                    const rows = await PlaceCache.find({ $and: cond, hidden: { $ne: true }, name: { $not: /^mirror:/ } })
                        .select('name rating details.rating details.formatted_address primaryType').limit(6).lean().catch(() => []);
                    return rows.map(r => ({ name: r.name, kind: r.primaryType || null, rating: r.rating ?? r.details?.rating ?? null, address: r.details?.formatted_address || null, source: 'cache' }));
                });
                for (const r of await searchCache()) push(r.name, { ...r, name: undefined });
            } catch { /* next tier */ }
            // 3. Google — LAST, only when our own data came back thin, and
            //    with the model's clean query, never chat text.
            if (results.length < 3) {
                try {
                    const searchGoogle = deps.searchFindGoogle
                        || ((qq, near) => require('../../services/googleService').findPlaces(qq, near));
                    const found = await searchGoogle(q, ctx.center || null) || [];
                    for (const f of found.slice(0, 5)) {
                        push(f.name, { kind: (f.types || [])[0] || null, rating: f.rating ?? null, address: f.formatted_address || f.vicinity || null, source: 'google' });
                    }
                } catch { /* honest empty below */ }
            }
            if (!results.length) return { query: q, results: [], note: 'nothing found — say so honestly, never invent places' };
            return { query: q, results: results.slice(0, 8) };
        },
        get_route: async ({ origin, destination } = {}) => {
            if (!origin || !destination) return { error: 'origin_and_destination_required' };
            // Names resolve through the same cheapest-first ladder the stated-
            // position feature uses: session cards, gazetteer, own corpus,
            // Google last. Injectable for tests.
            const resolve = deps.resolveLocation || (async (nm) =>
                require('../geo/whereAmI').resolveStatedLocation(nm,
                    { sessionCards: ctx.sessionPlaces || [], near: ctx.center || null },
                    { findPlaces: (q, near) => require('../../services/googleService').findPlaces(q, near) }));
            let a = null, b = null;
            try { [a, b] = await Promise.all([resolve(origin), resolve(destination)]); } catch { /* honest miss below */ }
            if (!a || !b) return { error: 'place_not_found', which: !a ? origin : destination };
            const { haversineKm } = require('../utils/geo');
            const straightKm = Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * 10) / 10;
            const fetchRoute = deps.fetchRoute || (async (from, to) => {
                const axios = require('axios');
                const { osrmBaseFor, buildOsrmRouteUrl } = require('../travel/osrm');
                const base = osrmBaseFor('driving-car');
                if (!base) return null;
                const res2 = await axios.get(buildOsrmRouteUrl(base, [from, to]), { timeout: 6000 });
                const r = res2.data?.routes?.[0];
                return (r && Number.isFinite(r.distance)) ? { km: r.distance / 1000, minutes: r.duration / 60 } : null;
            });
            let route = null;
            try { route = await fetchRoute(a, b); } catch { route = null; }
            if (!route) {
                // Fail HONEST, not silent: the straight line is labeled as such
                // and the model is told not to turn it into a drive time.
                return { origin: a.name, destination: b.name, straight_line_km: straightKm,
                         note: 'road route unavailable — this is the STRAIGHT-LINE distance; the road is longer, do NOT state a drive time' };
            }
            return { origin: a.name, destination: b.name,
                     road_km: Math.round(route.km * 10) / 10, drive_minutes: Math.round(route.minutes),
                     straight_line_km: straightKm, source: 'osrm' };
        },
        find_flights: async ({ origin, destination, depart_date: departDate, depart_from: departFrom, depart_to: departTo, return_date: returnDate, currency, nights, one_way: oneWay } = {}) => {
            if (!origin || !destination) return { error: 'origin_and_destination_required' };
            const flights = require('../travel/flights');
            const search = deps.searchFlights || flights.searchFlights;
            const searchWindow = deps.searchFlightsWindow || flights.searchFlightsWindow;
            // Any dated ask — one day, a range, a month — is served as a
            // WINDOW so the traveler hears about the nearest fares the route
            // has when the asked dates hold none (live 2026-09-13: "tomorrow"
            // → "no fares", while the 15th had one). A round trip keeps the
            // plain query: the feed prices the pair, not a departure window.
            const win = returnDate ? null : flights.windowFor({ departDate, departFrom, departTo });
            // LIVE, bookable fares from Nuitee (liteAPI), asked in parallel with
            // the feed. A live search prices real departures, so a range or a
            // month is sampled on a few concrete future days, and a no-date ask
            // is priced as a sample round trip. Dark unless LITE_FLIGHTS=true.
            const lite = deps.liteFlights || require('../travel/flightsLite');
            const today = (deps.today || (() => new Date().toISOString().slice(0, 10)))();
            const plan = livePlan({ departDate, win, returnDate, today, nights, oneWay });
            const livePromise = (plan.days.length && lite.liteFlightsEnabled(deps.env || process.env))
                ? Promise.all(plan.days.map(day => liveFares({ lite, flights, origin, destination, day, returnDate: plan.returnFor(day), currency, deps }).catch(() => null)))
                    .then(sets => mergeLive(sets))
                : Promise.resolve(null);
            // No dates at all = an APPROXIMATE trip price: the feed's cheapest
            // known ROUND TRIPS (any dates) ride beside its one-way fares.
            const roundPromise = (plan.estimate && !oneWay)
                ? search({ origin, destination, roundTrip: true, currency: currency || 'usd' }).catch(() => null)
                : Promise.resolve(null);
            const shortenUrl = deps.shortenBookUrl || require('../travel/flightLinks').shortenBookUrl;
            let r;
            try {
                r = win
                    ? await searchWindow({ origin, destination, from: win.from, to: win.to, currency: currency || 'usd' })
                    : await search({ origin, destination, departDate, returnDate, currency: currency || 'usd' });
            } catch (err) {
                return { error: `flight_search_failed: ${err.message}` };
            }
            // No data is an ANSWER ("I don't have fares for that route"), not a
            // licence to quote a remembered price.
            const [live, rounds] = await Promise.all([livePromise, roundPromise]);
            if (!r || (!r.offers?.length && !r.nearest?.length)) {
                if (live?.length || rounds?.offers?.length) {
                    const base = { offers: [], asked: win || null, note: 'The fare feed has no one-way fares for this route. ' };
                    if (rounds?.offers?.length) await attachRounds(base, rounds, shortenUrl);
                    if (plan.estimate) base.note += estimateNote(plan);
                    return live?.length ? attachLive(base, live, shortenUrl) : base;
                }
                return { offers: [], asked: win || null, note: 'no fares returned — do not state any price' };
            }
            if (!r.offers.length && r.nearest?.length) {
                // The asked dates have nothing; the route has dated fares near
                // them. Say the first plainly, then offer the second AS
                // alternatives — never as if they were what was asked.
                r.asked = win;
                r.offers = r.nearest;
                r.nearestOnly = true;
                delete r.nearest;
            } else {
                r.asked = win || null;
                delete r.nearest;
            }
            // Ready-made per-fare label (founder 2026-09-07: answers must always
            // carry airline + date + price, not just the route): the model
            // reliably echoes a prepared label where it may drop raw fields.
            let anyConnection = false;
            for (const o of r.offers) {
                const date = (o.departureAt || '').slice(0, 10);
                const time = (o.departureAt || '').slice(11, 16);
                const stops = o.transfers === 0
                    ? 'direct'
                    : (o.transfers > 0 ? `${o.transfers} stop${o.transfers === 1 ? '' : 's'}` : '');
                if (o.transfers > 0) {
                    anyConnection = true;
                    // The fare feed returns a COUNT of transfers and nothing
                    // else — no connecting airport anywhere in the row. Saying
                    // "1 stop" and going quiet invites the next question, and
                    // the only wrong answer is a guessed hub, so the gap is
                    // marked on the offer itself (founder 2026-09-07: "it says
                    // 1 stop but doesnt mention where is the stop").
                    o.connectingAirport = null;
                    o.connectionNote = 'the fare feed does not say where this connects';
                }
                o.label = [date && `${date}${time ? ' ' + time : ''}`, o.airlineName || o.airline, o.price != null ? `${o.price} ${r.currency}` : '', stops]
                    .filter(Boolean).join(' · ');
            }
            // Short links, not the ~400-character tracking URLs: copied
            // verbatim those ate the reply's token budget (four fares, answer
            // stopped mid-URL) and the chat's `_x_` italics rule broke them
            // (live 2026-09-13). /go/f/<id> redirects to the real one.
            const shorten = deps.shortenBookUrl || require('../travel/flightLinks').shortenBookUrl;
            for (const o of r.offers) if (o.bookUrl) o.bookUrl = await shorten(o.bookUrl);
            // The airline name becomes the tappable thing (founder 2026-09-07:
            // "underline each company name … after clicking will navigate").
            // It links to THAT fare's bookUrl — the booking page for the exact
            // flight, which also shows the routing this feed omits. Never the
            // airline's homepage: we hold no such URL and would be guessing.
            const anyLink = r.offers.some(o => o.bookUrl);
            r.note = (r.nearestOnly
                    ? `NONE of these fall on the asked dates (${r.asked.from}${r.asked.to !== r.asked.from ? ' to ' + r.asked.to : ''}) — say plainly that you have no fares for those dates, then offer these as the NEAREST dated fares this route has. `
                    : '')
                + 'For EVERY fare you mention, state its departure date (and time), airline and price — the label field has them ready. '
                + 'These are the fares the feed KNOWS for the route, not a full search: call them "the fares I have", never "the cheapest", '
                + 'unless the traveler asked for the cheapest. For a range of dates give ONE fare per day (the best) unless asked for more.'
                + (anyLink
                    ? ' Write each airline name as a markdown link to THAT fare\'s bookUrl, exactly as given: [Wizz Air](<bookUrl>). '
                      + 'Copy the URL character for character and never build, shorten or invent one — a fare with no bookUrl is written as plain text.'
                    : '')
                + (anyConnection
                    ? ' Some of the FEED fares (the `offers` list) connect. The feed gives the NUMBER of stops and never the connecting airport, so for THOSE fares you do not know '
                      + 'where they stop: never name a hub, never infer one from the airline, and when asked, say plainly that the fare '
                      + 'data does not include it and that the airline link on that fare opens the routing.'
                    : '');
            if (rounds?.offers?.length) await attachRounds(r, rounds, shortenUrl);
            if (plan.estimate) r.note += estimateNote(plan);
            return live?.length ? attachLive(r, live, shortenUrl) : r;
        },
    };
}

/* Which days to ask the live search for. A live search prices one real
 * departure, so: a day → that day; a range or a month → up to three concrete
 * days inside it (every day of a short range, else first / middle / last),
 * never a day already gone; no date at all → a sample round trip about three
 * weeks out for `nights` nights, flagged as an estimate. */
const _addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
function livePlan({ departDate, win, returnDate, today, nights, oneWay }) {
    const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const n = Number.isFinite(+nights) && +nights > 0 ? Math.min(60, Math.round(+nights)) : 7;
    if (returnDate && isDay(returnDate) && isDay(departDate)) return { days: departDate >= today ? [departDate] : [], returnFor: () => returnDate, estimate: false };
    if (win) {
        const from = win.from < today ? today : win.from, to = win.to;
        if (to < from) return { days: [], returnFor: () => null, estimate: false };
        const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
        const days = span <= 2 ? Array.from({ length: span + 1 }, (_, i) => _addDays(from, i)) : [from, _addDays(from, Math.round(span / 2)), to];
        return { days, returnFor: () => null, estimate: false };
    }
    if (!departDate && !returnDate) {
        const day = _addDays(today, 21);
        return { days: [day], returnFor: () => (oneWay ? null : _addDays(day, n)), estimate: true, sampleDay: day, nights: oneWay ? null : n };
    }
    return { days: [], returnFor: () => null, estimate: false };
}

/* Several days of live fares → at most two per day (the cheapest), six in all,
 * in date order so a range reads as a calendar. */
function mergeLive(sets) {
    const out = [];
    for (const set of sets || []) if (Array.isArray(set)) out.push(...set.slice(0, 2));
    if (!out.length) return null;
    return out.sort((a, b) => String(a.departureAt).localeCompare(String(b.departureAt)) || a.price - b.price).slice(0, 6);
}

/* The feed's cheapest known round trips — real fares on their own dates. */
async function attachRounds(r, rounds, shorten) {
    const list = rounds.offers.slice(0, 3);
    for (const o of list) {
        const out = (o.departureAt || '').slice(0, 10), back = (o.returnAt || '').slice(0, 10);
        o.label = [out && back ? `${out} → back ${back}` : out, o.airlineName || o.airline, o.price != null ? `${o.price} ${rounds.currency} round trip` : '', o.transfers === 0 ? 'direct' : (o.transfers > 0 ? `${o.transfers} stop${o.transfers === 1 ? '' : 's'}` : '')].filter(Boolean).join(' · ');
        if (o.bookUrl) o.bookUrl = await shorten(o.bookUrl);
    }
    r.roundTrips = list;
    r.note = (r.note || '') + ' ROUND TRIPS (the `roundTrips` list) are real fares the feed knows for out-AND-back on the dates in each label; each price covers both flights.';
    return r;
}

function estimateNote(plan) {
    return ' THE TRAVELER GAVE NO DATES: this is an APPROXIMATE answer. Give a rough round-trip price RANGE built only from the round-trip prices returned here'
        + (plan.sampleDay ? ` (live fares are a SAMPLE trip leaving ${plan.sampleDay}${plan.nights ? ` for ${plan.nights} nights` : ''}; say those dates)` : '')
        + ', say plainly that it is approximate and changes with dates and season, and offer to check their exact dates. '
        + 'If they asked what a whole TRIP costs, flights are only one part: never invent hotel, food or other costs — only give numbers a tool returned.';
}

/* Live fares from Nuitee → the compact rows the narrator reads. Unlike the feed,
 * a live journey carries its segments, so the connecting airport IS known and
 * is named. A round-trip price covers both flights and says so. */
async function liveFares({ lite, flights, origin, destination, day, returnDate, currency, deps }) {
    const env = deps.env || process.env;
    const resolve = deps.resolveIata || flights.resolveIata;
    const [o, d] = await Promise.all([resolve(origin, deps), resolve(destination, deps)]);
    if (!o || !d) return null;
    const ret = /^\d{4}-\d{2}-\d{2}$/.test(returnDate || '') ? returnDate : null;
    const legs = [{ origin: o, destination: d, date: day }, ...(ret ? [{ origin: d, destination: o, date: ret }] : [])];
    const cur = String(currency || 'usd').toUpperCase();
    const res = await lite.searchLiteFlights({ legs, adults: 1, currency: cur }, deps);
    if (!res?.ok || !res.journeys?.length) return null;
    // A live fare with no price is not a fare we can quote: drop it rather than hand the model a priceless row.
    return res.journeys.filter(j => j.price != null && j.airline).slice(0, 3).map(j => {
        const time = (j.departureAt || '').slice(11, 16);
        const via = j.transfers > 0 ? (j.segments || []).slice(0, -1).map(s => s.to).filter(Boolean) : [];
        const stops = j.transfers === 0 ? 'direct' : `${j.transfers} stop${j.transfers === 1 ? '' : 's'}${via.length ? ` via ${via.join(', ')}` : ''}`;
        return {
            source: 'nuitee', live: true, roundTrip: !!ret,
            airline: j.airline, flightNumber: j.flightNumber, departureAt: j.departureAt, arrivalAt: j.arrivalAt,
            price: j.price, currency: j.currency, transfers: j.transfers, connectingAirports: via,
            durationMin: j.durationMin, seatsRemaining: j.seatsRemaining, refundable: j.refundable,
            inbound: j.inbound || null,
            label: [`${day}${time ? ' ' + time : ''}`, j.airline, j.flightNumber, j.price != null ? `${j.price} ${j.currency}${ret ? ' round trip' : ''}` : '', stops,
                j.inbound ? `back ${(j.inbound.departureAt || '').slice(0, 16).replace('T', ' ')}${j.inbound.transfers === 0 ? ' direct' : ` ${j.inbound.transfers} stop${j.inbound.transfers === 1 ? '' : 's'}${j.inbound.via?.length ? ` via ${j.inbound.via.join(', ')}` : ''}`}` : ''].filter(Boolean).join(' · '),
            bookUrl: lite.liteBookUrl({ origin: o, destination: d, date: day, returnDate: ret, adults: 1, currency: j.currency || cur, offerId: j.offerId }, env),
        };
    });
}

/* Live fares ride BESIDE the feed's, never blended into them: a live fare is a
 * price Jinni can sell at, a feed fare is one other travelers were shown. */
async function attachLive(r, live, shorten) {
    for (const f of live) if (f.bookUrl) f.bookUrl = await shorten(f.bookUrl);
    r.live = live;
    r.note = (r.note || '')
        + ' LIVE FARES (the `live` list) come from a real-time airline search and can be BOOKED NOW. Present them as their own group, '
        + 'introduced as live bookable fares, each with its label (date/time, airline, price, stops). '
        + 'Unlike the feed, a live fare KNOWS where it connects: its label says "via XXX" — always say that airport, and never apply the feed\'s "does not say where it connects" caveat to a live fare. '
        + (live.some(f => f.bookUrl) ? 'Write each live fare\'s airline as a markdown link to ITS OWN bookUrl exactly as given; a live fare with no bookUrl is plain text. ' : 'Live fares have NO booking link yet: write them as plain text — never put a link on a live fare, and never reuse a feed fare\'s link for it, even when it is the same flight. Do not tell the traveler anything about links being missing — just give the fare. ')
        + 'Never merge a live price with a feed price, never call one the cheapest of the other, and never say a feed fare can be booked in Jinni.'
        + (live.some(f => f.roundTrip) ? ' A live round-trip price covers BOTH flights — say so.' : '');
    return r;
}

module.exports = { PLACE_DETAILS_TOOL, FIND_FLIGHTS_TOOL, GET_ROUTE_TOOL, FIND_PLACES_TOOL, makeExecutors, ownedNameMatches };
