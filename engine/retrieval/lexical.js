// Jinni V2 Engine — lexical ranking (BM25, in-process).
// Plain-Mongo decision (Arsen, 2026-08-21): no Atlas Search dependency. The
// candidate set is already geo/category-bounded (a few hundred docs at most),
// so BM25 over it in-process is milliseconds, needs no index, and — unlike a
// Mongo $text score — is fully unit-testable. Tokenization reuses
// normalizePlaceName, so diacritics/scripts behave exactly like the matchers.

const { normalizePlaceName } = require('../places/matching');

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text) {
    return normalizePlaceName(text).split(' ').filter(t => t.length >= 2);
}

/**
 * Rank candidates lexically against a free-text query.
 * @param {string} query
 * @param {Array<{id: string, text: string}>} candidates
 * @returns {Array<{id: string, score: number}>} best-first; zero-scored dropped
 */
function rankLexical(query, candidates) {
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !candidates?.length) return [];

    const docs = candidates.map(c => ({ id: c.id, tokens: tokenize(c.text || '') }));
    const N = docs.length;
    const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;

    // Document frequency per query token.
    const df = new Map();
    for (const t of qTokens) {
        df.set(t, docs.reduce((n, d) => n + (d.tokens.includes(t) ? 1 : 0), 0));
    }

    const scored = [];
    for (const d of docs) {
        let score = 0;
        for (const t of qTokens) {
            const tf = d.tokens.filter(x => x === t).length;
            if (!tf) continue;
            const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
            score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.tokens.length / avgLen)));
        }
        if (score > 0) scored.push({ id: d.id, score });
    }
    return scored.sort((a, b) => b.score - a.score);
}

module.exports = { tokenize, rankLexical, BM25_K1, BM25_B };
