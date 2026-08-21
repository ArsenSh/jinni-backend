// Jinni V2 Engine — Narrator: the provider-agnostic LLM contract.
// Every provider (providers/claude.js, providers/deepseek.js, providers/ollama.js)
// implements EXACTLY this interface, so swapping models — including future local
// inference via Ollama — is a config change, not a refactor (V3 blueprint §5, §9.4).
// NOT yet implemented and NOT mounted anywhere — v1 is untouched by this file.
//
// Contract (frozen 2026-08-21):
//
// narrator.stream({
//   messages,            // provider-neutral [{role, content}]
//   tools,               // optional tool definitions (v2 agentic loop)
//   model,               // resolved from AppConfig routing, never hardcoded
//   onToken(text),       // streamed content callback
//   onToolCall(call),    // agentic loop callback (name, input) → tool_result
// }) → { text, usage: {in, out, cacheRead, cacheWrite}, searches, searchCount }
//
// narrator.embed(texts) → [Float32Array]   // retrieval-core + semantic-cache embeddings
//
// Rules: the narrator NEVER names a place that didn't come from a tool/retrieval
// result; billing uses REAL usage (all four token buckets) — never characters/4.

async function stream(opts) {
  throw new Error('[engine/narrator] not implemented yet — see engine/ENGINE.md build state');
}

async function embed(texts) {
  throw new Error('[engine/narrator] embed not implemented yet — see engine/ENGINE.md build state');
}

module.exports = { stream, embed };
