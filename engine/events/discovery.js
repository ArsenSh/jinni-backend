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
const _discoveredByCountry = new Map();   // country(lc) → { at, domains, feeds }
const _discoveryInFlight = new Map();     // country(lc) → Promise (one call, not N)

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

/** Can WE fetch it? Only needed to decide whether it can be a free feed. */
async function _fetchDomainHome(host) {
    /* `/en` WITHOUT the trailing slash matters: tomsarkgh.am/en/ 404s while
     * tomsarkgh.am/en is the English listing page. Falling straight through to
     * `/` served the Armenian homepage, where the Latin word "Yerevan" never
     * appears — so the relevance test excluded a site that is the country's
     * best event source. */
    for (const url of [`https://${host}/en`, `https://${host}/en/`, `https://${host}/`]) {
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
    const key = String(country || '').toLowerCase().trim();
    if (!key || _fetchUnavailable) return { domains: [], feeds: [] };

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
                maxTokens: 200,
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
                           + `Reply with ONLY a JSON array of at most ${DOMAIN_DISCOVERY_MAX} bare hostnames, e.g. ["example.com","example.org"].`
                }]
            });
            const raw = String(res?.text || '');
            const arr = JSON.parse((raw.match(/\[[\s\S]*?\]/) || ['[]'])[0]);
            const proposed = (Array.isArray(arr) ? arr : [])
                .map(d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
                .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
                .slice(0, DOMAIN_DISCOVERY_MAX);

            // ── Verify, then probe. A name the model produced is a HINT, never
            //    a fact: it reaches the network only after passing the same
            //    SSRF guards as any other fetched URL.
            const checks = await Promise.all(proposed.map(async host => {
                // Real domain? → the SEARCH may read it, whether or not we can.
                const real = await _domainResolves(host);
                if (!real) return { host, real: false, feed: null };
                // Fetchable by us? → then it can also be probed for a free feed.
                const ok = await _fetchDomainHome(host);
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
                const events = _extractLdEvents(ok.html).map(_normalizeLdEvent).filter(e => e.name && e.startDate);
                return {
                    host, real: true, relevant,
                    feed: relevant && events.length >= 3
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
    _fetchDomainHome,
    _confirmDomainBySearch,
    DOMAIN_DISCOVERY_TTL_MS,
    DOMAIN_DISCOVERY_MAX,
};
