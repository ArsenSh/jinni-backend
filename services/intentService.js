// services/intentService.js
//
// ── The intent "pre-pass" ────────────────────────────────────────────────────
// ONE structured call that replaces the pile of per-message guessing that used
// to run at the top of the chat route:
//
//   • translationService.isLikelyEnglish  → sent "Hi"/"Ok"/"Thanks" to Google
//     Translate on every message (word-length heuristic counted zero words).
//   • translationService.extractPlaceNames → treated any capitalized word as a
//     place, so "Hi" fired a Google Places search and could recenter the
//     session onto a random business named "Hi".
//   • translationService.isTravelQuery    → keyword lists; "best way to learn
//     Python" counted as travel (→ reverse-geocode + Distance Matrix spend),
//     while keyword-less follow-ups ("any cheaper ones?") did not.
//   • the detectedActionType regex chain and the weather regex in aiRoutes.
//
// Three tiers — cheapest wins:
//
//   Tier 0  FAST PATH   deterministic, zero cost. Very short messages and
//           common greetings/thanks/acks (in the app's 6 UI languages) return
//           immediately: not travel, no places, no translation, no API calls.
//
//   Tier 1  LLM CALL    one small completion (DeepSeek or Claude — follows the
//           same AppConfig.aiProviderChat toggle the chat itself uses) that
//           returns strict JSON: language, English translation, isTravel,
//           actionType, placeNames, needsWeather. It sees the last few
//           conversation turns, so "any cheaper ones?" after a hotel list is
//           correctly travel/hotels — something no per-message keyword matcher
//           can ever do, because the information isn't in the message.
//
//   Tier 2  FALLBACK    the ORIGINAL keyword/regex logic, preserved verbatim.
//           Runs only when the LLM call errors or exceeds the timeout, so a
//           provider outage degrades to yesterday's behaviour instead of
//           taking chat down.
//
// Every decision is logged on one line ("[intent] source=… travel=… …") so
// classification accuracy is measurable from production logs — misfires become
// grep-able facts instead of anecdotes.

const openai = require('../config/openai');
const claudeService = require('./claudeService');
const translationService = require('./translationService');

let AiProviderDailyStats = null;
try { AiProviderDailyStats = require('../models/AiProviderDailyStats'); } catch (_) { /* stats optional */ }

// DeepSeek non-streaming completions regularly take 3–5s (the whole JSON must
// finish before we get anything), so 3.5s timed out on real traffic and pushed
// good messages onto the keyword fallback. 8s is the ceiling, not the norm —
// typical calls return in 1–3s, especially with the "" -translation shortcut
// below that keeps output tiny for English messages.
const INTENT_TIMEOUT_MS = parseInt(process.env.INTENT_TIMEOUT_MS, 10) || 8000;
const ACTION_TYPES = new Set(['hotels', 'restaurants', 'historical', 'hidden_gems', 'events', 'shopping', 'photo_spots', 'general']);
// Same six sub-types the Shopping quick-action's chips send (proximityService
// SHOPPING_SUBTYPES / googleService._SHOPPING_BASE). Chat has no chips, so the
// classifier picks the sub-type from the message itself — without it a
// "jewelry shop" query had NO correct bucket and fell into hidden_gems or
// general (which un-gates the destination query → the mall/restaurant leaks).
const SHOPPING_SUBTYPES = new Set(['souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food']);

// ── Tier 0: fast path ────────────────────────────────────────────────────────

