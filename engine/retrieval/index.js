// Jinni V2 Engine — Retrieval Core entry point.
// THE one parameterized query every surface converges on (V3 blueprint §9.4).
// NOT mounted anywhere yet — v1 is untouched by this file.
//
// Contract (frozen 2026-08-21; extend via new optional fields only):
//
// findPlaces({
//   category,        // 'restaurants'|'hotels'|'historical'|'hidden_gems'|'events'|
//                    // 'photo_spots'|'shopping'|'activities'|null (null = free query)
//   subType,         // shopping/activities sub-kind or null
//   query,           // free-text query (chat mode) or null (seeded/quick-action mode)
//   center,          // { lat, lng, city?, country? }
//   mode,            // 'destination' | 'discovery' | 'nearby'
//   radiusKm,
//   preferences,     // { interests, travelStyle, budget } — user's saved prefs
//   timeContext,     // from contextEngine.buildTimeContext (optional)
//   enforceOpenNow,  // drop KNOWN-closed places for droppable categories (right-now asks)
//   taste,           // loadTaste() profile (likes/saves/seen) — soft rank nudge
//   excludes,        // { names: [], placeIds: [] } — already-shown this session
//   count,           // requested card count
//   tapState,        // 'first' | 'refill'
//   requestId,
// }, deps)
//   → { places: [candidate], degraded, reason?, provenance }
//
// Guarantees: every returned place came from deps.loadCandidates (owned corpus /
// cache / Google-verified — never model-invented); never null; empty results
// carry degraded/reason instead of throwing.
//
// Pipeline: cache? → loadCandidates → excludes → open-now → rank
// (prior ∥ BM25 ∥ vector → RRF) → slice → cache-set.
// Plain-Mongo decision (Arsen, 2026-08-21): vectors are number[] fields compared
// in-process; candidates arrive geo/category-bounded so every stage is O(hundreds).

const { rankLexical } = require('./lexical');
const { rankByVector } = require('./vector');
const { fuseRankings } = require('./rrf');
const { SemanticCache } = require('./semanticCache');
const { getEmbedder } = require('./embedder');
const { annotateOpenNow, shouldDropWhenClosed } = require('../context/contextEngine');
const { normalizePlaceName } = require('../places/matching');
const { haversineKm } = require('../utils/geo');

const _defaultCache = new SemanticCache({});

const _idOf = (c) => c.placeId || c.verifiedId || `name:${normalizePlaceName(c.name || '')}`;

