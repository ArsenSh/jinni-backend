// services/claudeService.js
//
// Self-contained Claude (Anthropic) provider adapter. Knows NOTHING about
// travel, places, or your routes — it only turns "a system prompt + messages"
// into either a finished string (complete) or a normalized event stream
// (streamChat). Your route layer keeps owning all the place logic.
//
// Why normalized events?  Your chat-stream arrow parser was written against
// DeepSeek's OpenAI-style stream (data: lines, delta.content, [DONE]). Claude
// streams a different, typed shape AND, when web search is on, interleaves
// search blocks into the stream. Rather than teach your parser two formats,
// this adapter flattens Claude into the SAME neutral vocabulary your parser
// will consume:
//
//     { type: 'text',          content }          // a chunk of model text
//     { type: 'search_start',  query }            // Claude fired a web search
//     { type: 'search_results' }                  // results came back
//     { type: 'done',          fullText, usage, searchCount }
//     { type: 'error',         error }
//
// The DeepSeek adapter (when you write it) emits the same three content events
// minus search, so the parser downstream never knows or cares which provider
// answered.

const anthropic = require('../config/anthropic');

// Current Anthropic web search tool version. The newer 'web_search_20260209'
// adds dynamic result filtering; '..._20250305' is the stable baseline and is
// supported on Haiku. Bump this string if/when you move to the newer version.
const WEB_SEARCH_TOOL_VERSION = 'web_search_20250305';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Build the `tools` array for a request. Empty unless web search is enabled.
 */
function buildTools({ webSearch = false, webSearchMaxUses = 3, allowedDomains, blockedDomains } = {}) {
    if (!webSearch) return undefined;
    const tool = {
        type: WEB_SEARCH_TOOL_VERSION,
        name: 'web_search',
        max_uses: webSearchMaxUses,
    };
    if (Array.isArray(allowedDomains) && allowedDomains.length) tool.allowed_domains = allowedDomains;
    if (Array.isArray(blockedDomains) && blockedDomains.length) tool.blocked_domains = blockedDomains;
    return [tool];
}

/**
 * Anthropic wants `system` as a top-level param and `messages` containing only
 * user/assistant turns. Your existing code builds an OpenAI-style array that
 * may start with a {role:'system'} message. This splits that cleanly.
 *
 * Pass `cacheSystem: true` to mark the system prompt for prompt caching
 * (10% input cost on cache hits) — worth it because your system prompt and
 * generateTargetedPrompt are largely static across requests.
 */
function fromOpenAIMessages(messages = [], { cacheSystem = false } = {}) {
    let systemText = '';
    const convo = [];
    for (const m of messages) {
        if (m.role === 'system') { systemText += (systemText ? '\n\n' : '') + (m.content || ''); continue; }
        // Anthropic accepts string content directly for plain text turns.
        convo.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }
    const system = cacheSystem && systemText
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : (systemText || undefined);
    return { system, messages: convo };
}

/**
 * Pull the web-search count out of a finished message's usage block.
 * Anthropic reports it as usage.server_tool_use.web_search_requests.
 */
function searchCountFromUsage(usage) {
    return usage?.server_tool_use?.web_search_requests || 0;
}

/**
 * Every token Anthropic actually bills for, from a usage block.
 *
 * `usage.input_tokens` counts ONLY the uncached input. This service sends the
 * system prompt with cache_control:'ephemeral' (three call sites below), so on
 * a cache hit the bulk of the input arrives as `cache_read_input_tokens` and on
 * a miss as `cache_creation_input_tokens` — summing input+output alone silently
 * omits both. Measured against the Anthropic console over four real events
 * taps, the admin dashboard read ~14.2K tokens where the console read ~138K:
 * an order of magnitude, essentially all of it cache traffic.
 *
 * Cached input is cheaper per token, not free, so it belongs in the count. The
 * dashboard exists to answer "what is this costing?", and it cannot answer that
 * from a tenth of the tokens.
 */
function billableTokens(usage) {
    if (!usage) return 0;
    return (usage.input_tokens || 0)
         + (usage.output_tokens || 0)
         + (usage.cache_read_input_tokens || 0)
         + (usage.cache_creation_input_tokens || 0);
}

/**
 * Re-chunk a Claude text_delta into DeepSeek-sized pieces.
 *
 * Claude streams coarse, bursty text_delta chunks (often a whole phrase or a
 * full "**Name** → desc ←" block at once). The chat-stream arrow parser in
 * aiRoutes.js was written against DeepSeek, which emits tiny tokens and sends
 * '**', '→', '←' as their own tokens. Feeding it Claude's big chunks makes the
 * live stream look choppy and confuses the name/arrow detection.
 *
 * This splitter turns one coarse delta into many small pieces, keeping the
 * delimiters ('**', '→', '←') isolated and breaking the rest on whitespace —
 * i.e. it makes Claude *look like* DeepSeek to the parser. Final correctness is
 * already handled by the end-of-stream reconciliation in processStreamCompletion;
 * this only smooths what the user sees while tokens arrive.
 *
 * `carryRef` is a tiny stateful holder ({ value: '' }) owned by the caller. It
 * carries a lone trailing '*' across delta boundaries so a '**' that happens to
 * be split between two deltas is never broken in half.
 */
