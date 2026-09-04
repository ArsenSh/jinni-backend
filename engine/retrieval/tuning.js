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

/* Radius wording is a CONSTRAINT, not content — it rides the ledger as
 * radiusKm. Left in the query text it poisons the paid search: the fallback
 * POSTed textQuery="restaurants within 500 meters Arinj" and got 1 junk hit
 * (live 2026-09-04, right after meters support shipped). Strips every
 * RADIUS_RES span plus any leftover bare "N unit" pair. */
function stripRadiusPhrase(text) {
    const src = String(text || '');
    let out = src;
    for (const re of RADIUS_RES) out = out.replace(new RegExp(re.source, re.flags + 'g'), ' ');
    out = out.replace(/\b\d{1,4}\s*(km|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?)\b/gi, ' ')
             .replace(/(\d{1,4})\s*(км|километ[а-яё]*|метр[а-яё]*|м|կմ|կիլոմետր[ա-ֆ]*|մետր[ա-ֆ]*|մ)/gi, ' ');
    // "within 2 km of me" — the first pattern eats "within 2 km" and orphans
    // the connector. Only tidied when a radius actually came out, so plain
    // proximity phrasing ("bars around me") stays untouched.
    if (out !== src) out = out.replace(/\b(?:of|from|around) me\b|\bradius\b/gi, ' ');
    return out.replace(/\s{2,}/g, ' ').trim();
}

