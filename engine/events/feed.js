// Jinni V2 Engine — ticketing index feeds + language-free normalization.
// COPIED from routes/aiRoutes.js (v1, lines ~4774–5004) per the copy-not-cut rule
// (engine/ENGINE.md). Deviations: imports from engine modules; AppConfig and
// claudeService are required LAZILY inside the model-calling functions, so jest
// can import this module without booting Mongoose or the Anthropic SDK.

const { _fetchListingHtml, _fetchUnavailable } = require('../utils/safeFetch');
const { _extractLdEvents, _normalizeLdEvent, _htmlToText } = require('./listing');
const { cleanEventTitle, _extractOgImage } = require('./matching');
const { EVENT_FEED_SOURCES, EVENT_TAG_VOCABULARY } = require('./sources');
const { discoverEventSources } = require('./discovery');

/* ═══════════════════════ Ticketing index feeds ════════════════════════════
 * The cheapest good data in this pipeline, and the answer to the cost problem.
 *
 * Events web-search on EVERY tap (not just the first), at roughly $0.05–0.07 a
 * tap once the ~18k tokens of injected search results are counted. That is per
 * user, per tap, forever — the one part of this app whose cost grows linearly
 * with success. And it buys unreliable dates: the model put the Shéné concert
 * three weeks early and Blessing of Grapes a day early.
 *
 * ticket-am.com publishes its whole upcoming schedule as schema.org/Event
 * JSON-LD, in ENGLISH at /en/, with exact start times, real venue names and
 * official poster art. One HTTP GET. No tokens, no web searches, no model
 * recall. Cached process-wide and shared by ALL users — cost does not scale
 * with traffic at all.
 *
 * Used two ways: to CORRECT an AI event whose date the model guessed at, and
 * to SUPPLY events outright. Confined to the country each source covers.
 */

/* ═══════════════ Language-free canonicalization (the normalizer) ═══════════
 * THE architectural rule: identity is never words (it is coords + day + URL),
 * and linguistics belongs to the MODEL, once, at ingestion — never to regexes
 * at request time. The English regex layer (cleanEventTitle, _EVENT_STOPWORDS)
 * only ever worked in English; every non-Latin market walked around it. These
 * two functions replace that layer for any language, at one small model call
 * per SOURCE per refresh — shared by every user, so per-user AI cost stays 0.
 * The regexes remain only as the degradation path when the model call fails.
 *
 * The model handles ONLY language (titles, tags, price text). Dates, URLs and
 * coordinates are code-owned: the normalizer is never even shown a date it
 * could corrupt, and the extractor's dates are code-validated or dropped —
 * an unparseable date is a guess, and a guess never renders as fact. */

/** One call per feed refresh: English titles + canonical tags for any language. */
async function normalizeEventBatch(sourceLabel, events) {
    if (!events.length) return events;
    try {
        const AppConfig = require('../../models/AppConfig');
        const claudeService = require('../../services/claudeService');
        const cfg = await AppConfig.getConfig();
        const payload = events.map((e, i) => ({ i, name: e.rawName || e.name, venue: e.venueName || null }));
        const res = await claudeService.complete({
            model: cfg.claudeModel, maxTokens: 1500, temperature: 0,
            system: 'You return only JSON. No prose, no markdown fences.',
            messages: [{ role: 'user', content:
                `For each event give a concise English title (drop ticket-shop wording like "Tickets for") `
              + `and tags chosen ONLY from: ${EVENT_TAG_VOCABULARY.join(', ')}. `
              + `Events (any language): ${JSON.stringify(payload)}. `
              + `Reply ONLY a JSON array [{"i":0,"en":"...","tags":["music"]}]. Do not add or remove events.` }]
        });
        const arr = JSON.parse((String(res?.text || '').match(/\[[\s\S]*\]/) || ['[]'])[0]);
        const byI = new Map((Array.isArray(arr) ? arr : []).filter(x => x && Number.isInteger(x.i)).map(x => [x.i, x]));
        let applied = 0;
        events.forEach((e, i) => {
            const n = byI.get(i); if (!n) return;
            const en = typeof n.en === 'string' && n.en.trim() ? n.en.trim().slice(0, 120) : null;
            const tags = Array.isArray(n.tags) ? n.tags.filter(t => EVENT_TAG_VOCABULARY.includes(t)).slice(0, 6) : [];
            if (en) { e.names = { original: e.rawName || e.name, en }; e.name = en; applied++; }
            if (tags.length) e.tags = tags;
        });
        console.log(`[normalize] ${sourceLabel}: ${applied}/${events.length} titled+tagged in one shared call`);
    } catch (err) {
        console.warn(`[normalize] ${sourceLabel} failed (${err.message}) — regex-cleaned titles stand in`);
    }
    return events;
}