// Whole-message greetings / thanks / acks in en, ru, fr, hy, ar, zh.
// Matched against the NORMALIZED message (lowercased, punctuation/emoji
// stripped, spaces collapsed) — so "Hi!!", "ok 👍", "Спасибо!" all hit.
const FAST_PATH_PHRASES = new Set([
    // English
    'hi', 'hello', 'hey', 'yo', 'sup', 'whats up', 'what s up', 'ok', 'okay', 'k', 'kk',
    'thanks', 'thank you', 'thanks a lot', 'thank you so much', 'thx', 'ty', 'tnx',
    'yes', 'no', 'yep', 'nope', 'yeah', 'sure', 'cool', 'nice', 'great', 'awesome', 'perfect',
    'good', 'fine', 'lol', 'haha', 'hmm', 'wow', 'bye', 'goodbye', 'see you', 'good night',
    'good morning', 'good evening', 'good afternoon', 'how are you', 'how are you doing',
    // Russian
    'привет', 'здравствуй', 'здравствуйте', 'добрый день', 'доброе утро', 'добрый вечер',
    'спасибо', 'спасибо большое', 'благодарю', 'пока', 'до свидания', 'да', 'нет', 'ок',
    'хорошо', 'отлично', 'класс', 'супер', 'как дела',
    // French
    'salut', 'bonjour', 'bonsoir', 'bonne nuit', 'merci', 'merci beaucoup', 'oui', 'non',
    'ca va', 'au revoir', 'super', 'genial', 'd accord', 'daccord',
    // Armenian
    'բարև', 'բարեւ', 'ողջույն', 'բարի լույս', 'բարի երեկո', 'շնորհակալություն',
    'շնորհակալ եմ', 'մերսի', 'հա', 'այո', 'չէ', 'ոչ', 'լավ', 'ցտեսություն',
    // Arabic
    'مرحبا', 'اهلا', 'أهلا', 'السلام عليكم', 'صباح الخير', 'مساء الخير', 'شكرا', 'شكراً',
    'شكرا جزيلا', 'نعم', 'لا', 'تمام', 'حسنا', 'مع السلامة',
    // Chinese
    '你好', '您好', '嗨', '早上好', '晚上好', '晚安', '谢谢', '谢谢你', '多谢', '好', '好的',
    '是', '不是', '不', '再见', '拜拜'
]);