async function findPlaces(params = {}, deps = {}) {
    const {
        category = null, subType = null, query = null, center = null,
        mode = null, timeContext = null, enforceOpenNow = false,
        excludes = {}, count = 8, tapState = 'first',
    } = params;
    const loadCandidates = deps.loadCandidates;
    if (typeof loadCandidates !== 'function') {
        throw new Error('[engine/retrieval] deps.loadCandidates is required — canonicalStore wiring provides it (see engine/ENGINE.md)');
    }
    const cache = deps.cache || _defaultCache;
    const wanted = Math.min(Math.max(Number(count) || 8, 1), 20);
    // win: the asked time window's label — different windows must never share
    // a cached pool (the "next week served this-week events" live bug).
    const cacheParams = { category, subType, mode, tapState, center, win: params.eventWindow?.label || null,
        style: params.preferences?.travelStyle || null };
    const provenance = { candidateCount: 0, lexical: 0, vector: false, cacheHit: false, openNowDropped: 0 };

    // ── Query embedding (fail-open: an embedder problem only costs ranking) ──
    let queryVector = null;
    if (query) {
        try {
            const embedder = deps.embedder !== undefined ? deps.embedder : await getEmbedder();
            if (embedder) queryVector = (await embedder.embed([query]))[0] || null;
        } catch { queryVector = null; }
    }

    // ── Semantic cache (query mode only). THE 2026-08-22 lesson ("same 6
    //    results every new chat"): the cache is process-global and 30-min, so
    //    it may only hold the NEUTRAL ranked pool — the expensive, user-free
    //    part (load + fuse). Everything personal or moment-bound (excludes,
    //    open-now, taste, demand seats) runs fresh on EVERY request below;
    //    caching a finished deck froze one user's exclusions into everyone's
    //    answer for half an hour. ──
    let pool = null;
    if (query) {
        const hit = cache.get(cacheParams, { queryVector, queryText: query });
        if (hit && Array.isArray(hit.pool)) {
            // A traveler-stated count is a promise (founder 2026-08-30:
            // "give me 10 examples" on a cached pool delivered 3): if the
            // pool minus this session's excludes cannot fill it, the hit is
            // a MISS and the full pipeline — with its paid top-up — runs.
            const exI = new Set((excludes.placeIds || []).filter(Boolean));
            const exN = new Set((excludes.names || []).map(n => normalizePlaceName(n)).filter(Boolean));
            const usable = hit.pool.filter(c =>
                !exI.has(c.placeId) && !exI.has(c.verifiedId)
                  && !exN.has(normalizePlaceName(c.name || ''))).length;
            if (!(params.strictCount && usable < wanted)) {
                pool = hit.pool;
                Object.assign(provenance, hit.provenance, { cacheHit: true });
            }
        }
    }

    if (!pool) {
        // ── Candidates (the only source of places — real by construction) ──
        let candidates;
        try {
            candidates = (await loadCandidates(params)) || [];
        } catch (err) {
            return { places: [], degraded: true, reason: `load_failed: ${err.message}`, provenance };
        }
        provenance.candidateCount = candidates.length;
        if (!candidates.length) {
            return { places: [], degraded: true, reason: 'no_candidates', provenance };
        }
        candidates = candidates.filter(Boolean);

        // ── Rank: prior order (store's proximity/quality) ∥ BM25 ∥ vector → RRF.
        //    When the user expressed a QUERY, relevance evidence outweighs the
        //    popularity prior (weight 0.5) — otherwise two swapped lists tie
        //    exactly in plain RRF and the prior silently wins (see rrf.js). ──
        const withIds = candidates.map(c => ({ c, id: _idOf(c) }));
        const byId = new Map(withIds.map(({ c, id }) => [id, c]));
        const priorList = withIds.map(({ id }) => id);
        // Intent-conditioned weights (tuning.rankingWeights): callers may shift
        // what evidence matters per ask — right-now boosts proximity, romantic
        // boosts the quality prior. Absent → the historical defaults.
        const W = { lexical: 1, vector: 1, proximity: 0.5, prior: 0.5, ...(params.weights || {}) };
        const lists = [];
        if (query) {
            const lex = rankLexical(query, withIds.map(({ c, id }) => ({ id, text: c.text || c.name || '' })));
            provenance.lexical = lex.length;
            if (lex.length) lists.push({ ids: lex.map(r => r.id), weight: W.lexical });
            if (queryVector) {
                const vec = rankByVector(queryVector, withIds.map(({ c, id }) => ({ id, vector: c.vector })), 0.1);
                if (vec.length) { lists.push({ ids: vec.map(r => r.id), weight: W.vector }); provenance.vector = true; }
            }
        }
        const relevanceLists = lists.length;
        // Proximity evidence (tuning round): a distance-ordered list joins the
        // blend — nearer places climb without any hard cutoff, and the effect
        // scales with how far apart their prior ranks were.
        const withDist = withIds.filter(({ c }) => Number.isFinite(c.distanceKm));
        if (withDist.length >= 2) {
            lists.push({ ids: [...withDist].sort((a, b) => a.c.distanceKm - b.c.distanceKm).map(({ id }) => id), weight: W.proximity });
            provenance.proximity = true;
        }
        lists.push({ ids: priorList, weight: relevanceLists ? W.prior : 1 });
        const fused = lists.length > 1 ? fuseRankings(lists).map(r => r.id) : priorList;
        pool = fused.map(id => byId.get(id)).filter(Boolean);
        if (query) {
            // Name-ask quarantine ripple (2026-08-31): this cache is GLOBAL
            // across users, and it is written BEFORE aiChatV2 quarantines a
            // fallback-born place — caching a pool that holds one would hand
            // the quarantined place to another user's similar ask as a hit.
            // Fallback-born pools are novel one-offs; skip caching them.
            if (pool.some(p => p && p.source === 'google')) {
                console.log('[retrieval] semantic-cache skip: pool holds google-fallback place(s)');
            } else {
                cache.set(cacheParams, { queryVector, queryText: query },
                    { pool, provenance: { ...provenance } });
            }
        }
    }

    // ══ Per-user, per-moment pipeline — runs on EVERY request, hit or miss. ══
    // Shallow-clone: cached pool objects are shared across users; annotations
    // (_openNow, _tasteLiked) must never leak from one request into another.
    let ordered = pool.map(c => ({ ...c }));

    // ── Session excludes + dislikes. verifiedId too: dislikes on partner/
    //    validator places are keyed by the stringified Business/Destination
    //    _id, not a Google placeId. ──
    const _beforeExcludes = ordered.length;
    const exIds = new Set((excludes.placeIds || []).filter(Boolean));
    const exNames = new Set((excludes.names || []).map(n => normalizePlaceName(n)).filter(Boolean));
    ordered = ordered.filter(c =>
        !exIds.has(c.placeId) && !exIds.has(c.verifiedId)
          && !exNames.has(normalizePlaceName(c.name || '')));
    const _afterExcludes = ordered.length;
    // ── A CACHED POOL OBEYS THIS TURN'S RADIUS (2026-09-04) ──
    // "пешком" capped the radius at 2km, but the semantic cache returned the
    // previous turn's pool — built at 5km — and nothing re-checked distances:
    // the walking deck carded places 4.5–4.9 km out (live, RU chain). Cached
    // pools only: fresh loads already respect the radius at query time, and
    // corridor pools measure distance against their own segment centres.
    // Unknown distance is kept (the trust rule, same as unknown hours).
    if (provenance.cacheHit && Number.isFinite(params.radiusKm)) {
        const beforeR = ordered.length;
        ordered = ordered.filter(c => !(Number.isFinite(c?.distanceKm) && c.distanceKm > params.radiusKm));
    }
    // ── OUT-OF-TOWN RING (founder 2026-09-06): "somewhere outside the city"
    //    means NOT HERE — drop everything inside the ring. Unknown distance
    //    is kept (the trust rule). Fail-open when almost nothing survives:
    //    a thin honest pool beats an empty deck, and the narrator already
    //    says plainly when results are not truly out of town. ──
    if (Number.isFinite(params.minDistanceKm) && params.minDistanceKm > 0) {
        const outside = ordered.filter(c => !(Number.isFinite(c?.distanceKm) && c.distanceKm < params.minDistanceKm));
        if (outside.length >= 2) {
            console.log(`[retrieval] out-of-town ring: ${ordered.length - outside.length} in-city candidate(s) dropped (<${params.minDistanceKm}km)`);
            ordered = outside;
        } else {
            console.log(`[retrieval] out-of-town ring skipped — only ${outside.length} candidate(s) beyond ${params.minDistanceKm}km`);
        }
        provenance.outsideRadius = beforeR - ordered.length;
        if (provenance.outsideRadius) {
            console.log(`[retrieval] cached pool re-checked against r=${params.radiusKm}km — ${provenance.outsideRadius} outside`);
        }
    }
    // Emptied HERE = everything real was already shown — that, and only that,
    // is the "you've seen everything" case. (Dilijan 23:21 lesson, 2026-08-30:
    // the open-now drop below used to land in the same bucket, so a town whose
    // restaurants were merely CLOSED was told it had "seen everything".)
    if (!ordered.length) {
        return { places: [], degraded: true, reason: 'all_filtered', provenance };
    }

    // ── Context engine: stamp _openNow FRESH (a cached pool may be 30 min
    //    old); drop only KNOWN-closed, only for droppable categories, only
    //    when the caller asked (right-now intent). Unknown hours (null)
    //    always survive — the trust rule. ──
    if (timeContext) {
        // ── Season awareness (founder 2026-09-05): bestTimeToVisit is
        //    ADVICE, not closure — off-season candidates sink to the back of
        //    the ordering and carry _offSeason for the narrator's caveat, but
        //    are NEVER dropped (trust ladder: a June-August lake activity in
        //    January still exists; it just must not lead the deck). Unknown/
        //    unparseable windows stay neutral.
        // STAMP here (the narrator caveat needs _offSeason on every
        // candidate); the SINK runs at the very end of the pipeline — an
        // early sink was undone by the curated-seat hoist and the deck
        // carded WAKEBOARDING at #3 in September (live 2026-09-05).
        {
            const { parseSeasonWindow, inSeason } = require('./tuning');
            const month = Number(String(timeContext.localISO || '').slice(5, 7)) || null;
            if (month) {
                for (const c of ordered) {
                    const w = parseSeasonWindow(c.bestTime);
                    c._offSeason = !!(w && !inSeason(w, month));
                }
            }
        }
        annotateOpenNow(ordered, timeContext);
        if (enforceOpenNow && shouldDropWhenClosed(category)) {
            const before = ordered.length;
            ordered = ordered.filter(c => c._openNow !== false);
            provenance.openNowDropped = before - ordered.length;
        }
    }
    provenance.excluded = _beforeExcludes - _afterExcludes;
    if (!ordered.length) {
        // Everything that survived the excludes was dropped as KNOWN-closed —
        // the honest reply is "they're closed right now", never "seen it all".
        return { places: [], degraded: true, reason: 'all_closed', provenance };
    }

    // ── Paid-tier nudge (Arsen's decision, 2026-08-22 evening: "only
    //    spotlight and signature ones can be a little more visible than
    //    ordinary destinations and verified business ones"). The first TWO
    //    Spotlight/Signature partners in fused order climb 3 positions;
    //    plain destinations and Verified businesses compete on pure merit.
    //    Never enough to hijack a specific ask; labeled by the badge; a
    //    quality floor joins when paid placement goes live. ──
    {
        const CURATED_BOOST = 3, CURATED_SEATS = 2;
        const isCurated = (c) => c.tier === 'spotlight' || c.tier === 'signature';
        if (ordered.some(isCurated)) {
            let seats = 0;
            const scored = ordered.map((c, i) => {
                const boost = isCurated(c) && seats < CURATED_SEATS ? (seats++, CURATED_BOOST) : 0;
                return { c, i, s: i - boost };
            });
            scored.sort((a, b) => a.s - b.s || a.i - b.i);
            ordered = scored.map(e => e.c);
        }
    }

    // ── Personal taste (nudge, never hijack — see personalization/taste.js):
    //    liked/saved climb a few fused positions, oft-seen-never-acted sinks —
    //    harder with every repeat show, so identical asks ROTATE the deck.
    //    Runs BEFORE the demand-seat hoist so that guarantee stays on top,
    //    and annotates _tasteLiked/_tasteSaved for the narrator. ──
    if (params.taste) {
        const { tasteAdjust } = require('../personalization/taste');
        ordered = tasteAdjust(ordered, params.taste, { category });
        provenance.taste = true;
    }

    // ── Curated-tag interest nudge (founder audit 2026-09-05: romantic-only
    //    user got a nightlife-heavy deck while the one card tagged 'romantic'
    //    sat unweighted). Validator/business tags share the onboarding
    //    vocabulary (via the _TAG_STEMS drift map) — a direct hit climbs a few
    //    fused positions. A NUDGE, never a hijack — same law as taste. ──
    if (Array.isArray(params.preferences?.interests) && params.preferences.interests.length) {
        const { _prefFitScore } = require('../places/canonicalStore');
        const _hit = (c) => _prefFitScore([], null, params.preferences,
            [...(Array.isArray(c.types) ? c.types : []), ...(Array.isArray(c.interests) ? c.interests : [])]) === 1;
        const CLIMB = 3;
        let climbed = 0;
        const arr = ordered.slice();
        for (let i = 1; i < arr.length; i++) {
            if (_hit(arr[i]) && !_hit(arr[i - 1])) {
                const j = Math.max(0, i - CLIMB);
                const [c] = arr.splice(i, 1);
                arr.splice(j, 0, c);
                climbed++;
            }
        }
        if (climbed) {
            ordered = arr;
            console.log(`[retrieval] interest nudge: ${climbed} curated-tag match(es) climbed (interests=${params.preferences.interests.join(',')})`);
        }
    }

    // ── Demanded-term guarantee (the sushi lesson, 2026-08-22): when the clean
    //    query names something RARE in the pool (sushi, uzbek — ≤25% of
    //    candidates match), the matching candidates must not be crowded out by
    //    high-prior regulars: the fallback may have just PAID to fetch them,
    //    and the narrator then honestly says "no sushi here" while sushi sits
    //    in the pool. Up to 3 guaranteed seats, best-fused-first. ──
    let effectiveWanted = wanted;
    if (params.coreQuery) {
        const { uncoveredQueryTokens } = require('../places/canonicalStore');
        const rare = uncoveredQueryTokens(params.coreQuery, ordered, 0.25);
        // The DEMAND is what the ask wants beyond the category's own noun.
        // "ethiopian restaurant" demands ethiopian; the token "restaurant"
        // being rare in a thin pool is a fact about the pool's wording, not
        // about the ask — a broad "restaurants" ask must never shrink just
        // because candidate texts spell it differently.
        const catNorm = String(category || '').toLowerCase().replace(/_/g, ' ');
        const demand = rare.filter(t => !catNorm.includes(t));
        // City words are WHERE, not WHAT (founder 2026-08-30: "hotels in
        // Dilijan" shrank to 3 cards because "dilijan" read as a specific
        // demand like "sushi"). Geo tokens still earn demand SEATS — the
        // in-town matches should lead — but only a non-geo demand may
        // shrink the deck.
        const geo = new Set((params.geoTokens || []).map(t => String(t).toLowerCase()));
        const nonGeoDemand = demand.filter(t => !geo.has(t));
        if (rare.length) {
            const seats = ordered.filter(c => {
                // _demandMatch: the store FETCHED this place for the demanded
                // term (the Uzbechka lesson — "uzbek" isn't a substring of
                // "Uzbechka", knowledge beats spelling).
                if (c._demandMatch) return true;
                const t = String(c.text || c.name || '').toLowerCase();
                return rare.some(d => t.includes(d));
            }).slice(0, 3);
            if (!seats.length) {
                // NOTHING matched what the ask demands. The deck is then merely
                // "places near you", which is not an answer — live 2026-08-23:
                // "I want to book a taxi. How can I do it" returned six
                // sightseeing cards. The route reads `unmatched` and answers
                // honestly for non-place asks; for a PLACE ask with a real
                // category ("Ethiopian restaurant", live 2026-08-29: six padded
                // cards) the deck itself now SHRINKS — a couple of honest
                // alternatives plus the narrator's widen-the-search question,
                // never a full padded six. Refills stay exempt: an asked count
                // is honored.
                provenance.unmatched = rare;
                // Shrink only on a REAL demand (beyond the category noun) —
                // a broad categorical ask with an oddly-worded pool keeps its
                // full deck.
                if (params.adaptiveDeck && nonGeoDemand.length) {
                    effectiveWanted = Math.min(wanted, 3);
                    provenance.adaptive = 'no_match';
                }
            }
            if (seats.length) {
                // Tell the narrator WHY these lead the deck. Without this it
                // hedged against its own evidence — "I can't confirm any of
                // these are Uzbek" over a deck holding Uzbechka (live
                // 2026-08-29) — because nothing said the places were fetched
                // for that exact term. Per-request annotation on the cloned
                // candidates; never written back into the shared cached pool.
                for (const s of seats) s._demandTerm = (demand.length ? demand : rare).join(' ');
                ordered = [...seats, ...ordered.filter(c => !seats.includes(c))];
                // ── Adaptive deck (battery fix #2): a SPECIFIC ask — the
                //    query demands something rare in the pool (sushi, uzbek,
                //    vegan) — answers with the match(es) + 1-2 honest
                //    alternatives, not six padded cards (the padding cost
                //    battery rows 1/4/5). Broad asks keep the full deck;
                //    refill asks (adaptiveDeck:false) honor the asked count. ──
                if (params.adaptiveDeck && nonGeoDemand.length) {
                    effectiveWanted = Math.min(wanted, 3);
                    provenance.adaptive = 'specific';
                }
            }
        }
    }
    // ── A category-less BROWSE ask gets a mixed deck (2026-09-01) ──
    // Only when there is no demand left in the query: "sushi in Dilijan" must
    // return sushi, not one sushi and a park. Geo tokens are already stripped
    // upstream, so a query that was nothing but a place name arrives as null,
    // and a vibe-only query ("good locations") is not substantive either.
    // A CATEGORY ask never diversifies — it was asked for one kind.
    if (!category && params.diversify !== false) {
        let browseAsk = !query;
        if (!browseAsk) {
            try { browseAsk = !require('../places/canonicalStore').isSubstantiveAsk(query); }
            catch { browseAsk = false; }
        }
        if (browseAsk) {
            const { diversify } = require('./diversify');
            const before = ordered.slice(0, effectiveWanted).map(c => c && c.name).join('|');
            ordered = diversify(ordered, { want: effectiveWanted });
            provenance.diversified = ordered.slice(0, effectiveWanted).map(c => c && c.name).join('|') !== before;
        }
    }

    // ── ONE VENUE, ONE CARD (2026-09-04) ──
    // Live: "For 4 people tonight at 8" carded Koyo TWICE — the founder's
    // Destination row and the Google cache row for the same restaurant. The
    // cache-twin suppression only runs inside the style verdict, so any deck
    // assembled without a style decision could seat both twins. This dedupe is
    // unconditional and runs last: same placeId, or same name (inclusion, the
    // _sameName rule) within 150 m, is the same venue. The OWNED row
    // (destination/business) always survives the fold — curated data outranks
    // its bought twin — otherwise the higher-ranked one stays.
    {
        const OWNED_SRC = new Set(['destination', 'business']);
        const _nrm = (n) => normalizePlaceName(n || '');
        const _samePlace = (a, b) => {
            if (a.placeId && b.placeId && a.placeId === b.placeId) return true;
            const x = _nrm(a.name), y = _nrm(b.name);
            if (!x || !y || x.length < 3 || y.length < 3) return false;
            if (x !== y && !x.includes(y) && !y.includes(x)) return false;
            const ag = a.geometry, bg = b.geometry;
            if (!ag || !bg || ag.lat == null || bg.lat == null) return x === y;
            return haversineKm(ag.lat, ag.lng, bg.lat, bg.lng) <= 0.15;
        };
        const kept = [];
        for (const c of ordered) {
            if (!c) continue;
            const i = kept.findIndex(k => _samePlace(k, c));
            if (i === -1) { kept.push(c); continue; }
            // Duplicate: the owned row wins the seat the ranked one earned.
            if (OWNED_SRC.has(c.source) && !OWNED_SRC.has(kept[i].source)) {
                console.log(`[retrieval] dedupe: "${kept[i].name}"(${kept[i].source}) folded into "${c.name}"(${c.source})`);
                kept[i] = c;
            } else {
                console.log(`[retrieval] dedupe: "${c.name}"(${c.source}) folded into "${kept[i].name}"(${kept[i].source})`);
            }
        }
        ordered = kept;
    }

    // ── OUR OWN DATA ALWAYS GETS A SEAT (2026-09-03) ──
    // Live: "I'm at Khor Virap. What should I visit next?" ranked Noah's
    // Garden — the founder's own curated destination, 1.5 km away — LAST of
    // six, because a staff-entered row carries no Google rating and the
    // quality prior that lifts a cache row scores it zero.
    //
    // The first attempt at this rewrote the final slice, and never fired: the
    // deck is cut again downstream, so protecting the last slot here protects
    // nothing. Hoisting into the top THREE is cut-proof — three is the
    // smallest deck the adaptive shrink ever produces, so a seat there
    // survives every later trim. One seat, not a takeover.
    const OWNED = new Set(['destination', 'business']);
    const SAFE_SEAT = 3;
    if (ordered.length > SAFE_SEAT && !ordered.slice(0, SAFE_SEAT).some(c => c && OWNED.has(c.source))) {
        const i = ordered.findIndex(c => c && OWNED.has(c.source));
        if (i >= SAFE_SEAT) {
            const owned = ordered[i];
            ordered = [...ordered.slice(0, SAFE_SEAT - 1), owned,
                ...ordered.slice(SAFE_SEAT - 1).filter(c => c !== owned)];
            provenance.ownedSeat = owned.name;
            console.log(`[retrieval] curated seat: "${owned.name}" (${owned.source}) hoisted `
                + `from #${i + 1} to #${SAFE_SEAT} — our own data is not the row that falls off`);
        }
    }

    // ── SEASON SINK, LAST WORD (founder 2026-09-05): nothing after this
    //    reorders, so an off-season row can no longer be hoisted back into
    //    the deck by curated-seat/taste/nudge. Still never a drop — when the
    //    pool is thinner than the deck they appear, at the end, with the
    //    OFF-SEASON caveat on their facts line. ──
    {
        const off = ordered.filter(c => c && c._offSeason).length;
        if (off && off < ordered.length) {
            ordered = [...ordered.filter(c => !c || !c._offSeason), ...ordered.filter(c => c && c._offSeason)];
            console.log(`[retrieval] season sink (final): ${off} off-season candidate(s) moved behind the rest`);
        }
    }
    const places = ordered.slice(0, effectiveWanted);
    // ── WHERE DID IT GO? (2026-09-03) ──
    // "Noah's Garden is in the pool and not in the deck" was unanswerable
    // three rounds running: the pool line says what ARRIVED, the summary says
    // how many were SERVED, and nothing said which stage ate the difference.
    // Every drop between the two is counted here, and the survivors are named
    // when the deck is small enough to read.
    if (places.length < provenance.candidateCount) {
        const lost = [];
        if (provenance.excluded) lost.push(`already-shown ${provenance.excluded}`);
        if (provenance.openNowDropped) lost.push(`closed ${provenance.openNowDropped}`);
        if (provenance.outsideRadius) lost.push(`outside-radius ${provenance.outsideRadius}`);
        const cut = ordered.length - places.length;
        if (cut > 0) lost.push(`cut ${cut} (deck ${effectiveWanted})`);
        console.log(`[retrieval] ${provenance.candidateCount} candidate(s) → ${places.length} served`
            + `${lost.length ? ` — lost to ${lost.join(', ')}` : ''}`
            + `${places.length <= 8 ? ` | deck: ${places.map(p => `${p.name}(${p.source || '?'})`).join(' · ')}` : ''}`);
    }
    return { places, degraded: false, provenance };
}

module.exports = { findPlaces };
