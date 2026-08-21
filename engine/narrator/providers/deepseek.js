// Jinni V2 Engine — DeepSeek provider (the default narrator, per cost routing).
// Thin wrapper over config/openai — the SAME axios client v1 uses, lazy-required
// so jest can import the narrator without env keys. complete() = one-shot;
// streamText() = true token streaming with v1's chunk-boundary lesson baked in
// (aiRoutes ~1870: SSE lines split across chunks — buffer the trailing partial
// line, or tokens silently drop). Streaming usage is ESTIMATED (chars/4) —
// config/openai doesn't forward stream_options, and touching it would be a
// v1-side edit; the estimate matches v1's own historical chat billing.

/** Pure SSE accumulator: feed the buffered string, get deltas + the remainder. */
function _sseDeltas(buffered) {
    const deltas = [];
    let done = false;
    const lines = buffered.split('\n');
    const rest = lines.pop() ?? '';          // keep the (possibly partial) last line
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { done = true; continue; }
        try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) deltas.push(content);
        } catch { /* malformed line — never kill the stream over one chunk */ }
    }
    return { deltas, done, rest };
}

async function streamText({ messages, model = null, maxTokens = 600, temperature = 0.5, onDelta = null }) {
    const openai = require('../../../config/openai');
    const response = await openai.chat.completions.create({
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
    });
    let text = '';
    let buffer = '';
    await new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const { deltas, done, rest } = _sseDeltas(buffer);
            buffer = rest;
            for (const d of deltas) {
                text += d;
                if (onDelta) { try { onDelta(d); } catch { /* consumer errors never kill the stream */ } }
            }
            if (done) resolve();
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
    });
    const inChars = messages.reduce((s, m) => s + String(m.content || '').length, 0);
    return {
        text,
        usage: { in: Math.ceil(inChars / 4), out: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0, estimated: true },
        searches: [],
        searchCount: 0,
    };
}

async function complete({ messages, model = null, maxTokens = 600, temperature = 0.5 }) {
    const openai = require('../../../config/openai');
    const res = await openai.chat.completions.create({
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
    });
    const text = res?.choices?.[0]?.message?.content || '';
    return {
        text,
        usage: {
            in: res?.usage?.prompt_tokens || 0,
            out: res?.usage?.completion_tokens || 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        searches: [],
        searchCount: 0,
    };
}

/**
 * Function-calling round (the tool loop's engine). config/openai (a v1 file)
 * doesn't forward `tools`, so this uses its OWN axios call on the same env —
 * v1 stays byte-identical.
 * @returns {{ message: {content, tool_calls?}, usage }}
 */
async function completeWithTools({ messages, tools = undefined, model = null, maxTokens = 500, temperature = 0.4 }) {
    const axios = require('axios');
    const body = {
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const res = await axios.post(
        `${process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1'}/chat/completions`,
        body,
        { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return {
        message: res.data?.choices?.[0]?.message || {},
        usage: {
            in: res.data?.usage?.prompt_tokens || 0,
            out: res.data?.usage?.completion_tokens || 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
    };
}

module.exports = { complete, streamText, completeWithTools, _sseDeltas };
