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
const { buildGroundedMessages, buildChitchatMessages, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail } = require('../engine/narrator/prompts/grounded');
const { DelimitedSplitter } = require('../engine/narrator/streamSplit');
const { toRecommendation, buildContentParts, hoistNarrated } = require('../engine/narrator/cards');
const { effectiveRadiusKm, buildRetrievalQuery, isRightNowAsk, rankingWeights } = require('../engine/retrieval/tuning');
const { getWeather, weatherNote } = require('../engine/context/weather');

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LANG_NAMES = { en: 'English', ru: 'Russian', hy: 'Armenian', fr: 'French', ar: 'Arabic', zh: 'Chinese' };

const { recentTurnsFromMessages, shownFromMessages, shownPlaces } = require('../engine/context/session');
const { runToolLoop } = require('../engine/narrator/toolLoop');
const { PLACE_DETAILS_TOOL, makeExecutors } = require('../engine/narrator/tools');
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
    // Session-destination fallback (v1's rule): a Paphos conversation stays
    // centered on Paphos even when this turn names no place and sends no GPS.
    if (!center && sessionPeek?.activeDestination?.latitude != null && sessionPeek?.activeDestination?.longitude != null) {
        center = { lat: sessionPeek.activeDestination.latitude, lng: sessionPeek.activeDestination.longitude };
    }

    let reply;
    let recommendations = [];
    const meta = { engine: 'v2', build: 'narrator-v0+cards', timestamp: new Date() };
    const t0 = Date.now();
    try {
        // Intent pre-pass — same classifier v1 trusts; failure degrades to
        // "treat it as a place query" rather than failing the turn.
        let intent = null;
        try {
            const intentService = require('../services/intentService');
            const AppConfig = require('../models/AppConfig');
            // Config + user load in PARALLEL (they were sequential — free ~200-400ms).
            const [appCfg, user] = await Promise.all([
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

        // ── Detail-question branch (THE TOOL LOOP): the message names a place
        //    the traveler already saw in this session → the model drives, with
        //    get_place_details as its tool. Session-first identity means the
        //    answer is about the exact card they saw. ──
        const sessionCards = shownPlaces(sessionPeek?.messages);
        const msgLower = String(message).toLowerCase();
        const namedCard = intent.isTravel && sessionCards.find(p => messageNamesPlace(msgLower, p.name));
        if (namedCard) {
            const loop = await runToolLoop({
                messages: buildToolAnswerMessages({ message, langName, history: recentTurns }),
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
        } else if (!intent.isTravel) {
            // ── Chit-chat: no retrieval, no place names — just Jinni. ──
            const out = await narrator.stream({
                messages: buildChitchatMessages({ message, langName, history: recentTurns }),
                onToken: (c) => send(res, { type: 'token', content: c }),
                maxTokens: 200,
                realStream: true,
            });
            reply = out.text;
            actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
            console.log(`[v2] chit-chat narrated in ${Date.now() - t0}ms (${out.usage.in}/${out.usage.out} tok)`);
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
            const retrievalQuery = buildRetrievalQuery(intent.searchQuery, message);
            const radiusKm = effectiveRadiusKm({ category, mode, radiusKm: nearbyMode ? 5 : 50 });
            const result = await findPlaces({
                query: retrievalQuery,
                // Clean intent query only — drives the fallback's "demanded term
                // with zero owned matches" check (the Uzbek lesson); enriched
                // chat tokens must never trigger paid searches.
                coreQuery: intent.searchQuery || '',
                category,
                subType: intent.subType || null,
                center,
                mode,
                radiusKm,
                count: 6,
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
                reply = '🧪 V2: I don\'t have verified places for that here yet — my owned-data corpus is thin '
                      + 'in this area (V1 would reach for Google; that tier isn\'t wired into V2 yet). '
                      + 'Try a broader ask, or switch to V1.';
                send(res, { type: 'token', content: reply });
            } else {
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
                const promptArgs = { query: retrievalQuery, places: result.places, langName, timeNote, history: recentTurns };
                let intro = '', blurbs = [], streamedOk = false;
                try {
                    const splitter = new DelimitedSplitter((text) => send(res, { type: 'token', content: text }));
                    const streamOut = await narrator.stream({
                        messages: buildStreamedNarrationMessages(promptArgs),
                        maxTokens: 550,
                        temperature: 0.6,
                        realStream: true,
                        onToken: (d) => splitter.feed(d),
                    });
                    actualTokens += (streamOut.usage?.in || 0) + (streamOut.usage?.out || 0);
                    const tail = splitter.finalize();
                    intro = splitter.prose.trim();
                    const parsedTail = tail ? parseCardsTail(tail, result.places.length) : null;
                    if (parsedTail) { blurbs = parsedTail.blurbs; meta.followUpQuestion = parsedTail.question; }
                    streamedOk = !!intro;
                } catch (err) {
                    console.warn(`[v2] streamed narration failed (${err.message}) — one-shot fallback`);
                }
                if (!streamedOk) {
                    const out = await narrator.stream({ messages: buildNarrationJson(promptArgs), maxTokens: 550, temperature: 0.6 });
                    actualTokens += (out.usage?.in || 0) + (out.usage?.out || 0);
                    const parsed = parseNarrationJson(out.text, result.places.length);
                    if (parsed) {
                        intro = parsed.intro;
                        blurbs = parsed.blurbs;
                        meta.followUpQuestion = parsed.question;
                    } else {
                        const fb = await narrator.stream({ messages: buildGroundedMessages(promptArgs), maxTokens: 400 });
                        actualTokens += (fb.usage?.in || 0) + (fb.usage?.out || 0);
                        intro = fb.text;
                    }
                    for (const chunk of intro.match(/.{1,60}(\s|$)/gs) || [intro]) {
                        send(res, { type: 'token', content: chunk });
                    }
                }
                const footer = `\n\n🧪 v2 · ${result.places.length}/${result.provenance.candidateCount} candidates`
                             + `${result.provenance.cacheHit ? ' · cache HIT' : ''} · ${Date.now() - t0}ms`;
                send(res, { type: 'token', content: footer });
                reply = intro + footer;
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
                console.log(`[v2] q="${String(retrievalQuery).slice(0, 60)}" cat=${category || 'free'} r=${radiusKm}km style=${intent._preferences?.travelStyle || 'none'} → ${result.places.length}/${result.provenance.candidateCount} narrated (${streamedOk ? 'streamed' : 'fallback'}, blurbs=${blurbs.filter(Boolean).length}/${recommendations.length || result.places.length}) + ${recommendations.length} card(s) in ${Date.now() - t0}ms lex=${result.provenance.lexical} vec=${result.provenance.vector} taste=${!!result.provenance.taste} cacheHit=${result.provenance.cacheHit}`);
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
