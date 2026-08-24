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
const { usageTracker, estimateTokens } = require('../middleware/usageTracker');
const { findPlaces } = require('../engine/retrieval');
const { loadCandidates } = require('../engine/places/canonicalStore');
const { buildTimeContext } = require('../engine/context/contextEngine');
const narrator = require('../engine/narrator');
const { buildGroundedMessages, buildChitchatMessages, buildGettingAroundMessages, buildNoMatchMessages, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail } = require('../engine/narrator/prompts/grounded');
const { DelimitedSplitter } = require('../engine/narrator/streamSplit');
const { toRecommendation, buildContentParts, hoistNarrated } = require('../engine/narrator/cards');
const { effectiveRadiusKm, buildRetrievalQuery, isRightNowAsk, isTransportAsk, rankingWeights, parseRefillAsk } = require('../engine/retrieval/tuning');
const { getWeather, weatherNote } = require('../engine/context/weather');

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LANG_NAMES = { en: 'English', ru: 'Russian', hy: 'Armenian', fr: 'French', ar: 'Arabic', zh: 'Chinese' };

const { recentTurnsFromMessages, shownFromMessages, shownPlaces, lastCardAsk } = require('../engine/context/session');
const { runToolLoop } = require('../engine/narrator/toolLoop');
const { PLACE_DETAILS_TOOL, FIND_FLIGHTS_TOOL, makeExecutors } = require('../engine/narrator/tools');
const { flightsEnabled } = require('../engine/travel/flights');
const { lookupFacts, topicFor, topicForQuery } = require("../engine/knowledge/sync");
const { resolveRegion } = require('../engine/context/region');
const { resolveDestination } = require('../engine/context/destination');
const { buildToolAnswerMessages } = require('../engine/narrator/prompts/grounded');
const { messageNamesPlace } = require('../engine/places/matching');
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
            .select({ userId: 1, activeDestination: 1, messages: { $slice: -8 } })
            .lean()
            .catch(() => null);
        if (sessionPeek && String(sessionPeek.userId) !== String(req.user.id)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this conversation.' });
        }
    }
    const recentTurns = recentTurnsFromMessages(sessionPeek?.messages);
    const shown = shownFromMessages(sessionPeek?.messages);

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
    try {
        if (req.userLimit) {
            estimatedTokens = estimateTokens(message) + 500;
            const usageStatus = await req.userLimit.checkAndUpdateUsage(estimatedTokens, 0, 1);
            res.set('X-Usage-Tokens-Used', usageStatus.dailyTokensUsed.toString());
            res.set('X-Usage-Tokens-Remaining', usageStatus.dailyTokensRemaining.toString());
            res.set('X-Usage-Places-Viewed', usageStatus.dailyPlacesViewed.toString());
            res.set('X-Usage-Places-Remaining', usageStatus.dailyPlacesRemaining.toString());
            if (usageStatus.estimatedRequestsRemaining != null) { res.set('X-Usage-Requests-Remaining', usageStatus.estimatedRequestsRemaining.toString()); }
            if (usageStatus.onCooldown) {
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
    // `center` is the raw GPS reading and nothing else. The chosen destination
    // used to be folded in here as a fallback, which is what made it LOSE to
    // GPS; resolveDestination now settles the precedence once, below, after
    // intent has told us whether this message names a city.

    let reply;
    let recommendations = [];
    const meta = { engine: 'v2', build: 'narrator-v0+cards', timestamp: new Date() };
    const t0 = Date.now();
    // What the engine did this turn. Reported ONCE, at the bottom of the reply
    // (it used to be pasted into the prose, where it read as something Jinni
    // was saying). Filled by whichever branch answers.
    const stats = { candidates: null, cacheHit: false, path: null };
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
        } catch (err) {
            console.warn('[v2] intent failed, treating as place query:', err.message);
            intent = { isTravel: true, actionType: 'general', searchQuery: message, language: 'en', _userLanguage: 'en' };
        }
        const langName = LANG_NAMES[intent.language] || LANG_NAMES[intent._userLanguage] || 'English';

        // ── WHERE we are searching. Until now a chosen destination was only a
        //    fallback for missing GPS, and a city named in the message was
        //    never geocoded at all — so "events in dubai" searched Yerevan and
        //    returned Armenian theatre (live 2026-08-24). v1's precedence,
        //    restored: nearby → named city → session destination → GPS. ──
        try {
            const dest = await resolveDestination({
                placeNames: intent.placeNames || [],
                gps: center,
                sessionDestination: sessionPeek?.activeDestination || null,
                nearbyMode,
            }, { findPlaces: (q, near) => require('../services/googleService').findPlaces(q, near) });
            if (dest.center) center = dest.center;
            if (dest.city) meta.searchCity = dest.city;
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
        const providerName = (appCfg.aiProviderChat === 'claude'
            || (Array.isArray(appCfg.claudeChatCategories) && appCfg.claudeChatCategories.includes(intent.actionType))
            || (appCfg.aiEventsUseClaude && intent.actionType === 'events'))
            ? 'claude' : 'deepseek';
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

        // ── Detail-question branch (THE TOOL LOOP): the message names a place
        //    the traveler already saw in this session → the model drives, with
        //    get_place_details as its tool. Session-first identity means the
        //    answer is about the exact card they saw. ──
        const sessionCards = shownPlaces(sessionPeek?.messages);
        const msgLower = String(message).toLowerCase();
        const namedCard = intent.isTravel && sessionCards.find(p => messageNamesPlace(msgLower, p.name));

        // ── "How do I get there / get around" (Arsen 2026-08-23, after his
        //    brother asked "I want to book a taxi. How can I do it" and got six
        //    sightseeing cards). Transport is a QUESTION, not a deck: answer it
        //    in prose and skip retrieval entirely — no Google spend, no cards.
        //    The BRAIN decides (intent.infoAsk); the regex is the LLM-timeout
        //    fallback, in all six app languages. ──
        const transportAsk = intent.infoAsk === 'transport'
            || (intent.infoAsk === undefined && isTransportAsk(msgLower));

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
            meta.refill = true;
            console.log(`[v2] refill → continuing the ask that made the deck: "${String(prevUserAsk).slice(0, 60)}"`);
        }
        const deckCount = refillActive && refill.count ? Math.min(12, Math.max(3, refill.count)) : 6;

        if (transportAsk) {
            const cityLabel = [center?.city, center?.country].filter(Boolean).join(', ') || null;
            const tz = buildTimeContext({ timezone: userTimezone, lng: center?.lng });
            const weather = center ? await getWeather(center.lat, center.lng).catch(() => null) : null;
            // Owned knowledge first (Wikivoyage "Get around" etc.). For a city
            // like Yerevan no transit feed exists anywhere, so these notes are
            // the only real source there is — they outrank model memory.
            const region = await resolveRegion({ center, placeNames: intent.placeNames });
            // The RAW topic decides which notes answer this ("which metro" →
            // get_around); this branch falls back to get_around because that
            // is exactly what the branch is for.
            const gaFacts = await lookupFacts({ ...region, topic: topicFor(intent.infoTopic) || 'get_around' });
            const gaMessages = buildGettingAroundMessages({
                message, langName, cityLabel, history: recentTurns,
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
                reply = loop.text || '';
                toolCalls = loop.toolCalls.length;
                actualTokens += (loop.usage?.in || 0) + (loop.usage?.out || 0);
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
                actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
            }
            meta.answerType = 'getting_around';
            console.log(`[v2] getting-around answered in ${Date.now() - t0}ms src=${intent.infoAsk === 'transport' ? 'llm' : 'regex'} flights=${flightsEnabled() ? `on(${toolCalls} call${toolCalls === 1 ? '' : 's'})` : 'off'} region=${[region.city, region.country].filter(Boolean).join('/') || 'unknown'} facts=${gaFacts.length ? gaFacts.map(f => f.sourceName).join('+') : 'none'}`);
        } else if (namedCard) {
            const loop = await runToolLoop({
                messages: buildToolAnswerMessages({ message, langName, history: recentTurns, preferences: intent._preferences }),
                tools: [PLACE_DETAILS_TOOL],
                execute: makeExecutors({ center, sessionPlaces: sessionCards, requestId: `v2-${Date.now()}` }),
                maxTokens: 400,
            }, { provider: deepseekProvider });
            actualTokens += (loop.usage?.in || 0) + (loop.usage?.out || 0);
            reply = loop.text || 'I couldn\'t verify that just now — the place\'s card has the details under More.';
            for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
                send(res, { type: 'token', content: chunk });
            }
            meta.toolCalls = loop.toolCalls.map(c => ({ name: c.name, args: c.args }));
            console.log(`[v2] tool-loop "${String(message).slice(0, 50)}" → ${loop.toolCalls.length} call(s) [${loop.toolCalls.map(c => `${c.name}(${c.args?.name || ''})`).join(', ')}] in ${Date.now() - t0}ms iter=${loop.iterations}`);
        } else if (!intent.isTravel || intent.infoAsk === 'how_to') {
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
                    ...(await resolveRegion({ center, placeNames: intent.placeNames })),
                    topic: infoTopicWanted,
                })
                : [];
            if (infoFacts.length) meta.localFacts = infoFacts.map(f => ({ source: f.sourceName, url: f.sourceUrl, topic: f.topic }));
            const out = await narrator.stream({
                messages: buildChitchatMessages({ message, langName, history: recentTurns, localFacts: infoFacts, preferences: intent._preferences }),
                onToken: (c) => send(res, { type: 'token', content: c }),
                maxTokens: 200,
                realStream: true,
                model: providerName,
                modelName,
            });
            reply = out.text;
            actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
            console.log(`[v2] ${intent.infoAsk ? `info(${intent.infoAsk})` : 'chit-chat'} narrated in ${Date.now() - t0}ms (${out.usage.in}/${out.usage.out} tok)${infoFacts.length ? ` facts=${infoFacts.map(f => f.sourceName).join('+')}` : ''}`);
        } else if (!center) {
            reply = '🧪 V2: I need a location to search — enable GPS or pick a destination, then ask again.';
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
                : (intent.when === 'now' || nearbyMode || timeContext.isLateNight || isRightNowAsk(message));
            const category = intent.actionType && intent.actionType !== 'general' ? intent.actionType : null;
            const mode = nearbyMode ? 'nearby' : 'discovery';
            // Tuning round: enrich the lossy intent query with the message's
            // distinctive words, and cap dining/shopping radius (local decisions).
            // Refill turns enrich from the PREVIOUS ask — "10 other results"
            // contributes nothing to relevance; "suggest historical places" does.
            const retrievalQuery = buildRetrievalQuery(intent.searchQuery, refillActive ? (prevUserAsk || message) : message);
            const radiusKm = effectiveRadiusKm({ category, mode, radiusKm: nearbyMode ? 5 : 50 });
            // Events: the asked PERIOD rules the window ("upcoming weekend"
            // ⇒ Sat–Sun, "tonight" ⇒ rest of today — Arsen 2026-08-22; the
            // engine no longer serves a blind next-14-days slice).
            // The asked PERIOD: the intent model NAMES it (period field —
            // handles any phrasing in any language, inherits across
            // follow-ups); eventStore.windowFromPeriod does the clamped date
            // math. The regex parser remains the LLM-timeout fallback, with
            // refill turns inheriting the previous ask's words.
            const _ev = require('../engine/places/eventStore');
            const eventWindow = category === 'events'
                ? (_ev.windowFromPeriod(intent.period)
                    || _ev.parseEventWindow(refillActive ? (prevUserAsk || message) : message))
                : null;
            stage(category === 'events' ? 'events' : 'search',
                category === 'events' ? 'Checking what\'s on around here…' : 'Searching what I know about here…');
            const result = await findPlaces({
                query: retrievalQuery,
                eventWindow,
                // Progress voice — the store calls this when it goes out to the
                // city's listings or to Google, the two waits worth narrating.
                onStage: stage,
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
                coreQuery: intent.searchQuery || '',
                category,
                subType: intent.subType || null,
                center,
                mode,
                radiusKm,
                count: deckCount,
                // Specific asks shrink the deck to match + alternatives
                // (battery fix #2) — but never a refill, where the traveler
                // asked for a number and gets it.
                adaptiveDeck: !refillActive,
                timeContext,
                // Arsen's rules: right-now context → check hours; otherwise
                // pass. And the AI decides — intent.when is the brain ('now' /
                // 'planned' / 'unspecified'); nearby/late-night/now-words are
                // the degradation path when it abstains. An explicit 'planned'
                // ALWAYS skips the filter. Unknown hours survive regardless.
                enforceOpenNow: rightNow,
                // The ask's nature shifts what evidence matters: right-now →
                // proximity up; romantic/special → quality prior up.
                weights: rankingWeights({ rightNow, nearbyMode, message }),
                preferences: intent._preferences || {},   // tier gates + pref scoring in the store
                // Likes/saves climb, oft-seen-unacted sinks — a nudge on the
                // fused order, never a filter (personalization/taste.js).
                taste,
                excludes: shown,          // already shown this session → follow-ups get NEW places
            }, { loadCandidates });
            meta.provenance = result.provenance;
            if (result.degraded || !result.places.length) {
                // Honest empty (copy refreshed 2026-08-22 — the old text
                // claimed the Google tier wasn't wired; it is, and events now
                // serve from owned data too. Reaching here means every source
                // genuinely came up dry for this ask+area).
                // all_filtered = everything I had was already shown (or
                // excluded) — "that's the lot" reads honest; "I have none"
                // would be false. no_candidates = genuinely nothing listed.
                const sawEverything = result.reason === 'all_filtered';
                // Name the city we actually searched. "this area" let a Dubai
                // ask read as if it had been answered about Dubai when the
                // search had run somewhere else entirely (live 2026-08-24).
                const where = meta.searchCity ? ` in ${meta.searchCity}` : ' for this area';
                reply = category === 'events'
                    ? (sawEverything
                        ? `🧪 V2: That's every upcoming event I have${where} right now — you've seen them all. Ask me for places, or check back in a day or two.`
                        : `🧪 V2: I don't have any verified event listings${where} yet. I'll go looking for that city's sources — try again shortly, or ask me for places instead.`)
                    : (sawEverything
                        ? '🧪 V2: You\'ve seen everything I have for that ask here — try shifting the ask a little for a fresh angle.'
                        : '🧪 V2: I searched all my sources and came up empty for that ask here. Try broadening it — or a different area.');
                send(res, { type: 'token', content: reply });
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
                actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
                meta.answerType = 'no_match';
                console.log(`[v2] relevance brake: nothing matches [${result.provenance.unmatched.join(',')}] — answered without cards (${Date.now() - t0}ms)`);
            } else {
                stage('writing', 'Almost there — putting it together…');
                const weather = await weatherPromise;   // resolved long ago or null
                const timeNote = [
                    timeContext.isLateNight ? `late night (${String(timeContext.hour).padStart(2, '0')}:00 local)` : null,
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
                const promptArgs = { query: retrievalQuery, places: result.places, langName, timeNote, history: recentTurns, localFacts: placeFacts, preferences: intent._preferences };
                let intro = '', blurbs = [], streamedOk = false;
                try {
                    const splitter = new DelimitedSplitter((text) => send(res, { type: 'token', content: text }));
                    const streamOut = await narrator.stream({
                        messages: buildStreamedNarrationMessages(promptArgs),
                        maxTokens: 550,
                        temperature: 0.6,
                        realStream: true,
                        onToken: (d) => splitter.feed(d),
                        model: providerName,
                        modelName,
                        webSearch,
                    });
                    actualTokens += (streamOut.usage?.in || 0) + (streamOut.usage?.out || 0);
                    const tail = splitter.finalize();
                    intro = splitter.prose.trim();
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
                    }
                    streamedOk = !!intro;
                } catch (err) {
                    console.warn(`[v2] streamed narration failed (${err.message}) — one-shot fallback`);
                }
                if (!streamedOk) {
                    const out = await narrator.stream({ messages: buildNarrationJson(promptArgs), maxTokens: 550, temperature: 0.6, model: providerName, modelName, webSearch });
                    actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
                    const parsed = parseNarrationJson(out.text, result.places.length);
                    if (parsed) {
                        intro = parsed.intro;
                        blurbs = parsed.blurbs;
                        meta.followUpQuestion = parsed.question;
                    } else {
                        const fb = await narrator.stream({ messages: buildGroundedMessages(promptArgs), maxTokens: 400, model: providerName, modelName });
                        actualTokens += (fb.usage?.in || 0) + (fb.usage?.out || 0);
                        intro = fb.text;
                    }
                    for (const chunk of intro.match(/.{1,60}(\s|$)/gs) || [intro]) {
                        send(res, { type: 'token', content: chunk });
                    }
                }
                stats.candidates = result.provenance.candidateCount;
                stats.cacheHit = !!result.provenance.cacheHit;
                reply = intro;
                // ── Cards, real by construction: every one started as a
                //    retrieval candidate. v1's exact payload shape → the
                //    frontend renders them unchanged (photos, map, votes).
                //    Prose and deck AGREE: intro-named places lead the cards. ──
                const hoisted = hoistNarrated(intro, result.places, blurbs);
                recommendations = hoisted.places.map((p, i) =>
                    toRecommendation(p, i, { action: category || 'general', nearbyMode, description: hoisted.blurbs[i] || null }));
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
                console.log(`[v2] q="${String(retrievalQuery).slice(0, 60)}" cat=${category || 'free'} r=${radiusKm}km style=${intent._preferences?.travelStyle || 'none'} → ${result.places.length}/${result.provenance.candidateCount} narrated (${streamedOk ? 'streamed' : 'fallback'}, blurbs=${blurbs.filter(Boolean).length}/${recommendations.length || result.places.length}) + ${recommendations.length} card(s) in ${Date.now() - t0}ms lex=${result.provenance.lexical} vec=${result.provenance.vector} taste=${!!result.provenance.taste} cacheHit=${result.provenance.cacheHit} prov=${providerName}${webSearch ? '+ws' : ''}${eventWindow ? ` win=${eventWindow.label}` : ''}`);
            }
        }
    } catch (err) {
        console.error('[v2] turn failed:', err.message);
        reply = '🧪 V2: this turn hit an error (logged server-side). Switch to V1 for real answers.';
        send(res, { type: 'token', content: reply });
    }

    // ── Usage true-up (parity with v1 ~1774 + ~3429): correct the pre-stream
    //    token ESTIMATE with the narrator's real counts (positive corrections
    //    only — crossing the cap here gates the NEXT request, never this
    //    already-streamed reply: the v1 prod lesson of 2026-08-20), and consume
    //    the places actually carded. Pure bookkeeping — never user-facing. ──
    try {
        if (req.userLimit) {
            const correction = Math.max(0, actualTokens - estimatedTokens);
            const uniquePlaces = new Set(recommendations.map(r => r.name).filter(Boolean));
            if (correction > 0 || uniquePlaces.size > 0) {
                await req.userLimit.checkAndUpdateUsage(correction, uniquePlaces.size, 0);
            }
            console.log(`[v2][limits] tok est=${estimatedTokens} actual=${actualTokens || 'n/a'} charged=${estimatedTokens + correction} places+${uniquePlaces.size}`);
        }
    } catch (e) {
        console.warn(`[v2][limits] post-stream usage true-up skipped: ${e.message}`);
    }

    meta.debug = {
        engine: 'v2',
        shown: recommendations.length,
        candidates: stats.candidates,
        cacheHit: stats.cacheHit,
        ms: Date.now() - t0,
    };

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
