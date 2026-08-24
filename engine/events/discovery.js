// Jinni V2 Engine — automatic per-country event-source discovery.
// COPIED from routes/aiRoutes.js (v1, lines ~5027–5269) per the copy-not-cut rule
// (engine/ENGINE.md). Deviations: imports from engine modules; AppConfig and
// claudeService are required LAZILY inside the functions that use them, so jest
// can import this module without booting Mongoose or the Anthropic SDK.

const { _assertPublicHttpUrl, _fetchListingHtml, _fetchUnavailable } = require('../utils/safeFetch');
const { _extractLdEvents, _normalizeLdEvent } = require('./listing');
const { EVENT_FEED_SOURCES, KNOWN_EVENT_SEARCH_DOMAINS } = require('./sources');

/* ═══════════ Automatic per-country event-source discovery ═════════════════
 * A hand-typed domain allowlist only ever covers one country. The moment the
 * app is opened in Tbilisi or Paris it either blocks everything useful or has
 * to be extended by hand, forever — and this app is used worldwide.
 *
 * So the sources are DISCOVERED, once per country, and then reused:
 *
 *   1. ask the model which sites list events in that country (one small call,
 *      no web search, ~100 tokens);
 *   2. VERIFY every name it gives — models invent plausible-looking domains,
 *      so anything that fails DNS/SSRF checks or does not return HTML is
 *      discarded before it is trusted with anything;
 *   3. probe each survivor for schema.org/Event JSON-LD. A site that publishes
 *      it becomes a free, exact-date, poster-carrying FEED — the same deal
 *      ticket-am gives — with no country-specific code written for it;
 *   4. cache the result for a week.
 *
 * Cost is one small call per country per week, shared by every user in it.
 * A MANUAL allowlist always wins where one is set: discovery fills the gaps,
 * it does not overrule a human decision.
 */
const DOMAIN_DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOMAIN_DISCOVERY_MAX = 6;
const _discoveredByCountry = new Map();   // `country|city` (lc) → { at, domains, feeds }
const _discoveryInFlight = new Map();     // `country|city` (lc) → Promise (one call, not N)

/* Two DIFFERENT questions, and conflating them threw away real sources.
 *
 * Dubai's first discovery proposed 6 sites and kept 2, rejecting
 * ticketmaster.ae, timeoutdubai.com and platinumlist.net — all real, major
 * event sites. Checked by hand: ticketmaster.ae answers 200 to anyone,
 * timeoutdubai.com returns 403 to bots, platinumlist.net simply would not
 * connect from our host. Only virgin-megastore.ae was genuinely invented
 * (no DNS at all).
 *
 * The error was using ONE test for both purposes. For the search allowlist we
 * never fetch the site — Claude's own search infrastructure does, and it is
 * not blocked by the things that block us. All that matters there is that the
 * domain is real and public. Our fetch has to succeed only for the JSON-LD
 * feed probe, where we genuinely need the bytes.
 */

/** Real, public, resolvable? Enough to let the SEARCH read it. */
async function _domainResolves(host) {
    try {
        await _assertPublicHttpUrl(`https://${host}/`);   // DNS + SSRF guards
        return true;
    } catch {
        return false;
    }
}

/** The model's reply → an array of proposals, even when it is cut off.
 *
 *  A closing bracket is not something to depend on: a token cap can truncate
 *  the array mid-object, and then a whole-array parse yields nothing at all.
 *  So parse the array when it closes, and salvage the complete {...} objects
 *  when it does not. Markdown fences are ignored either way.
 */
function _parseProposals(raw) {
    const text = String(raw || '');
    const whole = text.match(/\[[\s\S]*\]/);            // greedy: the LAST bracket closes it
    if (whole) {
        try { const a = JSON.parse(whole[0]); if (Array.isArray(a) && a.length) return a; } catch { /* salvage */ }
    }
    const out = [];
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
        try { out.push(JSON.parse(m[0])); } catch { /* skip this fragment */ }
    }
    if (out.length) return out;
    // Last resort: bare quoted hostnames, the oldest answer shape.
    return [...text.matchAll(/"([a-z0-9-]+(?:\.[a-z0-9-]+)+)"/gi)].map(m => m[1]);
}

/** Hostname and listing URL out of ONE proposal, whatever shape it arrived in.
 *
 *  The model may answer a bare string, {host,url}, {hostname,link}, {site,…} —
 *  its key names are its choice, not a contract we get to depend on. So we read
 *  the VALUES and take the first that looks like a host or a URL. Being liberal
 *  here is free; being strict cost a Dubai run that returned "proposed 0".
 */
