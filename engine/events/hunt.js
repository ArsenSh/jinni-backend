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
const { haversineKm } = require('../utils/geo');
const { pickAdapter: _pickAdapter, runAdapter: _runAdapter } = require('./adapters');
const { renderPage: _renderPage, renderAvailable: _renderAvailable } = require('../utils/render');

const MAX_PAGES = 3;     // fetched per hunt (search fallback)
const MAX_CURATED = 8;   // registered sources read per hunt
const MAX_STORE = 12;    // events stored per hunt
const DEAD_READS = 3;    // empty reads before a DISCOVERED source switches itself off
const MAX_RENDERS = 2;   // browser renders per hunt — seconds each, so escalate, never start here

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

/** Does this HTML carry anything a reader could call a date? Cheap and
 *  deliberately loose — it only decides whether a render is worth trying. */
function _datedish(html) {
    const s = String(html || '');
    return /"startDate"|itemprop=["']startDate|data-stime=|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+\d{4}/i.test(s);
}

/** Follow each event to ITS OWN page for the facts a listing does not carry.
 *
 *  Listing pages carry teasers; the event page carries the machine-readable
 *  truth — exact start, ticket price, venue, full poster. Proven live
 *  2026-08-24: tomsarkgh's listing exposes NO structured data and its event
 *  page exposes all of it. Site-agnostic, because that is simply where
 *  publishers put it.
 *
 *  Shared by the model-read tier AND by adapters: an adapter reads a listing,
 *  so without this its events would arrive with no venue (and therefore no map
 *  pin) and no price. Budgeted, and any failure leaves the listing data intact.
 */
// A listing thumbnail makes a poor card image (Arsen 2026-08-23: "images
// little bad quality than in that web") — tomsarkgh serves 260x146 crops in
// the list and the full picture as og:image on the event page. So a
// thumbnail-looking URL counts as "no good image yet".
const _looksThumbnail = (u) => /thumbnail|\/thumb|_thumb|\b\d{2,4}[x_]\d{2,4}\b|small|preview/i.test(String(u || ''));

async function _followDetails(rows, { fetchHtml, pageUrl, timeoutMs = 10000, budget = 6 } = {}) {
    const { _structuredFromHtml } = require('../search/readPage');
    for (const e of rows) {
        const wantPoster = !e.image || _looksThumbnail(e.image);
        const wantFacts = !e.price || !e.startDate || !e.venueName
            || (e.startDate.getUTCHours() === 0 && e.startDate.getUTCMinutes() === 0);
        if (!(wantPoster || wantFacts) || !e.url || e.url === pageUrl || budget <= 0) continue;
        budget--;
        try {
            const dHtml = await fetchHtml(e.url, { timeoutMs });
            if (!dHtml) continue;
            if (wantPoster) {
                const og = (dHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1];
                if (og && /^https:\/\//i.test(og)) e.image = og;
            }
            const day = e.startDate.toISOString().slice(0, 10);
            const all = _structuredFromHtml(dHtml);
            const hit = all.find(o => o.day === day) || all[0];
            if (!hit) continue;
            const noTime = e.startDate.getUTCHours() === 0 && e.startDate.getUTCMinutes() === 0;
            if (hit.time && noTime) {
                e.startDate = new Date(`${day}T${hit.time}:00Z`);
                console.log(`[hunt] detail page gave "${String(e.name).slice(0, 40)}" an exact start ${hit.time}`);
            }
            if (hit.price && !e.price) e.price = hit.price;
            // A truncated venue is worse than no venue: it blocked the full
            // name the detail page was offering.
            if (hit.venue && (!e.venueName || _cleanVenue(e.venueName).truncated)) e.venueName = hit.venue;
        } catch { /* the listing data still stands */ }
    }
    return rows;
}

/** A venue name as the LISTING GRID showed it — which is often cut short.
 *
 *  tomsarkgh clips long venue names in its cards, the model faithfully copies
 *  what it can see, and we stored the clipping: "State theatre of musical
 *  comedy after...", "Drama Theatre named after Hrachya Gha...". That string
 *  then went to Google as a search query and onto the card as the location
 *  (Arsen 2026-08-24).
 *
 *  The ellipsis is dropped along with the word it interrupted — a half word
 *  hurts a search more than it helps. `truncated` tells callers the name is a
 *  PREFIX, so a fuller one from the detail page or from Google may replace it.
 */
function _cleanVenue(raw) {
    const v = String(raw || '').trim();
    if (!v) return { name: null, truncated: false };
    const m = v.match(/^(.*?)[\s]*(?:…|\.\.\.)$/);
    if (!m) return { name: v, truncated: false };
    // Drop the interrupted word, then any dangling connective it left behind.
    const cut = m[1].replace(/\s+\S*$/, '').replace(/[\s,;:–—-]+$/, '').trim();
    return cut.length >= 3 ? { name: cut, truncated: true } : { name: null, truncated: true };
}

/** Pin each event to its VENUE on the map, once, at storage time.
 *
 *  A hunted event stores lat/lng null, so the recommendation map had nothing to
 *  plot and simply skipped every event (Arsen 2026-08-24: "the map ... is not
 *  showing location from jinnievents"). Get Directions still worked, because
 *  that opens the address as TEXT — which is the tell that the address was
 *  known and only the coordinates were missing.
 *
 *  Resolved per unique VENUE, not per event: one theatre hosts many nights, so
 *  a dozen events usually cost two or three lookups. A hit is accepted only if
 *  it lands near the city we hunted — a "Bohem theatre" somewhere else on earth
 *  is a worse answer than no pin at all.
 */
const VENUE_PIN_MAX = 6;          // venue lookups per hunt
const VENUE_PIN_MAX_KM = 80;      // a pin further out than this is the wrong place

async function _pinVenues(rows, { city, center }, deps) {
    const byVenue = new Map();
    for (const { e } of rows) {
        const { name, truncated } = _cleanVenue(e.venueName);
        e.venueName = name;                       // never store or show an ellipsis
        e._venueTruncated = truncated;
        if (!name || e.lat != null) continue;
        if (!byVenue.has(name)) byVenue.set(name, []);
        byVenue.get(name).push(e);
    }
    // Cleaning happens even when we cannot geocode — an ellipsis must never be
    // stored or shown, whatever else fails.
    const finder = deps.findPlaces
        || (() => { try { return require('../../services/googleService').findPlaces; } catch { return null; } })();
    if (typeof finder !== 'function') return;

    let budget = VENUE_PIN_MAX, pinned = 0;
    for (const [venue, events] of byVenue) {
        if (budget-- <= 0) break;
        try {
            const hit = (await finder(`${venue}, ${city}`, center || null))[0];
            const loc = hit?.geometry?.location;
            if (!loc || loc.lat == null) continue;
            if (center && haversineKm(center.lat, center.lng, loc.lat, loc.lng) > VENUE_PIN_MAX_KM) {
                console.log(`[hunt] venue "${venue}" resolved far from ${city} — leaving it unpinned`);
                continue;
            }
            for (const e of events) {
                e.lat = loc.lat; e.lng = loc.lng; e.venuePlaceId = hit.place_id || null;
                // Our name was a prefix; Google's is the whole thing. Adopting it
                // fixes the card's location line as well as the pin.
                if (e._venueTruncated && hit.name) e.venueName = hit.name;
            }
            pinned += events.length;
        } catch { /* a venue we cannot place stays unpinned, which is honest */ }
    }
    if (pinned) console.log(`[hunt] pinned ${pinned} event(s) to ${byVenue.size} venue(s) — they can appear on the map now`);
}

/** Search results, confined to the domains discovery actually verified.
 *
 *  Left unconfined, the Dubai search returned a Gulf News article and a
 *  government press release — so four "events" arrived with no times, no
 *  posters and one shared source link (live 2026-08-24). A newspaper writing
 *  ABOUT events is not an event listing. With nothing verified we cannot
 *  filter, and unrestricted search is still better than nothing.
 */
function _onlyVerified(results, domains, city) {
    const list = results || [];
    if (!domains || !domains.length) return list;
    const ok = new Set(domains.map(d => String(d).toLowerCase().replace(/^www\./, '')));
    const kept = list.filter((r) => {
        try {
            const h = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
            return ok.has(h) || [...ok].some(d => h.endsWith(`.${d}`));
        } catch { return false; }
    });
    // Filtering to nothing is worse than not filtering: Tbilisi kept 0/5 and
    // the city returned no events at all (live 2026-08-24). A confinement that
    // empties the deck has stopped being a quality gate.
    if (!kept.length) {
        console.log(`[hunt] search for ${city}: no result on a verified domain — reading all ${list.length} rather than none`);
        return list;
    }
    if (kept.length !== list.length) {
        console.log(`[hunt] search for ${city}: kept ${kept.length}/${list.length} result(s) on verified domains`);
    }
    return kept;
}

/** Drop feeds a human already disabled for this city. Discovery has no memory
 *  of a validator's decision, and re-reading a page someone switched off would
 *  quietly overrule them. */
async function _dropDisabled(feeds, city, deps) {
    if (!feeds.length) return feeds;
    try {
        const EventSource = deps.EventSource
            || (require('mongoose').connection.readyState === 1 ? require('../../models/EventSource') : null);
        if (!EventSource) return feeds;
        const rows = await EventSource.find({ url: { $in: feeds.map(f => f.url) }, enabled: false }).select('url').lean();
        const off = new Set(rows.map(r => r.url));
        const kept = feeds.filter(f => !off.has(f.url));
        if (kept.length !== feeds.length) console.log(`[hunt] skipping ${feeds.length - kept.length} source(s) disabled by staff for ${city}`);
        return kept;
    } catch { return feeds; }
}

/** Write the productive discoveries into the registry, so the NEXT question
 *  about this city reads them directly and costs nothing. `enabled` and
 *  `discoveredAt` are insert-only: a later hunt must never flip a source a
 *  validator turned off back on. */
async function _registerDiscovered(sources, city, country, deps) {
    if (!sources.length) return;
    try {
        const EventSource = deps.EventSource
            || (require('mongoose').connection.readyState === 1 ? require('../../models/EventSource') : null);
        if (!EventSource) return;
        await EventSource.bulkWrite(sources.map(s => ({ updateOne: {
            filter: { url: s.url, city },
            update: {
                $set: { country: country || null, lastReadAt: new Date(), lastFoundCount: s.count },
                $setOnInsert: { name: `${s.label} · ${city}`, url: s.url, city, enabled: true, discoveredAt: new Date(), addedBy: null },
            },
            upsert: true,
        } })), { ordered: false });
        console.log(`[hunt] registered ${sources.length} source(s) for ${city} — next hunt reads them free: ${sources.map(s => `${s.label}(${s.count})`).join(', ')}`);
    } catch (err) {
        console.warn(`[hunt] registering discovered sources failed: ${err.message}`);
    }
}

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
    // Nobody has curated this city yet (Dubai, live 2026-08-24). Before paying
    // for a search, DISCOVER its sources: the model proposes the sites that
    // list events there, and code verifies each one — DNS, fetchability, that
    // the page actually names this city, and that it publishes schema.org
    // events. Survivors are registered below, so the city is curated from the
    // second question onward and every later hunt is a free read.
    let discovered = [], verifiedDomains = [];
    if (!curated.length && country) {
        try {
            const discover = deps.discoverEventSources || require('./discovery').discoverEventSources;
            const found = (await discover(country, city)) || {};
            verifiedDomains = found.domains || [];
            discovered = await _dropDisabled((found.feeds || []).slice(0, MAX_CURATED), city, deps);
            if (discovered.length) console.log(`[hunt] discovered ${discovered.length} source(s) for ${city}: ${discovered.map(f => f.label).join(', ')}`);
        } catch (err) {
            console.warn(`[hunt] discovery for ${city} failed: ${err.message} — falling back to search`);
        }
    }
    const urls = curated.length
        ? curated.map((s) => ({ url: s.url, _sourceId: s._id, _adapter: s.adapter || null }))
        : (discovered.length
            ? discovered.map((f) => ({ url: f.url, _discovered: f }))
            : _onlyVerified(await search(q, { count: 5, webSearchCfg: deps.webSearchCfg || null }), verifiedDomains, city).slice(0, MAX_PAGES));
    if (curated.length) console.log(`[hunt] curated: reading ${curated.length} registered source(s) for ${city} — no web search`);
    if (!urls.length) return [];

    const wStart = new Date(win.start), wEnd = new Date(win.end);
    const found = [];
    const sourceYield = new Map();                    // _sourceId → events read this hunt
    const newSources = [];                            // discovered pages that actually produced events
    let renderBudget = MAX_RENDERS;
    for (const u of urls) {
        const beforeCount = found.length;
        try {
            let html = await fetchHtml(u.url, { timeoutMs: deps.timeoutMs || 10000 });
            if (!html) continue;
            // A listing with no dated events in its plain HTML is either empty
            // or JavaScript. One render tells us which — budgeted, and only
            // after the cheap read has already come back with nothing.
            if (renderBudget > 0 && !_datedish(html) && (deps.renderAvailable || _renderAvailable)()) {
                renderBudget--;
                const rendered = await (deps.renderPage || _renderPage)(u.url);
                if (rendered && _datedish(rendered)) {
                    console.log(`[hunt] rendered ${String(u.url).slice(0, 60)} — the plain HTML carried no dates`);
                    html = rendered;
                }
            }

            // A site-specific adapter, when this source names one or when one
            // declares this host. It reads per event BLOCK, so a title cannot
            // borrow its neighbour's link, poster or start time — the failure
            // the generic path had on allevents (live 2026-08-24). Returning
            // nothing is not an answer: the generic ladder then runs as usual,
            // so a stale adapter degrades the result and never deletes one.
            const adapter = (deps.pickAdapter || _pickAdapter)(u.url, u._adapter || null);
            if (adapter) {
                const rows = (deps.runAdapter || _runAdapter)(adapter, html, { url: u.url, city });
                // An adapter reads a LISTING, so its events still need the
                // event page for venue, price and the full poster — without
                // this they would arrive unpinnable and priceless.
                if (rows.length) await _followDetails(rows, { fetchHtml, pageUrl: u.url, timeoutMs: deps.timeoutMs });
                let kept = 0;
                for (const e of rows) {
                    if (e.startDate > wEnd) continue;
                    if ((e.endDate || e.startDate) < wStart) continue;
                    found.push({ ...e, sourceUrl: e.url || u.url, _tier: 'listing' });
                    kept++;
                }
                if (kept) {
                    console.log(`[hunt] adapter ${adapter.name}: ${kept} event(s) from ${String(u.url).slice(0, 60)}`);
                    if (u._sourceId) sourceYield.set(String(u._sourceId), found.length - beforeCount);
                    if (u._discovered) newSources.push({ ...u._discovered, count: found.length - beforeCount });
                    if (found.length >= MAX_STORE) break;
                    continue;
                }
                console.log(`[hunt] adapter ${adapter.name} read nothing from ${String(u.url).slice(0, 60)} — falling back to the generic reader`);
            }

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
                    await _followDetails(extracted, { fetchHtml, pageUrl: page.url, timeoutMs: deps.timeoutMs });
                    for (const e of extracted) found.push({ ...e, sourceUrl: e.url || u.url });
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
        // A discovered page earns its registry row by PRODUCING dated events on
        // the turn it was found — never by merely being proposed or fetched.
        if (u._discovered && found.length > beforeCount) newSources.push({ ...u._discovered, count: found.length - beforeCount });
        if (found.length >= MAX_STORE) break;
    }
    await _registerDiscovered(newSources, city, country, deps);
    // Yield tracking, and the pruner. A source that reads nothing is visible in
    // the staff list; a DISCOVERED one that reads nothing DEAD_READS times in a
    // row switches itself off. Staff-registered sources only ever get the
    // counter — turning off a human's choice is not the machine's call.
    if (sourceYield.size) {
        try {
            const EventSource = deps.EventSource || require('../../models/EventSource');
            await EventSource.bulkWrite([...sourceYield].map(([id, n]) => ({ updateOne: {
                filter: { _id: id },
                update: n > 0
                    ? { $set: { lastReadAt: new Date(), lastFoundCount: n, zeroStreak: 0 } }
                    : { $set: { lastReadAt: new Date(), lastFoundCount: 0 }, $inc: { zeroStreak: 1 } },
            } })), { ordered: false });
            const dead = [...sourceYield].filter(([, n]) => n === 0).map(([id]) => id);
            if (dead.length) {
                const off = await EventSource.updateMany(
                    { _id: { $in: dead }, discoveredAt: { $ne: null }, zeroStreak: { $gte: DEAD_READS } },
                    { $set: { enabled: false, disabledReason: `no events in ${DEAD_READS} consecutive reads` } },
                );
                if (off?.modifiedCount) console.log(`[hunt] switched off ${off.modifiedCount} discovered source(s) that keep reading empty`);
            }
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
    await _pinVenues(rows, { city, center }, deps);
    const now = deps.nowFn ? new Date(deps.nowFn()) : new Date();
    const ops = rows.map(({ key, e }) => ({ updateOne: {
        filter: { key },
        update: {
            $setOnInsert: {
                key,
                name: e.name,
                description: null,
                placeId: e.venuePlaceId || null, lat: e.lat ?? null, lng: e.lng ?? null,
                venueName: e.venueName || null,
                address: e.venueAddress || null,
                city, country,
                startDate: e.startDate,
                endDate: e.endDate,
                isRecurring: false,
                image: e.image || null,
                price: e.price || null,
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
        city, country, image: e.image || null, price: e.price || null, sourceUrl: e.sourceUrl || null,
        startDate: e.startDate, endDate: e.endDate, isRecurring: false, description: null,
    }, center));
}

module.exports = { huntEvents, _cleanVenue, _onlyVerified };
