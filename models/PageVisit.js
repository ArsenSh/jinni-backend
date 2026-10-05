const mongoose = require('mongoose');

/* Anonymous public-page visits (founder 2026-10-06: "which url users used most
 * in last 7 days and in last 30 days" — the admin Overview's Most Used Pages
 * card). Same privacy rules as FunnelEvent: one document per (UTC day, page,
 * anonymous browser id); no user id, no IP, no UA. `sid` is the browser's own
 * random id (localStorage `jinni_sid`, shared with the funnel). Signed-in app
 * sections come from UserActivity instead — these are the pages anyone can
 * open without an account. Rows expire after ~180 days.
 */
const PAGE_KEYS = [
    'discover',   // /discover/<city> (and /ru/discover/<city>)
    'guide',      // /@<handle> — a guide's own page
    'guides',     // /guides — the guide programme page
    'business',   // /business — the business landing
];

const pageVisitSchema = new mongoose.Schema({
    day: { type: String, required: true },     // 'YYYY-MM-DD' (UTC)
    page: { type: String, required: true, enum: PAGE_KEYS },
    sid: { type: String, required: true, maxlength: 64 },
    source: { type: String, default: 'direct', maxlength: 60 },
    createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

pageVisitSchema.index({ day: 1, page: 1, sid: 1 }, { unique: true });
pageVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const PageVisit = mongoose.models.PageVisit || mongoose.model('PageVisit', pageVisitSchema);
module.exports = PageVisit;
module.exports.PAGE_KEYS = PAGE_KEYS;