function reChunk(text, carryRef) {
    let s = (carryRef.value || '') + text;
    carryRef.value = '';
    // If the buffer ends in a single '*' (not '**'), hold it back — the next
    // delta may complete it into '**'.
    if (s.endsWith('*') && !s.endsWith('**')) { carryRef.value = '*'; s = s.slice(0, -1); }
    // Keep '**', '→', '←' and whitespace runs as their own pieces.
    return s.split(/(\*\*|→|←|\s+)/).filter(p => p !== '');
}

/**
 * BLOCKING completion — use this for quick-action-stream (which already makes
 * a non-streaming model call and parses the full text afterwards).
 *
 * Returns: { text, usage, searchCount }
 *   text       — concatenated text from all text blocks
 *   usage      — raw Anthropic usage object (input_tokens, output_tokens, ...)
 *   searchCount— number of web searches performed (bill at $0.01 each)
 */
async function complete({
    system,
    messages,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.3,
    webSearch = false,
    webSearchMaxUses = 3,
    cacheSystem = false,
    allowedDomains,
    blockedDomains,
} = {}) {
    // Allow either an explicit system string OR an OpenAI-style messages array
    // with a leading system message.
    let sys = system;
    let convo = messages;
    if (system === undefined && Array.isArray(messages) && messages.some(m => m.role === 'system')) {
        const split = fromOpenAIMessages(messages, { cacheSystem });
        sys = split.system; convo = split.messages;
    } else if (cacheSystem && typeof system === 'string' && system) {
        sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    const tools = buildTools({ webSearch, webSearchMaxUses, allowedDomains, blockedDomains });

    // Web search needs real token headroom. With a search tool attached, Claude
    // first writes a short "I'll search…" preamble, then issues a server-side
    // search call, THEN reads the results and only afterwards writes the real
    // answer. A 150–300 token budget (fine for a no-search bracket list) gets
    // entirely consumed by the preamble + tool call, so the turn stops on
    // max_tokens before any answer exists — the caller sees only the preamble
    // and finds zero bracketed names. Floor the budget whenever a tool is in play.
    const effectiveMaxTokens = tools ? Math.max(maxTokens, 2048) : maxTokens;

    const baseParams = {
        model,
        max_tokens: effectiveMaxTokens,
        temperature,          // NOTE: Anthropic has no frequency_penalty / presence_penalty.
        ...(sys !== undefined ? { system: sys } : {}),
        ...(tools ? { tools } : {}),
    };

    // A turn that runs a server-side web search can come back with
    // stop_reason 'pause_turn' (the API paused a long-running turn). When that
    // happens the assistant turn is INCOMPLETE — to finish it we must feed the
    // partial turn back in and let Claude resume (run the search, read results,
    // write the answer). Without this we keep only the pre-search preamble.
    // Loop until the turn actually ends, accumulating text + usage + searches.
    let convoLoop = Array.isArray(convo) ? [...convo] : convo;
    let text = '';
    // Cache fields accumulate too — see billableTokens() for why leaving them
    // out under-reported the admin dashboard by ~10×.
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let searchCount = 0;
    let guard = 0;
    // ── Search provenance ───────────────────────────────────────────────────
    // The response already carries WHAT was searched (server_tool_use blocks)
    // and WHICH pages came back (web_search_tool_result blocks). We kept only
    // the count and dropped both, which left every "why did it say that?"
    // question unanswerable from the logs. Collected here so the caller can log
    // the queries and the sources behind an answer. Costs nothing extra — this
    // data is already in the response being paid for.
    const searches = [];

    while (true) {
        const resp = await anthropic.messages.create({ ...baseParams, messages: convoLoop });

        for (const b of (resp.content || [])) {
            if (b.type === 'server_tool_use' && b.name === 'web_search') {
                searches.push({ query: b.input?.query || null, results: [] });
            } else if (b.type === 'web_search_tool_result') {
                // .content is the result list on success, or an error object on failure.
                const rows = Array.isArray(b.content) ? b.content : [];
                const sources = rows
                    .filter(r => r && r.type === 'web_search_result')
                    .map(r => ({ url: r.url || null, title: r.title || null }));
                const open = searches[searches.length - 1];
                if (open && !open.results.length) open.results = sources;
                else searches.push({ query: null, results: sources });
            }
        }

        text += (resp.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
        usage.input_tokens  += resp.usage?.input_tokens  || 0;
        usage.output_tokens += resp.usage?.output_tokens || 0;
        usage.cache_read_input_tokens     += resp.usage?.cache_read_input_tokens     || 0;
        usage.cache_creation_input_tokens += resp.usage?.cache_creation_input_tokens || 0;
        searchCount += searchCountFromUsage(resp.usage);

        // Continue only on a genuine pause; end_turn / max_tokens / stop_sequence end the loop.
        if (resp.stop_reason === 'pause_turn' && guard++ < 5) {
            convoLoop = [...convoLoop, { role: 'assistant', content: resp.content }];
            continue;
        }
        break;
    }

    // `searches` is additive — existing callers destructuring { text, usage,
    // searchCount } are unaffected.
    return { text, usage, searchCount, searches };
}

/**
 * STREAMING completion — async generator yielding the normalized events above.
 * Use this for chat-stream. Your route writes each event to the SSE response
 * and feeds 'text' chunks into your existing arrow state machine.
 *
 * Example wiring in a route:
 *
 *   for await (const ev of claudeService.streamChat({ system, messages, webSearch })) {
 *       if (ev.type === 'text')          feedArrowParser(ev.content, res);   // your existing logic
 *       else if (ev.type === 'search_start')  res.write(`data: ${JSON.stringify({ type:'searching' })}\n\n`);
 *       else if (ev.type === 'done')     finalize(ev.fullText, ev.searchCount, res);
 *       else if (ev.type === 'error')    handleError(ev.error, res);
 *   }
 */
async function* streamChat({
    system,
    messages,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.5,
    webSearch = false,
    webSearchMaxUses = 3,
    cacheSystem = false,
    allowedDomains,
    blockedDomains,
    signal,                 // optional AbortSignal for client-disconnect cancellation
} = {}) {
    let sys = system;
    let convo = messages;
    if (system === undefined && Array.isArray(messages) && messages.some(m => m.role === 'system')) {
        const split = fromOpenAIMessages(messages, { cacheSystem });
        sys = split.system; convo = split.messages;
    } else if (cacheSystem && typeof system === 'string' && system) {
        sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    const tools = buildTools({ webSearch, webSearchMaxUses, allowedDomains, blockedDomains });

    let fullText = '';
    let usage = {};
    // Tracks which content-block index is the text we care about vs a search block.
    const blockTypeByIndex = {};
    // Carries a lone trailing '*' across deltas so '**' is never split in half.
    const carry = { value: '' };

    try {
        const stream = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            temperature,
            ...(sys !== undefined ? { system: sys } : {}),
            messages: convo,
            ...(tools ? { tools } : {}),
            stream: true,
        }, signal ? { signal } : undefined);

        for await (const event of stream) {
            switch (event.type) {
                case 'message_start':
                    usage = { ...usage, ...(event.message?.usage || {}) };
                    break;

                case 'content_block_start': {
                    const cb = event.content_block || {};
                    blockTypeByIndex[event.index] = cb.type;
                    if (cb.type === 'server_tool_use' && cb.name === 'web_search') {
                        // The query streams in via input_json_delta, so it may be empty here;
                        // we surface a generic "searching" signal. (Query text, if present,
                        // is in cb.input?.query.)
                        yield { type: 'search_start', query: cb.input?.query || null };
                    } else if (cb.type === 'web_search_tool_result') {
                        yield { type: 'search_results' };
                    }
                    break;
                }

                case 'content_block_delta': {
                    const d = event.delta || {};
                    // Only real model text. Ignore input_json_delta (tool args) and
                    // citations_delta (search citation metadata) for parsing purposes.
                    if (d.type === 'text_delta' && d.text) {
                        fullText += d.text;
                        // Emit many small pieces (delimiters isolated) so the
                        // DeepSeek-tuned arrow parser sees DeepSeek-like granularity
                        // and the live stream renders fluently.
                        for (const piece of reChunk(d.text, carry)) {
                            yield { type: 'text', content: piece };
                        }
                    }
                    break;
                }

                case 'message_delta':
                    // Cumulative usage (output tokens, server_tool_use counts) lands here.
                    if (event.usage) usage = { ...usage, ...event.usage };
                    break;

                case 'message_stop':
                    yield {
                        type: 'done',
                        fullText,
                        usage,
                        searchCount: searchCountFromUsage(usage),
                    };
                    return;

                // 'ping' and 'content_block_stop' need no action.
                default:
                    break;
            }
        }

        // Safety net if the stream ends without an explicit message_stop.
        yield { type: 'done', fullText, usage, searchCount: searchCountFromUsage(usage) };
    } catch (error) {
        yield { type: 'error', error };
    }
}

module.exports = {
    complete,
    streamChat,
    fromOpenAIMessages,
    billableTokens,
    WEB_SEARCH_TOOL_VERSION,
    DEFAULT_MODEL,
};