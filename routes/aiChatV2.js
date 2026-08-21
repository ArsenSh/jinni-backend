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
const { buildGroundedMessages, buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
const { toRecommendation, buildContentParts } = require('../engine/narrator/cards');

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const LANG_NAMES = { en: 'English', ru: 'Russian', hy: 'Armenian', fr: 'French', ar: 'Arabic', zh: 'Chinese' };

const { recentTurnsFromMessages, shownFromMessages } = require('../engine/context/session');

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

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
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
            const appCfg = await AppConfig.getConfig().catch(() => ({}));
            const user = await require('../models/User').findById(req.user.id).select('settings').lean().catch(() => null);
            const userLanguage = user?.settings?.language || 'en';
            intent = await intentService.classify({ message, recentTurns, userLanguage, appCfg });
            intent._userLanguage = userLanguage;
        } catch (err) {
            console.warn('[v2] intent failed, treating as place query:', err.message);
            intent = { isTravel: true, actionType: 'general', searchQuery: message, language: 'en', _userLanguage: 'en' };
        }
        const langName = LANG_NAMES[intent.language] || LANG_NAMES[intent._userLanguage] || 'English';

        if (!intent.isTravel) {
            // ── Chit-chat: no retrieval, no place names — just Jinni. ──
            const out = await narrator.stream({
                messages: buildChitchatMessages({ message, langName, history: recentTurns }),
                onToken: (c) => send(res, { type: 'token', content: c }),
                maxTokens: 200,
            });
            reply = out.text;
            console.log(`[v2] chit-chat narrated in ${Date.now() - t0}ms (${out.usage.in}/${out.usage.out} tok)`);
        } else if (!center) {
            reply = '🧪 V2: I need a location to search — enable GPS or pick a destination, then ask again.';
            send(res, { type: 'token', content: reply });
        } else {
            const timeContext = buildTimeContext({ timezone: userTimezone, lng: center.lng });
            const category = intent.actionType && intent.actionType !== 'general' ? intent.actionType : null;
            const result = await findPlaces({
                query: intent.searchQuery || message,
                category,
                subType: intent.subType || null,
                center,
                mode: nearbyMode ? 'nearby' : 'discovery',
                radiusKm: nearbyMode ? 5 : 50,
                count: 6,
                timeContext,
                excludes: shown,          // already shown this session → follow-ups get NEW places
            }, { loadCandidates });
            meta.provenance = result.provenance;
            if (result.degraded || !result.places.length) {
                reply = '🧪 V2: I don\'t have verified places for that here yet — my owned-data corpus is thin '
                      + 'in this area (V1 would reach for Google; that tier isn\'t wired into V2 yet). '
                      + 'Try a broader ask, or switch to V1.';
                send(res, { type: 'token', content: reply });
            } else {
                const timeNote = timeContext.isLateNight ? `late night (${String(timeContext.hour).padStart(2, '0')}:00 local)` : null;
                const out = await narrator.stream({
                    messages: buildGroundedMessages({ query: intent.searchQuery || message, places: result.places, langName, timeNote, history: recentTurns }),
                    onToken: (c) => send(res, { type: 'token', content: c }),
                    maxTokens: 400,
                });
                const footer = `\n\n🧪 v2 · ${result.places.length}/${result.provenance.candidateCount} candidates`
                             + `${result.provenance.cacheHit ? ' · cache HIT' : ''} · ${Date.now() - t0}ms`;
                send(res, { type: 'token', content: footer });
                reply = out.text + footer;
                // ── Cards, real by construction: every one started as a
                //    retrieval candidate. v1's exact payload shape → the
                //    frontend renders them unchanged (photos, map, votes). ──
                recommendations = result.places.map((p, i) =>
                    toRecommendation(p, i, { action: category || 'general', nearbyMode }));
                console.log(`[v2] q="${String(intent.searchQuery || message).slice(0, 50)}" cat=${category || 'free'} → ${result.places.length}/${result.provenance.candidateCount} narrated + ${recommendations.length} card(s) in ${Date.now() - t0}ms lex=${result.provenance.lexical} cacheHit=${result.provenance.cacheHit}`);
            }
        }
    } catch (err) {
        console.error('[v2] turn failed:', err.message);
        reply = '🧪 V2: this turn hit an error (logged server-side). Switch to V1 for real answers.';
        send(res, { type: 'token', content: reply });
    }

    send(res, {
        type: 'complete',
        contentParts: buildContentParts(reply || '', recommendations.length),
        recommendations,
        metadata: meta,
    });
    send(res, { type: 'stream_end' });
    res.end();
});

module.exports = router;