const _HOSTLIKE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function _bareHost(v) {
    return String(v || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function _rowHost(row) {
    if (typeof row === 'string') { const h = _bareHost(row); return _HOSTLIKE.test(h) ? h : ''; }
    if (!row || typeof row !== 'object') return '';
    for (const v of Object.values(row)) {
        const h = _bareHost(v);
        if (_HOSTLIKE.test(h)) return h;
    }
    return '';
}

function _rowUrl(row) {
    if (!row || typeof row !== 'object') return null;
    for (const v of Object.values(row)) {
        const str = String(v || '').trim();
        if (/^https?:\/\//i.test(str)) return str;
    }
    return null;
}

/** How many DATED events a page yields to the reader we actually use.
 *
 *  The old gate accepted a site only if it published schema.org JSON-LD. Our
 *  reader is far stronger than that — microdata, RDFa, epoch attributes — and
 *  neither tomsarkgh nor allevents, our two best sources, would have passed it
 *  either. Testing the page against a proxy for our capability instead of the
 *  capability itself is what made Dubai look unreadable when it was not.
 */
const MIN_DATED_EVENTS = 3;

function _datedEventCount(html) {
    let n = 0;
    try {
        n = _extractLdEvents(html).map(_normalizeLdEvent).filter(e => e.name && e.startDate).length;
    } catch { /* fall through to the ladder */ }
    if (n >= MIN_DATED_EVENTS) return n;
    try {
        const { _structuredFromHtml } = require('../search/readPage');
        const days = new Set(_structuredFromHtml(html).map(o => o.day).filter(Boolean));
        return Math.max(n, days.size);
    } catch {
        return n;
    }
}

/** Where a site lists THIS CITY's events, in the order worth trying.
 *
 *  Probing the bare domain root is what lost Dubai: platinumlist.net has no
 *  event list on it, so the probe found nothing and a perfectly readable
 *  source was discarded — the city's events live at dubai.platinumlist.net
 *  (verified 2026-08-24). The model's own answer leads, because naming the
 *  page a city's events live on is a judgement; the patterns below are the
 *  deterministic fallback for when it 404s, and cost no model call.
 *
 *  `/en` WITHOUT the trailing slash stays in the list: tomsarkgh.am/en/ 404s
 *  while tomsarkgh.am/en is the English listing page, and falling through to
 *  `/` served the Armenian homepage where the Latin word "Yerevan" never
 *  appears — so the relevance test excluded the country's best source.
 */
function _cityListingUrls(host, city, modelUrl = null) {
    const slug = String(city || '').trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')       // Zürich → zurich
        .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const urls = [];
    // The model's URL, but only if it stays on the domain it proposed — an
    // off-domain "listing page" is a different site wearing this one's name.
    if (modelUrl) {
        try {
            const u = new URL(modelUrl);
            const h = u.hostname.replace(/^www\./, '');
            if (h === host || h.endsWith(`.${host}`)) urls.push(u.toString());
        } catch { /* unusable string — the patterns below still apply */ }
    }
    if (slug) urls.push(
        `https://${slug}.${host}/`,
        `https://${host}/${slug}`,
        `https://${host}/en/${slug}`,
        `https://${host}/events/${slug}`,
    );
    urls.push(`https://${host}/en`, `https://${host}/en/`, `https://${host}/`);
    return [...new Set(urls)];
}

/** Fetch the first candidate that answers with a real page. */
async function _fetchCityListing(host, city, modelUrl = null) {
    for (const url of _cityListingUrls(host, city, modelUrl)) {
        try {
            const html = await _fetchListingHtml(url);
            if (html && html.length > 500) return { url, html };
        } catch { /* try the next form */ }
    }
    return null;
}

/** Confirm a real-but-UNFETCHABLE domain by asking the search tool, restricted
 * to that one domain, whether it lists events for this place. The search engine
 * fetches the site for us — bot-checks and all — so a site that 403s our own
 * fetch (Dubai's Platinumlist, Timeout) can still be proven. If the restricted
 * search returns ANY result, the domain covers the place. One search, fails
 * safe to false. Never called for a domain we DID fetch and found off-city
 * (atlanta.net for Tbilisi) — that one is already disproven, not unknown. */
async function _confirmDomainBySearch(host, place, model) {
    if (!place) return false;
    try {
        const claudeService = require('../../services/claudeService');
        const { searches } = await claudeService.complete({
            model,
            maxTokens: 512,
            temperature: 0,
            webSearch: true,
            webSearchMaxUses: 1,
            allowedDomains: [host],
            system: 'You are a silent verifier. Run one web search, then stop.',
            messages: [{ role: 'user', content: `Find upcoming events happening in ${place}.` }],
        });
        return (searches || []).some(s => (s.results || []).length > 0);
    } catch {
        return false;
    }
}

async function discoverEventSources(country, city) {
    // Keyed by city, not country: the listing URL is per city, so Dubai and
    // Abu Dhabi — or Tbilisi and Batumi — must not share one cached answer.
    const key = `${String(country || '').toLowerCase().trim()}|${String(city || '').toLowerCase().trim()}`;
    if (!String(country || '').trim() || _fetchUnavailable) return { domains: [], feeds: [] };

    const hit = _discoveredByCountry.get(key);
    if (hit && (Date.now() - hit.at) < DOMAIN_DISCOVERY_TTL_MS) return hit;
    if (_discoveryInFlight.has(key)) return _discoveryInFlight.get(key);

    const run = (async () => {
        let domains = [], feeds = [];
        try {
            const AppConfig = require('../../models/AppConfig');
            const claudeService = require('../../services/claudeService');
            const cfg = await AppConfig.getConfig();
            const res = await claudeService.complete({
                model: cfg.claudeModel,
                // 200 was sized for bare hostnames. Asking for objects with
                // full URLs overflowed it, the array never closed, and the
                // parser saw nothing — Dubai's whole discovery, twice (live
                // 2026-08-24).
                maxTokens: 700,
                temperature: 0,
                system: 'You return only JSON. No prose, no markdown fences.',
                messages: [{
                    role: 'user',
                    /* The place MUST be named unambiguously. Asked for "Georgia"
                     * alone the model returned exploregeorgia.org, atlanta.net and
                     * US ticket sellers — the STATE, not the country — and every
                     * one passed verification because they are real domains. A
                     * Tbilisi user's search was locked to Atlanta and found
                     * nothing. Naming the city settles it, and "the COUNTRY"
                     * settles it again for Georgia, Jordan, Luxembourg and every
                     * other name shared with a city or region. */
                    content: `Which websites list upcoming public events and sell event tickets in `
                           + `${city ? `${city}, ` : ''}${country}? `
                           + `${country} here is the COUNTRY${city ? `, and ${city} is a city in it` : ''} — `
                           + `not a US state or any similarly named place elsewhere. `
                           + `Prefer national ticket sellers and official city/tourism event calendars for that country. `
                           + `Exclude blogs, travel magazines, aggregators and social networks. `
                           + `For each site give its bare hostname AND the URL of the page that lists `
                           + `${city ? `${city}'s` : 'that city\'s'} upcoming events — often a subdomain or a city path, `
                           + `not the site's front page. `
                           + `Reply with ONLY a JSON array of at most ${DOMAIN_DISCOVERY_MAX} objects, e.g. `
                           + `[{"host":"example.com","url":"https://city.example.com/"}].`
                }]
            });
            const raw = String(res?.text || '');
            const arr = _parseProposals(raw);
            const urlByHost = new Map();
            const proposed = (Array.isArray(arr) ? arr : [])
                .map((row) => {
                    const host = _rowHost(row);
                    const url = _rowUrl(row);
                    if (host && url) urlByHost.set(host, url);
                    return host;
                })
                .filter(Boolean)
                .slice(0, DOMAIN_DISCOVERY_MAX);
            // Say what came back when nothing survives. Asking for objects and
            // then depending on the key names "host" and "url" cost a whole
            // Dubai run — the model answered, we did not recognise it, and the
            // log said only "proposed 0" (live 2026-08-24). Never guess again.
            if (!proposed.length) console.warn(`[discovery] ${country}: nothing usable in the reply — ${raw.slice(0, 200).replace(/\s+/g, ' ')}`);

            // ── Verify, then probe. A name the model produced is a HINT, never
            //    a fact: it reaches the network only after passing the same
            //    SSRF guards as any other fetched URL.
            const checks = await Promise.all(proposed.map(async host => {
                // Real domain? → the SEARCH may read it, whether or not we can.
                const real = await _domainResolves(host);
                if (!real) return { host, real: false, feed: null };
                // Fetchable by us? → then it can also be probed for a free feed.
                const ok = await _fetchCityListing(host, city, urlByHost.get(host));
                // Real but we can't fetch it (bot-blocked). NOT disproven — a
                // search-tool confirmation pass below decides. `fetchable:false`
                // marks it for that pass; `relevant` stays undefined for now.
                if (!ok) return { host, real: true, fetchable: false, feed: null };
                /* Real is not the same as RELEVANT. Every Atlanta domain above was
                 * real. When we can read the page, require it to mention the place
                 * we asked about — a Georgian ticket site names Tbilisi or Georgia;
                 * atlanta.net names neither. Sites we cannot fetch keep the benefit
                 * of the doubt, since we have no page to judge. */
                /* Match on the CITY, not the country. Country names are the whole
                 * problem: atlanta.net and exploregeorgia.org both say "Georgia"
                 * on every page, so a country-name test kept exactly the domains
                 * it was meant to remove. "Tbilisi" appears on neither. */
                const hay = ok.html.toLowerCase();
                const needle = String(city || country || '').toLowerCase().replace(/^t'/, '');
                const relevant = !needle || hay.includes(needle);
                const dated = _datedEventCount(ok.html);
                return {
                    host, real: true, relevant, url: ok.url, dated,
                    feed: relevant && dated >= MIN_DATED_EVENTS
                        ? { label: host, url: ok.url, countries: [String(country).toLowerCase()] }
                        : null
                };
            }));

            /* The allowlist requires PROVEN relevance: fetched, and the page names
             * the city. Unfetchable domains no longer get the benefit of the doubt.
             *
             * That leniency was added so bot-blocked Dubai sites survived, and it
             * is precisely what let atlanta.net and exploregeorgia.org through for
             * Tbilisi — both 403 us, so neither could be disproved, and search was
             * locked to the wrong continent while the user saw "no events".
             *
             * The two failure modes are not symmetric. A WRONG allowlist actively
             * breaks the feature; a SMALL or empty one merely means unrestricted
             * search, which is what happened before discovery existed. So when in
             * doubt, leave the domain out. */
            /* Search-confirm the real-but-unfetchable domains (Dubai's bot-blocked
             * sites). Bounded to 3 searches, and only ever on a discovery
             * cache-miss (results cached 7 days per country), so cost is a few
             * cents at most, once a week, per new country. A domain we fetched
             * and found off-city is `relevant:false` and is skipped here. */
            const needSearch = checks.filter(c => c.real && c.fetchable === false);
            let confirmBudget = 3;
            for (const c of needSearch) {
                if (confirmBudget-- <= 0) break;
                if (await _confirmDomainBySearch(c.host, city || country, cfg.claudeModel)) {
                    c.relevant = true; c.viaSearch = true;
                }
            }
            const bySearch = checks.filter(c => c.viaSearch).map(c => c.host);

            const offTopic = checks.filter(c => c.real && c.relevant !== true).map(c => c.host);
            domains = checks.filter(c => c.relevant === true).map(c => c.host);
            feeds = checks.filter(c => c.feed).map(c => c.feed);
            const invented = checks.filter(c => !c.real).map(c => c.host);
            console.log(`[discovery] ${country}: model proposed ${proposed.length} → ${domains.length} real [${domains.join(', ') || '—'}]`
                + `${bySearch.length ? ` | search-confirmed: ${bySearch.join(', ')}` : ''}`
                + `${invented.length ? ` | not a real domain: ${invented.join(', ')}` : ''}`
                + `${offTopic.length ? ` | unconfirmed for ${city || country} (excluded): ${offTopic.join(', ')}` : ''}`
                + `${feeds.length ? ` | JSON-LD feed(s): ${feeds.map(f => f.label).join(', ')}` : ' | no free feeds here — search only'}`);
        } catch (err) {
            console.warn(`[discovery] ${country} failed: ${err.message} — falling back to unrestricted search`);
            domains = []; feeds = [];
        }
        const out = { at: Date.now(), domains, feeds };
        _discoveredByCountry.set(key, out);
        _discoveryInFlight.delete(key);
        return out;
    })();

    _discoveryInFlight.set(key, run);
    return run;
}

/** Domains the web search may read here. A manual allowlist always wins. */
async function resolveSearchDomains(cfg, userRegion) {
    const manual = Array.isArray(cfg.claudeWebSearchAllowedDomains) ? cfg.claudeWebSearchAllowedDomains.filter(Boolean) : [];
    if (manual.length) return manual;
    if (cfg.eventSourceAutoDiscover === false) return [];
    const country = userRegion?.country;
    if (!country) return [];
    const key = String(country).toLowerCase();
    // Registry first: the floor no model answer can remove. Feed sources'
    // own hosts ride along — a site good enough to supply events is good
    // enough to be read by the search.
    const known = new Set(KNOWN_EVENT_SEARCH_DOMAINS
        .filter(r => r.countries.includes(key))
        .flatMap(r => r.domains));
    for (const s of EVENT_FEED_SOURCES.filter(s => s.countries.includes(key))) {
        try { known.add(new URL(s.url).hostname.replace(/^www\./, '')); } catch {}
    }
    let discovered = [];
    try { discovered = (await discoverEventSources(country, userRegion?.city)).domains; } catch {}
    return [...new Set([...known, ...discovered])];
}

module.exports = {
    discoverEventSources,
    resolveSearchDomains,
    _domainResolves,
    _fetchCityListing,
    _cityListingUrls,
    _parseProposals,
    _rowHost,
    _rowUrl,
    _datedEventCount,
    _confirmDomainBySearch,
    DOMAIN_DISCOVERY_TTL_MS,
    DOMAIN_DISCOVERY_MAX,
};
