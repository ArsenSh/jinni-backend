// Jinni V2 Engine — the embedding slot (provider-agnostic, fail-open).
// The retrieval core never depends on WHICH embedder runs — this module is the
// single place that decides. Resolution order:
//   1. an explicitly injected embedder (tests; future narrator/Ollama provider);
//   2. @xenova/transformers (free local CPU model, all-MiniLM-L6-v2, 384-dim)
//      IF the package is installed — enable with:  npm i @xenova/transformers
//   3. none → getEmbedder() resolves null and retrieval runs LEXICAL-ONLY.
// Fail-open by design: a missing/broken embedder can never fail a request,
// it only reduces ranking quality — same degradation philosophy as v1.

let _override = null;          // injected embedder (tests / future providers)
let _localPromise = null;      // lazy one-time init of the local model
let _localFailed = false;

const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';   // 384-dim, ~23 MB quantized, CPU-fine

/** Inject a custom embedder ({ embed(texts)→number[][], model }) or null to reset. */
function setEmbedder(embedder) {
    _override = embedder;
}

async function _loadLocal() {
    try {
        // Optional dependency — resolved at runtime so the engine works (lexical-
        // only) on installs that don't carry it. Dynamic import(), NOT require():
        // the package is ESM-only and require() throws ERR_REQUIRE_ESM on server
        // Node versions (caught live 2026-08-22 — ran lexical-only silently).
        const { pipeline } = await import('@xenova/transformers');
        const pipe = await pipeline('feature-extraction', LOCAL_MODEL);
        return {
            model: LOCAL_MODEL,
            async embed(texts) {
                const arr = Array.isArray(texts) ? texts : [texts];
                const out = [];
                for (const t of arr) {
                    const res = await pipe(String(t || ''), { pooling: 'mean', normalize: true });
                    out.push(Array.from(res.data));
                }
                return out;
            },
        };
    } catch (err) {
        _localFailed = true;
        console.log(`[embedder] no local embedding model available (${err.code || err.message}) — retrieval runs lexical-only. Enable with: npm i @xenova/transformers`);
        return null;
    }
}

/**
 * @returns {Promise<{embed(texts): Promise<number[][]>, model: string} | null>}
 *          null = no embedder available; callers MUST degrade to lexical-only.
 */
async function getEmbedder() {
    if (_override) return _override;
    if (_localFailed) return null;
    if (!_localPromise) _localPromise = _loadLocal();
    return _localPromise;
}

module.exports = { getEmbedder, setEmbedder, LOCAL_MODEL };
