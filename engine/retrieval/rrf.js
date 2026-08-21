// Jinni V2 Engine — Reciprocal Rank Fusion (V3 blueprint §3.2; ChatV2 §2B).
// The one-line algorithm behind Elastic/Qdrant/Weaviate hybrid search:
// score(id) = Σ over lists of 1 / (k + rank), rank 1-based, k = 60.
// No score normalization needed — that is the whole point of RRF.

const RRF_K = 60;

/**
 * Fuse N ranked lists of ids into one ranking. WEIGHTED variant: with exactly
 * two plain lists, swapping the top two produces an exact tie (1/61 + 1/62 on
 * both sides) and the tie-break silently falls to insertion order — which let
 * the popularity prior override an explicit query. A list may therefore carry
 * a weight ({ids, weight}); relevance evidence (lexical/vector) gets weight 1,
 * the prior gets less when a query exists (see retrieval/index.js).
 * @param {Array<Array<string>|{ids: Array<string>, weight?: number}>} rankedLists
 * @param {number} [k]
 * @returns {Array<{id: string, score: number}>} best-first
 */
function fuseRankings(rankedLists, k = RRF_K) {
    const scores = new Map();
    for (const entry of rankedLists || []) {
        const ids = Array.isArray(entry) ? entry : entry?.ids;
        const weight = Array.isArray(entry) ? 1 : (Number.isFinite(entry?.weight) ? entry.weight : 1);
        if (!Array.isArray(ids)) continue;
        ids.forEach((id, i) => {
            if (id == null) return;
            scores.set(id, (scores.get(id) || 0) + weight / (k + i + 1));
        });
    }
    return [...scores.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
}

module.exports = { fuseRankings, RRF_K };
