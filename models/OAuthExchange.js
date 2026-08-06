const mongoose = require('mongoose');

/**
 * Single-use, short-lived handoff for the OAuth token.
 *
 * The Google callback used to redirect with `?token=<JWT>` in the URL — which
 * Caddy logged in plaintext, browsers kept in history, and the browser leaks
 * in the Referer header to any third-party asset the landing page loads. A
 * 7-day token exposed that many ways is an account-takeover waiting to happen.
 *
 * Instead the callback stores the token here under a random `code`, redirects
 * with `?code=<opaque>`, and the frontend swaps the code for the token via a
 * POST once. The code is deleted on first use and expires in 60s regardless,
 * so a leaked code is worthless — it has already been consumed or timed out.
 */
const oauthExchangeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true, index: true },
  token:     { type: String, required: true },
  // TTL index: Mongo deletes the document automatically at this instant, so an
  // unclaimed code cannot linger and the collection cannot grow unbounded.
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

module.exports = mongoose.model('OAuthExchange', oauthExchangeSchema);
