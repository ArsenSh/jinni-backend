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

// ── Timeouts (live 2026-09-14: a reply stream hung for 910 s with ZERO
//    tokens while DeepSeek was degraded — the traveler saw "trouble
//    connecting" after fifteen minutes). config/openai's axios client has
//    no timeout at all, so every limit lives here. A stall is a typed error
//    (code DEEPSEEK_STALL, `emitted` = tokens already sent) so the narrator
//    can fail over to another provider when nothing has reached the client.
const FIRST_TOKEN_MS = Number(process.env.DEEPSEEK_FIRST_TOKEN_MS) || 25000;
const IDLE_MS = Number(process.env.DEEPSEEK_IDLE_MS) || 20000;
const HARD_MS = Number(process.env.DEEPSEEK_HARD_MS) || 120000;
const COMPLETE_MS = Number(process.env.DEEPSEEK_COMPLETE_MS) || 60000;

function stallError(why, emitted = 0) {
    const e = new Error(`deepseek stalled: ${why}`);
    e.code = 'DEEPSEEK_STALL';
    e.emitted = emitted;
    return e;
}

function withTimeout(promise, ms, why) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(stallError(why)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

async function streamText({ messages, model = null, maxTokens = 600, temperature = 0.5, onDelta = null, timeouts = {} } = {}, deps = {}) {
    const openai = deps.openai || require('../../../config/openai');
    const firstMs = timeouts.firstTokenMs ?? FIRST_TOKEN_MS;
    const idleMs = timeouts.idleMs ?? IDLE_MS;
    const hardMs = timeouts.hardMs ?? HARD_MS;
    const response = await withTimeout(openai.chat.completions.create({
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
    }), firstMs, `no response in ${firstMs} ms`);
    let text = '';
    let buffer = '';
    let emitted = 0;
    await new Promise((resolve, reject) => {
        let idle = null, settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(idle); clearTimeout(hard);
            fn(arg);
        };
        const fail = (why) => {
            try { response.data.destroy?.(); } catch { /* already gone */ }
            finish(reject, stallError(`${why} after ${emitted} token(s)`, emitted));
        };
        const hard = setTimeout(() => fail(`stream exceeded ${hardMs} ms`), hardMs);
        const arm = (ms, why) => { clearTimeout(idle); idle = setTimeout(() => fail(why), ms); };
        arm(firstMs, `no first token in ${firstMs} ms`);
        response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const { deltas, done, rest } = _sseDeltas(buffer);
            buffer = rest;
            for (const d of deltas) {
                text += d;
                emitted++;
                if (onDelta) { try { onDelta(d); } catch { /* consumer errors never kill the stream */ } }
            }
            arm(idleMs, `no token for ${idleMs} ms`);
            if (done) finish(resolve);
        });
        response.data.on('end', () => finish(resolve));
        response.data.on('error', (err) => finish(reject, err));
    });
    const inChars = messages.reduce((s, m) => s + String(m.content || '').length, 0);
    return {
        text,
        usage: { in: Math.ceil(inChars / 4), out: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0, estimated: true },
        searches: [],
        searchCount: 0,
    };
}

async function complete({ messages, model = null, maxTokens = 600, temperature = 0.5, timeouts = {} } = {}, deps = {}) {
    const openai = deps.openai || require('../../../config/openai');
    const completeMs = timeouts.completeMs ?? COMPLETE_MS;
    const res = await withTimeout(openai.chat.completions.create({
        model: model || process.env.OPENAI_MODEL || 'deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
    }), completeMs, `no completion in ${completeMs} ms`);
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
        // The tool loop's turns share the completion cap: an axios call with no
        // timeout is exactly how the 910 s hang happened elsewhere in this file.
        { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: COMPLETE_MS }
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

module.exports = { complete, streamText, completeWithTools, _sseDeltas, stallError, withTimeout };
