// UK FCDO travel advice via the GOV.UK Content API — entry requirements and
// safety, the highest-harm questions a travel assistant can be asked.
// (Arsen 2026-08-23: "lets build wikivoyage and fcdo".)
//
// WHY this source over the visa datasets on GitHub: every open passport-index
// dataset is scraped from one site, keyed on nationality alone, and the most
// widely used one has had no data commit since January 2025. None can express
// passport-validity rules, residence permits, transit or "pending" — and a
// wrong visa answer costs someone a flight. FCDO publishes structured, current,
// official prose WITH its own review date, under the Open Government Licence
// (commercial use permitted with attribution).
//
// THE CAVEAT IS PART OF THE DATA: FCDO advice is written for British citizens.
// Every row carries that caveat so the answer says so out loud instead of
// implying it applies to an Armenian or Emirati passport.

const axios = require('axios');

const BASE = 'https://www.gov.uk/api/content/foreign-travel-advice';
const HUMAN = 'https://www.gov.uk/foreign-travel-advice';
const UA = 'JinniTravelBot/1.0 (+https://jinni.travel; travel assistant)';
const TIMEOUT_MS = 10000;
const MAX_BODY = 4000;
const BRITISH_CAVEAT = 'UK government advice, written for British passport holders — rules differ by nationality, so confirm with the destination\'s own immigration authority.';

// Parts of the FCDO document we keep, mapped to our topics.
const PART_TOPICS = [
    { slug: 'entry-requirements', topic: 'entry_requirements' },
    { slug: 'safety-and-security', topic: 'safety' },
    { slug: 'health', topic: 'health' },
];

function _countrySlug(country) {
    return String(country || '').trim().toLowerCase()
        .replace(/^the\s+/, '').replace(/[^a-z\s-]/g, '').replace(/\s+/g, '-');
}

function _htmlToText(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Entry requirements + safety + health for one country.
 * @returns {Promise<Array>} [] fail-open (unknown country ⇒ 404 ⇒ []).
 */
async function fetchAdvisory(country, deps = {}) {
    const slug = _countrySlug(country);
    if (!slug) return [];
    try {
        const get = deps.get || axios.get;
        const res = await get(`${BASE}/${slug}`, {
            timeout: deps.timeoutMs || TIMEOUT_MS,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        const d = res?.data;
        const parts = d?.details?.parts;
        if (!Array.isArray(parts)) return [];
        const reviewedAt = d.details?.reviewed_at || d.public_updated_at || null;
        // A machine-readable severity enum, e.g. ['avoid_all_travel_to_parts'].
        const alertStatus = Array.isArray(d.details?.alert_status) ? d.details.alert_status : [];
        const title = d.title || country;

        const out = [];
        for (const { slug: partSlug, topic } of PART_TOPICS) {
            const part = parts.find(p => p?.slug === partSlug);
            if (!part) continue;
            const body = _htmlToText(part.body).slice(0, MAX_BODY);
            if (body.length < 120) continue;
            out.push({
                topic,
                title: `${title} — ${part.title || partSlug}`,
                body,
                sourceName: 'UK FCDO',
                sourceUrl: `${HUMAN}/${slug}`,
                license: 'Open Government Licence v3.0',
                caveat: BRITISH_CAVEAT,
                reviewedAt: reviewedAt ? new Date(reviewedAt) : null,
                alertStatus,
            });
        }
        return out;
    } catch (err) {
        if (err.response?.status !== 404) console.warn(`[fcdo] ${slug}: ${err.message}`);
        return [];
    }
}

module.exports = { fetchAdvisory, _htmlToText, _countrySlug, BRITISH_CAVEAT, PART_TOPICS };
