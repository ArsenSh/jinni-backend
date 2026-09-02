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
    // Distance phrasing describes the RADIUS, not a venue (live 2026-09-02:
    // "What can I do within 10 km?" left q="within" after everything else was
    // stripped, and BM25 scored the whole corpus against one filler word).
    'within', 'inside', 'radius', 'closest', 'nearest', 'kilometers', 'kilometres',
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

function rankingWeights({ rightNow = false, nearbyMode = false, message = '', countryScope = false } = {}) {
    const romantic = ROMANTIC_RE.test(String(message || ''));
    return {
        lexical: 1,
        vector: 1,
        // Across a whole COUNTRY, distance from the centre ranks nothing: it
        // would simply rebuild the capital-only deck the country scope exists
        // to escape (Arsen 2026-09-01).
        proximity: countryScope ? 0 : (rightNow || nearbyMode) ? 1 : romantic ? 0.35 : 0.5,
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
/* 3c. "Near me" — the DISCOVERY → NEARBY switch (Arsen's rule; live
 * 2026-09-01: "what restaurant you can find near me?" ran in discovery at
 * r=15km and seated a restaurant 6.9 km out, which nearby's 5 km would have
 * excluded). This is proximity to the TRAVELER, not a time word, so it is
 * separate from isRightNowAsk. Latin terms take word boundaries; non-Latin
 * scripts go boundary-free (the Cyrillic lesson). Pure. */
const NEARBY_LATIN_RE = /\b(near(by| me| here| my location)?|close (by|to me)|around (me|here)|next to me|walking distance|within walking|a few (steps|minutes) (away|from)|pr(e|è)s de moi|(a|à) proximit(e|é)|autour de moi)\b/i;
const NEARBY_NONLATIN_RE = /(рядом со мной|рядом|поблизости|недалеко|около меня|вблизи|неподалеку|неподалёку|մոտակա|մոտակայք|իմ մոտ|մոտս|附近|离我近|我附近|周边|قريب مني|بالقرب مني|القريبة مني)/i;
function isNearbyAsk(message) {
    const m = String(message || '');
    return NEARBY_LATIN_RE.test(m) || NEARBY_NONLATIN_RE.test(m);
}

/* 3c-bis. "CLOSEST" IS A SORT, NOT A LIMIT (2026-09-02).
 * Folding closest/nearest into isNearbyAsk would force nearby's 5 km — and in
 * the live Gyumri test the only real monastery (Marmashen) sits at 9.4 km, so
 * the honest answer would have been thrown away. A superlative asks us to RANK
 * by distance from the traveler, not to draw a boundary: the centre moves to
 * their GPS and proximity weight goes to 1.0, while the radius is left alone. */
const CLOSEST_LATIN_RE = /\b(closest|nearest|next nearest|le plus proche|la plus proche)\b/i;
const CLOSEST_NONLATIN_RE = /(ближайш\w*|ближе всего|ամենամոտ|最近的|离我最近|الأقرب)/i;
function isClosestAsk(message) {
    const m = String(message || '');
    return CLOSEST_LATIN_RE.test(m) || CLOSEST_NONLATIN_RE.test(m);
}

/* 3d. "I'm at X" — the traveler STATING where they are (live 2026-09-02:
 * "I'm at Khor Virap. What should I visit next?" was answered about Gyumri,
 * 200 km away, with cards labelled "just 1 km away"). intentService cannot
 * help here: its rules forbid putting a landmark in place_names, precisely so
 * a restaurant cannot hijack the centre. So the position is parsed in code and
 * resolved separately (engine/geo/whereAmI.js).
 *
 * The capture stops at punctuation or a joining word, so "I'm at Khor Virap
 * and want food" yields "Khor Virap" rather than the rest of the sentence.
 * Pure — returns the raw name string, never coordinates. */
const AT_LOCATION_RES = [
    /\b(?:i(?:'m|’m| am)|we(?:'re|’re| are))\s+(?:currently\s+|now\s+)?(?:at|in|near|by|around)\s+(?:the\s+)?(.{2,48})/i,
    /\b(?:currently|right now)\s+(?:at|in)\s+(?:the\s+)?(.{2,48})/i,
    /\b(?:standing|staying|sitting)\s+(?:at|in|near)\s+(?:the\s+)?(.{2,48})/i,
    /(?:я|мы)\s+(?:сейчас\s+)?(?:в|на|у|около)\s+(.{2,48})/i,
];
const _AT_STOP_RE = /\s+(?:and|but|so|what|where|which|can|could|should|would|now|please|я|и|а|что|где)\b|[.,;!?—–]/i;
function parseAtLocation(message) {
    const m = String(message || '');
    for (const re of AT_LOCATION_RES) {
        const hit = re.exec(m);
        if (!hit) continue;
        let name = String(hit[1] || '').split(_AT_STOP_RE)[0].trim();
        name = name.replace(/["'’`]+$/g, '').trim();
        // A bare pronoun or a single short filler word is not a place.
        if (name.length < 3 || /^(me|us|here|there|home|town|city)$/i.test(name)) continue;
        return name;
    }
    return null;
}

/* 3e. An EXPLICIT radius always wins (live 2026-09-02: "What can I do within
 * 10 km?" ran at r=50km and seated Talin at 45 km, which the narrator then had
 * to apologise for). Miles are converted; the result is clamped so a typo
 * cannot turn a walk into a country-wide sweep. Pure. */
const RADIUS_RES = [
    /\b(?:within|under|less than|no more than|inside|in a|max(?:imum)?)\s+(\d{1,3})\s*(km|kilomet(?:er|re)s?|mi|miles?)\b/i,
    /\b(\d{1,3})\s*(km|kilomet(?:er|re)s?|mi|miles?)\s*(?:radius|around|away|from me|of me)\b/i,
    /(?:в радиусе|не дальше|не более|в пределах)\s+(\d{1,3})\s*(км|километ\w*)/i,
    /(\d{1,3})\s*(կմ|կիլոմետր\w*)/i,
];
function parseRadiusKm(message) {
    const m = String(message || '');
    for (const re of RADIUS_RES) {
        const hit = re.exec(m);
        if (!hit) continue;
        const n = Number(hit[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        const unit = String(hit[2] || '').toLowerCase();
        const km = /^mi/.test(unit) ? n * 1.609 : n;
        return Math.min(100, Math.max(1, Math.round(km)));
    }
    return null;
}

/* 3f. A CORRIDOR ask names two places and wants what lies BETWEEN them (live
 * 2026-09-02: "on the way from Yerevan to Tatev" returned six Yerevan
 * nightclubs, because resolveDestination returns on the FIRST name it
 * resolves). Needs both endpoints, so it only fires when intent found two.
 * Pure — returns {from, to} or null; the route does the geometry. */
const CORRIDOR_RES = [
    /\bbetween\s+(.{2,40}?)\s+and\s+(.{2,40}?)(?:[.,;!?]|$)/i,
    /\b(?:on the way|en route|stops?|stopping)\b[^]*?\bfrom\s+(.{2,40}?)\s+to\s+(.{2,40}?)(?:[.,;!?]|$)/i,
    /\bfrom\s+(.{2,40}?)\s+to\s+(.{2,40}?)(?:[.,;!?]|$)/i,
    /(?:между)\s+(.{2,40}?)\s+и\s+(.{2,40}?)(?:[.,;!?]|$)/i,
    /(?:по пути|по дороге)\s+(?:из|от)\s+(.{2,40}?)\s+(?:в|до)\s+(.{2,40}?)(?:[.,;!?]|$)/i,
];
const _CORRIDOR_JUNK_RE = /^(here|there|home|it|them|us|me|you|this|that|the\s+\w+)$/i;
function _cleanEnd(raw) {
    const name = String(raw || '').replace(/^(?:the|a)\s+/i, '').replace(/["'’`.,]+$/g, '').trim();
    if (name.length < 3 || _CORRIDOR_JUNK_RE.test(name)) return null;
    return name;
}
function parseCorridorAsk(message, placeNames = []) {
    const names = (placeNames || []).filter(Boolean);
    const m = String(message || '');
    const hit = CORRIDOR_RES.map(re => re.exec(m)).find(Boolean);
    if (!hit) return null;
    // Intent's geocodable names win — it has already transliterated and
    // validated them. But a FOLLOW-UP ("other ones?") has no place names of
    // its own, and without a fallback the corridor was lost: live 2026-09-02
    // the Yerevan→Tatev follow-up ran as a plain hotels ask and bought a paid
    // Google search for the raw question, answering with Yerevan hotels. The
    // sentence still says where the road runs, so its own capture stands in.
    if (names.length >= 2) return { from: names[0], to: names[1], source: 'intent' };
    const from = _cleanEnd(hit[1]);
    const to = _cleanEnd(hit[2]);
    // Unresolvable ends simply produce no corridor — geocoding is the gate.
    return (from && to) ? { from, to, source: 'text' } : null;
}

const REFILL_LATIN_RE = /\b(more|other|others|another|different|new ones|something else|else|additional|encore|autres|davantage|nouveaux|nouvelles)\b|d['’]autres/i;
const REFILL_NONLATIN_RE = /(ещё|еще|друг(ие|ое|их)|новые|больше|այլ|ուրիշ|էլի|更多|其他|别的|另外|再来|再推荐|المزيد|أخرى|غيرها|أكثر|اقتراحات جديدة)/i;
function parseRefillAsk(message) {
    const msg = String(message || '');
    const isRefill = REFILL_LATIN_RE.test(msg) || REFILL_NONLATIN_RE.test(msg);
    const m = isRefill ? msg.match(/\b([2-9]|1[0-2])\b/) : null;
    return { isRefill, count: m ? Number(m[1]) : null };
}

// ── Explicit deck count on a FRESH ask ("show me 10 hotels", "топ 5 мест") —
//    Group C 2026-08-30: counts were only honored on refill turns, so a fresh
//    "show me 10 hotels" got the default 6 shrunk to 3. The intent LLM names
//    the count (intent.count); this regex is the timeout fallback. Guarded:
//    the number must sit next to a listing verb or a results-ish noun, so
//    "table for 2", "2 nights" or a street number never resize the deck. ──
const DECK_COUNT_VERB_RE = /(?:\b(?:show|give|list|suggest|recommend|find|top|want|need)\b|покажи|дай|найди|топ|порекомендуй|предложи|ցույց|տուր|առաջարկ|اعرض|أعطني|رشح)[^0-9]{0,16}\b([2-9]|1[0-2])\b/i;
const DECK_COUNT_NOUN_RE = /\b([2-9]|1[0-2])\s*(?:hotels?|restaurants?|places?|spots?|options?|results?|events?|cafes?|bars?|ideas?|suggestions?|отел\S*|ресторан\S*|мест\S*|вариант\S*|событи\S*|идеи|հյուրանոց\S*|ռեստորան\S*|տեղ\S*|միջոցառ\S*|فنادق|مطاعم|أماكن|خيارات)/iu;
function parseDeckCount(message) {
    const msg = String(message || '');
    const m = msg.match(DECK_COUNT_VERB_RE) || msg.match(DECK_COUNT_NOUN_RE);
    return m ? Number(m[1]) : null;
}

/* 2b. A DESTINATION NAME must not score lexically (live 2026-09-01).
 * "suggest 3 good locations in Dilijan" put "dilijan" into BM25, and a place's
 * text is name + primaryType + types + interests + CITY. Every Dilijan
 * candidate carries the token once through `city`; a place BRANDED with it —
 * "Dilijan Resort & Restaurant" — carries it twice, so tf=2 beat tf=1 and the
 * town's namesakes took the deck. The token cannot discriminate anything: the
 * geography was already applied as coordinates before retrieval ran.
 *
 * Returns null when nothing but the place name was asked — that is a browse
 * ask, and ranking should fall to the prior (rating, popularity, interests)
 * rather than to whoever is named after the town. Kept separate from
 * buildRetrievalQuery because its output also feeds the narration prompt. */
function stripGeoTokens(query, geoTokens = []) {
    const geo = new Set((geoTokens || []).flatMap(t => tokenize(String(t || ''))));
    if (!geo.size) return query || null;
    const kept = tokenize(query || '').filter(t => !geo.has(t));
    return kept.length ? kept.join(' ') : null;
}

module.exports = { effectiveRadiusKm, buildRetrievalQuery, stripGeoTokens, isRightNowAsk, isTransportAsk, isNearbyAsk, isClosestAsk,
    parseAtLocation, parseRadiusKm, parseCorridorAsk, rankingWeights, parseRefillAsk, parseDeckCount, LOCAL_DISCOVERY_CAP_KM };
