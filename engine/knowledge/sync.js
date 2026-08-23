// Knowledge sync + lookup — turns Wikivoyage and FCDO into OWNED answers.
// (Arsen 2026-08-23: "lets build wikivoyage and fcdo".)
//
// The economics mirror the events hunt: read a source once, store it, and every
// later traveler asking the same thing in that city is served free and
// instantly from your own database. Unlike an API you rent, the store is yours.
//
// Both sources maintain themselves — FCDO republishes advice continuously and
// stamps each page with its own review date; Wikivoyage is edited daily by
// travelers. This module re-reads them on a schedule, so the answers age with
// the sources rather than freezing on the day they were first fetched.
//
// Freshness is per-topic, because volatility is per-topic: entry requirements
// and safety go stale in weeks, while "how the marshrutkas work" holds for
// months. A stale row is never served — it is re-read instead.

const { fetchCityKnowledge } = require('./wikivoyage');
const { fetchAdvisory } = require('./advisories');

const STALE_DAYS = { entry_requirements: 30, safety: 30, health: 60 };
const STALE_DAYS_DEFAULT = 180;
const DAY_MS = 24 * 3600 * 1000;

/** intent.infoAsk (open vocabulary) → the LocalFact topic that answers it. */
function topicFor(infoAskLabel) {
    const l = String(infoAskLabel || '').toLowerCase();
    if (!l) return null;
    if (/visa|entry|passport|border|customs|immigration/.test(l)) return 'entry_requirements';
    if (/safe|danger|crime|scam|protest|risk/.test(l)) return 'safety';
    if (/health|vaccin|medic|hospital|water/.test(l)) return 'health';
    if (/sim|internet|wifi|phone|connect/.test(l)) return 'connect';
    if (/money|currency|cash|atm|tip|exchange/.test(l)) return 'money';
    if (/arriv|airport|get_in/.test(l)) return 'get_in';
    return 'get_around';           // transport and anything movement-shaped
}

function _esc(s) { return String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _row(f, { city, country, tier, now }) {
    const days = STALE_DAYS[f.topic] || STALE_DAYS_DEFAULT;
    return {
        key: `${[city, country].filter(Boolean).join('|').toLowerCase()}|${f.topic}`,
        city: city || null, country: country || null, topic: f.topic,
        title: f.title || null, body: f.body,
        sourceName: f.sourceName, sourceUrl: f.sourceUrl, license: f.license || null,
        tier, caveat: f.caveat || null,
        reviewedAt: f.reviewedAt || null,
        fetchedAt: now, staleAfter: new Date(now.getTime() + days * DAY_MS),
    };
}

/**
 * Read the sources for one place and upsert what they gave.
 * Validator-written rows (tier 'validator') are NEVER overwritten.
 */
async function syncKnowledge({ city = null, country = null } = {}, deps = {}) {
    const LocalFact = deps.LocalFact || require('../../models/LocalFact');
    const now = deps.nowFn ? new Date(deps.nowFn()) : new Date();
    const rows = [];

    if (city) {
        const wv = await (deps.fetchCityKnowledge || fetchCityKnowledge)(city, deps);
        rows.push(...wv.map(f => _row(f, { city, country, tier: 'wikivoyage', now })));
    }
    if (country) {
        const adv = await (deps.fetchAdvisory || fetchAdvisory)(country, deps);
        // Country-wide rows: city stays null so any city in that country matches.
        rows.push(...adv.map(f => _row(f, { city: null, country, tier: 'fcdo', now })));
    }
    if (!rows.length) return { city, country, stored: 0 };

    try {
        await LocalFact.bulkWrite(rows.map(r => ({ updateOne: {
            filter: { key: r.key, tier: { $ne: 'validator' } },
            update: { $set: r, $setOnInsert: { status: 'new' } },
            upsert: true,
        } })), { ordered: false });
    } catch (err) {
        // A duplicate-key race against a validator row is expected and benign.
        if (err.code !== 11000) console.warn(`[knowledge] store failed: ${err.message}`);
    }
    console.log(`[knowledge] ${[city, country].filter(Boolean).join(', ')} → ${rows.length} fact(s) [${rows.map(r => r.topic).join(',')}]`);
    return { city, country, stored: rows.length };
}

/**
 * The serving path: owned facts for this place + question. City rows win over
 * country-wide rows; hidden and STALE rows are never served — a stale entry
 * requirement must be re-read, not repeated.
 */
async function lookupFacts({ city = null, country = null, topic = null, limit = 2 } = {}, deps = {}) {
    if (!topic) return [];
    const LocalFact = deps.LocalFact || require('../../models/LocalFact');
    const now = deps.nowFn ? new Date(deps.nowFn()) : new Date();
    const scopes = [];
    if (city) scopes.push({ city: new RegExp(`^${_esc(city)}$`, 'i') });
    if (country) scopes.push({ city: null, country: new RegExp(`^${_esc(country)}$`, 'i') });
    if (!scopes.length) return [];
    try {
        const rows = await LocalFact.find({
            topic, status: { $ne: 'hidden' }, $or: scopes,
        }).lean();
        const fresh = rows.filter(r => !r.staleAfter || new Date(r.staleAfter) > now);
        // A city row beats a country row; validator > FCDO > Wikivoyage.
        const rank = { validator: 0, fcdo: 1, wikivoyage: 2 };
        fresh.sort((a, b) => (a.city ? 0 : 1) - (b.city ? 0 : 1) || (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9));
        return fresh.slice(0, limit);
    } catch (err) {
        console.warn(`[knowledge] lookup failed: ${err.message}`);
        return [];
    }
}

module.exports = { syncKnowledge, lookupFacts, topicFor, STALE_DAYS };