/* Server-rendered sites with no JSON-LD (tomsarkgh) still print every event in
 * their visible text — name, date, venue, price, in their own language. The
 * model reads that text once per refresh; CODE then validates every date and
 * drops anything unparseable or out of range. Provenance 'extracted' sits one
 * trust tier below a structured feed: it may fill holes, never overwrite. */
async function extractEventsFromPage(source, html) {
    const text = _htmlToText(html);
    if (text.length < 200) return [];
    const AppConfig = require('../../models/AppConfig');
    const claudeService = require('../../services/claudeService');
    const cfg = await AppConfig.getConfig();
    const today = new Date().toISOString().slice(0, 10);
    const res = await claudeService.complete({
        model: cfg.claudeModel, maxTokens: 2000, temperature: 0,
        system: 'You return only JSON. No prose, no markdown fences.',
        messages: [{ role: 'user', content:
            `Visible text of ${source.label}, an event-listing page (any language). Today is ${today}. `
          + `List ONLY events explicitly present with an explicit date — never invent or guess. `
          + `Reply ONLY a JSON array [{"original":"<title as written>","en":"<concise English title>","date":"YYYY-MM-DD","endDate":null,"venue":"<as written or null>","priceMin":null,"priceMax":null,"currency":null,"tags":[only from: ${EVENT_TAG_VOCABULARY.join(',')}]}].\n\n${text}` }]
    });
    const arr = JSON.parse((String(res?.text || '').match(/\[[\s\S]*\]/) || ['[]'])[0]);
    const out = [];
    const minT = Date.now() - 86400000, maxT = Date.now() + 366 * 86400000;
    for (const e of (Array.isArray(arr) ? arr : [])) {
        if (!e || typeof e.en !== 'string' || !e.en.trim()) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
        const t = Date.parse(e.date + 'T00:00:00.000Z');
        if (!Number.isFinite(t) || t < minT || t > maxT) continue;
        const end = /^\d{4}-\d{2}-\d{2}$/.test(e.endDate || '') ? e.endDate + 'T00:00:00.000Z' : null;
        out.push({
            name: e.en.trim().slice(0, 120), rawName: (e.original || e.en).trim(),
            names: { original: (e.original || e.en).trim(), en: e.en.trim() },
            startDate: e.date + 'T00:00:00.000Z', ...(end ? { endDate: end } : {}),
            image: null, url: source.url,
            venueName: typeof e.venue === 'string' && e.venue.trim() ? e.venue.trim() : null, venueAddress: null,
            tags: Array.isArray(e.tags) ? e.tags.filter(x => EVENT_TAG_VOCABULARY.includes(x)).slice(0, 6) : [],
            price: Number.isFinite(e.priceMin)
                ? { min: e.priceMin, max: Number.isFinite(e.priceMax) ? e.priceMax : e.priceMin, currency: typeof e.currency === 'string' ? e.currency.slice(0, 3).toUpperCase() : null }
                : null,
            provenance: 'extracted', feedLabel: source.label
        });
    }
    console.log(`[extract] ${source.label}: ${out.length} dated event(s) read from page text (model-read, code-validated)`);
    return out;
}

