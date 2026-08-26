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

/* THE ONE HOLE IN THE RULE ABOVE (2026-08-26).
 *
 * Enrichment is right and stays. But it rests on the assumption stated above —
 * "useless tokens cost nothing (idf ≈ 0 when they match no documents)" — and
 * that only holds for tokens matching NOTHING. A token matching nearly
 * EVERYTHING is the opposite case, and the enrichment had no guard for it.
 *
 * Live: "where can I get acquainted with a girl in Yerevan" searched
 * `help acquainted normal girl yerevan` and matched 44 of 52 candidates. Every
 * place in Yerevan carries "Yerevan" in its name or address, so the one word
 * that means nothing INSIDE a Yerevan search was the only word matching
 * anything. Its idf is not 0, it is small-but-positive, and when nothing else
 * matches, small-but-positive is the entire ranking. The deck came back a
 * jewellery shop, a nut shop and a helicopter tour, each with a blurb
 * explaining why it suited meeting someone.
 *
 *     "help acquainted normal girl yerevan"  → 44 matches
 *     "help acquainted normal girl"          →  0 matches   ← the truth
 *
 * Second harm: it inflated provenance.lexical, and the relevance brake fires
 * only when that is 0 — so the guard built for exactly this deck was held shut
 * by the bug it existed to catch.
 *
 * `filters` is whatever has ALREADY been applied structurally — the city, the
 * country, the category, the sub-type. Those select the set; repeating them as
 * text can only match what already survived, which is noise wearing the shape
 * of signal. Everything else the traveler said still enriches exactly as before.
 */
function buildRetrievalQuery(searchQuery, rawMessage, { filters = [], maxTokens = 8 } = {}) {
    const filtered = new Set(
        (Array.isArray(filters) ? filters : [filters])
            .filter(Boolean)
            .flatMap(f => tokenize(String(f)))
    );
    const base = tokenize(searchQuery || '').filter(t => !filtered.has(t));
    const seen = new Set(base);
    const extra = [];
    for (const t of tokenize(rawMessage || '')) {
        if (t.length < 4) continue;
        if (seen.has(t) || CHAT_STOPWORDS.has(t) || filtered.has(t)) continue;
        seen.add(t);
        extra.push(t);
        if (base.length + extra.length >= maxTokens) break;
    }
    const combined = [...base, ...extra].join(' ');
    if (combined) return combined;
    // Nothing survived, and the filters are why. That is an honest empty query,
    // not a failure: "restaurants in Dubai" carries no want beyond a kind and a
    // place, and both are already applied. Empty makes findPlaces skip lexical
    // and vector ranking and fall to the prior — correct, since there is no
    // textual evidence to weigh — and it stops the Google fallback paying for a
    // search whose only surviving term was the city.
    if (filtered.size) return '';
    // No filters were supplied, so this is the original path, unchanged: a
    // message whose words were all too short to tokenize still searches for
    // something rather than nothing.
    return String(searchQuery || rawMessage || '');
}

/* 3. Right-now intent (Arsen's rule, 2026-08-22): "if the context is right now
 * then it should check [open hours]; if not, let it pass without." Nearby mode
 * and late night imply it; these words make it explicit at any hour. A
 * planning-ahead ask ("next week", "tomorrow") never matches. */
// \b is ASCII-only in JS regex — it never matches beside Cyrillic/Armenian
// letters, so the non-Latin now-words are tested without boundaries.
// All six app languages (EN/FR share the \b group; RU/HY/ZH/AR go boundary-
// free — JS \b is ASCII-only, the Cyrillic lesson).
const RIGHT_NOW_LATIN_RE = /\b(right now|now|tonight|currently|open now|at the moment|this evening|maintenant|ce soir|tout de suite|actuellement)\b/i;
const RIGHT_NOW_NONLATIN_RE = /(сейчас|сегодня вечером|այս պահին|հիմա|现在|今晚|此刻|马上|الآن|الليلة|حالا)/i;
function isRightNowAsk(message) {
    const m = String(message || '');
    return RIGHT_NOW_LATIN_RE.test(m) || RIGHT_NOW_NONLATIN_RE.test(m);
}

