// Jinni V2 chat endpoint — parallel to v1's /chat-stream (which stays untouched).
// Mounted beside v1 in server.js; the frontend reaches it only when the
// admin-only "Chat engine" toggle in JinniChat settings selects V2.
//
// CURRENT STATE: honest scaffold. It speaks v1's exact SSE dialect (token /
// complete / stream_end) so JinniChat renders it unchanged, and reports what
// the engine can already do. As engine steps land (see backend/engine/ENGINE.md
// build state), this handler grows into the real tool-loop pipeline — the
// route stays thin per the blueprint (§9.1: routes adapt, the engine computes).

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { usageTracker } = require('../middleware/usageTracker');
const { findPlaces } = require('../engine/retrieval');
const { loadCandidates } = require('../engine/places/canonicalStore');
const { buildTimeContext } = require('../engine/context/contextEngine');
const narrator = require('../engine/narrator');
const { buildGroundedMessages, buildChitchatMessages, buildGettingAroundMessages, buildNoMatchMessages, buildEmptyDeckMessages, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail, buildSettingsMessages } = require('../engine/narrator/prompts/grounded');
const { DelimitedSplitter } = require('../engine/narrator/streamSplit');
const { stripLeadingGreeting, makeGreetingGate, messageGreets } = require('../engine/narrator/greetingStrip');
const { toRecommendation, buildContentParts, hoistNarrated, realignBlurbs } = require('../engine/narrator/cards');
const { effectiveRadiusKm, buildRetrievalQuery, stripGeoTokens, stripRadiusPhrase, isNearbyAsk, isWalkingAsk, isClosestAsk,
    parseAtLocation, parseRadiusKm, parseCorridorAsk, alsoTypesFor, isRightNowAsk, isTransportAsk, rankingWeights, parseRefillAsk, parseDeckCount,
    isEntityQuestion, parseReferentAsk, namesVenueType } = require('../engine/retrieval/tuning');
const { parsePartySize, parseTargetTime, fmtTargetTime, mergeConstraints, ledgerLine } = require('../engine/session/constraints');
const { getWeather, weatherNote } = require('../engine/context/weather');

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LANG_NAMES = { en: 'English', ru: 'Russian', hy: 'Armenian', fr: 'French', ar: 'Arabic', zh: 'Chinese' };

const { recentTurnsFromMessages, shownFromMessages, shownPlaces, lastCardAsk, lastDeckLabels, lastDeckAction, narrowingMatches } = require('../engine/context/session');
const { runToolLoop } = require('../engine/narrator/toolLoop');
const { PLACE_DETAILS_TOOL, FIND_FLIGHTS_TOOL, makeExecutors } = require('../engine/narrator/tools');
const { flightsEnabled } = require('../engine/travel/flights');
const { lookupFacts, topicFor, topicForQuery } = require("../engine/knowledge/sync");
const { resolveRegion } = require('../engine/context/region');
const { resolveDestination } = require('../engine/context/destination');
const { approxIn } = require('../engine/money/price');
const { validateProposal, isAffirmative, isNegative, applyProposal, isExplicit, refusalReason, radiusKmFor, parseBudgetReply } = require('../engine/preferences/proposal');
const { buildToolAnswerMessages } = require('../engine/narrator/prompts/grounded');
const { messageNamesPlace, looseTokenMatch } = require('../engine/places/matching');
const deepseekProvider = require('../engine/narrator/providers/deepseek');
const { loadTaste, dislikeExcludes, recordViews } = require('../engine/personalization/taste');

