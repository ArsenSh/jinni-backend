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

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

router.post('/chat-stream-v2', auth, usageTracker, async (req, res) => {
    const { message } = req.body || {};
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

    // Honest status, streamed as ordinary tokens so the bubble renders normally.
    const reply =
        '🧪 V2 engine (beta scaffold).\n\n'
      + 'Your message reached /chat-stream-v2 — the toggle and streaming plumbing work. '
      + 'The new engine is being built in parallel: matching, events machinery, the '
      + 'context engine (open-now / time-of-day) and the retrieval core are done and '
      + 'tested; the Mongo data wiring and the narrator come next. Until then, switch '
      + 'back to V1 for real answers.';
    for (const chunk of reply.match(/.{1,60}(\s|$)/gs) || [reply]) {
        send(res, { type: 'token', content: chunk });
    }
    send(res, {
        type: 'complete',
        contentParts: [{ type: 'text', content: reply }],
        recommendations: [],
        metadata: { engine: 'v2', build: 'scaffold', timestamp: new Date() },
    });
    send(res, { type: 'stream_end' });
    res.end();
});

module.exports = router;
