// Jinni V2 Engine — Narrator: the provider-agnostic LLM contract.
// Providers implement { complete({messages, model, maxTokens, temperature}) →
// {text, usage, searches, searchCount} } — swapping models (DeepSeek today,
// Claude/Ollama later) is a config change, not a refactor (V3 blueprint §5, §9.4).
//
// v0 STATE: DeepSeek provider only; tool-use loop NOT yet implemented (the
// grounded-prompt path in routes/aiChatV2.js does retrieval BEFORE narration,
// so no tools are needed yet); pseudo-streaming (complete → chunked onToken).
// embed() still unimplemented — the retrieval embedder slot covers vectors.
//
// Contract (frozen 2026-08-21):
//   narrator.stream({messages, tools?, model?, onToken?}) → {text, usage, searches, searchCount}
//   narrator.embed(texts) → [Float32Array]
// Rules: the narrator NEVER names a place that didn't come from tool/retrieval
// results (enforced by the grounded prompts); billing uses REAL usage.

const deepseek = require('./providers/deepseek');

// Claude joins the registry (2026-08-22, admin-config parity): AppConfig's
// aiProviderChat picks the narrator for BOTH engines, and Claude carries the
// admin's web-search knobs. Lazy require — no SDK load unless selected.
const PROVIDERS = { deepseek, get claude() { return require('./providers/claude'); } };

async function stream({ messages, tools = null, model = 'deepseek', modelName = null, onToken = null, maxTokens = 600, temperature = 0.5, realStream = false, webSearch = null } = {}, deps = {}) {
    if (tools && tools.length) {
        throw new Error('[engine/narrator] tool-use loop not implemented yet — see engine/ENGINE.md build state');
    }
    const provider = deps.provider || PROVIDERS[String(model).toLowerCase()] || deepseek;
    // Tokens already sent to the client are counted: a failure AFTER them
    // cannot be retried cleanly (the traveler would see two half-replies), a
    // failure BEFORE them can be handed to another provider unseen.
    let emitted = 0;
    const counted = typeof onToken === 'function' ? (c) => { emitted++; onToken(c); } : null;
    const run = async (p) => {
        // TRUE streaming when requested and the provider can (tokens reach
        // onToken as the model produces them). Falls back to complete+pseudo-stream.
        if (realStream && typeof p.streamText === 'function') {
            return p.streamText({ messages, maxTokens, temperature, onDelta: counted, webSearch, modelName });
        }
        const result = await p.complete({ messages, maxTokens, temperature, webSearch, modelName });
        if (counted && result.text) {
            // Pseudo-stream: the reply arrives whole, the client still sees it flow.
            for (const chunk of result.text.match(/.{1,60}(\s|$)/gs) || [result.text]) counted(chunk);
        }
        return result;
    };
    try {
        return await run(provider);
    } catch (err) {
        // FAILOVER (live 2026-09-14): DeepSeek degraded — a stream hung 910 s
        // with zero tokens, then the classifier timed out three times. When
        // the primary is DeepSeek and NOTHING has reached the client yet, the
        // reply is written by Claude instead; the traveler never knows.
        // Never after a token has gone out, and never when Claude is not
        // configured — then the error is the honest outcome.
        const primaryIsDeepseek = provider === deepseek || provider === PROVIDERS.deepseek;
        if (emitted > 0) throw err;
        // First: one more try with the SAME provider, one-shot instead of a
        // stream — a stalled stream is usually a bad connection, not a bad
        // model (founder 2026-09-15: DeepSeek by default, no Anthropic).
        const retry = deps.retryOnStall !== undefined ? deps.retryOnStall : primaryIsDeepseek;
        if (retry && err.code === 'DEEPSEEK_STALL' && typeof provider.complete === 'function') {
            console.warn(`[narrator] ${err.message.slice(0, 100)} — retrying once, one-shot`);
            try {
                const result = await provider.complete({ messages, maxTokens, temperature, webSearch, modelName });
                if (counted && result.text) for (const chunk of result.text.match(/.{1,60}(\s|$)/gs) || [result.text]) counted(chunk);
                result.retried = true;
                return result;
            } catch (again) { err = again; }
        }
        // Then, ONLY when opted in (NARRATOR_FAILOVER=claude in the env, with
        // a funded key): the reply is written by Claude instead, unseen.
        const failover = deps.failover !== undefined
            ? deps.failover
            : ((primaryIsDeepseek && process.env.NARRATOR_FAILOVER === 'claude' && process.env.ANTHROPIC_API_KEY) ? PROVIDERS.claude : null);
        if (!failover || failover === provider) throw err;
        console.warn(`[narrator] ${err.code || err.name || 'error'} before any token (${String(err.message).slice(0, 120)}) — failing over to claude`);
        const result = await run(failover);
        result.failedOver = 'claude';
        return result;
    }
}

async function embed(texts) {
    throw new Error('[engine/narrator] embed not implemented — use engine/retrieval/embedder');
}

module.exports = { stream, embed };
