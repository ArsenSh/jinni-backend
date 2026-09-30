const mongoose = require('mongoose');

/* Anonymous sign-up funnel (founder 2026-09-30) — in-house, no third-party tag.
 *
 * Why: an Instagram ad brought ~1,371 in-app loads of `/` and ZERO calls to
 * any sign-up endpoint, and "Make a Wish" → /auth is a client-side route, so
 * the server could not tell "left on the landing" from "left on /auth".
 *
 * One document per (UTC day, event, anonymous browser id). The unique index
 * makes a refresh or a double tap count once per day, so a report is simply
 * "distinct browsers that reached this step". No user id, no IP, no UA is
 * stored — `sid` is a random id the browser made up for itself
 * (localStorage `jinni_sid`). Rows expire after ~180 days.
 */
const FUNNEL_EVENTS = [
    'landing_view',        // landing page mounted
    'wish_tap',            // a "Make a Wish" CTA tapped
    'auth_view',           // /auth screen mounted
    'auth_switch_signup',  // switched to (or opened on) Create account
    'signup_start',        // email sign-up form submitted (before send-verification)
    'google_tap',          // Google button tapped (before the redirect)
    'signup_done',         // email verification succeeded → account exists
];

const funnelEventSchema = new mongoose.Schema({
    day: { type: String, required: true },     // 'YYYY-MM-DD' (UTC)
    event: { type: String, required: true, enum: FUNNEL_EVENTS },
    sid: { type: String, required: true, maxlength: 64 },
    source: { type: String, default: 'direct', maxlength: 60 },
    createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

funnelEventSchema.index({ day: 1, event: 1, sid: 1 }, { unique: true });
funnelEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const FunnelEvent = mongoose.models.FunnelEvent || mongoose.model('FunnelEvent', funnelEventSchema);
module.exports = FunnelEvent;
module.exports.FUNNEL_EVENTS = FUNNEL_EVENTS;
