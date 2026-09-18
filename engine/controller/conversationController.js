// Jinni V3 — the conversation controller.
//
// FOUNDER DECISION (Arsen, 2026-09-14, V3 doc §12): "We cannot control words
// users will use. AI needs to be smart and code logic to work correctly
// instead of word-like." One state-aware model call decides what the
// traveler MEANT and which lane answers. It replaces, in v3 only: the regex
// fast path, the DeepSeek intent classifier, and the keyword lane rules.
//
// It returns the SAME intent object the lanes already consume (validated by
// intentService.validateIntent — the deterministic brake on the model's JSON)
// PLUS: lane, answers_pending_question, topic_changed, a resolved flights
// object, a clarify question. Code still decides what Jinni is ALLOWED to
// say; this decides what was meant.
//
// FAIL-OPEN: any failure — timeout, bad JSON, API error — falls back to the
// v2 classifier with no lane, so v3 degrades to exactly v2, never worse.

const claudeService = require('../../services/claudeService');
const deepseekProvider = require('../narrator/providers/deepseek');
const intentService = require('../../services/intentService');

const LANES = new Set(['flights', 'transport', 'place_question', 'deck', 'itinerary', 'settings', 'currency', 'destinations', 'chitchat', 'clarify']);
// Founder 2026-09-15: "make all DeepSeek work, no Anthropic one by default".
// DeepSeek decides unless CONTROLLER_PROVIDER=claude is set in the env; the
// model name follows the provider (CONTROLLER_MODEL overrides either).
const CONTROLLER_PROVIDER = (process.env.CONTROLLER_PROVIDER || 'deepseek').toLowerCase() === 'claude' ? 'claude' : 'deepseek';
const CONTROLLER_MODEL = process.env.CONTROLLER_MODEL || (CONTROLLER_PROVIDER === 'claude' ? 'claude-sonnet-5' : (process.env.OPENAI_MODEL || 'deepseek-chat'));
const TIMEOUT_MS = Number(process.env.CONTROLLER_TIMEOUT_MS) || 12000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const SYSTEM_PROMPT =
    'You are the conversation controller of Jinni, a travel assistant. You read the conversation, the '
  + 'traveler\'s date, and the engine\'s own state, and you decide what the CURRENT message means and which '
  + 'lane of the engine should answer it. You never answer the traveler yourself. '
  + 'Reply with ONLY one JSON object. No markdown, no code fences, nothing before or after the JSON.';

