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
    const exIds = new Set((excludes.placeIds || []).filter(Boolean));
    const exNames = new Set((excludes.names || []).map(n => normalizePlaceName(n)).filter(Boolean));
    ordered = ordered.filter(c =>
        !exIds.has(c.placeId) && !exIds.has(c.verifiedId)
          && !exNames.has(normalizePlaceName(c.name || '')));
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
        annotateOpenNow(ordered, timeContext);
        if (enforceOpenNow && shouldDropWhenClosed(category)) {
            const before = ordered.length;
            ordered = ordered.filter(c => c._openNow !== false);
            provenance.openNowDropped = before - ordered.length;
        }
    }
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

    // ── OUR OWN DATA ALWAYS GETS A SEAT (2026-09-03) ──
    // Live: "I'm at Khor Virap. What should I visit next?" ranked seven
    // candidates and served six. The one cut was Noah's Garden — the founder's
    // OWN curated destination, 1.5 km away — because a staff-entered row
    // carries no Google rating, so the quality prior that lifts a cache row
    // scores it zero. Six strangers outranked the one place we actually know.
    //
    // The moat is the data, so a curated row that passed every gate is never
    // the row that falls off the end: it takes the last slot instead. One
    // seat, not a takeover — it still has to earn the rest on score.
    let places = ordered.slice(0, effectiveWanted);
    const OWNED = new Set(['destination', 'business']);
    if (places.length >= effectiveWanted && effectiveWanted > 1) {
        const shown = new Set(places.map(p => p && (p.placeId || p.name)));
        const ownedInPool = ordered.find(c => c && OWNED.has(c.source)
            && !shown.has(c.placeId || c.name));
        if (ownedInPool && !places.some(p => p && OWNED.has(p.source))) {
            const droppedName = places[places.length - 1]?.name;
            places = [...places.slice(0, effectiveWanted - 1), ownedInPool];
            provenance.ownedSeat = ownedInPool.name;
            console.log(`[retrieval] curated seat: "${ownedInPool.name}" (${ownedInPool.source}) `
                + `takes the last slot from "${droppedName}" — our own data outranks a stranger`);
        }
    }
    return { places, degraded: false, provenance };
}

module.exports = { findPlaces };
