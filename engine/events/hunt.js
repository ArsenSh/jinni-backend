// Jinni V2 Engine — the events HUNT (fresh tier, Arsen sign-off 2026-08-22:
// "then lets build, it is good").
//
// When the owned events shelf is thin for the ASKED window and the admin's
// web-search gate is open, this module goes and fills it: search the web for
// that specific period → fetch pages through the SSRF-guarded fetcher →
// extract ONLY schema.org/Event JSON-LD (a date read off an unstructured page
// would be a guess, and guessed dates are what the events trust ladder
// exists to eliminate) → window-filter → STORE to AiFoundEvent (status 'new',
// validator-moderatable, self-expiring) → return as candidates.
//
// The economics are the point: one hunt costs ~a search query + a few page
// fetches; the RESULTS become owned data, so every later asker for that
// window is served from the DB for free. Search fills the database; the
// database fills the cards — the anti-hallucination invariant holds.

const { searchWeb } = require('../search/webSearch');
const { _extractLdEvents, _normalizeLdEvent } = require('./listing');
const { _fetchListingHtml } = require('../utils/safeFetch');
const { normalizePlaceName } = require('../places/matching');
const { aiEventToCandidate } = require('../places/eventStore');

const MAX_PAGES = 3;     // fetched per hunt (search fallback)
const MAX_CURATED = 8;   // registered sources read per hunt
const MAX_STORE = 12;    // events stored per hunt

function _fmtWindow(win) {
    const f = (d) => new Date(d).toUTCString().slice(5, 16);   // "22 Aug 2026"
    return `${f(win.start)} - ${f(win.end)}`;
}

/**
 * @param {object} args { city, country?, center?, window:{start,end,label} }
 * @param {object} deps { AiFoundEvent?, searchWeb?, fetchHtml?, webSearchCfg?, nowFn? }
 * @returns {Promise<Array>} event candidates (eventStore shape); [] fail-open.
 */
