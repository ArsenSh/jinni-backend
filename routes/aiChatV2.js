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

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

router.post('/chat-stream-v2', auth, usageTracker, async (req, res) => {
    const { message, location = null, userTimezone = null, nearbyMode = false } = req.body || {};
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required and must be a string.' });
    }
    if (message.length > 2000) {
        return res.status(400).json({ error: 'Message too long. Maximum 2000 characters allowed.' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    // ── V2 build state: RETRIEVAL CORE LIVE (owned data only — Destination/
    //    Business via proximityService + PlaceCache via canonicalStore).
    //    No narrator yet: results stream as an honest text list, not prose;
    //    no Google fallback tier yet: a thin area reports itself thin. ──
    const center = (location && location.lat != null && location.lng != null)
        ? { lat: Number(location.lat), lng: Number(location.lng) } : null;

    let reply;
    const meta = { engine: 'v2', build: 'retrieval-core', timestamp: new Date() };
    if (!center) {
        reply = '🧪 V2: I need a location to search — enable GPS or pick a destination, then ask again.';
    } else {
        try {
            const timeContext = buildTimeContext({ timezone: userTimezone, lng: center.lng });
            const t0 = Date.now();
            const result = await findPlaces({
                query: message,
                category: null,                        // free query — no intent classifier yet
                center,
                mode: nearbyMode ? 'nearby' : 'discovery',
                radiusKm: nearbyMode ? 5 : 50,
                count: 8,
                timeContext,
            }, { loadCandidates });
            const ms = Date.now() - t0;
            meta.provenance = result.provenance;
            if (result.degraded || !result.places.length) {
                reply = `🧪 V2 retrieval: no owned-data candidates for this area yet (${result.reason || 'empty'}). `
                      + `V1 would fall back to Google here — v2's Google tier isn't wired yet.`;
            } else {
                const lines = result.places.map((p, i) => {
                    const bits = [
                        p.distanceKm != null ? `${p.distanceKm.toFixed(1)} km` : null,
                        p.rating ? `★${p.rating}` : null,
                        p._openNow === true ? 'open now' : (p._openNow === false ? 'closed now' : null),
                        p.source !== 'cache' ? p.source : null,
                    ].filter(Boolean);
                    return `${i + 1}. ${p.name}${bits.length ? ' — ' + bits.join(' · ') : ''}`;
                });
                reply = `🧪 V2 retrieval core (owned data, hybrid-ranked, no AI narration yet) — `
                      + `top ${result.places.length} of ${result.provenance.candidateCount} candidates in ${ms}ms`
                      + `${result.provenance.cacheHit ? ' · semantic cache HIT' : ''}:\n\n${lines.join('\n')}`;
                console.log(`[v2] q="${String(message).slice(0, 60)}" → ${result.places.length}/${result.provenance.candidateCount} in ${ms}ms lex=${result.provenance.lexical} vec=${result.provenance.vector} cacheHit=${result.provenance.cacheHit}`);
            }
        } catch (err) {
            console.error('[v2] retrieval failed:', err.message);
            reply = '🧪 V2: retrieval hit an error (logged server-side). Switch to V1 for real answers.';
        }
    }

    for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
        send(res, { type: 'token', content: chunk });
    }
    send(res, {
        type: 'complete',
        contentParts: [{ type: 'text', content: reply }],
        recommendations: [],
        metadata: meta,
    });
    send(res, { type: 'stream_end' });
    res.end();
});

module.exports = router;
