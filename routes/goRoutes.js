// routes/goRoutes.js — GET /go/f/:id → 302 to the fare's real booking URL.
// See engine/travel/flightLinks.js for why the narrator never sees the real
// one. Unknown or expired ids get a plain sentence, never a guessed page.
const express = require('express');
const { resolveBookUrl } = require('../engine/travel/flightLinks');

const router = express.Router();

async function fareRedirect(req, res) {
    const url = await resolveBookUrl(req.params.id);
    if (!url) {
        res.status(404).type('text/plain').send('This booking link has expired. Ask Jinni for the fare again to get a fresh one.');
        return;
    }
    res.redirect(302, url);
}

router.get('/f/:id', fareRedirect);

module.exports = router;
module.exports.fareRedirect = fareRedirect;