function buildRetrievalQuery(searchQuery, rawMessage, maxTokens = 8) {
    searchQuery = stripRadiusPhrase(searchQuery);
    rawMessage = stripRadiusPhrase(rawMessage);
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
const TRANSPORT_LATIN_RE = /\b(taxi|cab|uber|careem|bolt|shuttle|metro|subway|underground|tram|bus|ferry|boat|train|flight|flights|fly|airport|scooter|bicycle|car rental|rent a (car|scooter|bike)|how (do|can|should) i (get|reach|travel)|get (there|around)|walk (there|to)|drive (there|to)|directions?|(fastest|quickest|shortest) (route|way)|best route|route (to|there)|how (far|long)( is| does)?|comment (aller|se rendre)|louer une voiture)\b/i;
const TRANSPORT_NONLATIN_RE = /(такси|убер|метро|автобус|маршрут|как добраться|как доехать|как дойти|пешком|паром|электричк|տաքսի|մետրո|ավտոբուս|ինչպես հասնել|ոտքով|métro|出租车|打车|地铁|公交|渡轮|步行|怎么去|怎么走|怎么到|تاكسي|مترو|حافلة|عبّارة|سيرا|كيف أصل|كيف اذهب)/i;
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
const NEARBY_LATIN_RE = /\b(near(by| me| here| my location)?|close (by|to me)|around (me|here)|next to me|pr(e|è)s de moi|(a|à) proximit(e|é)|autour de moi)\b/i;
const NEARBY_NONLATIN_RE = /(рядом со мной|рядом|поблизости|недалеко|около меня|вблизи|неподалеку|неподалёку|մոտակա|մոտակայք|իմ մոտ|մոտս|附近|离我近|我附近|周边|قريب مني|بالقرب مني|القريبة مني)/i;
function isNearbyAsk(message) {
    const m = String(message || '');
    return NEARBY_LATIN_RE.test(m) || NEARBY_NONLATIN_RE.test(m);
}

/* "Walking distance" is a LIMIT, not a re-centre (live 2026-09-03). It used to
 * live inside NEARBY_LATIN_RE, so "Walking distance." after "near Republic
 * Square" flipped the mode to nearby, teleported the centre from the square to
 * the traveler's GPS in Arinj, and every card distance measured from the wrong
 * point. The phrase says HOW FAR, never FROM WHERE — the centre stays wherever
 * the conversation put it and only the radius tightens (aiChatV2 caps it). */
const WALKING_LATIN_RE = /\b(walking distance|within (a )?walk|within walking|a (few|couple) (steps|minutes|min)('|’)?s? (away|walk|from)|(a )?short walk)\b/i;
const WALKING_NONLATIN_RE = /(пешком|пешей доступност\w*|ոտքով|徒歩)/i;
function isWalkingAsk(message) {
    const m = String(message || '');
    return WALKING_LATIN_RE.test(m) || WALKING_NONLATIN_RE.test(m);
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
    // "…near Khor Virap" NAMES a place (live 2026-09-03: "what other results
    // you can suggest near Khor Virap" matched isNearbyAsk on the bare word
    // "near", switched to nearby mode, and answered from the traveler's GPS
    // 40 km away — cocktail bars in Yerevan, described as "your immediate
    // surroundings"). A pronoun after "near" is still an around-me ask and is
    // rejected by the junk filter below.
    /\b(?:near|around|close to|next to|beside)\s+(?:the\s+)?(.{2,48})/i,
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
        if (name.length < 3 || /^(me|us|here|there|home|town|city|my location|my position|our location|current location)$/i.test(name)) continue;
        return name;
    }
    return null;
}

/* 3e. An EXPLICIT radius always wins (live 2026-09-02: "What can I do within
 * 10 km?" ran at r=50km and seated Talin at 45 km, which the narrator then had
 * to apologise for). Miles are converted; the result is clamped so a typo
 * cannot turn a walk into a country-wide sweep. Pure. */
const RADIUS_RES = [
    /\b(?:within|under|less than|no more than|inside|in a|max(?:imum)?)\s+(\d{1,4})\s*(km|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?)\b/i,
    /\b(\d{1,4})\s*(km|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?)\s*(?:radius|around|away|from me|of me)\b/i,
    /(?:в радиусе|не дальше|не более|в пределах)\s+(\d{1,4})\s*(км|километ[а-яё]*|метр[а-яё]*|м)/i,
    /(\d{1,4})\s*(կմ|կիլոմետր[ա-ֆ]*|մետր[ա-ֆ]*|մ)/i,
];
function parseRadiusKm(message) {
    const m = String(message || '');
    for (const re of RADIUS_RES) {
        const hit = re.exec(m);
        if (!hit) continue;
        const n = Number(hit[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        const unit = String(hit[2] || '').toLowerCase();
        // "500 meters" used to fall through entirely and run at 15km (QA §9,
        // 2026-09-04). Order matters: 'mi' starts with 'm'.
        const km = /^mi/.test(unit) ? n * 1.609
            : /^(m$|met|м$|метр|մ$|մետր)/.test(unit) ? n / 1000
            : n;
        if (km < 1) return Math.min(100, Math.max(0.2, Math.round(km * 10) / 10));
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

/* 3f. A BROAD ASK IS NOT A NARROW ONE (founder design, 2026-09-01; live
 * 2026-09-03: "I'm at Khor Virap. What should I visit next?" read as
 * `historical`, and the strict category gate then threw away the traveler's
 * OWN restaurant and hidden gem sitting a few km away — and bought a Google
 * search to replace them).
 *
 * The intent model must still answer with ONE category: it leads the deck, and
 * "what can I do in Dilijan" should open with activities, not a monastery.
 * What is wrong is treating that one guess as an exclusion. When the traveler
 * named no venue type at all, the neighbouring sightseeing categories are
 * admissible too — Arsen's rule: "activities are first but the historical
 * places we can keep, or the national_park and so on".
 *
 * Deliberately narrow:
 *  · only inside the SIGHTSEEING family — asking for food must never widen
 *    into museums, and "hotels" must stay hotels;
 *  · only when the message names no venue type of its own. "What is the
 *    closest monastery?" is a narrow ask and stays narrow.
 * Pure — returns an array (category first) or null. */
const SIGHTSEEING_FAMILY = ['activities', 'historical', 'photo_spots', 'hidden_gems'];
const VENUE_NOUN_RE = new RegExp([
    'restaurant', 'cafe', 'coffee', 'bar', 'pub', 'diner', 'eatery', 'bistro', 'food',
    'hotel', 'hostel', 'guesthouse', 'apartment', 'stay', 'lodging', 'resort',
    'museum', 'monaster', 'vank', 'church', 'cathedral', 'temple', 'mosque', 'shrine',
    'ruin', 'castle', 'fortress', 'monument', 'statue', 'memorial', 'archaeolog',
    'market', 'bazaar', 'mall', 'shop', 'store', 'boutique',
    'park', 'garden', 'lake', 'waterfall', 'canyon', 'cave', 'mountain', 'peak', 'trail',
    'viewpoint', 'panorama', 'photo', 'event', 'festival', 'concert', 'show', 'exhibition',
    'spa', 'club', 'casino', 'cinema', 'theatre', 'theater', 'zoo', 'winery', 'brewery',
].join('|'), 'i');
const VENUE_NOUN_NONLATIN_RE = /(ресторан|кафе|бар|отел|гостиниц|музе|монастыр|церк|храм|крепост|рынок|парк|озер|водопад|каньон|пещер|гор|смотровая|фестивал|концерт|выстав|спа|клуб|кино|театр|ռեստորան|սրճարան|հյուրանոց|թանգարան|վանք|եկեղեց|ամրոց|շուկա|այգի|լիճ|ջրվեժ|քարանձավ|լեռ|փառատոն|համերգ|թատրոն)/i;

function namesVenueType(message) {
    const m = String(message || '');
    return VENUE_NOUN_RE.test(m) || VENUE_NOUN_NONLATIN_RE.test(m);
}

function alsoTypesFor(category, message) {
    if (!category || !SIGHTSEEING_FAMILY.includes(category)) return null;
    if (namesVenueType(message)) return null;
    // Category first: it still leads the deck and the narration.
    return [category, ...SIGHTSEEING_FAMILY.filter(t => t !== category)];
}

/* ── ENTITY QUESTION (QA §6, 2026-09-04) ──
 * "Tell me about the medieval castle next to Republic Square" is a question
 * about ONE claimed thing, not a browse — but the intent model classified 2
 * of 5 such asks as category searches, and the deck path answered a false
 * premise with six unrelated cards (honest prose, dishonest deck). The turns
 * it labeled 'place' were handled perfectly by the tool loop, premise
 * rejection included. This deterministic overlay routes the SHAPE, so the
 * router stops depending on the intent model's mood. Browse markers (best,
 * nearest, plural asks…) keep ordinary discovery out of it. */
const ENTITY_Q_RE = new RegExp('^\\s*(?:'
    + "tell me about|what do you know about|where(?:'s|\u2019s| is)|what time|when (?:does|do|is)"
    + '|how much (?:is|does|do)|is there (?:a|an))\\b', 'i');
// \b is ASCII-only, so the non-latin prefixes get their own boundary-free
// pattern (the NEARBY_*_RE pair set the precedent).
const ENTITY_Q_NONLATIN_RE = /^\s*(?:расскажи(?:те)?(?: мне)? (?:о|про) |где (?:находится|расположен)|сколько стоит |во сколько |когда (?:открывается|закрывается)|պատմիր |որտեղ է )/i;
const BROWSE_MARK_RE = /\b(best|top|good|great|cheapest|cheap|nearest|closest|nearby|near me|around me|some|any|options|ideas|recommend\w*|restaurants|hotels|bars|cafes|museums|places|what (can|should|shall) (i|we) do|things to do|somewhere to go)\b/i;
// \b is ASCII-only — Cyrillic/Armenian markers live boundary-free (repo lesson).
const BROWSE_MARK_NONLATIN_RE = /(где можно|что.{0,12}(делать|посмотреть)|чем заняться|куда (сходить|пойти)|ինչ անել|ուր գնալ)/i;
/* Destination.bestTimeToVisit ("June-August", free text from validators) —
 * parsed leniently: month-name ranges, single months, season words. Anything
 * unparseable returns null and stays NEUTRAL (unknown never ranks down —
 * trust ladder). */
const _MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const _SEASONS = { spring: [3, 5], summer: [6, 8], autumn: [9, 11], fall: [9, 11], winter: [12, 2] };
function parseSeasonWindow(str) {
    const s = String(str || '').toLowerCase().trim();
    if (!s) return null;
    const season = Object.keys(_SEASONS).find(k => s.includes(k));
    if (season) return { start: _SEASONS[season][0], end: _SEASONS[season][1] };
    const ms = [...s.matchAll(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g)].map(m => _MONTHS[m[1]]);
    if (!ms.length) return null;
    return { start: ms[0], end: ms.length > 1 ? ms[ms.length - 1] : ms[0] };
}
/* Dec–Feb wraps the year boundary. */
function inSeason(w, month) {
    if (!w || !month) return true;
    return w.start <= w.end ? (month >= w.start && month <= w.end) : (month >= w.start || month <= w.end);
}

/* "How much is 20,000 AMD in USD?" was answered from MODEL MEMORY at
 * 385-400 AMD/$ while currencyService held the real 364 (live 2026-09-05) —
 * a no-numbers-from-memory violation. Parsed in code, computed from live
 * rates, no LLM. */
const _FX_UNIT_RE = '(usd|eur|amd|rub|gbp|aed|dollars?|euros?|drams?|rubles?|pounds?|dirhams?|доллар\\w*|евро|драм\\w*|рубл\\w*|фунт\\w*|дирхам\\w*|\\$|€|£|֏)';
function _fxCode(w) {
    w = String(w || '').toLowerCase();
    if (w === '$') return 'USD'; if (w === '€') return 'EUR'; if (w === '£') return 'GBP'; if (w === '֏') return 'AMD';
    if (/^(usd|dollar|доллар)/.test(w)) return 'USD';
    if (/^(eur|euro|евро)/.test(w)) return 'EUR';
    if (/^(amd|dram|драм)/.test(w)) return 'AMD';
    if (/^(rub|ruble|рубл)/.test(w)) return 'RUB';
    if (/^(gbp|pound|фунт)/.test(w)) return 'GBP';
    if (/^(aed|dirham|дирхам)/.test(w)) return 'AED';
    return null;
}
function parseCurrencyConvert(message) {
    const m = String(message || '').toLowerCase();
    const amt = new RegExp('(\\d[\\d\\s.,]*)\\s*' + _FX_UNIT_RE, 'u').exec(m);
    if (!amt) return null;
    const rest = m.slice(amt.index + amt[0].length);
    // no \b around Cyrillic (ASCII-only) — anchor on whitespace instead.
    const to = new RegExp('(?:^|\\s)(?:in|to|на|в[оа]?|→)\\s+' + _FX_UNIT_RE, 'u').exec(rest);
    if (!to) return null;
    const from = _fxCode(amt[2]), target = _fxCode(to[1]);
    const amount = parseFloat(String(amt[1]).replace(/[\s,]/g, ''));
    if (!from || !target || from === target || !Number.isFinite(amount) || amount <= 0) return null;
    return { amount, from, to: target };
}

/* "Can you plan 3 day itinerary?" fell into the deck path (q="plan
 * itinerary", lex=0) and served coworking spaces (live 2026-09-05). A
 * day-by-day plan is the ITINERARY tool's job (founder scope §10: itinerary
 * stays on quick actions) — the shape is deterministic. */
// How many days did an itinerary ask state? Digits in any of the six app
// languages ("3 days", "3 jours", "3天", "3 أيام") plus spelled-out numbers
// ("three days", "три дня", "եռօրյա" — Armenian fuses the numeral into one
// word). Returns an int or null; the CALLER clamps to the clarifier's cap.
// No \b near non-Latin scripts (repo lesson — ASCII-only word boundaries).
const _DAYS_DIGIT_RE = /(\d{1,2})\s*[- ]?(?:days?|jours?|дня|дней|день|дн\.|օր|天|يوم|أيام)/i;
const _DAYS_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
    'один': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10,
    'մեկ': 1, 'երկու': 2, 'երեք': 3, 'չորս': 4, 'հինգ': 5, 'վեց': 6, 'յոթ': 7, 'ութ': 8, 'ինը': 9, 'տասը': 10,
};
// Armenian compound "N-day" adjectives and CJK numerals fused to 天.
const _DAYS_FUSED = {
    'երկօրյա': 2, 'եռօրյա': 3, 'քառօրյա': 4, 'հնգօրյա': 5, 'վեցօրյա': 6, 'յոթօրյա': 7, 'ութօրյա': 8,
    '一天': 1, '两天': 2, '二天': 2, '三天': 3, '四天': 4, '五天': 5, '六天': 6, '七天': 7, '八天': 8, '九天': 9, '十天': 10,
};
function parseItineraryDays(message) {
    const m = String(message || '');
    const d = _DAYS_DIGIT_RE.exec(m);
    if (d) { const n = parseInt(d[1], 10); if (n >= 1 && n <= 30) return n; }
    for (const [word, n] of Object.entries(_DAYS_FUSED)) if (m.includes(word)) return n;
    const lower = m.toLowerCase();
    const w = /([a-zа-яё\u0561-\u0587]+)[\s-]+(?:days?|jours?|дня|дней|день|օր\w*)/iu.exec(lower);
    if (w && _DAYS_WORDS[w[1]] != null) return _DAYS_WORDS[w[1]];
    return null;
}

const _IT_LATIN = /\bitinerar|\bitin[eé]rair|\b\d{1,2}\s*[- ]?day (trip|plan|tour|route)|\bplan\b[^.!?]{0,40}\b\d{1,2}\s*days?\b|\bday[- ]by[- ]day\b|\b\d{1,2}\s*jours?\b[^.!?]{0,20}(voyage|plan)|(plan|programme)[^.!?]{0,30}\b\d{1,2}\s*jours?\b/i;
const _IT_NONLATIN = /(маршрут|план)\w*[^.!?]{0,30}\d{1,2}\s*(дня|дней|день)|\d{1,2}[- ]?дневн\w+ (маршрут|план|поездк)|օրվա (ծրագիր|երթուղի)|\d{1,2}\s*օր\w*[^.!?]{0,15}(ծրագիր|երթուղի|ուղևորություն)|行程|\d{1,2}\s*天[^.!?]{0,10}(计划|行程|旅行)|خط سير|برنامج[^.!?]{0,20}\d{1,2}\s*(يوم|أيام)|رحلة[^.!?]{0,15}\d{1,2}\s*(يوم|أيام)/i;
function isItineraryAsk(message) {
    const m = String(message || '');
    return _IT_LATIN.test(m) || _IT_NONLATIN.test(m);
}

/* A browse-marked message wants a DECK — the junk-question brake must never
 * swallow "what can I do", "best bars", "recommend something". */
function isBrowseAsk(message) { const m = String(message || ''); return BROWSE_MARK_RE.test(m) || BROWSE_MARK_NONLATIN_RE.test(m); }

function isEntityQuestion(message) {
    const m = String(message || '');
    return (ENTITY_Q_RE.test(m) || ENTITY_Q_NONLATIN_RE.test(m)) && !BROWSE_MARK_RE.test(m);
}

/* ── REFERENT ASK (QA §7, 2026-09-04) ──
 * "Is it worth it?" was answered "Yes — Victory Park is only 4.1 km away"
 * about places the engine picked ITSELF: the deck path has no "I don't know
 * what you mean" exit (q="worth", lex=0, deck served anyway). A pronoun is a
 * POINTER — resolve it to the most recently shown card, or ask. Pure-pronoun
 * shapes only: a sentence that names a venue noun ("is this restaurant
 * open?") already flows through the named-card machinery. */
const REFERENT_RE = new RegExp('^[\\s"\u0027«»“”’(\\[]*(?:'
    + 'is (?:it|that|this)\\b[^.?!]{0,30}'
    + '|how (?:far|much)[^.?!]{0,6}\\b(?:it|that|this)\\b[^.?!]{0,15}'
    + '|(?:take me to |show me )?the best one'
    + '|is it worth(?: it)?'
    + '|what about (?:this|that)(?: (?:place|one|spot))?'
    + '|how far (?:walking|on foot|by foot)'
    + '|это (?:далеко|дорого|того стоит|стоит того)|сколько это стоит|это открыто'
    + '|արժե\\u055e?)[\\s.?!"\u0027«»“”’)\\]]*$', 'i');
function parseReferentAsk(message) {
    const m = String(message || '').trim();
    if (!m || m.length > 48) return false;
    return REFERENT_RE.test(m) && !namesVenueType(m);
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

module.exports = { effectiveRadiusKm, buildRetrievalQuery, stripGeoTokens, stripRadiusPhrase, isBrowseAsk, parseCurrencyConvert, parseSeasonWindow, inSeason, isItineraryAsk, parseItineraryDays, CHAT_STOPWORDS, isRightNowAsk, isTransportAsk, isNearbyAsk, isWalkingAsk, isClosestAsk,
    parseAtLocation, parseRadiusKm, parseCorridorAsk, alsoTypesFor, namesVenueType, isEntityQuestion, parseReferentAsk, rankingWeights, parseRefillAsk, parseDeckCount, LOCAL_DISCOVERY_CAP_KM };