const EVENT_FEED_TTL_MS = 30 * 60 * 1000;   // a ticketing schedule moves in days, not minutes
const _eventFeedCache = new Map();          // url → { at, events }

/**
 * Upcoming events from one ticketing index, normalized to the shape the event
 * pipeline already uses. Never throws — a dead feed degrades to [].
 */
async function getEventFeed(source) {
    const hit = _eventFeedCache.get(source.url);
    if (hit && (Date.now() - hit.at) < EVENT_FEED_TTL_MS) return hit.events;
    if (_fetchUnavailable) return [];

    let events = [];
    try {
        const html = await _fetchListingHtml(source.url);
        if (html && source.mode === 'extract') {
            events = await extractEventsFromPage(source, html);
        } else if (html) {
            events = _extractLdEvents(html)
                .map(_normalizeLdEvent)
                .filter(e => e.name && e.startDate)
                .map(e => ({ ...e, rawName: e.name, name: cleanEventTitle(e.name), feedLabel: source.label }));

            /* Posters: the index JSON-LD carries an image for only a couple of
             * events, so most cards fell back to the VENUE's Google photo — a
             * generic building where the official artwork exists. Each event's
             * own page has it in og:image, so fill the gaps from there.
             *
             * Done once per feed refresh (every 30 min, shared by ALL users),
             * not per request, and bounded to 4 at a time. Still $0 in AI. */
            const missing = events.filter(e => !e.image && e.url).slice(0, 20);
            if (missing.length) {
                const queue = missing.slice();
                let found = 0;
                const worker = async () => {
                    while (queue.length) {
                        const ev = queue.shift();
                        try {
                            const page = await _fetchListingHtml(ev.url);
                            if (page) { const og = _extractOgImage(page); if (og) { ev.image = og; found++; } }
                        } catch { /* a missing poster is not worth failing over */ }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
                console.log(`[feed] ${source.label}: ${found}/${missing.length} poster(s) recovered from event pages`);
            }
            // Language work happens HERE, once per refresh — not per request.
            events = await normalizeEventBatch(source.label, events);
        }
        console.log(`[feed] ${source.label}: ${events.length} upcoming event(s) (cached ${Math.round(EVENT_FEED_TTL_MS / 60000)} min, shared by all users, $0 in AI)`);
    } catch (err) {
        console.warn(`[feed] ${source.label} unavailable: ${err.message}`);
        events = [];
    }
    // Cache even an empty result, so a broken feed is retried on the TTL rather
    // than on every single tap.
    _eventFeedCache.set(source.url, { at: Date.now(), events });
    return events;
}

/** Every feed covering the country the user is actually in. */
async function getEventFeedsForLocation(userRegion, effectiveLocation, destinationInfo) {
    const hay = [userRegion?.country, destinationInfo?.country, effectiveLocation?.country]
        .filter(Boolean).map(s => String(s).toLowerCase().trim());
    if (!hay.length) return [];
    // Hand-registered sources first, then anything discovery verified for this
    // country — so a new market gets free feeds without a code change.
    let sources = EVENT_FEED_SOURCES.filter(s => s.countries.some(c => hay.includes(c)));
    if (userRegion?.country) {
        try {
            const found = (await discoverEventSources(userRegion.country, userRegion.city)).feeds || [];
            const known = new Set(sources.map(s => s.label));
            sources = sources.concat(found.filter(f => !known.has(f.label)));
        } catch { /* discovery is an optimisation, never a dependency */ }
    }
    if (!sources.length) return [];   // no source here — the AI path is unchanged
    const lists = await Promise.all(sources.map(s => getEventFeed(s)));
    return lists.flat();
}

module.exports = {
    getEventFeed,
    getEventFeedsForLocation,
    normalizeEventBatch,
    extractEventsFromPage,
    EVENT_FEED_TTL_MS,
};