router.post('/chat-stream-v2', auth, usageTracker, async (req, res) => {
    const { message, location = null, userTimezone = null, nearbyMode = false, sessionId = null } = req.body || {};
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required and must be a string.' });
    }
    if (message.length > 2000) {
        return res.status(400).json({ error: 'Message too long. Maximum 2000 characters allowed.' });
    }

    // ── Session peek (v1's pattern): ownership 403 BEFORE any history reaches
    //    a prompt; last turns for intent/narration; activeDestination fallback;
    //    already-shown places → excludes, so "more hotels" brings new ones. ──
    let sessionPeek = null;
    if (sessionId) {
        sessionPeek = await require('../models/ChatSession')
            .findById(sessionId)
            .select({ userId: 1, activeDestination: 1, pendingPrefChange: 1, constraints: 1, lastDiscussed: 1, messages: { $slice: -30 } })
            .lean()
            .catch(() => null);
        if (sessionPeek && String(sessionPeek.userId) !== String(req.user.id)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this conversation.' });
        }
    }
    const recentTurns = recentTurnsFromMessages(sessionPeek?.messages);
    const shown = shownFromMessages(sessionPeek?.messages);
    // Deterministic greeting-strip (polish 2026-08-31): mid-chat replies kept
    // opening with "Привет! 😊" despite the prompt ban — the opener is now
    // removed in code. Off on the FIRST turn (a greeting there is warmth, not
    // bleed) and off when the traveler's own message greets (echo is natural).
    const greetGateOn = recentTurns.length > 0 && !messageGreets(message);

    // ── Personal taste, one load for the whole turn (grown 2026-08-22 from the
    //    dislikes-only block): likes + saves + cross-session seen history +
    //    dislikes. Dislikes stay EXCLUDES (latest vote per place wins, and the
    //    direct-ask exception holds — a place the user names right now is never
    //    hidden); likes/saves/seen become a soft rank nudge inside retrieval
    //    and honest narrator facts ("you saved this one"). These collections
    //    outlive deleted chat sessions by design. Fail-open: a broken signal
    //    load costs personalization, never the turn. ──
    let taste = null;
    try {
        taste = await loadTaste(req.user.id);
        const ex = dislikeExcludes(taste, message);
        shown.placeIds.push(...ex.placeIds);
        shown.names.push(...ex.names);
    } catch (tasteErr) {
        console.warn('[v2] taste load failed:', tasteErr.message);
    }

    // ── Usage gate (caught 2026-08-22: a whole V2 evening barely moved the
    //    meters — V2 turns were FREE). Parity with v1 aiRoutes ~701: consume an
    //    ESTIMATE before the stream opens (a 429 must still be a JSON response,
    //    and limit-crossing must block the turn), then true up after narration
    //    with the provider's real token counts. usageTracker (fail-closed)
    //    already put req.userLimit here — it was just never charged. ──
    let estimatedTokens = 0;
    let actualTokens = 0;
    let actualSearches = 0;
    // Billable = ALL FOUR usage buckets. Anthropic bills cache read/write
    // tokens too — in+out alone undercounted Claude turns, the same 66×
    // admin-undercount lesson v1 already learned (round 42b).
    const addUsage = (r) => {
        const u = r?.usage;
        if (u) actualTokens += (u.in || 0) + (u.out || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        actualSearches += r?.searchCount || 0;
    };
    try {
        if (req.userLimit) {
            // Self-calibrating pre-charge: the user's OWN observed average
            // per turn (the model keeps statistics.avgTokensPerQuery), not a
            // constant. message+500 under-estimated every real turn ~5×
            // (ChatTurn data, 2026-08-29: est ~505 vs actual ~2,500), so a
            // user crossing their cap got green-lit one expensive turn late.
            // The reservation settles to the turn's REAL cost in the
            // bidirectional true-up below, so this number only decides how
            // conservatively the gate blocks at the boundary.
            const avg = Math.round(req.userLimit.statistics?.avgTokensPerQuery || 0);
            estimatedTokens = avg > 0 ? Math.min(4000, Math.max(800, avg)) : 1200;
            const usageStatus = await req.userLimit.checkAndUpdateUsage(estimatedTokens, 0, 1);
            res.set('X-Usage-Tokens-Used', usageStatus.dailyTokensUsed.toString());
            res.set('X-Usage-Tokens-Remaining', usageStatus.dailyTokensRemaining.toString());
            res.set('X-Usage-Places-Viewed', usageStatus.dailyPlacesViewed.toString());
            res.set('X-Usage-Places-Remaining', usageStatus.dailyPlacesRemaining.toString());
            if (usageStatus.estimatedRequestsRemaining != null) { res.set('X-Usage-Requests-Remaining', usageStatus.estimatedRequestsRemaining.toString()); }
            if (usageStatus.onCooldown) {
                // Diagnostic (founder 2026-08-31: hit "reached your limit"
                // right after delete+re-register) — log WHO tripped it and
                // the doc's numbers so a stale-doc leak is provable from logs.
                console.warn(`[v2][limits] 429 user=${req.user.id} until=${usageStatus.cooldownUntil} tokensUsed=${usageStatus.dailyTokensUsed} tokensRemaining=${usageStatus.dailyTokensRemaining}`);
                return res.status(429).json({ type: 'cooldown', message: 'AI services are on cooldown.', cooldownUntil: usageStatus.cooldownUntil, reason: 'daily_limit_exceeded' });
            }
        }
    } catch (limitError) {
        console.log(`[v2][limits] blocked: ${limitError.message}`);
        return res.status(429).json({ type: 'cooldown', message: limitError.message, cooldownUntil: req.userLimit?.cooldownUntil });
    }

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining',
    });

    // ── V2 build state: RETRIEVAL + NARRATOR v0.
    //    intent (reused v1 service, fail-open) → retrieval over owned data →
    //    GROUNDED narration (may name ONLY retrieved places). Chit-chat skips
    //    retrieval entirely (the "Hi" case). Still honest about limits: no
    //    Google fallback tier, no cards yet, pseudo-streamed prose. ──
    let center = (location && location.lat != null && location.lng != null)
        ? { lat: Number(location.lat), lng: Number(location.lng) } : null;
    // The raw reading, kept because `center` is reassigned to the chosen
    // destination below. "Set my destination to my current location" has to mean
    // the GPS, not whatever the search is centred on — otherwise it would save
    // Dubai back onto itself while the traveler stood in Yerevan.
    const gpsCenter = center;
    // The city THIS turn named, geocoded through Google by resolveDestination.
    // Kept so "change my location, choose Dubai" can be saved as Dubai — the
    // model says which city it meant, never where it is.
    let namedPlace = null;
    let settingsApplied = [];
    let settingsRefused = [];
    // They asked for a budget without naming one. Not a refusal — a question.
    let budgetFiguresWanted = false;
    // `center` is the raw GPS reading and nothing else. The chosen destination
    // used to be folded in here as a fallback, which is what made it LOSE to
    // GPS; resolveDestination now settles the precedence once, below, after
    // intent has told us whether this message names a city.

    // ── An open "shall I change your saved preference?" question is answered
    //    HERE, before anything reads preferences, so an approved change shapes
    //    this very turn. Only an explicit yes writes; a new question, a vague
    //    reply or silence all leave the settings alone. Either way the question
    //    is closed — Jinni asks once (Arsen 2026-08-24). ──
    let prefApplied = null;
    // A budget-style switch parked last turn while Jinni asked for the figures.
    // It is NOT a yes/no question — the answer is a pair of numbers — so it must
    // not be consumed by the consent logic below, and it must survive this block
    // to be completed once the budget lands. Cleared where it is resolved.
    let deferredStyle = null;
    // The Discovery/Nearby toggle as it applies to THIS turn. The body carries
    // what the client had on screen when the message was sent, which is by
    // definition before any switch asked for IN that message. Without this a
    // "switch to nearby" turn would save the new mode and then answer in the
    // old one, and the visible toggle — sitting right beside the input — would
    // be the thing that showed the contradiction.
    let effectiveNearbyMode = nearbyMode;
    const pending = sessionPeek?.pendingPrefChange?.field ? sessionPeek.pendingPrefChange : null;
    const awaitingStyle = (pending?.field === 'travelStyle' && pending.value === 'budget') ? pending : null;
    // A bare "set my budget" parked last turn while Jinni asked for the
    // figures (live 2026-08-29: the question wasn't parked, so "what answer?"
    // hit chit-chat blind and a figures reply would have gone nowhere). Like
    // awaitingStyle it is answered with NUMBERS, never yes/no — the consent
    // logic below must not consume it.
    const awaitingBudget = (pending?.field === 'budget' && !pending.value) ? pending : null;
    if (pending && !awaitingStyle && !awaitingBudget) {
        const said = isAffirmative(message);
        if (said) prefApplied = (await applyProposal(req.user.id, pending)) ? pending : null;
        else if (!isNegative(message)) console.log('[prefs] no clear answer — leaving the setting as it is');
        if (sessionId) {
            require('../models/ChatSession')
                .updateOne({ _id: sessionId }, { $set: { pendingPrefChange: { field: null, value: null, label: null, askedAt: null } } })
                .catch(() => {});
        }
    }

    let reply;
    let recommendations = [];
    const meta = { engine: 'v2', build: 'narrator-v0+cards', timestamp: new Date() };
    const t0 = Date.now();
    // What the engine did this turn. Reported ONCE, at the bottom of the reply
    // (it used to be pasted into the prose, where it read as something Jinni
    // was saying). Filled by whichever branch answers.
    // What the engine did this turn. Reported at the bottom of the reply AND
    // written to ChatTurn — the same facts the [v2] log line prints, but as
    // fields something can aggregate. `path` finally has a reader.
    const stats = {
        candidates: null, cacheHit: false, path: null,
        evidence: 'none', lexical: 0, lexicalTop: 0, lexicalShare: 0,
        vector: false, taste: false, category: null, subType: null,
        mode: null, radiusKm: null, googleCalls: 0, huntFired: false,
    };
    // Spend reported by the store (same optional shape as onStage). Counted
    // here because the route is the only place that knows the whole turn.
    const onSpend = (kind, n = 1) => {
        if (kind === 'google') stats.googleCalls += Number(n) || 0;
        if (kind === 'hunt') stats.huntFired = true;
    };
    // Genie-voiced progress. The traveler waits 8–24s on an event hunt with no
    // sign of life; these say what is happening in Jinni's own voice, not the
    // engine's. Unknown SSE types are ignored by older clients, so this is safe
    // to send unconditionally.
    const stage = (key, text) => { try { send(res, { type: 'stage', key, text }); } catch { /* client gone */ } };
    try {
        // Intent pre-pass — same classifier v1 trusts; failure degrades to
        // "treat it as a place query" rather than failing the turn.
        let intent = null;
        let appCfg = {};
        try {
            const intentService = require('../services/intentService');
            const AppConfig = require('../models/AppConfig');
            // Config + user load in PARALLEL (they were sequential — free ~200-400ms).
            let user = null;
            [appCfg, user] = await Promise.all([
                AppConfig.getConfig().catch(() => ({})),
                require('../models/User').findById(req.user.id).select('settings preferences').lean().catch(() => null),
            ]);
            const userLanguage = user?.settings?.language || 'en';
            intent = await intentService.classify({ message, recentTurns, userLanguage, appCfg });
            intent._userLanguage = userLanguage;
            intent._preferences = user?.preferences || {};
            // Settings Jinni may read and be asked to change: how far it looks
            // in nearby and discovery modes (Arsen 2026-08-24), and whether a
            // position was actually reported this turn — the traveler may have
            // switched location off, and claiming to see it then is a lie.
            intent._preferences._searchRadius = user?.settings?.searchRadius || null;
            intent._savedLocation = user?.settings?.location?.city ? user.settings.location : null;
            // ── A SETTINGS COMMAND IS CARRIED OUT HERE, before retrieval. ──
            //
            // Arsen 2026-08-24: "this kind of commands why it triggers to show
            // locations??? … it only updated interest to family but it
            // recommended locations, it couldnt set to dubai, and have not
            // asked budget to set style."
            //
            // All three symptoms were one cause. A change used to be parsed out
            // of the CARD narration, which meant: the turn had to retrieve
            // places to carry one (so every "set my style" produced six cards),
            // the prose was written from preferences read BEFORE the write (so
            // it reported the old value while saving the new one), and if the
            // narrator simply left the field out — as it did for "set style to
            // budget" — nothing was written at all while the reply still said
            // "done".
            //
            // Now the intent step reports the command, code validates and
            // writes it, and the reply describes what code actually did. No
            // retrieval, no cards, nothing to disagree with.
            settingsApplied = [];
            settingsRefused = [];
            budgetFiguresWanted = false;
            for (let c of (intent.settingsChange || [])) {
                // ── A CURRENCY-ONLY change re-denominates the saved band. ──
                // "now set to usd" after 10–300 RUB carries no figures, so it
                // fell into the ask-for-figures hole — and the "10 to 200"
                // answer then inherited RUB, the currency they were trying to
                // leave (live 2026-08-29). The Preferences form's behavior is
                // the model: switching the currency dropdown keeps the
                // figures. Figures are NEVER converted — "set to usd" means
                // re-label, and inventing an exchange would be a number from
                // nowhere. An UNSUPPORTED currency (AMD, GEL…) keeps its
                // named code here so validateProposal refuses it LOUDLY with
                // the supported list, instead of the old silent abstain that
                // let chit-chat claim it was set.
                if (c.field === 'budget' && c.value?.currency
                    && !(Number(c.value?.min) > 0) && !(Number(c.value?.max) > 0)) {
                    const have = intent._preferences?.budget;
                    if (have && (have.min > 0 || have.max > 0)) {
                        c = { ...c, value: { min: have.min, max: have.max, currency: c.value.currency } };
                    }
                }
                const proposed = validateProposal(c, {
                    currentPlace: null,          // filled below when it is needed
                    namedPlace: null,
                });
                // "set budget" with no numbers in it is a REQUEST, not a bad
                // value. Validation is right to refuse it, but the reply then
                // read "I could not set your budget because the maximum has to
                // be above zero" (live 2026-08-26) — an error message for
                // someone who simply hasn't been asked yet. Only the traveler
                // knows the figures, so ask; never invent them.
                if (c.field === 'budget' && !(Number(c.value?.min) > 0) && !(Number(c.value?.max) > 0)) {
                    budgetFiguresWanted = true;
                    continue;
                }
                if (!proposed) {
                    // A refusal the traveler can act on, written where the
                    // decision is made. "nearbyRadius" alone told them nothing;
                    // refusalReason names the setting and the screen to change it
                    // on — so the reply explains itself with no prompt sentence
                    // about what Jinni cannot do.
                    settingsRefused.push(refusalReason(c.field, c.value));
                    continue;
                }
                // Budget style with no figures is a state the Preferences form
                // will not let anyone save (OnboardingPage isBudgetValid: min >
                // 0, max > 0, min <= max). So the ASK comes first and the switch
                // waits for the answer (Arsen 2026-08-25: "ai should ask minimum
                // and maximum budget initially, then switch to budget").
                // Writing it now would leave the traveler on budget style with a
                // 0–0 band that gates nothing, while the reply said it was done.
                if (proposed.field === 'travelStyle' && proposed.value === 'budget') {
                    const have = intent._preferences?.budget;
                    if (!(have && (have.min > 0 || have.max > 0))) { deferredStyle = proposed; continue; }
                }
                // Whether there WAS a band to drop, read before the write.
                // applyProposal clears preferences.budget whenever the style
                // moves off 'budget' (the Preferences screen does the same), but
                // only this side knows if that cleared anything real — and a
                // reply must never announce a change that did not happen.
                const _hadBudget = !!(intent._preferences?.budget
                    && (intent._preferences.budget.min > 0 || intent._preferences.budget.max > 0));
                if (req.user?.id && await applyProposal(req.user.id, proposed)) {
                    // Switching off budget style DROPS the figures, and the
                    // traveler has to be told: the band gates retrieval, so
                    // losing it silently changes what they are shown with no
                    // visible cause (Arsen 2026-08-26 — "it is not just setting
                    // luxury, it has to also delete minimum and maximum budget").
                    //
                    // The label is amended by CODE, from what the write actually
                    // did. buildSettingsMessages forbids the model from adding
                    // anything not on its lines, which is why no prompt sentence
                    // could have produced this — and why none was added.
                    if (proposed.field === 'travelStyle' && proposed.value !== 'budget' && _hadBudget) {
                        proposed.label += ' (your saved budget range was cleared with it)';
                        // The rest of THIS turn must not keep reading the band we
                        // just deleted — travelerRows would print it back as a
                        // current fact while the reply says it is gone.
                        intent._preferences.budget = { min: 0, max: 0, currency: 'USD' };
                    }
                    settingsApplied.push(proposed);
                    // The reply is written from these rows, so they must show
                    // the NEW value — reporting the old one while having saved
                    // the new one is exactly what went wrong before. The radius
                    // branch that used to sit here went with the radius write
                    // (2026-08-26): only the four registry fields reach this line.
                    intent._preferences[proposed.field] = proposed.value;
                    // Applies immediately: the traveler asked for this mode, so
                    // this answer is already in it.
                    if (proposed.field === 'searchMode') effectiveNearbyMode = proposed.value === 'nearby';
                } else settingsRefused.push(c.field);
            }
            // The figures arrived, so the switch that was waiting on them can
            // happen now — and both are reported in the same breath, which is
            // the order the form uses: fill the budget in, then the style is
            // complete. Jinni asks once, so the slot is released either way.
            if ((awaitingStyle || awaitingBudget) && req.user?.id) {
                // Jinni ASKED for the figures, so the answer arrives as a
                // fragment — "10-200", "50 to 300" — with no verb for the intent
                // model to recognise as a command. It abstained, nothing was
                // written, and the traveler believed they had answered (Arsen
                // 2026-08-26). The brain still decides first; this is the
                // fallback, and it runs ONLY while the question is open, so a
                // stray pair of numbers can never be read as a budget.
                // awaitingBudget (a bare "set my budget" parked last turn)
                // shares the whole path; only the style unshift below is
                // style-switch-specific — the budget-implies-style derivation
                // after this block covers the bare-budget case on its own.
                if (!settingsApplied.some(p2 => p2.field === 'budget')) {
                    // Their existing currency is inherited when they name none —
                    // answering "10-200" is not a change of mind about currency.
                    const guessed = parseBudgetReply(message, intent._preferences?.budget?.currency);
                    const asBudget = guessed ? validateProposal({ field: 'budget', value: guessed }) : null;
                    if (asBudget && await applyProposal(req.user.id, asBudget)) {
                        settingsApplied.push(asBudget);
                        intent._preferences.budget = asBudget.value;
                        console.log(`[prefs] budget read from the answer to our own question: ${asBudget.label}`);
                    } else if (guessed) {
                        // Figures we could read but not store — an unsupported
                        // currency. Say why rather than ignoring the answer.
                        settingsRefused.push(refusalReason('budget', guessed));
                    }
                }
                if (awaitingStyle && settingsApplied.some(p2 => p2.field === 'budget')) {
                    const style = { field: 'travelStyle', value: 'budget', label: 'travel style to budget' };
                    if (await applyProposal(req.user.id, style)) {
                        settingsApplied.unshift(style);
                        intent._preferences.travelStyle = 'budget';
                    }
                } else if (awaitingStyle) console.log('[prefs] budget style still waiting on figures — not switched');
                if (sessionId) {
                    require('../models/ChatSession')
                        .updateOne({ _id: sessionId }, { $set: { pendingPrefChange: { field: null, value: null, label: null, askedAt: null } } })
                        .catch(() => {});
                }
            }
            // ── Setting a budget IS choosing the budget style. ──
            //
            // "set budget 10 to 100" saved the figures and left the style on
            // luxury (live 2026-08-26) — a state the Preferences screen cannot
            // even produce: the min/max inputs only render while budget style is
            // selected, and switching away clears them. A band stored under
            // luxury is invisible to its owner while still gating retrieval,
            // which is the orphaned-figures problem from the other side.
            //
            // The model is NOT asked to infer this. intentService still says an
            // amount is a budget change and nothing else, because "find me
            // something under 50" must never rewrite anyone's style. What makes
            // the derivation safe is that settings_change is filled only for an
            // explicit command, so by this line the traveler has genuinely asked
            // for a budget. Code derives the consequence, exactly as it already
            // derives the clear-on-luxury in applyProposal.
            if (req.user?.id
                && settingsApplied.some(p2 => p2.field === 'budget')
                // A style named IN THIS TURN is their own word and outranks the
                // derivation — "set luxury style" plus figures stays luxury.
                && !settingsApplied.some(p2 => p2.field === 'travelStyle')
                && intent._preferences?.travelStyle !== 'budget') {
                const style = { field: 'travelStyle', value: 'budget', label: 'travel style to budget' };
                if (await applyProposal(req.user.id, style)) {
                    settingsApplied.push(style);
                    intent._preferences.travelStyle = 'budget';
                    console.log('[prefs] budget figures imply the budget style — switched with them');
                }
            }
            intent._preferences._savedLocation = intent._savedLocation;
            intent._preferences._knowsLocation = !!gpsCenter && user?.settings?.privacy?.autoDetectLocation !== false;
            // Already in the request body every turn — it just never reached a
            // prompt. Set after the settings loop, so a mode switched THIS turn
            // is the one described.
            intent._preferences._searchMode = effectiveNearbyMode ? 'nearby' : 'discovery';
            // An approval a moment ago is already true for this turn.
            if (prefApplied) {
                intent._preferences = { ...intent._preferences, [prefApplied.field]: prefApplied.value };
                // A style approved a moment ago took the budget band with it in
                // the database (applyProposal), so this turn must not go on
                // reading the old figures — same rule as the command path above.
                if (prefApplied.field === 'travelStyle' && prefApplied.value !== 'budget') {
                    intent._preferences.budget = { min: 0, max: 0, currency: 'USD' };
                }
            }
        } catch (err) {
            console.warn('[v2] intent failed, treating as place query:', err.message);
            intent = { isTravel: true, actionType: 'general', searchQuery: message, language: 'en', _userLanguage: 'en' };
        }
        // ── Deterministic language brake (founder 2026-08-30: an English
        //    "restaurants in Dilijan" answered in Russian under a Russian
        //    history — twice, with the spec AND a STRICT prompt line both in
        //    place). The message's SCRIPT is computable ground truth; no
        //    model guess may override it. ──
        intent.language = require('../services/intentService')
            .pinLanguage(message, intent.language || intent._userLanguage || 'en');
        const langName = LANG_NAMES[intent.language] || LANG_NAMES[intent._userLanguage] || 'English';
        meta.langUsed = intent.language || intent._userLanguage || null;

        // ── Provider/web-search config, decided up here because the branch
        //    signals below need to know whether web search exists
        //    on this turn. Depends only on appCfg + the intent category. ──
        const providerName = (appCfg.aiProviderChat === 'claude'
            || (Array.isArray(appCfg.claudeChatCategories) && appCfg.claudeChatCategories.includes(intent.actionType))
            || (appCfg.aiEventsUseClaude && intent.actionType === 'events'))
            ? 'claude' : 'deepseek';
        meta.provider = providerName;
        const modelName = providerName === 'claude' ? (appCfg.claudeModel || null) : null;
        const wsActions = Array.isArray(appCfg.claudeWebSearchActionsChat)
            ? appCfg.claudeWebSearchActionsChat : (appCfg.claudeWebSearchActions || []);
        const webSearch = (providerName === 'claude' && appCfg.claudeWebSearch && wsActions.includes(intent.actionType))
            ? {
                maxUses: appCfg.claudeWebSearchMaxUses || 3,
                allowedDomains: appCfg.claudeWebSearchAllowedDomains,
                blockedDomains: appCfg.claudeWebSearchBlockedDomains,
            } : null;
        if (webSearch) meta.webSearch = true;

        // ── Branch signals, decided BEFORE the destination machinery runs. A
        //    QUESTION about a place is not a decision to GO there: "do I need
        //    a visa for UAE" recentred the whole session to the UAE, paid a
        //    Text Search for the geocode, and saved activeDestination=UAE —
        //    so the traveler's NEXT ask would have searched the Emirates from
        //    a Yerevan sofa (live 2026-08-29, Group B battery). Settings
        //    commands and transport/how-to questions never move the centre. ──
        const sessionCards = shownPlaces(sessionPeek?.messages);
        const msgLower = String(message).toLowerCase();
        // A geographic name in the message is never card-name evidence: the
        // intent's placeNames tokens are excluded from the matcher so "Cafe
        // #2 Dilijan" (whose only distinctive token IS the city) can't claim
        // "suggest 6 hotels, all in Dilijan". Category-agnostic by nature.
        const geoTokens = new Set((intent.placeNames || [])
            .flatMap(n => String(n).toLowerCase().split(/\s+/)).filter(Boolean));
        // A fresh DECK ask always beats the shown-card question path: the
        // brain named a category + a place, or an explicit result count —
        // that is a request for new cards, whatever card names are on screen
        // (live 2026-08-30: a count+place hotels ask fell into the tool loop
        // and answered with one hostel's phone number).
        // A REFILL is a deck ask too (live 2026-09-03): "other results?" after
        // "I'm at Khor Virap. What should I visit next?" carried no count and
        // no place of its own, so it fell through to the bridge, which took
        // the PREVIOUS turn's place and answered from the tool loop — prose
        // naming Areni-1 and Noravank out of the model's memory, with no cards
        // and no retrieval behind them. Asking for more results is asking for
        // more CARDS, and only a deck can honestly answer it.
        // Count/refill asks are UNAMBIGUOUSLY deck asks; the placeNames clause
        // below is weaker — "Where is the Armenian Grand Canyon in Yerevan?"
        // carries places=["Yerevan"] as a geo qualifier, and the entity-question
        // overlay must not be blocked by it (live 2026-09-04: the canyon ask
        // stayed on the deck path and padded 3 nightlife cards at 1 AM).
        const countOrRefillAsk = !!intent.count
            || (parseRefillAsk(message).isRefill && sessionCards.length > 0);
        const deckAsk = intent.isTravel && !intent.infoAsk
            && (countOrRefillAsk
                || (intent.actionType && intent.actionType !== 'general' && (intent.placeNames || []).length > 0));
        // MOST-SPECIFIC match wins — the city-token disease's FOURTH home
        // (live 2026-08-31: "how to get to DilijanInn Hotel and Restaurant?"
        // routed to "Dilijan Resort" — .find() took the first any-token match,
        // and with places=[] nothing excluded the city word). Score = how many
        // of the card's own distinctive tokens the message actually contains;
        // ties go to the longer (more specific) name.
        const _bestCardFor = (lower) => sessionCards
            .filter(p => messageNamesPlace(lower, p.name, geoTokens))
            .sort((a, b) => {
                const score = (p) => String(p.name).toLowerCase().split(/[^a-z0-9Ѐ-ӿ԰-֏]+/u)
                    .filter(t => t.length >= 4 && !geoTokens.has(t))
                    .filter(t => looseTokenMatch(lower, t)).length;
                return score(b) - score(a) || String(b.name).length - String(a.name).length;
            })[0];
        // Transport phrasing lifts the deckAsk gate: the intent LLM sometimes
        // labels "how to reach <shown card>?" as a CATEGORY search (live
        // 2026-09-01: '7 visions hotel' → action=hotels → tool-loop, no
        // bridge, while the identical Ararat ask classified general and
        // bridged). A named SHOWN card + transport wording is unambiguous.
        let namedCard = intent.isTravel && (!deckAsk || isTransportAsk(msgLower)) && _bestCardFor(msgLower);
        // Follow-up asks name no place — "can you give a route?" right after
        // "how to reach to republic hotel?" (live 2026-09-01) got a generic
        // transit answer because the bridge only read the CURRENT message.
        // The place lives one user turn back: try the PREVIOUS user message
        // with the same matcher. (sessionPeek already contains the current
        // message — the frontend saves before it fetches — so "previous"
        // is the second-to-last user entry.)
        // Ordinal references — "first restaurant you mentioned" (live
        // 2026-09-01: answered about the WRONG place): resolve against the
        // newest multi-card deck, in deck order. Beats the stale-carry below.
        if (!namedCard && intent.isTravel && !deckAsk) {
            const ORD = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, last: -1, 'первый': 0, 'первого': 0, 'второй': 1, 'третий': 2, 'последний': -1, 'առաջին': 0, 'երկրորդ': 1, 'վերջին': -1 };
            const hit = Object.keys(ORD).find(w => msgLower.includes(w));
            if (hit) {
                for (let i = (sessionPeek?.messages || []).length - 1; i >= 0; i--) {
                    const recs = sessionPeek.messages[i]?.recommendations || [];
                    if (recs.length > 1) {
                        const idx = ORD[hit] === -1 ? recs.length - 1 : ORD[hit];
                        if (recs[idx]) { namedCard = recs[idx]; console.log(`[v2] bridge ordinal: "${hit}" → "${namedCard.name}"`); }
                        break;
                    }
                }
            }
        }
        // Carry is ONLY for referential follow-ups ("can you give a route?").
        // A message that names its OWN subject must never inherit the old one
        // (live 2026-09-01: "how to go to Four seasons hotel in Moscow?"
        // answered with The Club's card carried from the previous turn).
        const _referential = (intent.places || []).length === 0
            && (message.trim().split(/\s+/).length <= 6
                || /\b(it|there|that|this|one|them|туда|там|это|его|её|այնտեղ|այն)\b/i.test(msgLower));
        // "Okay, plan the trip again." carried "Lake Sevan" as a named card
        // into the tool loop, which refused (live 2026-09-04) — a redo ask
        // wants a NEW DECK, not facts about one place.
        const _redoAsk = /\b(again|anew|re-?plan|заново|ещ[её] раз|նորից)\b/i.test(msgLower);
        // "ok, покажи рестораны рядом" is 4 words, so the ≤6-word clause made
        // it "referential" and the bridge carried Blanca into the tool loop —
        // prose about one place instead of the asked deck (live 2026-09-04).
        // Naming a venue type means a NEW browse, never a follow-up pointer.
        if (!namedCard && intent.isTravel && !deckAsk && _referential && !_redoAsk && !namesVenueType(message)) {
            const userTurns = (sessionPeek?.messages || []).filter(m => m?.sender === 'user' && m.text);
            const prev = userTurns.length >= 2 ? userTurns[userTurns.length - 2] : null;
            if (prev) {
                namedCard = _bestCardFor(String(prev.text).toLowerCase()) || false;
                if (namedCard) console.log(`[v2] bridge follow-up: place carried from previous turn ("${namedCard.name}")`);
            }
        }
        // ── "Is it worth it?" — a pronoun is a POINTER (QA §7, 2026-09-04) ──
        // The deck path has no "I don't know what you mean" exit, so a bare
        // referent ask was answered with a deck the engine picked itself
        // (q="worth", lex=0, six cards incl. a coworking space). Resolve the
        // pronoun to the most recent deck's TOP card — the pick the traveler
        // just saw praised — and let the tool loop answer about THAT place.
        // Nothing shown yet -> clarify in one sentence, never a deck.
        let referentClarify = false;
        if (!namedCard && parseReferentAsk(message)) {
            let ref = null, refAt = null;
            for (let i = (sessionPeek?.messages || []).length - 1; i >= 0 && !ref; i--) {
                const m = sessionPeek.messages[i];
                const recs = m?.recommendations || [];
                if (recs.length && recs[0]?.name) { ref = recs[0]; refAt = m.timestamp || null; }
            }
            // A place the tool loop DISCUSSED after that deck outranks the
            // deck's top card: "Is it safe to drive there?" after two turns
            // about Mount Hatis routed and mapped to the Dinosaur Park — the
            // last deck's top — while the prose was about Hatis (QA §12,
            // live 2026-09-04). _bestCardFor recovers the full card (coords,
            // placeId → route map) when the discussed place was ever carded.
            const ld = sessionPeek?.lastDiscussed;
            if (ld?.name && (!refAt || (ld.at && new Date(ld.at) > new Date(refAt)))) {
                namedCard = _bestCardFor(String(ld.name).toLowerCase()) || { name: ld.name };
                console.log(`[v2] referent ask -> "${ld.name}" (last discussed place)`);
            } else if (ref) {
                namedCard = ref;
                console.log(`[v2] referent ask -> "${ref.name}" (last deck's top card)`);
            } else {
                referentClarify = true;
                console.log('[v2] referent ask with nothing shown -> clarify, no deck');
            }
        }
        // A bare name as the whole message ("amar") right after a transport
        // exchange is the traveler ANSWERING "which place?" — it must not
        // fall to chit-chat (live 2026-09-01: intent even misread it as
        // Armenian and denied knowing the address).
        let forceTransport = false;
        if (!namedCard && !deckAsk && message.trim().split(/\s+/).length <= 4) {
            const cand = _bestCardFor(msgLower);
            if (cand) {
                const userTurns2 = (sessionPeek?.messages || []).filter(m => m?.sender === 'user' && m.text);
                const prevU = userTurns2.length >= 2 ? String(userTurns2[userTurns2.length - 2].text).toLowerCase() : '';
                if (isTransportAsk(prevU)) {
                    namedCard = cand;
                    forceTransport = true;
                    console.log(`[v2] bare-name follow-up: "${message.trim()}" → "${namedCard.name}"`);
                }
            }
        }
        const transportAsk = intent.infoAsk === 'transport'
            || (intent.infoAsk === undefined && isTransportAsk(msgLower))
            // Deterministic override: transport wording about a card that is
            // ON SCREEN is a route ask, whatever the intent model guessed
            // (category, place_details, …). Requires BOTH signals, so plain
            // category asks ("hotels near opera") can never trip it.
            || (isTransportAsk(msgLower) && !!namedCard)
            || forceTransport;
        const settingsTurn = !!(settingsApplied.length || settingsRefused.length || deferredStyle || budgetFiguresWanted);
        const infoTurn = !intent.isTravel || intent.infoAsk === 'how_to';
        // "Search the internet for X" is a SEARCH, not a capability quiz
        // (founder reversal 2026-08-30: "truly i dont like that it replies
        // cannot find in the internet… it can search in database silently
        // then in google"). The deck path already IS a live search — owned
        // data first, Google fallback for the rest — so these asks flow into
        // it like any other, and the app never announces a limitation. The
        // old honest no-web reply survives only as the identity rule for
        // pure chit-chat about capabilities.
        // The BRAIN says this is a question about ONE SPECIFIC named place
        // (hours, price, booking — intent spec's 'place' label). Routed to
        // the tool loop regardless of card-name matching: the traveler's
        // spelling never has to match a card ("is toufenkian hotel open
        // tonight?" fell to the deck path and got "you've seen everything",
        // live 2026-08-30) — get_place_details' Google name search resolves
        // typos on its own.
        let placeQuestion = intent.infoAsk === 'place';
        // ── Entity questions route by SHAPE, not by the intent model's mood
        //    (QA §6, 2026-09-04): "tell me about the medieval castle next to
        //    Republic Square" was classified as a historical BROWSE and the
        //    deck path padded a false premise with squares and a monument.
        //    The same night's 'place'-labeled asks (Roman temple, Aragats
        //    museum, Eiffel Tower) were answered perfectly by the tool loop,
        //    premise rejection included. ──
        if (!placeQuestion && !countOrRefillAsk && isEntityQuestion(message)) {
            placeQuestion = true;
            console.log('[v2] entity question -> tool loop (deterministic shape match)');
        }
        // Mirrors the branch chain below: turns that end at transport,
        // settings, place-question, info/chit-chat, or the no-web reply never
        // search places, so the session's centre and activeDestination are
        // not theirs to touch.
        const questionTurn = transportAsk || settingsTurn || placeQuestion || (infoTurn && !namedCard);

        // ── The region the QUESTION is about — for owned-fact lookup ONLY.
        //    Geocodes a named place through the same type-gated resolver, but
        //    the result stays LOCAL to the answer: centre, meta.centreSource
        //    and the session document are never touched by a question. Needed
        //    because lookupFacts matches names verbatim — "UAE" never equals
        //    the stored "United Arab Emirates"; only a geocode bridges the
        //    alias (which is why the old recentring accidentally worked). ──
        const resolveAskedRegion = async () => {
            const ambient = await resolveRegion({ center, placeNames: intent.placeNames });
            if (!(intent.placeNames || []).length) return ambient;
            try {
                const asked = await resolveDestination({
                    placeNames: intent.placeNames, gps: null, sessionDestination: null,
                    savedDestination: null, nearbyMode: false, currentRegion: null,
                }, { findPlaces: (q, near) => require('../services/googleService').findPlaces(q, near) });
                if (asked?.center) {
                    const named = await resolveRegion({ center: asked.center });
                    if (named.city || named.country) {
                        return { city: named.city || asked.city || null, country: named.country, place: ambient.place };
                    }
                }
            } catch (err) {
                console.warn('[v2] asked-region resolve failed, using ambient:', err.message);
            }
            return ambient;
        };

        // ── WHERE we are searching. Until now a chosen destination was only a
        //    fallback for missing GPS, and a city named in the message was
        //    never geocoded at all — so "events in dubai" searched Yerevan and
        //    returned Armenian theatre (live 2026-08-24). v1's precedence,
        //    restored, plus the saved one: nearby → named city → session
        //    destination → Settings destination → GPS. Question/settings
        //    turns skip ALL of it (see questionTurn above) — their branches
        //    take resolveAskedRegion instead. ──
        // ── A FOLLOW-UP CONTINUES THE PREVIOUS ASK'S GEOGRAPHY (2026-09-02) ──
        // Live: "What is the closest monastery?" → "other ones?" came back
        // with restaurants, bars and a shopping centre. Three words say
        // nothing about monasteries, closeness or distance — the ask being
        // continued does. Both are read here, above the centre rules, so
        // "closest" and "within 10 km" survive the follow-up.
        const followUpAsk = (parseRefillAsk(message).isRefill && sessionCards.length)
            ? lastCardAsk(sessionPeek?.messages) : null;
        const geoAsk = followUpAsk ? `${followUpAsk} ${message}` : message;
        // Declared at handler scope: the retrieval call far below ranks by
        // them, and a `const` inside the try block is invisible there.
        let hereRegion = null;
        let statedPosition = null;
        const closestAsk = isClosestAsk(geoAsk) && !(intent.placeNames || []).length;

        try {
            // Resolved once and reused: the destination rules need it, and the
            // prompt needs to NAME it. Telling the model it can see a position
            // without saying which one is what produced "your location is Dubai
            // right now" while the traveler stood in Yerevan (live 2026-08-24).
            // ── DISCOVERY → NEARBY, when they ask for what is around THEM ──
            // The mirror of the nearby→discovery switch below (Arsen's rule:
            // "if user is in discovery and want nearby locations it can switch
            // nearby automatically then make request"). Live 2026-09-01: "what
            // restaurant you can find near me?" ran in discovery at r=15km from
            // the session centre and seated a place 6.9 km out.
            //
            // Only when they named NO place — "restaurants near me in Dilijan"
            // is a Dilijan ask, and a named place always wins — and only when a
            // position was actually reported this turn, because nearby without
            // GPS has nothing to be near. Turn-local, like the other direction.
            // …and not when the message NAMES the place to look near. intent
            // never puts a landmark in placeNames, so "near Khor Virap" looked
            // identical to "near me" until parseAtLocation was asked (live
            // 2026-09-03).
            const statedName = parseAtLocation(message);
            if (!effectiveNearbyMode && gpsCenter && !statedName
                && isNearbyAsk(message) && !(intent.placeNames || []).length) {
                effectiveNearbyMode = true;
                meta.modeSwitched = 'nearby';
                console.log('[destination] discovery -> nearby: they asked for what is around them');
            }
            // ── "I'm at Khor Virap" (2026-09-02) ──
            // The traveler STATING their position. intentService never puts a
            // landmark in placeNames (the rule that stops a restaurant
            // hijacking the centre), so it is parsed here and resolved from the
            // cheapest source that knows it — usually this very conversation.
            // "Closest / nearest X" — a SORT by distance from the traveler, not
            // a 5km limit. It re-centres on their GPS through the same rung the
            // stated position uses, so a stale session centre cannot answer it
            // (live 2026-09-02: "the closest monastery" was answered from a
            // Gyumri left over from an earlier question, and only looked right
            // because that happened to be where they were).
            // Resolved BEFORE the rules that read it: as a `const` below the
            // closest-ask branch it threw "Cannot access 'hereRegion' before
            // initialization" and the whole centre fell back to raw GPS
            // (live 2026-09-02, "other ones?").
            hereRegion = gpsCenter ? await resolveRegion({ center: gpsCenter }) : null;
            const hereLabel = [hereRegion?.city, hereRegion?.country].filter(Boolean).join(', ');
            if (intent._preferences) intent._preferences._here = hereLabel || null;

            if (statedName) {
                statedPosition = await require('../engine/geo/whereAmI').resolveStatedLocation(
                    statedName,
                    { sessionCards, near: gpsCenter },
                    { findPlaces: (q, near) => require('../services/googleService').findPlaces(q, near) },
                ).catch(() => null);
                if (statedPosition) {
                    meta.statedAt = statedPosition.name;
                    console.log(`[destination] stated position "${statedPosition.name}" via ${statedPosition.source}`);
                } else {
                    console.log(`[destination] could not place "${statedName}" — keeping the usual centre`);
                }
            }
            if (!statedPosition && closestAsk && gpsCenter) {
                statedPosition = { lat: gpsCenter.lat, lng: gpsCenter.lng, name: hereRegion?.city || null, source: 'gps' };
                console.log('[destination] closest-ask -> centred on the traveler');
            }
            if (!questionTurn) {
            const dest = await resolveDestination({
                placeNames: intent.placeNames || [],
                gps: center,
                sessionDestination: sessionPeek?.activeDestination || null,
                // The destination chosen in Settings. Without it, choosing
                // Dubai did nothing until the traveler typed "Dubai" out loud.
                // settings.location is the field the Preferences screen shows
                // and the one Jinni now writes; preferences.destination stays
                // as the fallback so accounts set up before this still work.
                savedDestination: intent._savedLocation || intent._preferences?.destination || null,
                nearbyMode: effectiveNearbyMode,
                // Where we are now, so naming it is understood as "here" rather
                // than as a move to its centroid. Same 1km grid cache the
                // search region uses a moment later, so it costs nothing.
                currentRegion: hereRegion,
                // Parsed from "I'm at X" a few lines up. Beaten only by a place
                // named as a destination in the same message.
                statedPosition,
            }, { findPlaces: (q, near) => require('../services/googleService').findPlaces(q, near) });
            meta.centreSource = dest.source;
            // How big the named place IS — country / region / town. The named-
            // town radius cap below is only correct for a TOWN; without this
            // it capped a whole COUNTRY to 15 km around its centroid.
            meta.destScale = dest.scale || 'town';
            meta.destPopulation = dest.population || 0;
            meta.destCountryName = dest.countryName || null;
            // They named somewhere they are not, while the toggle said nearby.
            // The switch applies to THIS turn only — an inferred change never
            // rewrites a saved setting — and the reply says what it did.
            if (dest.switchedFromNearby) {
                effectiveNearbyMode = false;
                meta.modeSwitched = 'discovery';
                meta.modeSwitchedTo = dest.city || null;
            }
            if (dest.center) center = dest.center;
            if (dest.city) meta.searchCity = dest.city;
            if (dest.source === 'named' && dest.center && dest.city) {
                namedPlace = { city: dest.city, country: null, countryCode: '', lat: dest.center.lat, lng: dest.center.lng };
            }
            if (dest.source !== 'gps') {
                console.log(`[v2] centre=${dest.source}${dest.city ? ` "${dest.city}"` : ''} (${center?.lat?.toFixed(3)},${center?.lng?.toFixed(3)})`);
            }
            // Remember a newly named city so the NEXT turn stays there without
            // paying for another geocode (v1's activeDestination contract).
            if (dest.remember && sessionId) {
                require('../models/ChatSession')
                    .updateOne({ _id: sessionId }, { $set: { activeDestination: dest.remember } })
                    .catch(err => console.warn('[v2] activeDestination save failed:', err.message));
            }
            }
        } catch (err) {
            console.warn('[v2] destination resolve failed, keeping GPS centre:', err.message);
        }

        // ── Admin-config parity (Arsen 2026-08-22: "we need create v2 same
        //    way so admin will be able configure if needed"): the SAME
        //    AppConfig knobs that drive v1 drive v2 — aiProviderChat picks
        //    the narrator, claudeWebSearch + claudeWebSearchActionsChat gate
        //    paid web search (a Claude-only server tool; DeepSeek has none),
        //    with the admin's max-uses cap and domain lists. ──
        //    v1's FULL selection rule (aiRoutes ~1595), not just the master
        //    switch: per-category Claude routing + the events override (events
        //    need web search, which DeepSeek lacks). claudeModel honors the
        //    admin's model name.
        // (provider/webSearch + sessionCards / namedCard / transportAsk are
        // decided ABOVE the destination block now — a question must not move
        // the centre.)

        // ── Refill follow-up ("can you give 10 other results?", "ещё") —
        //    caught live 2026-08-22: the intent LLM timed out, the keyword
        //    fallback saw no travel words → chit-chat, no cards. The SESSION
        //    knows what "other results" means: re-run the PREVIOUS ask's query
        //    (this message's own words are junk for retrieval), everything
        //    already shown is excluded, and the asked count is honored. ──
        // The BRAIN decides first (Arsen 2026-08-23: "ai should understand
        // itself... gas and brake pedals"): intent.refill is the LLM's read
        // of the conversation; the regex is the LLM-timeout fallback.
        const refill = parseRefillAsk(message);
        // WHICH ask is being continued is a lookup, not a guess. It used to be
        // "whatever they typed last", so a chit-chat turn in between hijacked
        // the search: "other interesting events please…" ran the query "then if
        // you see what are my preferences" (live 2026-08-24). A follow-up is
        // about the deck on screen, so it can only be the ask that produced one.
        const prevUserAsk = lastCardAsk(sessionPeek?.messages);
        const refillActive = (intent.refill === true || refill.isRefill)
            && !namedCard && sessionCards.length > 0 && !!prevUserAsk;
        if (refillActive) {
            if (!intent.isTravel) intent.isTravel = true;
            if (!intent.searchQuery || (intent.actionType || 'general') === 'general') {
                intent.searchQuery = intent.searchQuery || prevUserAsk;
            }
            // A refill continues the DECK, category included ("give me 10
            // examples" after a hotels deck ran cat=free and served
            // horseriding, live 2026-08-30). The cards on screen say what the
            // deck was — their majority label, mapped back through the ONE
            // category list, restores the action when this turn's own intent
            // is generic.
            if ((intent.actionType || 'general') === 'general') {
                // What the deck WAS, straight from the cards: every rec carries
                // the action it was produced under (_action, persisted with the
                // session). The display label below is the older, lossier path
                // — a monastery cards as "Place of worship", which maps back to
                // no category at all, so "other ones?" after "the closest
                // monastery" ran as a generic browse (live 2026-09-02).
                const deckAction = lastDeckAction(sessionPeek?.messages);
                if (deckAction) intent.actionType = deckAction;
            }
            if ((intent.actionType || 'general') === 'general') {
                const labels = lastDeckLabels(sessionPeek?.messages);
                if (labels.length) {
                    const { CATEGORY_LABELS } = require('../engine/narrator/cards');
                    const byLabel = Object.fromEntries(Object.entries(CATEGORY_LABELS).map(([act, lab]) => [lab, act]));
                    const tally = {};
                    for (const l of labels) { const act = byLabel[l]; if (act) tally[act] = (tally[act] || 0) + 1; }
                    const top = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
                    if (top && top[1] >= labels.length / 2) intent.actionType = top[0];
                }
            }
            meta.refill = true;
            console.log(`[v2] refill → continuing the ask that made the deck: "${String(prevUserAsk).slice(0, 60)}"`);
        }
        // Asked count is honored on ANY deck ask, not refills only (Group C
        // 2026-08-30: fresh "show me 10 hotels" got the default 6 shrunk
        // to 3). Brain first (intent.count), regex fallback second. An
        // explicit count also switches the adaptive shrink off below —
        // they asked for a number, they get it.
        const explicitCount = intent.count
            || (refillActive ? refill.count : parseDeckCount(message)) || null;
        const deckCount = explicitCount ? Math.min(12, Math.max(2, explicitCount)) : 6;

        // "Show on map (please)" is a UI wish about what is ALREADY on screen,
        // not a search (live 2026-08-31: it went to retrieval as q="Show on
        // map please" and served 6 semantically-random places — the relevance
        // brake's blind spot). Deterministic: re-serve the named card (or the
        // newest deck) with its map. No model, no retrieval, no Google.
        const mapAsk = /\b(map|carte|карт\w*|քարտեզ\w*|خريطة|地图)\b/iu.test(msgLower)
            && message.trim().split(/\s+/).length <= 6 && !deckAsk;
        if (mapAsk && sessionCards.length) {
            const target = namedCard || null;
            const MAP_LINES = {
                en: ['Here it is on the map 👇', 'Here they are on the map 👇'],
                ru: ['Вот оно на карте 👇', 'Вот они на карте 👇'],
                hy: ['Ահա քարտեզի վրա 👇', 'Ահա դրանք քարտեզի վրա 👇'],
                fr: ['Le voici sur la carte 👇', 'Les voici sur la carte 👇'],
                zh: ['已经在地图上标好了 👇', '都在地图上标好了 👇'],
                ar: ['ها هو على الخريطة 👇', 'ها هي على الخريطة 👇'],
            };
            const lines = MAP_LINES[String(intent._userLanguage || 'en').slice(0, 2)] || MAP_LINES.en;
            // Cards ride the session's stored payloads — real, already-served
            // data, never parsed from prose (cards-from-retrieval invariant).
            const _normM = (s2) => String(s2 || '').toLowerCase().trim();
            const pool = [];
            for (let i = (sessionPeek?.messages || []).length - 1; i >= 0; i--) {
                for (const r of (sessionPeek.messages[i]?.recommendations || [])) {
                    if (!target) pool.push(r);
                    else if ((target.placeId && r.placeId === target.placeId) || _normM(r.name) === _normM(target.name)) pool.push(r);
                }
                if (pool.length) break;   // newest deck (or first match) only
            }
            send(res, { type: 'token', content: (target && pool.length) ? lines[0] : lines[1] });
            if (pool.length) {
                recommendations = target ? [pool[0]] : pool;
                if (target) meta.routeTo = { placeId: target.placeId || null, name: target.name };
            }
            meta.answerType = 'map_reserve';
            stats.path = 'map';
            console.log(`[v2] map-ask re-served ${recommendations.length} card(s)${target ? ` for "${target.name}"` : ' (newest deck)'}`);
        } else if (transportAsk) {
            const cityLabel = [center?.city, center?.country].filter(Boolean).join(', ') || null;
            const tz = buildTimeContext({ timezone: userTimezone, lng: center?.lng });
            const weather = center ? await getWeather(center.lat, center.lng).catch(() => null) : null;
            // Owned knowledge first (Wikivoyage "Get around" etc.). For a city
            // like Yerevan no transit feed exists anywhere, so these notes are
            // the only real source there is — they outrank model memory.
            const region = await resolveAskedRegion();
            // The RAW topic decides which notes answer this ("which metro" →
            // get_around); this branch falls back to get_around because that
            // is exactly what the branch is for.
            const gaFacts = await lookupFacts({ ...region, topic: topicFor(intent.infoTopic) || 'get_around' });
            const gaMessages = buildGettingAroundMessages({
                message, langName, cityLabel, history: recentTurns,
                destination: namedCard ? { name: namedCard.name } : null,
                timeNote: [tz.isLateNight ? `late night (${String(tz.hour).padStart(2, '0')}:00 local)` : null,
                    weatherNote(weather) || null].filter(Boolean).join('; ') || null,
                canQuoteFares: flightsEnabled(),
                localFacts: gaFacts,
                preferences: intent._preferences,
            });
            if (gaFacts.length) meta.localFacts = gaFacts.map(f => ({ source: f.sourceName, url: f.sourceUrl, topic: f.topic }));
            let toolCalls = 0;
            if (flightsEnabled()) {
                // Flights configured → the model may fetch REAL fares. It
                // decides whether the question needs them; prices in the reply
                // can then only be ones the API returned.
                const loop = await runToolLoop({
                    messages: gaMessages,
                    tools: [FIND_FLIGHTS_TOOL],
                    execute: makeExecutors({ center, requestId: `v2f-${Date.now()}` }),
                    maxTokens: 320,
                }, { provider: deepseekProvider });
                reply = loop.text || 'I couldn\'t verify that just now — ask me again in a moment.';
                toolCalls = loop.toolCalls.length;
                addUsage(loop);
                for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
                    send(res, { type: 'token', content: chunk });
                }
                if (toolCalls) meta.toolCalls = loop.toolCalls.map(c => ({ name: c.name, args: c.args }));
            }
            if (!reply) {
                const out = await narrator.stream({
                    messages: gaMessages,
                    onToken: (c) => send(res, { type: 'token', content: c }),
                    maxTokens: 260,
                    realStream: true,
                    model: providerName,
                    modelName,
                });
                reply = out.text;
                addUsage(out);
            }
            // Chat→map bridge (founder 2026-08-31: "will it trace in map too?"):
            // a transport ask about a place already on a CARD carries routeTo
            // meta — the frontend opens that card's map and runs the exact
            // "Tap for distance" flow (self-hosted OSRM does the tracing).
            if (namedCard) {
                meta.routeTo = { placeId: namedCard.placeId || null, name: namedCard.name };
                // Give the ANSWER its own map (founder 2026-08-31: "it auto
                // expanded old map above, can it give new map? showing see
                // route?"). The full card payload already lives in the
                // session's stored messages — riding it on this reply makes
                // the frontend render a fresh one-card map right under the
                // answer, and the bridge traces the route THERE instead of
                // expanding a deck far up the scroll.
                const _norm = (s2) => String(s2 || '').toLowerCase().trim();
                outer: for (let i = (sessionPeek?.messages || []).length - 1; i >= 0; i--) {
                    for (const r of (sessionPeek.messages[i]?.recommendations || [])) {
                        if ((namedCard.placeId && r.placeId === namedCard.placeId)
                            || _norm(r.name) === _norm(namedCard.name)) {
                            recommendations = [r];
                            break outer;
                        }
                    }
                }
                console.log(`[v2] transport answer routes to shown card "${namedCard.name}"${recommendations.length ? ' (own map attached)' : ''}`);
            }
            meta.answerType = 'getting_around';
            stats.path = 'transport';
            console.log(`[v2] getting-around answered in ${Date.now() - t0}ms src=${intent.infoAsk === 'transport' ? 'llm' : 'regex'} flights=${flightsEnabled() ? `on(${toolCalls} call${toolCalls === 1 ? '' : 's'})` : 'off'} region=${[region.city, region.country].filter(Boolean).join('/') || 'unknown'} facts=${gaFacts.length ? gaFacts.map(f => f.sourceName).join('+') : 'none'}`);
        } else if (settingsApplied.length || settingsRefused.length || deferredStyle || budgetFiguresWanted) {
            // budgetFiguresWanted joined the condition 2026-08-29: a bare "set
            // my budget" (no figures) set the flag but took no branch here —
            // the ask-for-figures reply below could never fire on its own.
            // A COMMAND WAS CARRIED OUT. Nothing was asked for, so nothing is
            // retrieved and no cards are produced (Arsen 2026-08-24: "this kind
            // of commands why it triggers to show locations???").
            //
            // The reply describes what CODE DID — the applied list, not the
            // model's memory of what it proposed. That is the whole point: for
            // "set style to budget" the narrator silently omitted the field, so
            // nothing was written while the reply still said it was done.
            const done = settingsApplied.map(p2 => p2.label);
            const failed = settingsRefused;
            // Budget style with no numbers behind it cannot be used for
            // anything, and only the traveler knows the figures.
            const b = intent._preferences?.budget;
            // Two ways to need the figures: the switch is WAITING on them (this
            // turn asked), or an older account is already on budget style with
            // none. Either way, ask — and never fill them in.
            const awaiting = deferredStyle ? [deferredStyle.label] : [];
            const needsBudget = budgetFiguresWanted
                || !!deferredStyle
                || (settingsApplied.some(p2 => p2.field === 'travelStyle' && p2.value === 'budget')
                    && !(b && (b.min > 0 || b.max > 0)));
            // Park the waiting switch so the next turn's figures can complete
            // it. Without this the traveler answers "10 and 200 usd" and gets a
            // budget saved against the style they were trying to leave.
            if (deferredStyle && sessionId) {
                require('../models/ChatSession')
                    .updateOne({ _id: sessionId }, { $set: { pendingPrefChange: { ...deferredStyle, askedAt: new Date() } } })
                    .catch(() => {});
            } else if (budgetFiguresWanted && !settingsApplied.some(p2 => p2.field === 'budget') && sessionId) {
                // A bare "set my budget" is also a question waiting on figures
                // (live 2026-08-29: it wasn't parked, so the next turn's
                // numbers — or "what answer?" — landed with no memory of it).
                // field 'budget' with a null value = the awaitingBudget marker
                // the next turn's fragment-parser completes.
                require('../models/ChatSession')
                    .updateOne({ _id: sessionId }, { $set: { pendingPrefChange: { field: 'budget', value: null, label: 'your budget range', askedAt: new Date() } } })
                    .catch(() => {});
            }
            const out = await narrator.stream({
                messages: buildSettingsMessages({ message, langName, done, failed, needsBudget, awaiting }),
                onToken: (c) => send(res, { type: 'token', content: c }),
                maxTokens: 120,
                realStream: true,
                model: providerName,
            }, { provider: deepseekProvider });
            reply = out.text || '';
            addUsage(out);
            streamedOk = !!reply;
            meta.answerType = 'settings';
            stats.path = 'settings';
            // `value` rides along so the client can move a CONTROL, not just a
            // label — the Discovery/Nearby toggle sits beside the input and has
            // to flip when Jinni switches it, or the screen contradicts the reply.
            meta.settingsApplied = settingsApplied.map(p2 => ({ field: p2.field, label: p2.label, value: p2.value }));
            if (settingsApplied.length) meta.prefApplied = meta.settingsApplied[0];
            console.log(`[v2] settings: ${done.length ? done.join('; ') : 'nothing applied'}`
                + `${failed.length ? ` | refused: ${failed.join(', ')}` : ''} — no retrieval, no cards`);
        } else if (namedCard || placeQuestion) {
            const loop = await runToolLoop({
                messages: buildToolAnswerMessages({ message, langName, history: recentTurns, preferences: intent._preferences,
                    aboutPlace: (namedCard && namedCard.name) || null }),
                tools: [PLACE_DETAILS_TOOL],
                execute: makeExecutors({ center, sessionPlaces: sessionCards, requestId: `v2-${Date.now()}` }),
                maxTokens: 400,
            }, { provider: deepseekProvider });
            addUsage(loop);
            reply = loop.text || 'I couldn\'t verify that just now — the place\'s card has the details under More.';
            for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
                send(res, { type: 'token', content: chunk });
            }
            stats.path = 'tool';
            meta.toolCalls = loop.toolCalls.map(c => ({ name: c.name, args: c.args }));
            console.log(`[v2] tool-loop "${String(message).slice(0, 50)}" → ${loop.toolCalls.length} call(s) [${loop.toolCalls.map(c => `${c.name}(${c.args?.name || ''})`).join(', ')}] in ${Date.now() - t0}ms iter=${loop.iterations}`);
            // Stamp what this turn DISCUSSED so a later pronoun can point at
            // it (see the referent block above). Fire-and-forget: a failed
            // stamp only costs the pointer, never the reply.
            const _discussed = (namedCard && namedCard.name)
                || loop.toolCalls.find(c => c.name === 'get_place_details')?.args?.name || null;
            if (sessionId && _discussed) {
                require('../models/ChatSession').updateOne(
                    { _id: sessionId },
                    { $set: { lastDiscussed: { name: _discussed, at: new Date() } } },
                ).catch(() => {});
            }
        } else if (!intent.isTravel || intent.infoAsk === 'how_to' || referentClarify) {
            // ── Chit-chat, and now also HOW-TO questions (visas, SIM cards,
            //    tipping): the traveler wants an answer, not a deck. Same
            //    voice, same no-invented-venues rule. ──
            // Visa, safety, SIM cards, tipping: if we OWN a sourced answer for
            // this country, it grounds the reply — the model never generates
            // entry rules from memory (the highest-harm question we get).
            // Only when we actually stock notes for THIS topic — an unstocked
            // question ("what AI works under you") gets no notes rather than
            // whatever happened to be nearest.
            const infoTopicWanted = topicFor(intent.infoTopic);
            const infoFacts = infoTopicWanted
                ? await lookupFacts({
                    ...(await resolveAskedRegion()),
                    topic: infoTopicWanted,
                })
                : [];
            if (infoFacts.length) meta.localFacts = infoFacts.map(f => ({ source: f.sourceName, url: f.sourceUrl, topic: f.topic }));
            const chitGate = makeGreetingGate((c) => send(res, { type: 'token', content: c }), { enabled: greetGateOn });
            const out = await narrator.stream({
                messages: buildChitchatMessages({
                    message: referentClarify
                        ? message + '\n\n[the traveler said "it" but nothing has been shown or discussed yet — ask in ONE short sentence which place they mean; recommend nothing]'
                        : message,
                    langName, history: recentTurns, localFacts: infoFacts, preferences: intent._preferences }),
                onToken: (c) => chitGate.feed(c),
                maxTokens: 200,
                realStream: true,
                model: providerName,
                modelName,
            });
            chitGate.finalize();
            reply = greetGateOn ? stripLeadingGreeting(out.text) : out.text;
            stats.path = 'chitchat';
            addUsage(out);
            console.log(`[v2] ${intent.infoAsk ? `info(${intent.infoAsk})` : 'chit-chat'} narrated in ${Date.now() - t0}ms (${out.usage.in}/${out.usage.out} tok)${infoFacts.length ? ` facts=${infoFacts.map(f => f.sourceName).join('+')}` : ''}`);
        } else if (!center) {
            stats.path = 'no_centre';
            reply = 'I need a location to search — enable GPS or pick a destination, then ask again.';
            send(res, { type: 'token', content: reply });
        } else {
            const timeContext = buildTimeContext({ timezone: userTimezone, lng: center.lng });
            // Weather rides along fail-open: fired here so it resolves in
            // parallel with retrieval + narration setup, awaited only at
            // prompt-build. 10-min cache in the engine → repeat turns free.
            const weatherPromise = getWeather(center.lat, center.lng);
            // Right-now context, decided ONCE: the AI's intent.when is the
            // brain; nearby/late-night/now-words are the degradation path.
            const rightNow = intent.when === 'planned' ? false
                : (intent.when === 'now' || effectiveNearbyMode || timeContext.isLateNight || isRightNowAsk(message));
            const category = intent.actionType && intent.actionType !== 'general' ? intent.actionType : null;
            const mode = effectiveNearbyMode ? 'nearby' : 'discovery';
            // Tuning round: enrich the lossy intent query with the message's
            // distinctive words, and cap dining/shopping radius (local decisions).
            // Refill turns enrich from the PREVIOUS ask — "10 other results"
            // contributes nothing to relevance; "suggest historical places" does.
            let retrievalQuery = buildRetrievalQuery(intent.searchQuery, refillActive ? (prevUserAsk || message) : message);
            // HOW FAR to look is the traveler's setting, not a constant. v2 hard-
            // coded 5/50 km, so the Preferences slider — and every radius Jinni
            // itself wrote — changed nothing at all: the reply said "I've widened
            // your search to 100 km" and the very next search still ran at 50
            // (found 2026-08-26). Same "saved it in his mind only" failure as the
            // prefs write, one layer down.
            //
            // It matters most in the case the setting exists for: a thin deck.
            // Jinni may notice and offer to widen — the Tinder distance slider —
            // and the offer is worthless if the number never reaches the query.
            // _searchRadius carries the value applied THIS turn, so a widening
            // asked for in this very message is already in force below.
            // Bounds and defaults come from proposal.js, which owns them — the
            // same numbers the Preferences slider enforces, stated once.
            const baseRadiusKm = radiusKmFor(mode, intent._preferences?._searchRadius);
            let radiusKm = effectiveRadiusKm({ category, mode, radiusKm: baseRadiusKm });
            // ONE named town is a boundary, not a bare centre (founder
            // 2026-08-30: "hotels in Dilijan" mixed 20-31km regional places
            // into the deck). Cap to the town's scale; the narrator's
            // widen-offer stays the escape hatch. Two+ named places
            // ("Dilijan, Ijevan also") keep the wide radius — the traveler
            // drew the bigger map themselves.
            // …and a REFILL inherits the deck's cap: "find 5 more" after
            // "hotels in Dilijan" arrives with centre=session (nothing named
            // THIS turn), ran at r=50km and seated Tsaghkadzor 25km +
            // Dzoraget 31km again (live 2026-08-31, third sighting). The
            // remembered destination carries singleTown from the ask that set
            // it; multi-town asks remembered singleTown=false and old
            // sessions carry nothing — both keep the wide radius.
            // A place we know the SIZE of sizes its own search (gazetteer,
            // 2026-09-01): the flat 15 km below was too wide for Dilijan
            // (~17k) and far too tight for a metro like Dubai. Only applies
            // to a town named THIS turn — everything else keeps the old path.
            let sizedByPopulation = false;
            if ((meta.destScale || 'town') === 'town' && meta.destPopulation > 0
                && meta.centreSource === 'named'
                && (intent.placeNames || []).length === 1) {
                const { radiusForPopulation } = require('../engine/geo/gazetteer');
                radiusKm = Math.min(radiusKm, radiusForPopulation(meta.destPopulation));
                sizedByPopulation = true;
            }
            // A COUNTRY or a REGION is not a town boundary — capping one to
            // 15 km is what made "best places to visit in Armenia" search a
            // small circle of countryside (analysis 2026-09-01).
            // Live 2026-09-01: Yerevan (pop 1.14M) sized to 20 km and was then
            // immediately re-capped to 15 by this rule. A place we know the size
            // of has already been sized; this is only for places we do not.
            // A STATED POSITION is a person standing on a spot, so it is a
            // boundary too — and it was the one centre this cap never covered
            // (live 2026-09-03: "I'm at Khor Virap. What should I visit next?"
            // answered well in nearby mode and awfully in discovery, because
            // discovery's default radius is 50 km. From Khor Virap that circle
            // swallows Yerevan, 30 km away, and the deck came back full of the
            // capital while the traveler stood in a field in Ararat).
            if (!sizedByPopulation && (meta.destScale || 'town') === 'town' && radiusKm > 15 && (
                (meta.centreSource === 'named' && (intent.placeNames || []).length === 1)
                || meta.centreSource === 'stated'
                || (refillActive && meta.centreSource === 'session'
                    && sessionPeek?.activeDestination?.singleTown === true)
            )) {
                radiusKm = 15;
                if (meta.centreSource === 'stated') {
                    console.log(`[v2] stated position -> ${radiusKm}km (a spot you stand on is not a 50km sweep)`);
                }
            }
            // Events: the asked PERIOD rules the window ("upcoming weekend"
            // ⇒ Sat–Sun, "tonight" ⇒ rest of today — Arsen 2026-08-22; the
            // engine no longer serves a blind next-14-days slice).
            // The asked PERIOD: the intent model NAMES it (period field —
            // handles any phrasing in any language, inherits across
            // follow-ups); eventStore.windowFromPeriod does the clamped date
            // math. The regex parser remains the LLM-timeout fallback, with
            // refill turns inheriting the previous ask's words.
            // ── An EXPLICIT radius always wins (2026-09-02) ──
            // "What can I do within 10 km?" ran at 50 km and seated Talin at
            // 45, which the narrator then had to apologise for. Applied last,
            // so it beats population sizing, the town cap and the mode default.
            const alsoTypes = alsoTypesFor(category, message);
            if (alsoTypes) console.log(`[v2] broad ask -> also ${alsoTypes.slice(1).join(', ')}`);
            // "Walking distance." tightens the radius around the centre the
            // conversation already has — it never re-centres (see tuning.js
            // isWalkingAsk; live 2026-09-03). An explicit "within N km" below
            // still outranks it.
            if (isWalkingAsk(message)) {
                radiusKm = Math.min(radiusKm, 2);
                meta.walkingAsk = true;
                console.log('[v2] walking-distance ask -> radius capped at 2km (a limit, not a re-centre)');
            }
            const askedRadiusKm = parseRadiusKm(geoAsk);
            if (askedRadiusKm) {
                radiusKm = askedRadiusKm;
                meta.radiusAsked = askedRadiusKm;
                console.log(`[v2] explicit radius: ${askedRadiusKm}km`);
            }

            // ── CONSTRAINT LEDGER (QA §4, 2026-09-04) ──
            // "For 4 people tonight at 8." ran at r=15km style=luxury: the
            // walking cap and the `cheaper` from the two previous turns had
            // evaporated, and "Actually make it 9." searched
            // q="restaurant actually make". Constraints are DATA on the
            // session now — each turn contributes only what it explicitly
            // said, everything else carries until changed or the mission
            // (category) changes. engine/session/constraints.js is pure and
            // unit-tests the whole ChatGPT §4 chain.
            const prevLedger = sessionPeek?.constraints || null;
            const _delta = {};
            if (intent.priceDirection) _delta.price = intent.priceDirection;
            if (meta.walkingAsk) _delta.radiusCapKm = 2;
            if (askedRadiusKm) _delta.radiusCapKm = askedRadiusKm;
            const _party = parsePartySize(message);
            if (_party) _delta.partySize = _party;
            const _tt = parseTargetTime(message, {
                prevTargetMin: prevLedger?.targetTime ?? null,
                nowMinutes: timeContext.hour * 60 + timeContext.minute,
            });
            if (_tt != null) _delta.targetTime = _tt;
            const { ledger, changed, reset: ledgerReset } = mergeConstraints(prevLedger, _delta, { category });
            if (ledgerReset) console.log('[ledger] mission changed -> previous constraints cleared');
            // An inherited constraint acts exactly as if said THIS turn.
            if (!intent.priceDirection && ledger.price) {
                intent.priceDirection = ledger.price;
                console.log(`[ledger] price carried: ${ledger.price}`);
            }
            if (ledger.radiusCapKm) radiusKm = Math.min(radiusKm, ledger.radiusCapKm);
            // A modifier-only turn changes ONE thing; the search is the SAME
            // search. Reusing the stored query keeps armenian+republic-square
            // alive through "make it 9".
            const modifierTurn = !!(prevLedger && !ledgerReset && ledger.lastQuery
                && changed.length && !refillActive
                && !(intent.placeNames || []).length && !namesVenueType(message));
            if (modifierTurn) {
                retrievalQuery = ledger.lastQuery;
                console.log(`[ledger] modifier turn -> reusing query "${String(ledger.lastQuery).slice(0, 50)}"`);
            }
            // "tonight at 8" = check hours AT 20:00 — same isOpenAt math the
            // open-now filter uses, different clock. Narration context keeps
            // the REAL timeContext; only retrieval shifts.
            const openAtCtx = ledger.targetTime != null
                ? { ...timeContext, hour: Math.floor(ledger.targetTime / 60), minute: ledger.targetTime % 60 }
                : timeContext;
            console.log(ledgerLine(ledger, changed)
                + (ledger.targetTime != null ? ` — open-at check @ ${fmtTargetTime(ledger.targetTime)}` : ''));

            const _ev = require('../engine/places/eventStore');
            const eventWindow = category === 'events'
                ? (_ev.windowFromPeriod(intent.period)
                    || _ev.parseEventWindow(refillActive ? (prevUserAsk || message) : message))
                : null;
            stage(category === 'events' ? 'events' : 'search',
                category === 'events' ? 'Checking what\'s on around here…' : 'Searching what I know about here…');
            // WHERE we are, by name. The events hunt used to take its city from
            // the events it already held — so a city with no events could never
            // be hunted, and Dubai returned "no listings" in 1.7s without ever
            // looking (live 2026-08-24). Reverse-geocoded once, ~1km grid cache.
            // ── CORRIDOR (2026-09-02) ──
            // "between Yerevan and Dilijan" / "on the way from Yerevan to
            // Tatev" returned central Yerevan — six nightclubs for the Tatev
            // drive — because resolveDestination returns on the FIRST name it
            // resolves. Search several points along the real road instead.
            let corridorCentresList = null;
            // The CONTINUED ask alone — never the concatenation. geoAsk is
            // safe for token tests ("closest", "within 10 km") but corrosive
            // to a capture: "…between Yerevan and Dilijan" + "other results
            // please" made the endpoint "Dilijan other results please", which
            // geocoded to nothing, dropped the corridor, and spent a Google
            // search proving it (live 2026-09-03).
            const corridor = parseCorridorAsk(followUpAsk || message, intent.placeNames || []);
            if (corridor) {
                try {
                    const gz = require('../engine/geo/gazetteer');
                    const gp = (q) => require('../services/googleService').findPlaces(q, gpsCenter || null);
                    const ends = await Promise.all([corridor.from, corridor.to].map(async (n) => {
                        const local = await gz.lookupPlace(n, { near: gpsCenter });
                        if (local) return { lat: local.lat, lng: local.lng, name: local.name };
                        const g = (await gp(n).catch(() => []))[0]?.geometry?.location;
                        return g ? { lat: g.lat, lng: g.lng, name: n } : null;
                    }));
                    if (ends[0] && ends[1]) {
                        corridorCentresList = await require('../engine/geo/corridor')
                            .corridorCentres({ from: ends[0], to: ends[1], samples: 4, radiusKm: 15 });
                        if (corridorCentresList.length) {
                            meta.corridor = { from: ends[0].name, to: ends[1].name, segments: corridorCentresList.length };
                            console.log(`[v2] corridor ${ends[0].name} → ${ends[1].name}: ${corridorCentresList.length} segment(s)`);
                        }
                    }
                } catch (err) {
                    console.warn(`[v2] corridor failed: ${err.message} — answering from the named centre`);
                }
            }

            const searchRegion = await resolveRegion({ center, placeNames: intent.placeNames });
            const findArgs = {
                // Retrieval sees the query WITHOUT the destination name; the
                // narration prompt below still gets the full one.
                query: stripGeoTokens(retrievalQuery, Array.from(geoTokens)),
                eventWindow,
                regionCity: searchRegion.city || meta.searchCity || null,
                regionCountry: searchRegion.country || null,
                // Progress voice — the store calls this when it goes out to the
                // city's listings or to Google, the two waits worth narrating.
                onStage: stage,
                onSpend,
                // Hunt permission rides the SAME admin gate as narration web
                // search: events category enabled + master switch on. The
                // store decides WHEN (unseen shelf thin for the asked window)
                // — unless the user EXPLICITLY ordered a search ("see in
                // internet…", 2026-08-23: that order was ignored). Brain
                // decides (intent.wantsSearch); tiny regex = timeout fallback.
                eventsHunt: (category === 'events' && webSearch) ? {
                    webSearch,
                    force: intent.wantsSearch === true
                        || /\b(internet|web|google|search online)\b|интернет|погугл|поищи в сети|上网|ابحث في الإنترنت|համացանց/i.test(message),
                } : null,
                // Clean intent query only — drives the fallback's "demanded term
                // with zero owned matches" check (the Uzbek lesson); enriched
                // chat tokens must never trigger paid searches.
                // A refill inherits the previous ASK, which is a sentence —
                // and coreQuery is what the paid search sends verbatim ("Give
                // me places between Yerevan and Dilijan" went to Google as
                // typed, live 2026-09-03). The retrieval query is the same ask
                // already reduced to its content words, which is what a search
                // engine can actually use.
                coreQuery: stripRadiusPhrase((modifierTurn
                    ? (ledger.lastCore || intent.searchQuery)
                    : (refillActive ? (retrievalQuery || intent.searchQuery) : intent.searchQuery)) || ''),
                category,
                subType: intent.subType || null,
                center,
                mode,
                radiusKm,
                count: deckCount,
                // Specific asks shrink the deck to match + alternatives
                // (battery fix #2) — but never a refill or an explicit
                // count, where the traveler asked for a number and gets it.
                adaptiveDeck: !refillActive && !explicitCount,
                // A stated count is a promise: a cached pool that cannot
                // fill it counts as a MISS (founder 2026-08-30: "give me 10
                // examples" on a cacheHit delivered 3).
                strictCount: !!explicitCount,
                // City words are WHERE, not WHAT — they must never make the
                // adaptive deck shrink to 3 the way "sushi" rightly does
                // ("hotels in Dilijan" came back 3 cards, 2026-08-30).
                geoTokens: Array.from(geoTokens),
                // Several centres along a route, when the ask is a corridor.
                centres: corridorCentresList,
                // ── BROAD ASK (founder design; live 2026-09-03) ──
                // "I'm at Khor Virap. What should I visit next?" read as
                // `historical`, and every gate — cache actions, Destination
                // type, Business type, the Google type check — then discarded
                // the traveler's OWN restaurant and hidden gem a few km away,
                // and paid Google to replace them with strangers. The category
                // still LEADS; it just stops being an exclusion when the
                // message named no venue type at all.
                alsoTypes,
                // A COUNTRY ask is scoped BY COUNTRY, not by any circle
                // (Arsen 2026-09-01). Falls back to the resolved place name
                // when the gazetteer had no country name to give.
                countryScope: meta.destScale === 'country'
                    ? (meta.destCountryName || meta.searchCity || null) : null,
                timeContext: openAtCtx,
                // Arsen's rules: right-now context → check hours; otherwise
                // pass. And the AI decides — intent.when is the brain ('now' /
                // 'planned' / 'unspecified'); nearby/late-night/now-words are
                // the degradation path when it abstains. An explicit 'planned'
                // ALWAYS skips the filter. Unknown hours survive regardless.
                enforceOpenNow: rightNow || ledger.targetTime != null,
                // The ask's nature shifts what evidence matters: right-now →
                // proximity up; romantic/special → quality prior up.
                weights: rankingWeights({ rightNow, message,
                    // "closest/nearest" is a SORT, not a limit — it ranks by
                    // distance from the traveler without shrinking the radius,
                    // so the one real monastery at 9.4km is not thrown away.
                    nearbyMode: effectiveNearbyMode || closestAsk,
                    countryScope: meta.destScale === 'country' }),
                // "Any cheaper ones?" beats the saved luxury style FOR THIS
                // TURN only — the ask outranks the profile without rewriting
                // it (Group C 2026-08-30: a cheap-hotels turn ranked with
                // style=luxury and even carded the Radisson). The override
                // rides the existing tier machinery: cache-tier mismatch
                // skip, tier scoring, proximity style gating.
                preferences: intent.priceDirection
                    ? { ...(intent._preferences || {}), travelStyle: intent.priceDirection === 'cheaper' ? 'budget' : 'luxury' }
                    : (intent._preferences || {}),        // tier gates + pref scoring in the store
                // Likes/saves climb, oft-seen-unacted sinks — a nudge on the
                // fused order, never a filter (personalization/taste.js).
                taste,
                excludes: shown,          // already shown this session → follow-ups get NEW places
            };
            let result = await findPlaces(findArgs, { loadCandidates });
            // ── NARROWING, not asking for more (live 2026-08-31): "in Dilijan
            //    please" after a deck mixing in-town and regional hotels got
            //    "you've seen everything" — true, and useless. A turn that
            //    NAMES a town and comes back all_filtered is the traveler
            //    organizing what they saw, not requesting novelty — so the
            //    already-shown places are exactly the right answer. Re-run
            //    once without the session excludes; the named-town 15km cap
            //    above scopes the deck to the town. Refills ("other ones")
            //    keep their excludes and stay on the honest-empty path. ──
            if (!result.places.length && ['all_filtered', 'no_candidates'].includes(result.reason)
                && sessionCards.length) {
                const townNarrowing = result.reason === 'all_filtered'
                    && meta.centreSource === 'named' && (intent.placeNames || []).length && !refillActive;
                // SUBTYPE narrowing (live 2026-08-31): "villas please" after a
                // mixed deck got "found nothing" while two SHOWN cards were
                // villas — the intent LLM had even tagged the turn refill. A
                // message token naming something already on screen is
                // narrowing, whatever the intent said. parseRefillAsk's own
                // regex on THIS message keeps real more-asks ("more villas")
                // honest; city words and the deck's category noun never count
                // (so an exhausted "more hotels in Dilijan" stays exhausted).
                const subsetTokens = (!townNarrowing && !parseRefillAsk(message).isRefill)
                    ? narrowingMatches(message, shown.names, { excludeTokens: [...geoTokens, category || ''] })
                    : [];
                if (townNarrowing || subsetTokens.length) {
                    const rerun = await findPlaces({ ...findArgs, excludes: {} }, { loadCandidates });
                    if (rerun.places.length) {
                        result = rerun;
                        meta.reServed = true;
                        console.log(`[v2] narrowing ask re-serves ${rerun.places.length} shown place(s) (${townNarrowing ? 'named town' : `matched: ${subsetTokens.join(',')}`})`);
                    }
                }
            }
            meta.provenance = result.provenance;
            // Every branch below this point shares these, including the two
            // that ship no cards — a turn that found nothing is the one most
            // worth counting.
            stats.category = category;
            stats.subType = intent.subType || null;
            stats.mode = mode;
            stats.radiusKm = radiusKm;
            stats.lexical = result.provenance.lexical || 0;
            stats.lexicalTop = result.provenance.lexicalTop || 0;
            stats.lexicalShare = result.provenance.lexicalShare || 0;
            stats.vector = !!result.provenance.vector;
            stats.taste = !!result.provenance.taste;
            stats.evidence = [category ? 'category' : null, result.provenance.lexical ? 'text' : null]
                .filter(Boolean).join('+') || 'none';
            if (result.degraded || !result.places.length) stats.path = 'empty';
            if (result.degraded || !result.places.length) {
                // Honest empty, split by CAUSE and spoken in the traveler's
                // language (Dilijan 23:21, 2026-08-30: an Armenian ask got a
                // hardcoded-English "you've seen everything" when the truth
                // was "everything here is closed right now").
                //   all_closed   = open-now filter emptied the deck — offer
                //                  "for tomorrow" (intent.when='planned'
                //                  already skips the filter next turn).
                //   all_filtered = everything real was already shown.
                //   otherwise    = every source genuinely came up dry.
                const cause = result.reason === 'all_closed' ? 'all_closed'
                    : result.reason === 'all_filtered' ? 'all_filtered' : 'empty';
                meta.emptyCause = cause;
                // Name the city we actually searched. "this area" let a Dubai
                // ask read as if it had been answered about Dubai when the
                // search had run somewhere else entirely (live 2026-08-24).
                const emptyCity = meta.searchCity
                    || [center?.city, center?.country].filter(Boolean).join(', ') || null;
                const where = emptyCity ? ` in ${emptyCity}` : ' for this area';
                // English fallback — streamed only if the narrator call fails.
                const fallback = cause === 'all_closed'
                    ? `Everything I have${where} looks closed at this hour — ask me again "for tomorrow" and I'll line them up.`
                    : category === 'events'
                        ? (cause === 'all_filtered'
                            ? `That's every upcoming event I have${where} right now — you've seen them all. Ask me for places, or check back in a day or two.`
                            : `I don't have any verified event listings${where} yet. I'll go looking for that city's sources — try again shortly, or ask me for places instead.`)
                        : (cause === 'all_filtered'
                            ? 'You\'ve seen everything I have for that ask here — try shifting the ask a little for a fresh angle.'
                            : 'I searched all my sources and came up empty for that ask here. Try broadening it — or a different area.');
                // ── Brake pedal for the brain (deterministic): a QUESTION-
                //    shaped ask that found nothing new is far more likely a
                //    question about a place than a request for more cards —
                //    try the tool loop before saying "you've seen everything"
                //    ("is toufenkian hotel open tonight?" got the exhausted
                //    reply, live 2026-08-30). Primary route is the intent's
                //    'place' label above; this covers the LLM-timeout/missed
                //    cases. Only when cards exist to ask about, and only on
                //    a real question mark. ──
                let rescued = false;
                if (sessionCards.length && /[?？՞]\s*$/.test(String(message).trim())) {
                    try {
                        const loop = await runToolLoop({
                            messages: buildToolAnswerMessages({ message, langName, history: recentTurns, preferences: intent._preferences }),
                            tools: [PLACE_DETAILS_TOOL],
                            execute: makeExecutors({ center, sessionPlaces: sessionCards, requestId: `v2-${Date.now()}` }),
                            maxTokens: 400,
                        }, { provider: deepseekProvider });
                        if (loop.text) {
                            addUsage(loop);
                            reply = loop.text;
                            for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
                                send(res, { type: 'token', content: chunk });
                            }
                            stats.path = 'tool';
                            meta.toolCalls = loop.toolCalls.map(c => ({ name: c.name, args: c.args }));
                            rescued = true;
                            console.log(`[v2] empty deck rescued by tool loop (question-shaped ask) → ${loop.toolCalls.length} call(s) in ${Date.now() - t0}ms`);
                        }
                    } catch (err) {
                        console.warn(`[v2] empty-deck tool rescue failed: ${err.message} — falling back to the empty reply`);
                    }
                }
                if (!rescued) {
                    let streamedAny = false;
                    // streamedAny flips only when text actually REACHES the
                    // client — the gate holds back the first chars, and a
                    // stream that dies inside that window must still get the
                    // English fallback below.
                    const emptyGate = makeGreetingGate((c) => { streamedAny = true; send(res, { type: 'token', content: c }); }, { enabled: greetGateOn });
                    try {
                        const out = await narrator.stream({
                            messages: buildEmptyDeckMessages({
                                message, langName, cause, isEvents: category === 'events',
                                cityLabel: emptyCity, history: recentTurns,
                                preferences: intent._preferences,
                            }),
                            onToken: (c) => emptyGate.feed(c),
                            maxTokens: 120,
                            realStream: true,
                            model: providerName,
                            modelName,
                        });
                        emptyGate.finalize();
                        reply = greetGateOn ? stripLeadingGreeting(out.text) : out.text;
                        addUsage(out);
                    } catch (err) {
                        console.warn(`[v2] empty-deck narrator failed (${err.message}) — English fallback`);
                        if (!streamedAny) { reply = fallback; send(res, { type: 'token', content: reply }); }
                    }
                    console.log(`[v2] empty deck: cause=${cause}${result.provenance.openNowDropped ? ` openNowDropped=${result.provenance.openNowDropped}` : ''} city=${emptyCity || 'n/a'} lang=${langName}`);
                }
            } else if (
                // ── RELEVANCE BRAKE (Arsen 2026-08-23). The deck matches
                //    NOTHING the ask demands, nothing matched lexically, the
                //    ask carries no category, and the brain produced no place
                //    query — i.e. this was never a "show me places" turn. Six
                //    nearby attractions would answer a question nobody asked
                //    ("book a taxi" → museums), so Jinni says so instead.
                //    All four conditions together: a normal place ask always
                //    breaks at least one of them. ──
                result.provenance.unmatched?.length && result.provenance.lexical === 0
                && !category && !intent.searchQuery && !refillActive
            ) {
                const cityLabel = [center?.city, center?.country].filter(Boolean).join(', ') || null;
                const out = await narrator.stream({
                    messages: buildNoMatchMessages({
                        message, langName, cityLabel, history: recentTurns,
                        unmatched: result.provenance.unmatched,
                        preferences: intent._preferences,
                    }),
                    onToken: (c) => send(res, { type: 'token', content: c }),
                    maxTokens: 220,
                    realStream: true,
                    model: providerName,
                    modelName,
                });
                reply = out.text;
                addUsage(out);
                meta.answerType = 'no_match';
                stats.path = 'no_match';
                console.log(`[v2] relevance brake: nothing matches [${result.provenance.unmatched.join(',')}] — answered without cards (${Date.now() - t0}ms)`);
            } else {
                stage('writing', 'Almost there — putting it together…');
                const weather = await weatherPromise;   // resolved long ago or null
                const timeNote = [
                    // A planned hour REPLACES the wall clock: for "tonight at 8"
                    // the deck was hour-checked at 20:00, and prose that says
                    // "open right now" at 01:45 contradicts the ask (live
                    // 2026-09-04). Late-night colour only when no hour is asked.
                    ledger.targetTime != null
                        ? `the traveler is planning for ${fmtTargetTime(ledger.targetTime)} today — every open/closed fact in this deck was checked for ${fmtTargetTime(ledger.targetTime)}, so speak about that hour ("open at ${fmtTargetTime(ledger.targetTime)}"), and never say "open right now" or mention the current hour`
                        : (timeContext.isLateNight ? `late night (${String(timeContext.hour).padStart(2, '0')}:00 local)` : null),
                    weatherNote(weather) || null,
                ].filter(Boolean).join('; ') || null;
                // ── TRUE-streamed narration: prose streams live to the user as
                //    the model writes it; the <<<CARDS>>> tail (blurbs + question)
                //    stays private via the splitter. Failure modes degrade in
                //    order: no tail → fact-line cards; stream error → the older
                //    one-shot JSON call; that too → plain grounded prose. ──
                // Owned notes on a PLACES turn: "where can I buy a SIM card"
                // should answer with the operators AND card the shops, instead
                // of claiming a phone-repair shop sells tourist SIMs.
                const askTopic = topicFor(intent.infoTopic) || topicForQuery(retrievalQuery);
                const placeFacts = askTopic
                    ? await lookupFacts({
                        ...(await resolveRegion({ center, placeNames: intent.placeNames })),
                        topic: askTopic, limit: 1,
                    })
                    : [];
                if (placeFacts.length) meta.localFacts = placeFacts.map(f => ({ source: f.sourceName, url: f.sourceUrl, topic: f.topic }));
                // Direct name-ask (live 2026-08-31: "Do you know Elegant hotel
                // and resort in Tsaghkadzor?" → Elegant + an unasked resort):
                // when the traveler's message NAMES retrieved places, they
                // asked about THOSE — serve only the named one(s). Category
                // asks never trigger: no retrieved name appears in the message,
                // and geo tokens alone never count (messageNamesPlace).
                {
                    // …but the place they said they are STANDING at is not the
                    // subject of the question (live 2026-09-02: "I'm at Khor
                    // Virap. What should I visit next?" answered with Khor
                    // Virap alone and threw away the six historical sites
                    // around it). The stated position names the centre, so it
                    // can never be the name-ask.
                    const statedLower = String(meta.statedAt || '').toLowerCase();
                    const namedHits = (result.places || []).filter(p =>
                        messageNamesPlace(msgLower, p.name, geoTokens)
                        && !(statedLower && messageNamesPlace(statedLower, p.name, geoTokens)));
                    if (namedHits.length && namedHits.length < result.places.length) {
                        console.log(`[v2] name-ask: serving ${namedHits.length}/${result.places.length} — the message names them`);
                        result.places = namedHits;
                    }
                    // Name-ask QUARANTINE (founder 2026-08-31): a row born from
                    // this direct ask serves ITS asker now, but stays invisible
                    // to every other user until staff admit it (see PlaceCache
                    // model + buildCacheQuery/v1 suppression sets). Only fresh
                    // Google-fallback places quarantine — a cache/curated hit
                    // was already public, so a name ask merely counts it.
                    for (const p of namedHits) {
                        if (!p.placeId) continue;
                        const quarantine = p.source === 'google';
                        require('../models/PlaceCache').updateOne({ placeId: p.placeId }, [{
                            $set: {
                                askedByNameCount: { $add: [{ $ifNull: ['$askedByNameCount', 0] }, 1] },
                                nameAskFirstAt: { $ifNull: ['$nameAskFirstAt', '$$NOW'] },
                                // Unconditional: the row was just created by this
                                // ask's fallback (mongoose default false is already
                                // on it, so $ifNull could never fire). An admitted
                                // row re-serves from the cache tier (source 'cache')
                                // and never reaches this branch.
                                ...(quarantine ? { nameAskPending: true } : {}),
                            },
                        }]).catch(err => console.warn(`[v2] name-ask flag failed for ${p.placeId}: ${err.message}`));
                        if (quarantine) console.log(`[v2] name-ask quarantine: "${p.name}" pending staff verdict`);
                    }
                }
                // ── TAG WHAT WE SHOWED WITH THE ACTION IT ANSWERED ──
                // Founder, 2026-09-03: "those examples came from cache? or every
                // time it makes google call?" — every time. v1 has always done
                // this ($addToSet in aiRoutes); v2 never did, in two weeks as
                // the default engine. buildCacheQuery gates a categorised ask on
                // `actions`, so a place v2 BOUGHT from Google was stored without
                // the category it was bought for and could never be found again:
                // "I'm at Khor Virap. What should I visit next?" reported
                // `owned had 0` and paid for a fresh Text Search twice in 90
                // minutes, re-buying rows already sitting in PlaceCache.
                //
                // Same rule as v1: never overwrite a staff-curated action set.
                if (category && result.places?.length) {
                    const shownIds = result.places.map(p => p.placeId).filter(Boolean);
                    if (shownIds.length) {
                        require('../models/PlaceCache').updateMany(
                            { placeId: { $in: shownIds }, actionsCurated: { $ne: true } },
                            { $addToSet: { actions: category } },
                        ).catch(err => console.warn(`[v2] action tagging failed: ${err.message}`));
                    }
                }
                const promptArgs = {
                    query: retrievalQuery, places: result.places, langName, timeNote,
                    // Distances honesty: with a NAMED centre the km figures are
                    // from that town's centre, not from the traveler (who may
                    // be in another city — live 2026-08-31, Yerevan user told
                    // "2.5 km from you" about Tsaghkadzor).
                    centreCity: meta.centreSource === 'named' ? (meta.searchCity || null) : null,
                    modeNote: meta.modeSwitched
                        ? { to: meta.modeSwitched, place: meta.modeSwitchedTo || meta.searchCity || null }
                        : null,
                    history: recentTurns, localFacts: placeFacts, preferences: intent._preferences,
                    // Honest max: CODE knows the promise fell short ("I want 10
                    // hotels" → 3 new cards, live 2026-08-30); the prompt tells
                    // the model to say these are all it could find.
                    askedCount: explicitCount ? deckCount : null,
                    // Narrowing turns re-serve already-shown places — the prose
                    // must present them as the matching subset, never as new.
                    reServed: !!meta.reServed,
                };
                // The tail budget scales with the deck. 550 was sized for 6
                // cards; a 10-card tail (one blurb per card) truncated at 550
                // and only the salvage parser recovered 4 blurbs (blurbs=4/10,
                // live 2026-08-30). 250 + 50/card keeps 6 cards at the proven
                // 550 and gives bigger decks room to finish their JSON.
                const narrationTokens = Math.min(250 + 50 * result.places.length, 1300);
                let intro = '', blurbs = [], streamedOk = false;
                try {
                    const proseGate = makeGreetingGate((text) => send(res, { type: 'token', content: text }), { enabled: greetGateOn });
                    const splitter = new DelimitedSplitter((text) => proseGate.feed(text));
                    const streamOut = await narrator.stream({
                        messages: buildStreamedNarrationMessages(promptArgs),
                        maxTokens: narrationTokens,
                        temperature: 0.6,
                        realStream: true,
                        onToken: (d) => splitter.feed(d),
                        model: providerName,
                        modelName,
                        // NO web search for the narrator. The hunt already did
                        // the searching, and everything it found became a CARD.
                        // Giving the narrator its own search let a fact reach a
                        // traveler without ever passing the card pipeline: live
                        // 2026-08-24 it announced "Dubai Fashion Week runs
                        // September 1–5 at Dubai Design District" — a real
                        // sounding claim with a date, on no card, checked by
                        // nothing. The narrator narrates evidence; it does not
                        // discover.
                    });
                    addUsage(streamOut);
                    const tail = splitter.finalize();   // flushes held prose into the gate
                    proseGate.finalize();               // …which flushes to the client
                    intro = greetGateOn ? stripLeadingGreeting(splitter.prose.trim()) : splitter.prose.trim();
                    const parsedTail = tail ? parseCardsTail(tail, result.places.length) : null;
                    if (parsedTail) {
                        blurbs = parsedTail.blurbs;
                        meta.followUpQuestion = parsedTail.question;
                        // The model's read of what each place IS, already checked
                        // against the vocabulary. Ride it on the candidate so it
                        // survives hoistNarrated's reordering — categoryFor picks
                        // it up, and a slot the model left blank falls back to the
                        // type table on its own.
                        (parsedTail.kinds || []).forEach((k, i) => { if (k && result.places[i]) result.places[i]._kind = k; });
                        // The model may PROPOSE a preference change; code checks
                        // it against the vocabulary and parks it for the
                        // traveler's answer. Nothing is written on this turn.
                        // Where they actually are, so a "set my destination to
                        // here" is filled in by code. The model never supplies
                        // coordinates.
                        // Only when a position was actually reported. Arsen
                        // 2026-08-24: "user may manually toggle off gps
                        // location" — with it off there is nothing to save, and
                        // validateProposal refuses rather than storing a guess.
                        const here = gpsCenter ? await resolveRegion({ center: gpsCenter }) : null;
                        // The named city's country, resolved the same way as
                        // everything else — from coordinates, not from a name
                        // the model wrote.
                        let named = namedPlace;
                        if (named) {
                            const nr = await resolveRegion({ center: { lat: named.lat, lng: named.lng } });
                            named = { ...named, city: nr?.city || named.city, country: nr?.country || null };
                        }
                        const proposed = validateProposal(parsedTail.prefUpdate, {
                            currentPlace: here ? { ...here, lat: gpsCenter.lat, lng: gpsCenter.lng } : null,
                            namedPlace: named,
                        });
                        if (proposed && isExplicit(parsedTail.prefUpdate) && req.user?.id) {
                            // They ASKED. An instruction is already consent, and
                            // this is the same change the onboarding screen makes
                            // (Arsen 2026-08-24: "it should simply set and save").
                            if (await applyProposal(req.user.id, proposed)) {
                                meta.prefApplied = { field: proposed.field, label: proposed.label };
                                console.log(`[prefs] ${proposed.label} — set on request, no confirmation needed`);
                            }
                        } else if (proposed && sessionId && !pending) {
                            meta.prefProposal = proposed;
                            require('../models/ChatSession')
                                .updateOne({ _id: sessionId }, { $set: { pendingPrefChange: { ...proposed, askedAt: new Date() } } })
                                .catch(() => {});
                            console.log(`[prefs] proposed: ${proposed.label} — awaiting the traveler's answer`);
                        }
                    }
                    streamedOk = !!intro;
                } catch (err) {
                    console.warn(`[v2] streamed narration failed (${err.message}) — one-shot fallback`);
                }
                if (!streamedOk) {
                    const out = await narrator.stream({ messages: buildNarrationJson(promptArgs), maxTokens: narrationTokens, temperature: 0.6, model: providerName, modelName });
                    addUsage(out);
                    const parsed = parseNarrationJson(out.text, result.places.length);
                    if (parsed) {
                        intro = parsed.intro;
                        blurbs = parsed.blurbs;
                        meta.followUpQuestion = parsed.question;
                    } else {
                        const fb = await narrator.stream({ messages: buildGroundedMessages(promptArgs), maxTokens: 400, model: providerName, modelName });
                        addUsage(fb);
                        intro = fb.text;
                    }
                    if (greetGateOn) intro = stripLeadingGreeting(intro);
                    for (const chunk of intro.match(/.{1,60}(\s|$)/gs) || [intro]) {
                        send(res, { type: 'token', content: chunk });
                    }
                }
                stats.path = 'deck';
                stats.candidates = result.provenance.candidateCount;
                stats.cacheHit = !!result.provenance.cacheHit;
                reply = intro;
                // ── Cards, real by construction: every one started as a
                //    retrieval candidate. v1's exact payload shape → the
                //    frontend renders them unchanged (photos, map, votes).
                //    Prose and deck AGREE: intro-named places lead the cards. ──
                // Blurbs seat on the card they NAME, not the index the model
                // wrote (mis-numbered by praise order, live 2026-09-04).
                const _realigned = realignBlurbs(result.places, blurbs);
                if (_realigned.some((b, i2) => b !== blurbs[i2])) {
                    console.log('[v2] blurbs realigned to their named cards');
                    blurbs = _realigned;
                }
                const hoisted = hoistNarrated(intro, result.places, blurbs);
                recommendations = hoisted.places.map((p, i) =>
                    toRecommendation(p, i, { action: category || 'general', nearbyMode: effectiveNearbyMode, description: hoisted.blurbs[i] || null }));
                // What the listing printed stays exactly as printed; the
                // traveler's own currency rides ALONGSIDE it, rounded and
                // marked ≈ (Arsen 2026-08-24: "it will show what it found and
                // how much it will be"). Null whenever it would be a guess.
                const displayCurrency = intent._preferences?.budget?.currency || 'USD';
                for (const rec of recommendations) {
                    if (rec.eventPrice) rec.eventPriceApprox = approxIn(rec.eventPrice, displayCurrency);
                }
                // Remember what this turn showed (fire-and-forget) — feeds the
                // cross-session novelty signal, and survives session deletion.
                recordViews(req.user.id, recommendations, category);
                // ── Live card birth + description TYPING (v1's protocol):
                //    streaming_recommendation creates each card immediately
                //    (photo + name — better than v1's "Searching…" shells),
                //    then description_token types the blurb into it. The
                //    final `complete` replaces everything consistently. ──
                if (streamedOk && recommendations.length) {
                    // PACED emission — without the sleeps every event lands in one
                    // network burst and the browser paints it all in a single
                    // frame (Arsen's report: "descriptions appeared immediately").
                    // The card is born, breathes, then its description TYPES in.
                    for (const rec of recommendations) {
                        send(res, { type: 'streaming_recommendation', recommendation: { ...rec, description: '', isStreaming: true }, metadata: { timestamp: new Date(), isPartial: true } });
                        await sleep(90);
                    }
                    for (const rec of recommendations) {
                        for (const chunk of rec.description.match(/.{1,14}(\s|$)/gs) || [rec.description]) {
                            send(res, { type: 'description_token', recommendationName: rec.name, content: chunk });
                            await sleep(24);
                        }
                        send(res, { type: 'description_complete', recommendationName: rec.name, timestamp: new Date() });
                        await sleep(60);
                    }
                }
                console.log(`[v2] q="${String(retrievalQuery).slice(0, 60)}" cat=${category || 'free'} r=${radiusKm}km style=${intent._preferences?.travelStyle || 'none'}${intent.priceDirection ? ` price=${intent.priceDirection}` : ''}${explicitCount ? ` count=${deckCount}` : ''} → ${result.places.length}/${result.provenance.candidateCount} narrated (${streamedOk ? 'streamed' : 'fallback'}, blurbs=${blurbs.filter(Boolean).length}/${recommendations.length || result.places.length}) + ${recommendations.length} card(s) in ${Date.now() - t0}ms lex=${result.provenance.lexical} vec=${result.provenance.vector} taste=${!!result.provenance.taste} cacheHit=${result.provenance.cacheHit} prov=${providerName}${webSearch ? '+hunt-ws' : ''}${eventWindow ? ` win=${eventWindow.label}` : ''}`);
                // The ledger persists WITH the query that actually built this
                // deck — the next modifier-only turn ("make it 9") reuses it
                // verbatim instead of degrading to its own filler words.
                if (sessionId && category) {
                    // A modifier turn contributed NO new query — persisting its
                    // intent output made the stored query drift a word per turn
                    // ("near" crept in and missed the search cache, one paid
                    // POST, live 2026-09-04). The anchor query survives until a
                    // turn actually searches for something new.
                    require('../models/ChatSession').updateOne({ _id: sessionId }, {
                        $set: { constraints: { ...ledger,
                            lastQuery: modifierTurn ? ledger.lastQuery : retrievalQuery,
                            lastCore: modifierTurn ? (ledger.lastCore || null)
                                : (stripRadiusPhrase(intent.searchQuery) || ledger.lastCore || null),
                            updatedAt: new Date() } },
                    }).catch(() => {});
                }
            }
        }
    } catch (err) {
        console.error('[v2] turn failed:', err.message);
        stats.path = 'error';
        reply = 'this turn hit an error (logged server-side). Switch to V1 for real answers.';
        send(res, { type: 'token', content: reply });
    }

    // ── Usage true-up (parity with v1 ~1774 + ~3429): correct the pre-stream
    //    token ESTIMATE with the narrator's real counts (positive corrections
    //    only — crossing the cap here gates the NEXT request, never this
    //    already-streamed reply: the v1 prod lesson of 2026-08-20), and consume
    //    the places actually carded. Pure bookkeeping — never user-facing. ──
    try {
        if (req.userLimit) {
            const uniquePlaces = new Set(recommendations.map(r => r.name).filter(Boolean));
            // BIDIRECTIONAL settle (2026-08-30): the pre-charge was a
            // reservation; the turn ends billed at its REAL cost. The old
            // positive-only correction never refunded, so every settings
            // turn quietly overcharged (~300 tok each, live logs). A turn
            // that ERRORED with no narrator usage refunds the whole
            // reservation; refunds clamp so the day counter never goes
            // below zero (the model's math is a plain +=).
            const settled = actualTokens > 0 ? actualTokens
                : (stats.path === 'error' ? 0 : estimatedTokens);
            let delta = settled - estimatedTokens;
            if (delta < 0) delta = Math.max(delta, -(req.userLimit.dailyUsage?.tokensUsed || 0));
            if (delta !== 0 || uniquePlaces.size > 0) {
                await req.userLimit.checkAndUpdateUsage(delta, uniquePlaces.size, 0);
            }
            console.log(`[v2][limits] tok est=${estimatedTokens} actual=${actualTokens || 'n/a'} charged=${estimatedTokens + delta} places+${uniquePlaces.size}`);
        }
    } catch (e) {
        console.warn(`[v2][limits] post-stream usage true-up skipped: ${e.message}`);
    }

    // ── Admin provider split (2026-08-30): AiProviderDailyStats heard
    //    NOTHING from v2 — the DEFAULT engine since 08-22 was invisible on
    //    the admin AI-usage page while v1 chat and quick-actions reported.
    //    Same endpoint value as v1's chat: the admin's question is what CHAT
    //    costs per provider, not which engine served it. Fire-and-forget. ──
    if (actualTokens > 0) {
        require('../models/AiProviderDailyStats')
            .track(meta.provider || 'deepseek', { tokens: actualTokens, queries: 1, searches: actualSearches, endpoint: 'chat' })
            .catch(err => console.error('AiProviderDailyStats error:', err));
    }

    if (prefApplied) meta.prefApplied = { field: prefApplied.field, label: prefApplied.label };
    meta.debug = {
        engine: 'v2',
        shown: recommendations.length,
        candidates: stats.candidates,
        cacheHit: stats.cacheHit,
        ms: Date.now() - t0,
    };

    // ── TURN LOG (2026-08-26) ──────────────────────────────────────────────
    // Everything above already reached a console line; none of it could be
    // counted. One row per turn makes "what happens in turns" answerable —
    // what share of decks had no evidence, which asks buy a Google search,
    // p95 per branch, whether the token estimate tracks the real cost.
    // Fire-and-forget: never awaited, and a failure here can only cost a row.
    // The message text is NOT stored, only its length.
    try {
        require('../models/ChatTurn').record({
            userId: req.user?.id || null,
            sessionId: sessionId || null,
            branch: stats.path || 'deck',
            askLen: String(message || '').length,
            lang: meta.langUsed || null,
            category: stats.category,
            subType: stats.subType,
            refill: !!meta.refill,
            evidence: stats.evidence,
            lexical: stats.lexical,
            lexicalTop: stats.lexicalTop,
            lexicalShare: stats.lexicalShare,
            vector: stats.vector,
            taste: stats.taste,
            candidateCount: stats.candidates || 0,
            shown: recommendations.length,
            mode: stats.mode,
            radiusKm: stats.radiusKm,
            centreSource: meta.centreSource || null,
            city: meta.searchCity || null,
            googleCalls: stats.googleCalls,
            huntFired: stats.huntFired,
            cacheHit: stats.cacheHit,
            provider: meta.provider || null,
            tokensEst: estimatedTokens,
            tokensActual: actualTokens,
            ms: Date.now() - t0,
        });
    } catch (e) { console.warn('[v2][turnlog] skipped:', e.message); }

    send(res, {
        type: 'complete',
        contentParts: buildContentParts(reply || '', recommendations.length, meta.followUpQuestion || null),
        recommendations,
        metadata: meta,
    });
    send(res, { type: 'stream_end' });
    res.end();
});

module.exports = router;