const clip = (v, n = 220) => {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** The engine's own facts, as lines the model can lean on. Unknown = absent. */
function stateBlock(state = {}, dateNote = null) {
    const lines = [];
    if (dateNote) lines.push(`Traveler's date: ${dateNote}`);
    if (state.travelerLocation) lines.push(`Where the traveler IS now (GPS or saved location): ${clip(state.travelerLocation, 120)} — the origin of any flight or trip they do not state otherwise`);
    if (state.lastLane) lines.push(`Lane that answered the previous turn: ${state.lastLane}`);
    if (state.lastReply) lines.push(`Jinni's previous reply (server copy; it may end with a question the traveler is now answering): ${clip(state.lastReply, 400)}`);
    if (state.lastFlights?.args) {
        const a = state.lastFlights.args;
        const offers = state.lastFlights.result?.offers || [];
        lines.push(`Fares last fetched (REAL data): ${clip(a.origin)} → ${clip(a.destination)}`
            + `${a.depart_from ? `, ${a.depart_from}..${a.depart_to || a.depart_from}` : (a.depart_date ? `, ${a.depart_date}` : '')}`
            + `; ${offers.length} fare(s)${offers.length ? ': ' + offers.slice(0, 6).map(o => o.label || '').filter(Boolean).join(' | ') : ''}`);
    }
    if (state.activeDestination) lines.push(`Destination in play: ${clip(state.activeDestination, 120)}`);
    if (state.lastDiscussed) lines.push(`Place last discussed: ${clip(state.lastDiscussed, 80)}`);
    if (Array.isArray(state.lastDeck) && state.lastDeck.length) lines.push(`Cards last shown, in order: ${state.lastDeck.map((n, i) => `${i + 1}. ${n}`).join('; ')}`);
    if (state.preferences && typeof state.preferences === 'object') {
        const p = state.preferences;
        const bits = [p.travelStyle && `style=${p.travelStyle}`, Array.isArray(p.interests) && p.interests.length && `interests=${p.interests.join(',')}`].filter(Boolean);
        if (bits.length) lines.push(`Saved preferences: ${bits.join(' · ')}`);
    }
    return lines.length ? lines.join('\n') : '(nothing yet — first turn)';
}

const CONTROLLER_KEYS = `
ENGINE STATE — facts the engine holds. Use them to resolve follow-ups; never contradict them:
{{STATE}}

In ADDITION to the object above, add these keys to the SAME JSON object:
"lane": one of flights | transport | place_question | deck | itinerary | settings | currency | destinations | chitchat | clarify — the lane whose answer is right for THIS message.
  flights = fares between cities, in ANY wording, and EVERY follow-up to fares (dates, a return, a length of stay, the other direction, a complaint about the fares answer).
  transport = getting around or reaching somewhere (taxi, metro, bus, walking, driving, distance, airport transfer).
  place_question = a question about ONE specific place (hours, price, booking, is it open, what is it).
  deck = the traveler wants to be SHOWN places — a list of options to choose from.
  itinerary = build a multi-day plan. settings = change a saved setting. currency = convert an amount of money. destinations = choosing WHERE IN THE WORLD to go (a country/city choice, not venues).
  chitchat = greetings, thanks, meta questions about Jinni, non-travel talk, or a how-to question answered in prose (visa, tipping, SIM card).
  clarify = the message cannot be acted on without ONE detail only the traveler has, AND the conversation and state do not already contain it.
    A VAGUE PLACES ASK is a clarify (founder 2026-09-16: "the AI tries to suggest places, but it could ask what I want specifically"): the traveler wants places but names no KIND of place, no mood and no purpose — "what is open right now", "what can I do", "suggest something", "I'm bored". Dealing six random cards to that is worse than one question. The clarify_question offers THREE concrete choices that fit the hour and the weather ("It's 2 am — are you after food, a drink, or somewhere to walk?"; at 3 pm: food, sights, shopping or something active), in the traveler's language.
    NOT a clarify: the conversation or the saved preferences already show what they want — bars discussed two turns ago and now "what's open?" is a deck for bars; a stated mood ("somewhere quiet", "active mood") or any kind of place ("restaurants", "cafes to eat") is a deck. A refill ("what else", "other ones") continues the previous deck and is never vague.
"answers_pending_question": true when this message answers or reacts to the question Jinni's previous reply ended with ("yes", "no", "4 days", "the second one", "not sure yet"). Such a reply is NEVER chitchat — it belongs to the lane that asked.
"topic_changed": true when the message starts a new topic rather than continuing the previous one.
"flights": null unless lane is flights, else {"origin":"<city>","destination":"<city>","depart_date":"YYYY-MM-DD or YYYY-MM or empty","depart_from":"YYYY-MM-DD or empty","depart_to":"YYYY-MM-DD or empty","return_date":"YYYY-MM-DD or empty","return_from":"YYYY-MM-DD or empty","return_to":"YYYY-MM-DD or empty","stay_days":<number, 0 when not stated>}. Resolve every relative date ("tomorrow", "this week", "in October") from the traveler's date line. Carry origin and destination from the fares last fetched when the message does not restate them; swap them for "back", "return", "the other direction", "vice versa". A return after a stay length = each outbound date plus the stay: give return_from = earliest outbound + stay and return_to = latest outbound + stay.
"clarify_question": "" unless lane is clarify — then ONE short question, in the traveler's language, asking for exactly the missing detail.
"reply_language": the ISO 639-1 code the reply should be written in — the language of the current message; for a bare yes/ok/number, the language of the conversation.

Rules that override everything else:
- A message that answers Jinni's question belongs to the lane that asked it, whatever words it uses.
- Words alone are never evidence: "stay 4 days" is a duration, not a hotel ask; "tickets" after fares is flights; "vice versa" after fares is flights the other way.
- Never invent a place, a date or a detail that is in neither the message, the conversation, nor the state. When it is genuinely missing and needed, lane = clarify.
- Prefer acting over asking: if the state or conversation already holds the detail, use it. A flight with no stated origin departs from where the traveler is now; never clarify the origin when the state names a location.
- When the traveler ANSWERS a clarify question ("food", "a drink", "walk"), that answer IS the ask: lane deck, place_search_query built from it and the hour ("late-night food Yerevan"), answers_pending_question true.
- "thanks", "ok thanks", "great", "bye", "perfect" CLOSE the exchange: lane chitchat, answers_pending_question false — a thank-you is not a yes to Jinni's offer (live 2026-09-14: "ok thanks" dealt six more restaurants). Only a message that actually decides the offer answers it.
- lane deck ONLY when there is something to search for: the message (or the follow-up it continues) names what to show. A deck with nothing to look for is never right.
- "Somewhere to relax / unwind / get away" for a WEEKEND or several days is a getaway: lodging in a calm setting (a resort, spa, countryside or lakeside stay), action_type hotels — not a park or an activity in the city (live 2026-09-18: "somewhere calm to relax for Saturday and Sunday" dealt a zoo and a VR arena). If the setting is open (mountains, lake, spa town), ask which, naming real nearby options.
- The saved travel style is part of every PRICED ask (hotels, restaurants, shops, activities): fold it into place_search_query as a word the search can use — "luxury lakeside hotel Sevan", "budget guesthouse Dilijan" — and when the message itself states a level ("something luxurious", "very cheap") that wins over the saved style. Never fold style into unpriced asks (parks, monuments, viewpoints).
- A place described by KIND rather than name — "near a lake", "by the sea", "in the mountains", "somewhere with hot springs" — is a WHERE, but not yet a where you can search. Never assume it means their own country: a traveler in Yerevan may mean Sevan or Lake Como (founder 2026-09-18: "the traveler may want any location without giving a specific one"). Search only when the conversation or state already shows the area (a destination in play, a country they are planning, "here", "nearby") — then name the real place that fits there in place_names (Armenia + "a lake" = Sevan; that is geography, not invention). Otherwise lane = clarify with ONE question that names the nearest real option first and leaves the world open: "Sevan, an hour from Yerevan — or are you thinking of somewhere abroad?" When a lake, sea or coast is what they chose, put the WATER BODY in place_names ("Lake Sevan", not "Sevan" the town) so the search covers its whole shore. Dealing city hotels to a lakeside ask is never right.
- OUTPUT COMPACTLY: omit every key whose value would be "" / false / 0 / [] / null — an absent key means that default. Always include language, is_travel, action_type, lane, and reply_language.`;

// The v2 intent schema + rules are STATIC, so they live in the system prompt,
// which claudeService marks cacheable: every call after the first reads ~3k
// tokens from cache instead of re-processing them (live 2026-09-14: 4–10 s
// per decision with the schema in the user turn). Sliced from the same
// function v2 uses, so the two can never drift.
const STATIC_SPEC = (() => {
    const full = intentService.buildUserPrompt('', []);
    const i = full.indexOf('Return ONLY this JSON object:');
    return i >= 0 ? full.slice(i) : full;
})();
const STATIC_KEYS = CONTROLLER_KEYS.replace('ENGINE STATE — facts the engine holds. Use them to resolve follow-ups; never contradict them:\n{{STATE}}\n\n', '');

function buildControllerMessages({ message, recentTurns = [], state = {}, dateNote = null } = {}) {
    const convo = Array.isArray(recentTurns) && recentTurns.length
        ? recentTurns.map(t => `${t.sender === 'ai' ? 'Assistant' : 'User'}: ${String(t.text || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
        : '(no previous messages)';
    return {
        system: `${SYSTEM_PROMPT}\n\n${STATIC_SPEC}\n${STATIC_KEYS}`,
        user: `Recent conversation (oldest first, may be empty):\n${convo}\n\n`
            + `Today's date (UTC): ${new Date().toISOString().slice(0, 10)}\n\n`
            + `ENGINE STATE — facts the engine holds. Use them to resolve follow-ups; never contradict them:\n${stateBlock(state, dateNote)}\n\n`
            + `Current user message: """${String(message || '').slice(0, 1000)}"""\n\nReturn the JSON object.`,
    };
}

function extractJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    if (t.includes('```')) {
        const fenced = t.split('```').find(chunk => chunk.includes('{'));
        if (fenced) t = fenced.replace(/^json/i, '');
    }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const day = (v) => (typeof v === 'string' && DAY_RE.test(v.trim()) ? v.trim() : null);
const dayOrMonth = (v) => (typeof v === 'string' && (DAY_RE.test(v.trim()) || MONTH_RE.test(v.trim())) ? v.trim() : null);
const city = (v) => (typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 60 ? v.trim() : null);

/** The model's flights object, shape-checked. Null when it names no route. */
function shapeFlights(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const origin = city(raw.origin), destination = city(raw.destination);
    if (!origin || !destination) return null;
    const stay = Number(raw.stay_days);
    const out = {
        origin, destination,
        depart_date: dayOrMonth(raw.depart_date), depart_from: day(raw.depart_from), depart_to: day(raw.depart_to),
        return_date: day(raw.return_date), return_from: day(raw.return_from), return_to: day(raw.return_to),
        stay_days: Number.isFinite(stay) && stay >= 1 && stay <= 90 ? Math.round(stay) : null,
    };
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    return out;
}

/** Raw model JSON → a decision the route can act on. Null when the intent
 *  part fails validation (the caller then falls back to v2). */
function shapeDecision(raw, message) {
    const intent = intentService.validateIntent(raw, message);
    if (!intent) return null;
    intent.source = 'controller';
    const wanted = (typeof raw.reply_language === 'string' && /^[a-z]{2}$/i.test(raw.reply_language.trim()))
        ? raw.reply_language.trim().toLowerCase() : intent.language;
    // The same deterministic language brake v2 applies: the SCRIPT decides
    // where it is unambiguous; the model's judgement survives where it is not.
    intent.language = intentService.pinLanguage(message, wanted || 'en');
    const laneRaw = String(raw.lane || '').trim().toLowerCase();
    let lane = LANES.has(laneRaw) ? laneRaw : null;
    const clarifyQuestion = lane === 'clarify' && typeof raw.clarify_question === 'string' && raw.clarify_question.trim()
        ? raw.clarify_question.trim().slice(0, 300) : null;
    if (lane === 'clarify' && !clarifyQuestion) lane = null;      // a clarify with no question is no decision
    // A question is not a search: places the model NAMES IN ITS QUESTION
    // ("Sevan, or abroad?") must not become a search destination this turn
    // (live 2026-09-18: they bought a paid lookup and re-centred mid-clarify).
    if (lane === 'clarify') intent.placeNames = [];
    const flights = lane === 'flights' ? shapeFlights(raw.flights) : null;
    // A deck needs something to search for. The model once said "deck" for
    // "ok thanks" with no query, no refill, no category — and six cards
    // followed. Inconsistent with its own JSON → the exchange is closing.
    if (lane === 'deck' && !intent.browse && !intent.refill && !intent.count && !intent.searchQuery
        && intent.actionType === 'general' && !(intent.placeNames || []).length) {
        lane = 'chitchat';
        intent.isTravel = false;
    }
    return {
        intent, lane,
        answersPendingQuestion: raw.answers_pending_question === true,
        topicChanged: raw.topic_changed === true,
        flights, clarifyQuestion,
    };
}

/**
 * Decide one message. Never throws: a failure of any kind becomes a v2
 * classification with lane null, and says so in `source`.
 */
async function decide({ message, recentTurns = [], state = {}, dateNote = null, userLanguage = 'en', appCfg = {} } = {}, deps = {}) {
    const t0 = Date.now();
    const model = deps.model || CONTROLLER_MODEL;
    const provider = deps.provider || CONTROLLER_PROVIDER;
    // Both providers take the same {system, messages} shape: Claude natively,
    // DeepSeek as an OpenAI-style messages array with a leading system turn.
    const complete = deps.complete || (provider === 'claude'
        ? ((args) => claudeService.complete(args))
        : (({ system, messages, model: m, maxTokens }) => deepseekProvider.complete({
            messages: [{ role: 'system', content: system }, ...messages], model: m, maxTokens, temperature: 0,
        })));
    const { system, user } = buildControllerMessages({ message, recentTurns, state, dateNote });
    // The v2 classifier starts NOW, in parallel. If the controller times out
    // or fails, its answer is already there — the traveler never pays for
    // both in sequence (live 2026-09-14: a 12 s timeout, then the fallback).
    const classify = deps.classify || intentService.classify;
    const hedge = classify({ message, recentTurns, userLanguage, appCfg }).catch(() => null);
    let decision = null, error = null;
    try {
        const r = await Promise.race([
            // temperature null: the Claude 5 family refuses the parameter outright.
            complete({ system, messages: [{ role: 'user', content: user }], model, maxTokens: 1400, temperature: null, cacheSystem: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`controller timeout after ${TIMEOUT_MS}ms`)), deps.timeoutMs || TIMEOUT_MS)),
        ]);
        decision = shapeDecision(extractJson(r?.text), message);
        if (!decision) error = `controller JSON unusable: ${String(r?.text || '').slice(0, 120)}`;
    } catch (err) {
        error = err.message;
    }
    if (!decision) {
        console.warn(`[v3] controller failed (${error}) — using the v2 classifier's parallel answer`);
        const intent = (await hedge) || await classify({ message, recentTurns, userLanguage, appCfg });
        return { intent, lane: null, answersPendingQuestion: false, topicChanged: false, flights: null, clarifyQuestion: null, source: 'fallback', model, provider, ms: Date.now() - t0, error };
    }
    return { ...decision, source: 'controller', model, provider, ms: Date.now() - t0, error: null };
}

module.exports = { decide, buildControllerMessages, shapeDecision, shapeFlights, stateBlock, extractJson, LANES, CONTROLLER_MODEL, CONTROLLER_PROVIDER };
