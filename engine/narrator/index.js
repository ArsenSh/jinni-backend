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

async function stream({ messages, tools = null, model = 'deepseek', onToken = null, maxTokens = 600, temperature = 0.5, realStream = false, webSearch = null } = {}, deps = {}) {
    if (tools && tools.length) {
        throw new Error('[engine/narrator] tool-use loop not implemented yet — see engine/ENGINE.md build state');
    }
    const provider = deps.provider || PROVIDERS[String(model).toLowerCase()] || deepseek;
    // TRUE streaming when requested and the provider can (tokens reach onToken
    // as the model produces them). Falls back to complete+pseudo-stream.
    if (realStream && typeof provider.streamText === 'function') {
        return provider.streamText({ messages, maxTokens, temperature, onDelta: onToken, webSearch });
    }
    const result = await provider.complete({ messages, maxTokens, temperature, webSearch });
    if (typeof onToken === 'function' && result.text) {
        // Pseudo-stream: the reply arrives whole, the client still sees it flow.
        for (const chunk of result.text.match(/.{1,60}(\s|$)/gs) || [result.text]) {
            onToken(chunk);
        }
    }
    return result;
}

async function embed(texts) {
    throw new Error('[engine/narrator] embed not implemented — use engine/retrieval/embedder');
}

module.exports = { stream, embed };