/* 3b. "How do I get there / get around" — transport asks (Arsen 2026-08-23,
 * after his brother asked "I want to book a taxi. How can I do it" and got six
 * sightseeing cards). This is the LLM-timeout fallback for intent.infoAsk —
 * the brain decides first. Latin terms take word boundaries so "bus" cannot
 * fire inside "business"; non-Latin scripts go boundary-free (the Cyrillic
 * lesson again). Pure. */
const TRANSPORT_LATIN_RE = /\b(taxi|cab|uber|careem|bolt|shuttle|metro|subway|underground|tram|bus|ferry|boat|train|flight|flights|fly|airport|scooter|bicycle|car rental|rent a (car|scooter|bike)|how (do|can|should) i (get|reach|travel)|get (there|around)|walk (there|to)|drive (there|to)|directions?|how (far|long)( is| does)?|comment (aller|se rendre)|louer une voiture)\b/i;
const TRANSPORT_NONLATIN_RE = /(такси|убер|метро|автобус|маршрутк|как добраться|как доехать|как дойти|пешком|паром|электричк|տաքսի|մետրո|ավտոբուս|ինչպես հասնել|ոտքով|métro|出租车|打车|地铁|公交|渡轮|步行|怎么去|怎么走|怎么到|تاكسي|مترو|حافلة|عبّارة|سيرا|كيف أصل|كيف اذهب)/i;
function isTransportAsk(message) {
    const m = String(message || '');
    return TRANSPORT_LATIN_RE.test(m) || TRANSPORT_NONLATIN_RE.test(m);
}

/* 4. Intent-conditioned fusion weights (the ChatGPT-essay §5 idea, adopted
 * 2026-08-22): the ask's NATURE shifts what evidence matters. A "right now"
 * ask cares where you ARE (proximity up); a romantic/special-occasion ask
 * cares how GOOD the place is (quality prior up, distance matters less —
 * nobody picks an anniversary dinner by walking distance). Defaults match
 * the weights findPlaces has always used. Pure. */
const ROMANTIC_RE = /\b(romantic|romance|anniversary|proposal|honeymoon|special occasion|celebrat\w*|impress|romantique|anniversaire|lune de miel)\b|романти|годовщин|юбилей|ռոմանտիկ|浪漫|求婚|周年|蜜月|رومانسي|شهر العسل|ذكرى/i;

function rankingWeights({ rightNow = false, nearbyMode = false, message = '' } = {}) {
    const romantic = ROMANTIC_RE.test(String(message || ''));
    return {
        lexical: 1,
        vector: 1,
        proximity: (rightNow || nearbyMode) ? 1 : romantic ? 0.35 : 0.5,
        prior: romantic ? 0.9 : 0.5,
    };
}

// ── Refill follow-ups ("can you give 10 other results?", "ещё", "show me
//    more") — caught live 2026-08-22: the intent LLM timed out, the keyword
//    fallback saw no travel words and the traveler got chit-chat instead of
//    cards. These messages carry no category on purpose — the SESSION holds
//    the context, so the route treats them as a re-run of the previous ask
//    with everything already shown excluded. Latin \b + non-Latin without
//    (the Cyrillic \b lesson). Count: a bare 2-12 in a refill ask is the
//    requested deck size ("10 other results" → 10). ──
const REFILL_LATIN_RE = /\b(more|other|others|another|different|new ones|something else|else|additional|encore|autres|davantage|nouveaux|nouvelles)\b|d['’]autres/i;
const REFILL_NONLATIN_RE = /(ещё|еще|друг(ие|ое|их)|новые|больше|այլ|ուրիշ|էլի|更多|其他|别的|另外|再来|再推荐|المزيد|أخرى|غيرها|أكثر|اقتراحات جديدة)/i;
function parseRefillAsk(message) {
    const msg = String(message || '');
    const isRefill = REFILL_LATIN_RE.test(msg) || REFILL_NONLATIN_RE.test(msg);
    const m = isRefill ? msg.match(/\b([2-9]|1[0-2])\b/) : null;
    return { isRefill, count: m ? Number(m[1]) : null };
}

module.exports = { effectiveRadiusKm, buildRetrievalQuery, isRightNowAsk, isTransportAsk, rankingWeights, parseRefillAsk, LOCAL_DISCOVERY_CAP_KM };
