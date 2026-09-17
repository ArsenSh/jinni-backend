// Where a sign-up came from (founder 2026-09-18): the standard utm_* fields
// an ad or a post carries, captured by the frontend on the visitor's FIRST
// landing and attached to the account once, so the admin page and the
// marketing report can split sign-ups and returning users by source without
// any third-party tag on the site.
const FIELDS = ['source', 'medium', 'campaign', 'term', 'content', 'landing', 'referrer'];
const MAX = 160;

/** Pure: keep only known string fields, trimmed and capped; null when empty. */
function sanitizeAcquisition(input) {
    if (!input || typeof input !== 'object') return null;
    const out = {};
    for (const k of FIELDS) {
        const v = input[k];
        if (typeof v !== 'string') continue;
        const s = v.trim().slice(0, MAX);
        if (s) out[k] = s;
    }
    if (!out.source && !out.referrer) return null;
    if (!out.source) out.source = hostOf(out.referrer) || 'referral';
    out.source = out.source.toLowerCase();
    if (out.medium) out.medium = out.medium.toLowerCase();
    return out;
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

/** Label used for grouping in reports: "google / yerevan-restaurants". */
function acquisitionLabel(a) {
    if (!a || !a.source) return 'direct';
    return a.campaign ? `${a.source} / ${a.campaign}` : a.source;
}

module.exports = { sanitizeAcquisition, acquisitionLabel, FIELDS };
