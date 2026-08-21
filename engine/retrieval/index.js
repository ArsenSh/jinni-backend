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

    // ── Semantic cache (query mode only — seeded taps are already cheap) ──
    if (query) {
        const hit = cache.get(cacheParams, { queryVector, queryText: query });
        if (hit) return { ...hit, provenance: { ...hit.provenance, cacheHit: true } };
    }

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

    // ── Session excludes ──
    const exIds = new Set((excludes.placeIds || []).filter(Boolean));
    const exNames = new Set((excludes.names || []).map(n => normalizePlaceName(n)).filter(Boolean));
    candidates = candidates.filter(c =>
        c && !exIds.has(c.placeId) && !exNames.has(normalizePlaceName(c.name || '')));

    // ── Context engine: stamp _openNow; drop only KNOWN-closed, only for
    //    droppable categories, only when the caller asked (right-now intent).
    //    Unknown hours (null) always survive — the trust rule. ──
    if (timeContext) {
        annotateOpenNow(candidates, timeContext);
        if (enforceOpenNow && shouldDropWhenClosed(category)) {
            const before = candidates.length;
            candidates = candidates.filter(c => c._openNow !== false);
            provenance.openNowDropped = before - candidates.length;
        }
    }
    if (!candidates.length) {
        return { places: [], degraded: true, reason: 'all_filtered', provenance };
    }

    // ── Rank: prior order (store's proximity/quality) ∥ BM25 ∥ vector → RRF.
    //    When the user expressed a QUERY, relevance evidence outweighs the
    //    popularity prior (weight 0.5) — otherwise two swapped lists tie
    //    exactly in plain RRF and the prior silently wins (see rrf.js). ──
    const withIds = candidates.map(c => ({ c, id: _idOf(c) }));
    const byId = new Map(withIds.map(({ c, id }) => [id, c]));
    const priorList = withIds.map(({ id }) => id);
    const lists = [];
    if (query) {
        const lex = rankLexical(query, withIds.map(({ c, id }) => ({ id, text: c.text || c.name || '' })));
        provenance.lexical = lex.length;
        if (lex.length) lists.push({ ids: lex.map(r => r.id), weight: 1 });
        if (queryVector) {
            const vec = rankByVector(queryVector, withIds.map(({ c, id }) => ({ id, vector: c.vector })), 0.1);
            if (vec.length) { lists.push({ ids: vec.map(r => r.id), weight: 1 }); provenance.vector = true; }
        }
    }
    lists.push({ ids: priorList, weight: lists.length ? 0.5 : 1 });
    const fused = lists.length > 1 ? fuseRankings(lists).map(r => r.id) : priorList;
    const places = fused.map(id => byId.get(id)).filter(Boolean).slice(0, wanted);

    const result = { places, degraded: false, provenance };
    if (query) cache.set(cacheParams, { queryVector, queryText: query }, result);
    return result;
}

module.exports = { findPlaces };
