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
    const cacheParams = { category, subType, mode, tapState, center };
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
            pool = hit.pool;
            Object.assign(provenance, hit.provenance, { cacheHit: true });
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
            cache.set(cacheParams, { queryVector, queryText: query },
                { pool, provenance: { ...provenance } });
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
        return { places: [], degraded: true, reason: 'all_filtered', provenance };
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
        if (rare.length) {
            const seats = ordered.filter(c => {
                // _demandMatch: the store FETCHED this place for the demanded
                // term (the Uzbechka lesson — "uzbek" isn't a substring of
                // "Uzbechka", knowledge beats spelling).
                if (c._demandMatch) return true;
                const t = String(c.text || c.name || '').toLowerCase();
                return rare.some(d => t.includes(d));
            }).slice(0, 3);
            if (seats.length) {
                ordered = [...seats, ...ordered.filter(c => !seats.includes(c))];
                // ── Adaptive deck (battery fix #2): a SPECIFIC ask — the
                //    query demands something rare in the pool (sushi, uzbek,
                //    vegan) — answers with the match(es) + 1-2 honest
                //    alternatives, not six padded cards (the padding cost
                //    battery rows 1/4/5). Broad asks keep the full deck;
                //    refill asks (adaptiveDeck:false) honor the asked count. ──
                if (params.adaptiveDeck) {
                    effectiveWanted = Math.min(wanted, 3);
                    provenance.adaptive = 'specific';
                }
            }
        }
    }
    const places = ordered.slice(0, effectiveWanted);
    return { places, degraded: false, provenance };
}

module.exports = { findPlaces };
