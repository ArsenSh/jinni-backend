// Jinni V2 Engine — vector similarity (plain-Mongo path).
// Decision (Arsen, 2026-08-21): embeddings live as plain number[] fields and are
// compared IN-PROCESS — no Atlas Vector Search, no plan change. At the corpus
// sizes this app has (~1–2k places, geo-filtered to hundreds per request) a JS
// cosine scan is sub-millisecond; revisit only if the corpus grows 100×.

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank candidates by similarity to a query vector.
 * @param {number[]} queryVector
 * @param {Array<{id: string, vector: number[]}>} candidates  (vector-less entries skipped)
 * @param {number} [minScore]  drop matches below this (0.0 keeps all)
 * @returns {Array<{id: string, score: number}>} best-first
 */
function rankByVector(queryVector, candidates, minScore = 0) {
    if (!Array.isArray(queryVector) || !queryVector.length || !candidates?.length) return [];
    const scored = [];
    for (const c of candidates) {
        if (!c || !Array.isArray(c.vector)) continue;
        const score = cosineSimilarity(queryVector, c.vector);
        if (score > minScore) scored.push({ id: c.id, score });
    }
    return scored.sort((a, b) => b.score - a.score);
}

module.exports = { cosineSimilarity, rankByVector };