function normalizeForFastPath(text) {
    return String(text || '')
        .toLowerCase()
        // strip everything that isn't a letter (any script) or whitespace
        .replace(/[^\p{L}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Best-effort language guess from the writing system (fast path / fallback
// only — the LLM tier detects language properly).
function guessLanguageFromScript(text, userLanguage) {
    const t = String(text || '');
    if (/[\u0400-\u04FF]/.test(t)) return 'ru';   // Cyrillic
    if (/[\u0530-\u058F]/.test(t)) return 'hy';   // Armenian
    if (/[\u0600-\u06FF]/.test(t)) return 'ar';   // Arabic
    if (/[\u4E00-\u9FFF]/.test(t)) return 'zh';   // CJK
    return userLanguage || 'en';
}

function fastPath(message, userLanguage) {
    const normalized = normalizeForFastPath(message);
    // ≤ 2 letters ("Hi", "Ok", "Да", "好") or a known whole-message phrase.
    const hit = normalized.length <= 2 || FAST_PATH_PHRASES.has(normalized);
    if (!hit) return null;
    return {
        source: 'fastpath',
        language: guessLanguageFromScript(message, userLanguage),
        translated: String(message || ''),
        isTravel: false,
        actionType: 'general',
        subType: null,
        placeNames: [],
        searchQuery: '',
        needsWeather: false
    };
}

// ── Tier 1: LLM classification ──────────────────────────────────────────────

const SYSTEM_PROMPT =
    'You classify user messages for a travel assistant app. ' +
    'Reply with ONLY one JSON object. No markdown, no code fences, no explanation, nothing before or after the JSON.';

function buildUserPrompt(message, recentTurns) {
    let context = '(no previous messages)';
    if (Array.isArray(recentTurns) && recentTurns.length > 0) {
        context = recentTurns
            .map(t => `${t.sender === 'ai' ? 'Assistant' : 'User'}: ${String(t.text || '').replace(/\s+/g, ' ').slice(0, 300)}`)
            .join('\n');
    }
    return `Recent conversation (oldest first, may be empty):
${context}

Today's date (UTC): ${new Date().toISOString().slice(0, 10)}

Current user message: """${String(message || '').slice(0, 1000)}"""

Return ONLY this JSON object:
{"language":"<ISO 639-1 code of the language the CURRENT message is WRITTEN in — judge only its own words, NOT the conversation's language; 'compare these two' in an otherwise-Russian chat is en>",
"translated":"<the current message translated to English — or an empty string "" if the message is already in English>",
"is_travel":<true or false>,
"action_type":"<one of: hotels, restaurants, historical, hidden_gems, events, shopping, photo_spots, general>",
"shopping_subtype":"<ONLY when action_type is shopping, one of: souvenirs, clothing, market, mall, jewelry, food — otherwise an empty string "">",
"place_names":["<GEOGRAPHIC destination explicitly named in the CURRENT message — a city, town, region, island or country, written in English>"],
"place_search_query":"<a short, clean Google-Maps-style search string for what the user wants, e.g. 'armenian restaurant Dubai' — resolve follow-ups from the conversation ('no, just show me there' after asking about Armenian restaurants in Dubai still yields 'armenian restaurant Dubai'). Empty string when the message is not asking to find places.>",
"when":"<now, planned, or unspecified — 'now' when the user wants something for RIGHT NOW or tonight (going out immediately, 'where can I eat', late-hour context); 'planned' when clearly for another day (tomorrow, next week, a trip); 'unspecified' otherwise>",
"period":"<the TIME PERIOD the message asks about (events/activities): one of today, tomorrow, weekend, next_week, Ndays (e.g. 3days for 'the next 3 days'), or explicit dates as YYYY-MM-DD..YYYY-MM-DD (resolve phrases like 'on September 5' or 'when my parents visit early September' using today's date). Follow-ups INHERIT the conversation's period ('other ones' after a next-week ask is still next_week). Empty string when no period is asked.>",
"refill":<true or false — true when the CURRENT message asks for MORE or OTHER results of the previous ask ("other ones", "another suggestions", "ещё", "d'autres") rather than a new topic>,
"wants_search":<true or false — true ONLY when the user EXPLICITLY asks to search the internet/web/Google for something ("see in internet", "search the web", "поищи в интернете", "погугли")>,
"info_ask":"<empty string "" whenever the traveler wants to be SHOWN PLACES. Otherwise a short lowercase label for the kind of question asked — 'transport' for anything about getting there or getting around (taxi, ride-hailing, metro, bus, walking, driving, car or scooter rental, ferry, flights, airport transfer, 'how far is it', 'which line do I take'), or a label of your own choosing for anything else (visa, tipping, safety, sim_card, currency, packing, booking…).>",
"needs_weather":<true or false>,
"settings_change":[{"field":"<travelStyle|interests|budget|searchMode|nearbyRadius|discoveryRadius>","value":<see below>}]}

Rules:
- is_travel is true when the current message asks about places, food, dining, lodging, attractions, sights, events, activities, shopping, nightlife, directions, or trip planning — OR when it clearly continues such a topic from the conversation (e.g. "any cheaper ones?" right after hotels were shown, "what about near the old town").
- is_travel is false for greetings, thanks, small talk, meta questions about the assistant, and topics unrelated to travel or local places (programming, health, gifts, homework, etc.) — even if words like "best", "suggest" or "recommend" appear.
- action_type describes what the CURRENT message asks for (use the conversation to resolve follow-ups). Use "general" when none clearly fits.
- action_type is "shopping" for any shop, store, boutique, mall, market or bazaar request. shopping_subtype maps: souvenirs & gifts -> souvenirs; clothing, boutiques, fashion, shoes -> clothing; markets & bazaars -> market; malls & department stores -> mall; jewelry, watches, gold (a Rolex store, a jeweler) -> jewelry; gourmet/food/grocery/wine/sweets shops -> food. Use "" only when no sub-type clearly fits.
- action_type is "photo_spots" for viewpoints, panoramas, scenic/instagrammable/photogenic spots and "where to take photos" requests.
- place_names: ONLY geographic destinations (cities, towns, regions, islands, countries) explicitly written in the current message, translated/transliterated to English (e.g. "Ереван" -> "Yerevan"). This INCLUDES elliptical follow-ups whose whole point is the place — "in Dubai", "what about Paris?", "and for Tbilisi?" after a search all mean the CURRENT ask targets that destination, so include it. NEVER put hotel, restaurant, bar or attraction names here — asking about a specific venue is NOT a destination change. Use [] if none. NEVER invent one and NEVER include a place that was only mentioned earlier in the conversation.
- info_ask marks a question that wants an ANSWER, not a deck of place cards ("how do I book a taxi", "can I walk there", "which metro line", "do I need a visa" all want answers; "where can I eat", "suggest rooftop bars" want places). A message can be travel-related AND info_ask — that is normal. Judge by what a GOOD answer looks like: prose, or a list of places? You are not limited to the example labels — name the topic yourself when none fits.
- settings_change: [] on almost every message. Fill it ONLY when the traveler ASKS FOR a saved setting to change ("change my style to budget", "make my interests family", "search 10 km around me"). A POLITE QUESTION IS STILL A COMMAND — "could you change my style to budget?", "can you make my interests family?", "would you make my interests family?", "можешь поставить бюджетный стиль?", "можешь установить текущее местоположение?" all fill settings_change. What decides it is whether the message NAMES A SETTING AND THE VALUE to give it, never the grammar. A question that names NO value is not a change ("can you change my preferences?", "what are my preferences?") — leave settings_change empty for those. Wanting something once is NOT a setting change: "find me a cheap lunch" changes nothing. Values:
    travelStyle   -> "luxury" or "budget".
    interests     -> an array from: family, romantic, nature, adventure, cultural, history, art, food_drink, nightlife, relaxation.
    budget        -> {"min":50,"max":200,"currency":"USD"} (currency one of AED, USD, RUB, EUR, GBP).
                     NAMING AN AMOUNT IS A BUDGET CHANGE AND NOTHING ELSE. "consider 500 usd",
                     "my budget is 50-200", "make it 20 a day" set the figures and leave travelStyle
                     exactly as it is — a luxury traveler stating a number stays luxury. Only add a
                     travelStyle entry when they actually say the STYLE should change.
    searchMode    -> "nearby" (search tight around where they physically are) or "discovery"
                     (search wide around the place they are exploring). This is the Discovery/Nearby
                     toggle beside the chat box: "switch to nearby", "search around me instead",
                     "go back to discovery mode".
    nearbyRadius  -> a number of km, 1-20.  discoveryRadius -> a number of km, 10-100.
  Several at once is fine: "set style to budget and interests to family" is two entries. There is NO location field: a city named in the message is a place to SEARCH (put it in place_names), never a setting to write. This is a COMMAND being carried out, not a question about places — when it is filled, the traveler is not asking to be shown anything.
- needs_weather is true only if answering requires current weather or forecast data (weather, temperature, rain, what to pack, what to wear). It STAYS true for elliptical follow-ups that shift a weather exchange to another place ("what about Dubai?" right after a weather answer) — and put that place in place_names.`;
}

function extractJsonObject(text) {
    if (!text) return null;
    let t = String(text).trim();
    // Strip markdown fences if the model added them anyway.
    if (t.includes('```')) {
        const fenced = t.split('```').find(chunk => chunk.includes('{'));
        if (fenced) t = fenced.replace(/^json/i, '');
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

function validateIntent(raw, message) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.is_travel !== 'boolean') return null;   // minimum viable answer

    const language = (typeof raw.language === 'string' && /^[a-z]{2}$/i.test(raw.language.trim()))
        ? raw.language.trim().toLowerCase()
        : null;

    const translated = (typeof raw.translated === 'string' && raw.translated.trim().length > 0)
        ? raw.translated.trim().slice(0, 2000)
        : String(message || '');

    const actionType = (typeof raw.action_type === 'string' && ACTION_TYPES.has(raw.action_type.trim().toLowerCase()))
        ? raw.action_type.trim().toLowerCase()
        : 'general';

    // Shopping sub-type — only meaningful (and only trusted) on a shopping turn.
    const subType = (actionType === 'shopping'
        && typeof raw.shopping_subtype === 'string'
        && SHOPPING_SUBTYPES.has(raw.shopping_subtype.trim().toLowerCase()))
        ? raw.shopping_subtype.trim().toLowerCase()
        : null;

    let placeNames = [];
    if (Array.isArray(raw.place_names)) {
        const seen = new Set();
        for (const p of raw.place_names) {
            if (typeof p !== 'string') continue;
            const name = p.trim();
            if (name.length < 2 || name.length > 60) continue;
            if (/^\d+$/.test(name)) continue;
            const key = name.toLowerCase();
            if (seen.has(key) || FAST_PATH_PHRASES.has(key)) continue;
            seen.add(key);
            placeNames.push(name);
            if (placeNames.length >= 3) break;   // getCoordinatesForPlace stops at the first hit anyway
        }
    }

    // Temporal intent (additive, 2026-08-22): 'now' | 'planned' | 'unspecified'.
    // v2 uses it to decide whether open-hours filtering applies; v1 ignores it.
    const when = (typeof raw.when === 'string' && ['now', 'planned'].includes(raw.when.trim().toLowerCase()))
        ? raw.when.trim().toLowerCase()
        : 'unspecified';

    // Asked period + refill (additive, 2026-08-23 — Arsen: "ai should
    // understand itself... gas and brake pedals"): the BRAIN names the
    // period/refill; deterministic code validates the format here and does
    // the date math downstream (eventStore.windowFromPeriod). Regex parsers
    // remain only as the LLM-timeout fallback. v1 ignores both fields.
    const period = (typeof raw.period === 'string'
        && /^(today|tomorrow|weekend|next_week|\d{1,2}days|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/
            .test(raw.period.trim().toLowerCase()))
        ? raw.period.trim().toLowerCase()
        : null;
    const refill = raw.refill === true;
    const wantsSearch = raw.wants_search === true;
    // A question that wants an ANSWER, not place cards (additive 2026-08-23,
    // after "I want to book a taxi. How can I do it" was answered with six
    // sightseeing cards).
    //
    // OPEN vocabulary on purpose (Arsen: "maybe it can ask another question we
    // have not imagined yet"). The model may name ANY topic — visa, tipping,
    // safety, sim_card, packing — and code makes exactly one distinction:
    // transport gets the getting-around voice, everything else gets answered
    // conversationally. An unforeseen label therefore degrades to "answer the
    // question", never back to "show six random places", which is the failure
    // this whole change exists to prevent.
    const rawInfo = typeof raw.info_ask === 'string' ? raw.info_ask.trim().toLowerCase().slice(0, 40) : '';
    const isInfo = !!rawInfo && !['none', 'null', 'false', 'places'].includes(rawInfo);
    const infoAsk = !isInfo ? null
        : (/transport|taxi|metro|bus|drive|walk|fly|flight|ferry|ride|getting_around/.test(rawInfo) ? 'transport' : 'how_to');
    // The RAW label survives alongside the folded one. Folding 'visa' into
    // 'how_to' and keeping only that destroyed the one word saying WHICH stored
    // notes answer the question — live 2026-08-23, visa questions were served
    // Yerevan transport notes because the topic was unrecoverable.
    const infoTopic = isInfo ? rawInfo : null;

    return {
        source: 'llm',
        language,
        translated,
        isTravel: raw.is_travel,
        // The engine validates every field again against the preference
        // vocabulary before anything is written; this only shapes it.
        settingsChange: Array.isArray(raw.settings_change)
            ? raw.settings_change
                .filter(c => c && typeof c === 'object' && typeof c.field === 'string')
                .slice(0, 4)
                .map(c => ({ field: c.field.trim(), value: c.value }))
            : [],
        actionType,
        subType,
        placeNames,
        when,
        period,
        refill,
        wantsSearch,
        infoAsk,
        infoTopic,
        // Clean Google-ready search string for the proactive grounding — the LLM
        // resolves follow-ups, so no fragile filler-stripping downstream.
        searchQuery: (typeof raw.place_search_query === 'string' ? raw.place_search_query.trim().slice(0, 120) : ''),
        needsWeather: raw.needs_weather === true
    };
}

async function callLLM(appCfg, message, recentTurns) {
    const userPrompt = buildUserPrompt(message, recentTurns);
    const useClaude = appCfg && appCfg.aiProviderChat === 'claude';
    let text = '';

    if (useClaude) {
        const model = process.env.INTENT_CLAUDE_MODEL || appCfg.claudeModel;
        const result = await claudeService.complete({
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            model,
            maxTokens: 250,
            temperature: 0,
            cacheSystem: true
        });
        text = result && result.text;
    } else {
        const completion = await openai.chat.completions.create({
            model: process.env.INTENT_OPENAI_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0,
            max_tokens: 250
        });
        text = completion && completion.choices && completion.choices[0] && completion.choices[0].message
            ? completion.choices[0].message.content
            : '';
    }

    // Per-provider daily usage, same pattern as chat / quick-action tracking.
    if (AiProviderDailyStats && typeof AiProviderDailyStats.track === 'function') {
        const tokens = Math.ceil(((userPrompt.length || 0) + ((text && text.length) || 0)) / 4);
        AiProviderDailyStats.track(useClaude ? 'claude' : 'deepseek', { tokens, queries: 1, searches: 0, endpoint: 'intent' })
            .catch(err => console.error('AiProviderDailyStats (intent) error:', err.message));
    }

    const parsed = validateIntent(extractJsonObject(text), message);
    if (!parsed) throw new Error('intent JSON parse/validate failed: ' + String(text || '').slice(0, 120));
    return parsed;
}

// ── Tier 2: fallback — the ORIGINAL keyword logic, verbatim ─────────────────
// This is exactly what the chat route did before the pre-pass existed:
// detectAndTranslate (may call Google Translate), extractPlaceNames,
// isTravelQuery, the action-type regex chain, and the weather regex.
// It only runs when the LLM tier errors or times out.

async function fallbackClassify(message, userLanguage) {
    const tr = await translationService.detectAndTranslate(message);
    const processed = (tr && tr.translated) || String(message || '');
    const lower = processed.toLowerCase();

    let actionType = 'general';
    if (/\b(hotel|hotels|accommodation|stay|lodging|inn|resort|guesthouse|hostel)\b/i.test(lower)) { actionType = 'hotels'; }
    else if (/\b(restaurant|restaurants|dining|eat|eatery|diner|cafe|bistro|pub|bar)\b/i.test(lower)) { actionType = 'restaurants'; }
    // Shopping BEFORE the food/historical/hidden-gems catch-alls so "jewelry
    // store", "shopping mall", "souvenir shop" land in shopping, not in
    // hidden_gems/general (the old un-gated fall-through). 'food' moved OUT of
    // the restaurants regex above for the same reason: "food market" is a
    // shopping ask, "where to eat" is the restaurants signal.
    else if (/\b(shop|shops|shopping|store|stores|mall|malls|market|markets|bazaar|bazar|boutique|boutiques|souvenir|souvenirs|jewelry|jewellery|jeweler|jewelery)\b/i.test(lower)) { actionType = 'shopping'; }
    else if (/\b(food|street food|gourmet)\b/i.test(lower)) { actionType = 'restaurants'; }
    else if (/\b(historical|history|ancient|monument|heritage|archaeological|ruins|fortress|castle)\b/i.test(lower)) { actionType = 'historical'; }
    else if (/\b(hidden|secret|local|gems|off the beaten path|lesser known|underrated)\b/i.test(lower)) { actionType = 'hidden_gems'; }
    else if (/\b(event|events|activity|activities|festival|festivals|celebration|concert|concerts|show|shows|performance|exhibition)\b/i.test(lower)) { actionType = 'events'; }
    else if (/\b(photo spot|photo spots|viewpoint|viewpoints|panorama|panoramic|scenic|instagram|instagrammable|photogenic|take photos|take pictures)\b/i.test(lower)) { actionType = 'photo_spots'; }

    // Sub-type guess for shopping (mirrors the quick-action chips).
    let subType = null;
    if (actionType === 'shopping') {
        if (/\b(jewelry|jewellery|jewelery|jeweler|watch|watches|gold|diamond|rolex)\b/i.test(lower)) subType = 'jewelry';
        else if (/\b(mall|malls|department store)\b/i.test(lower)) subType = 'mall';
        else if (/\b(market|markets|bazaar|bazar)\b/i.test(lower)) subType = 'market';
        else if (/\b(cloth|clothing|clothes|boutique|boutiques|fashion|shoe|shoes|dress)\b/i.test(lower)) subType = 'clothing';
        else if (/\b(souvenir|souvenirs|gift|gifts)\b/i.test(lower)) subType = 'souvenirs';
        else if (/\b(grocery|gourmet|deli|candy|chocolate|sweets|wine|liquor|cheese)\b/i.test(lower)) subType = 'food';
    }

    return {
        source: 'fallback',
        language: (tr && tr.isEnglish) ? 'en' : guessLanguageFromScript(message, userLanguage),
        translated: processed,
        isTravel: translationService.isTravelQuery(processed),
        actionType,
        subType,
        placeNames: translationService.extractPlaceNames(processed),
        searchQuery: '',   // fallback tier has no clean query; grounding derives one
        needsWeather: /\b(weather|temperature|rain|snow|hot|cold|climate|forecast|season|sunny|humid|warm|freezing|pack|wear|umbrella|week|daily|tomorrow|days)\b/i.test(processed)
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify one chat message.
 * @param {string}   opts.message      raw user message
 * @param {Array}    opts.recentTurns  [{ sender: 'user'|'ai', text }] — last few turns, oldest first
 * @param {string}   opts.userLanguage user's UI language setting (fallback language guess)
 * @param {object}   opts.appCfg       AppConfig doc (provider toggle + claudeModel)
 * @param {number}   [opts.timeoutMs]  LLM budget before falling back (default INTENT_TIMEOUT_MS)
 * @returns {Promise<{source, language, translated, isTravel, actionType, placeNames, needsWeather}>}
 */
async function classify({ message, recentTurns = [], userLanguage = 'en', appCfg = {}, timeoutMs = INTENT_TIMEOUT_MS }) {
    const started = Date.now();

    // Tier 0
    const fp = fastPath(message, userLanguage);
    if (fp) {
        console.log(`[intent] source=fastpath travel=false action=general lang=${fp.language} ms=0 msg="${String(message).slice(0, 60)}"`);
        return fp;
    }

    // Tier 1 (with hard timeout) → Tier 2
    let result;
    try {
        result = await Promise.race([
            callLLM(appCfg, message, recentTurns),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`intent LLM timeout after ${timeoutMs}ms`)), timeoutMs))
        ]);
    } catch (err) {
        console.warn(`[intent] LLM tier failed (${err.message}) — using keyword fallback`);
        result = await fallbackClassify(message, userLanguage);
    }

    console.log(
        `[intent] source=${result.source} travel=${result.isTravel} action=${result.actionType}` +
        (result.subType ? `/${result.subType}` : '') +
        ` places=${JSON.stringify(result.placeNames)} lang=${result.language} weather=${result.needsWeather}` +
        ` ms=${Date.now() - started} msg="${String(message).replace(/\s+/g, ' ').slice(0, 60)}"`
    );
    return result;
}

// validateIntent exported for tests only — it is the deterministic BRAKE on
// the model's JSON (enum/format checks, open-vocabulary info_ask folding).
// buildUserPrompt is exported for TESTS only. Whether a message is recognised
// as a settings command is decided by an LLM reading this prompt, so it is the
// one step in the chain no unit test can execute — and it is exactly where the
// chain broke live (a polite "can you set…?" read as a question, so nothing was
// ever written). Asserting the RULE still names its cases is the closest thing
// to coverage available, and it stops the wording being trimmed away later.
module.exports = { classify, validateIntent, buildUserPrompt };