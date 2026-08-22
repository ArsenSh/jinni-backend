// Jinni V2 Engine — retrieval tuning (pure).
// Born from the first live V1-vs-V2 comparison (2026-08-21): a 37.7 km
// Tsaghkadzor restaurant surfaced on a "dinner with my girlfriend" ask, and
// intent's cleaned query ("restaurant") was so generic that lexical ranking
// carried no signal. Two fixes, both deterministic:

const { tokenize } = require('./lexical');

/* 1. Category-aware radius. Dining/shopping/activities are LOCAL decisions —
 * nobody drives 40 km for dinner they didn't explicitly plan. Discovery mode
 * caps those at 15 km; sights/hotels keep the full radius (a monastery 40 km
 * out is a fine discovery answer). Nearby mode is already tight and
 * destination-mode centers are the user's own choice, so both pass through. */
const LOCAL_CATEGORIES = new Set(['restaurants', 'shopping', 'activities']);
const LOCAL_DISCOVERY_CAP_KM = 15;

function effectiveRadiusKm({ category = null, mode = 'discovery', radiusKm = 50 } = {}) {
    if (mode !== 'discovery') return radiusKm;
    if (category && LOCAL_CATEGORIES.has(category)) return Math.min(radiusKm, LOCAL_DISCOVERY_CAP_KM);
    return radiusKm;
}

/* 2. Query enrichment. Intent's searchQuery is clean but LOSSY — "I am looking
 * for restaurant to meet with my girlfriend" became "restaurant", which
 * matches every restaurant equally. Keep the clean query as the base and
 * append the raw message's DISTINCTIVE tokens (≥4 chars, not chat filler),
 * so "romantic", "rooftop", "seafood", "girlfriend" survive into BM25 —
 * useless tokens cost nothing (idf ≈ 0 when they match no documents), and
 * they become genuinely powerful once embeddings are enabled. */
const CHAT_STOPWORDS = new Set([
    'looking', 'look', 'want', 'wanted', 'need', 'needed', 'please', 'suggest',
    'suggestion', 'suggestions', 'recommend', 'recommendation', 'recommendations',
    'show', 'give', 'find', 'tell', 'know', 'some', 'somewhere', 'good', 'nice',
    'best', 'great', 'meet', 'with', 'that', 'this', 'have', 'what', 'where',
    'when', 'which', 'like', 'would', 'could', 'should', 'there', 'here',
    'place', 'places', 'around', 'near', 'nearby',
]);

function buildRetrievalQuery(searchQuery, rawMessage, maxTokens = 8) {
    const base = tokenize(searchQuery || '');
    const seen = new Set(base);
    const extra = [];
    for (const t of tokenize(rawMessage || '')) {
        if (t.length < 4) continue;
        if (seen.has(t) || CHAT_STOPWORDS.has(t)) continue;
        seen.add(t);
        extra.push(t);
        if (base.length + extra.length >= maxTokens) break;
    }
    const combined = [...base, ...extra].join(' ');
    return combined || String(searchQuery || rawMessage || '');
}

/* 3. Right-now intent (Arsen's rule, 2026-08-22): "if the context is right now
 * then it should check [open hours]; if not, let it pass without." Nearby mode
 * and late night imply it; these words make it explicit at any hour. A
 * planning-ahead ask ("next week", "tomorrow") never matches. */
// \b is ASCII-only in JS regex — it never matches beside Cyrillic/Armenian
// letters, so the non-Latin now-words are tested without boundaries.
const RIGHT_NOW_LATIN_RE = /\b(right now|now|tonight|currently|open now|at the moment|this evening)\b/i;
const RIGHT_NOW_NONLATIN_RE = /(сейчас|сегодня вечером|այս պահին|հիմա)/i;
function isRightNowAsk(message) {
    const m = String(message || '');
    return RIGHT_NOW_LATIN_RE.test(m) || RIGHT_NOW_NONLATIN_RE.test(m);
}

/* 4. Intent-conditioned fusion weights (the ChatGPT-essay §5 idea, adopted
 * 2026-08-22): the ask's NATURE shifts what evidence matters. A "right now"
 * ask cares where you ARE (proximity up); a romantic/special-occasion ask
 * cares how GOOD the place is (quality prior up, distance matters less —
 * nobody picks an anniversary dinner by walking distance). Defaults match
 * the weights findPlaces has always used. Pure. */
const ROMANTIC_RE = /\b(romantic|romance|anniversary|proposal|honeymoon|special occasion|celebrat\w*|impress)\b|романти|годовщин|юбилей/i;

function rankingWeights({ rightNow = false, nearbyMode = false, message = '' } = {}) {
    const romantic = ROMANTIC_RE.test(String(message || ''));
    return {
        lexical: 1,
        vector: 1,
        proximity: (rightNow || nearbyMode) ? 1 : romantic ? 0.35 : 0.5,
        prior: romantic ? 0.9 : 0.5,
    };
}

module.exports = { effectiveRadiusKm, buildRetrievalQuery, isRightNowAsk, rankingWeights, LOCAL_DISCOVERY_CAP_KM };
