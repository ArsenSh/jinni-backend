// Jinni V2 Engine — Claude provider (admin-configurable, 2026-08-22).
//
// Arsen: "we need create v2 same way so admin will be able configure if
// needed" — v1 picks its chat provider from AppConfig (aiProviderChat) and
// gates Anthropic server-side web search behind claudeWebSearch +
// claudeWebSearchActionsChat. This provider gives v2 the same knobs by
// WRAPPING services/claudeService (v1-shared, reused not copied — the
// intentService pattern), so both engines answer to one admin page.
//
// Contract (same as providers/deepseek):
//   complete({messages, maxTokens, temperature, webSearch?}) →
//       { text, usage:{in,out,cacheRead,cacheWrite}, searches, searchCount }
//   streamText({messages, maxTokens, temperature, onDelta, webSearch?}) → same
//
// webSearch (optional): { maxUses, allowedDomains, blockedDomains } — omitted
// ⇒ plain completion, zero search cost.

const claudeService = require('../../../services/claudeService');

const _usage = (u = {}) => ({
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
});

const _wsOpts = (webSearch) => webSearch ? {
    webSearch: true,
    webSearchMaxUses: webSearch.maxUses ?? 3,
    allowedDomains: webSearch.allowedDomains,
    blockedDomains: webSearch.blockedDomains,
} : {};

async function complete({ messages, maxTokens = 600, temperature = 0.5, webSearch = null } = {}) {
    const r = await claudeService.complete({ messages, maxTokens, temperature, ..._wsOpts(webSearch) });
    return { text: r.text || '', usage: _usage(r.usage), searches: r.searches || [], searchCount: r.searchCount || 0 };
}

async function streamText({ messages, maxTokens = 600, temperature = 0.5, onDelta = null, webSearch = null } = {}) {
    let text = '', usage = {}, searchCount = 0;
    for await (const ev of claudeService.streamChat({ messages, maxTokens, temperature, ..._wsOpts(webSearch) })) {
        if (ev.type === 'text' && ev.content) {
            text += ev.content;
            if (onDelta) onDelta(ev.content);
        } else if (ev.type === 'done') {
            text = ev.fullText || text;
            usage = ev.usage || {};
            searchCount = ev.searchCount || 0;
        } else if (ev.type === 'error') {
            throw ev.error;
        }
    }
    return { text, usage: _usage(usage), searches: [], searchCount };
}

module.exports = { complete, streamText };