// A hunt query is only as good as its city. Dirty data leaks street numbers
// into city fields (2026-08-23 live: hunted for "events 10/9 …" — the city
// was an address fragment) — letters, spaces and simple punctuation only.
const _CITY_RE = /^[\p{L}][\p{L}\s.'’-]{1,40}$/u;

async function huntEvents({ city, country = null, center = null, window: win } = {}, deps = {}) {
    if (!city || !win) return [];
    if (!_CITY_RE.test(String(city).trim())) {
        console.log(`[hunt] refusing garbage city "${String(city).slice(0, 30)}" — no search`);
        return [];
    }
    const AiFoundEvent = deps.AiFoundEvent || require('../../models/AiFoundEvent');
    const search = deps.searchWeb || searchWeb;
    const fetchHtml = deps.fetchHtml || _fetchListingHtml;

    // Curated sources FIRST (Arsen 2026-08-23: "if there are 8 sources for
    // instance in the location needed claude will not fill that database").
    // Validator-registered pages for this city/country are read directly —
    // free fetches, no paid search. Web search remains only the automatic
    // fallback for locations nobody has curated ("one time claude search").
    const q = `events ${city} ${_fmtWindow(win)}`;
    let curated = [];
    try {
        // Real model only when Mongo is actually connected — a buffering
        // mongoose query would hang the hunt (and every dep-injected test).
        const EventSource = deps.EventSource
            || (require('mongoose').connection.readyState === 1 ? require('../../models/EventSource') : null);
        if (!EventSource) throw Object.assign(new Error('no DB connection'), { _quiet: true });
        const cityRe = new RegExp(`^${String(city).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const or = [{ city: cityRe }];
        if (country) {
            const countryRe = new RegExp(`^${String(country).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
            or.push({ city: null, country: countryRe });
        }
        curated = await EventSource.find({ enabled: true, $or: or }).limit(MAX_CURATED).lean();
    } catch (err) {
        if (!err._quiet) console.warn(`[hunt] source registry unavailable: ${err.message}`);
    }
    const urls = curated.length
        ? curated.map((s) => ({ url: s.url, _sourceId: s._id }))
        : (await search(q, { count: 5, webSearchCfg: deps.webSearchCfg || null })).slice(0, MAX_PAGES);
    if (curated.length) console.log(`[hunt] curated: reading ${curated.length} registered source(s) for ${city} — no web search`);
    if (!urls.length) return [];

    const wStart = new Date(win.start), wEnd = new Date(win.end);
    const found = [];
    const sourceYield = new Map();                    // _sourceId → events read this hunt
    for (const u of urls) {
        const beforeCount = found.length;
        try {
            const html = await fetchHtml(u.url, { timeoutMs: deps.timeoutMs || 10000 });
            if (!html) continue;
            const nodes = _extractLdEvents(html) || [];
            let ldFound = 0;
            for (const raw of nodes) {
                const n = _normalizeLdEvent(raw);
                if (!n.name || !n.startDate) continue;              // undated ⇒ unverifiable ⇒ skip
                const start = new Date(n.startDate);
                const end = n.endDate ? new Date(n.endDate) : null;
                if (Number.isNaN(start.getTime())) continue;
                if (start > wEnd) continue;                          // starts after the asked window
                if ((end || start) < wStart) continue;               // over before it
                found.push({ ...n, startDate: start, endDate: end, sourceUrl: n.url || u.url, _tier: 'listing' });
                ldFound++;
            }
            // No JSON-LD on the page ⇒ the ChatGPT-style READ (Arsen
            // 2026-08-23): the model reads the page text and proposes dated
            // events; code validates dates + window; stored honestly at the
            // 'extracted' trust tier. Armenian event sites rarely publish
            // schema.org — without this tier the hunt starves.
            if (!ldFound && deps.allowExtracted !== false) {
                const { extractEventsFromPage, _reducePage } = require('../search/readPage');
                const page = deps.page || _reducePage(html, u.url);
                if (page) {
                    const extracted = await extractEventsFromPage(page, { city, window: win }, deps);
                    // Posters live on detail pages (og:image), not listing
                    // thumbnails — spend a few extra fetches on events whose
                    // own link the model matched but whose image it couldn't
                    // (allevents.in live 2026-08-23: 7 events, 0 posters).
                    // A listing thumbnail makes a poor card image (Arsen
                    // 2026-08-23: "images little bad quality than in that web")
                    // — tomsarkgh serves 260x146 crops in the list and the full
                    // picture as og:image on the event page. So a
                    // thumbnail-looking URL counts as "no good image yet".
                    const looksThumbnail = (u) => /thumbnail|\/thumb|_thumb|\b\d{2,4}[x_]\d{2,4}\b|small|preview/i.test(String(u || ''));
                    let detailBudget = 6;
                    for (const e of extracted) {
                        if ((!e.image || looksThumbnail(e.image)) && e.url && e.url !== page.url && detailBudget > 0) {
                            detailBudget--;
                            try {
                                const dHtml = await fetchHtml(e.url, { timeoutMs: deps.timeoutMs || 10000 });
                                const og = dHtml && (dHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1];
                                if (og && /^https:\/\//i.test(og)) e.image = og;
                            } catch { /* poster is optional */ }
                        }
                        found.push({ ...e, sourceUrl: e.url || u.url });
                    }
                    // Log the 0 case too — silence here is indistinguishable
                    // from "reader not deployed" (live lesson 2026-08-23).
                    console.log(`[hunt] extracted-tier: +${extracted.length} model-read event(s) from ${String(u.url).slice(0, 60)} (${page.text.length} chars read)`);
                } else {
                    console.log(`[hunt] extracted-tier: no readable text on ${String(u.url).slice(0, 60)} — skipped`);
                }
            }
        } catch (err) {
            console.warn(`[hunt] ${String(u.url).slice(0, 90)}: ${err.message}`);
        }
        if (u._sourceId) sourceYield.set(String(u._sourceId), found.length - beforeCount);
        if (found.length >= MAX_STORE) break;
    }
    // Yield tracking: dead sources become visible in the staff list.
    if (sourceYield.size) {
        try {
            const EventSource = deps.EventSource || require('../../models/EventSource');
            await EventSource.bulkWrite([...sourceYield].map(([id, n]) => ({ updateOne: {
                filter: { _id: id },
                update: { $set: { lastReadAt: new Date(), lastFoundCount: n } },
            } })), { ordered: false });
        } catch { /* bookkeeping only */ }
    }
    if (!found.length) {
        console.log(`[hunt] "${q}" → 0 dated events on ${urls.length} page(s)`);
        return [];
    }

    // Dedupe + store — v1's identity formula (normalizedName|startDay|anchor);
    // hunted rows carry no resolved venue pin yet, so the anchor is the city
    // (they survive the radius filter only on a city match — the Dubai rule).
    const rows = [];
    const seen = new Set();
    for (const e of found.slice(0, MAX_STORE)) {
        const key = `${normalizePlaceName(e.name)}|${e.startDate.toISOString().slice(0, 10)}|${String(city).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ key, e });
    }
    const now = deps.nowFn ? new Date(deps.nowFn()) : new Date();
    const ops = rows.map(({ key, e }) => ({ updateOne: {
        filter: { key },
        update: {
            $setOnInsert: {
                key,
                name: e.name,
                description: null,
                placeId: null, lat: null, lng: null,
                venueName: e.venueName || null,
                address: e.venueAddress || null,
                city, country,
                startDate: e.startDate,
                endDate: e.endDate,
                isRecurring: false,
                image: e.image || null,
                sourceUrl: e.sourceUrl || null,
                sourceTier: e._tier === 'extracted' ? 'extracted' : 'listing',
                status: 'new',
                // Queue self-cleans a week after the event passes (v1 parity).
                expireAt: new Date((e.endDate || e.startDate).getTime() + 7 * 24 * 3600 * 1000),
            },
            $inc: { timesShown: 1 },
            $set: { lastShownAt: now },
        },
        upsert: true,
    } }));
    try {
        await AiFoundEvent.bulkWrite(ops, { ordered: false });
    } catch (err) {
        console.warn(`[hunt] store failed: ${err.message}`);
    }
    console.log(`[hunt] "${q}" → ${rows.length} dated event(s) stored/refreshed from ${urls.length} page(s)`);

    return rows.map(({ e }) => aiEventToCandidate({
        name: e.name, placeId: null, lat: null, lng: null,
        venueName: e.venueName || null, address: e.venueAddress || null,
        city, country, image: e.image || null, sourceUrl: e.sourceUrl || null,
        startDate: e.startDate, endDate: e.endDate, isRecurring: false, description: null,
    }, center));
}

module.exports = { huntEvents };
