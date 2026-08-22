// Jinni V2 Engine — provider-agnostic web search (the fresh tier's front door).
// Arsen sign-off 2026-08-22 ("then lets build, it is good").
//
// Web search is a PIPELINE, not a model feature: this module only finds URLs;
// fetching/extraction stays with the SSRF-guarded machinery in engine/events.
// Providers, cheapest-first:
//   brave   — BRAVE_SEARCH_API_KEY env      (~$3 / 1k queries)
//   tavily  — TAVILY_API_KEY env            (similar)
//   claude  — the admin's web-search config (Anthropic server tool; used as
//             the URL-finder when no cheap key is configured — works TODAY
//             behind the existing admin switch)
// No provider available ⇒ [] (fail-open — the fresh tier just doesn't fire).

const TIMEOUT_MS = 6000;

async function _brave(query, count, key) {
    const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const data = await res.json();
    return (data?.web?.results || []).map(r => ({ url: r.url, title: r.title || null }));
}

async function _tavily(query, count, key) {
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: count }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data = await res.json();
    return (data?.results || []).map(r => ({ url: r.url, title: r.title || null }));
}

async function _claude(query, count, webSearchCfg) {
    // One capped search; we only mine the result URLs — the model's prose is
    // discarded (extraction happens in our own parser, where it's verifiable).
    const claude = require('../narrator/providers/claude');
    const r = await claude.complete({
        messages: [{ role: 'user', content: `Search the web for: ${query}\nReply with the single word: done` }],
        maxTokens: 30,
        webSearch: { ...webSearchCfg, maxUses: 1 },
    });
    const urls = (r.searches || []).flatMap(s => s.results || []);
    return urls.slice(0, count).map(u => ({ url: u.url, title: u.title || null }));
}

/**
 * @returns {Promise<Array<{url,title}>>} deduped by URL; [] on any failure.
 * opts.webSearchCfg: the admin's Claude web-search knobs (enables the claude
 * adapter when no cheap API key is configured).
 */
async function searchWeb(query, { count = 5, webSearchCfg = null, deps = {} } = {}) {
    try {
        const brave = deps.braveKey !== undefined ? deps.braveKey : process.env.BRAVE_SEARCH_API_KEY;
        const tavily = deps.tavilyKey !== undefined ? deps.tavilyKey : process.env.TAVILY_API_KEY;
        let results = [];
        if (deps.impl) results = await deps.impl(query, count);
        else if (brave) results = await _brave(query, count, brave);
        else if (tavily) results = await _tavily(query, count, tavily);
        else if (webSearchCfg) results = await _claude(query, count, webSearchCfg);
        else return [];
        const seen = new Set();
        return results.filter(r => {
            if (!r?.url || seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
        });
    } catch (err) {
        console.warn(`[search] "${String(query).slice(0, 60)}" failed: ${err.message}`);
        return [];
    }
}

module.exports = { searchWeb };
