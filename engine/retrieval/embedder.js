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
let _localPromise = null;      // lazy init of the local model (null = not loading)
// A load failure is TRANSIENT, never permanent. The old `_localFailed = true`
// forever meant one network blip during the container's first model download
// turned vectors off for the LIFE of the process — vec=false for a whole
// session after a redeploy, silently (live 2026-08-31). Now a failure sets a
// retry-after timestamp with growing backoff (1min → cap 10min); the next
// retrieval past that time simply tries again. Fail-open stays: while the
// model is absent, retrieval runs lexical-only, no request ever fails.
let _nextRetryAt = 0;
let _failCount = 0;

// MULTILINGUAL swap 2026-08-31 (founder-approved): all-MiniLM-L6-v2 was
// English-centric — an Armenian query scored 0.066 cosine against a Dilijan
// hotel doc, BELOW the unrelated-text noise floor (0.138), so hy/ru asks got
// zero semantic help. paraphrase-multilingual-MiniLM-L12-v2 (~50 languages
// incl. hy/ru/ka) scores the same pair 0.658 vs 0.189 noise — measured
// locally before the swap. Same 384 dims (no schema change), ~120 MB
// quantized. The sweep + backfill re-embed automatically on model mismatch
// (embeddingModel: { $ne: model } filters); candidates gate stored vectors
// by model name so old vectors are IGNORED, never mixed, until re-embedded.
// AFTER DEPLOY run on the server: node scripts/embedPlaceCache.js --apply
const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';   // 384-dim multilingual, CPU-fine

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
        _failCount += 1;
        const backoffMs = Math.min(_failCount * 60 * 1000, 10 * 60 * 1000);
        _nextRetryAt = Date.now() + backoffMs;
        _localPromise = null;   // allow the retry after the backoff window
        console.warn(`[embedder] model load failed (${err.code || err.message}) — retrying in ${Math.round(backoffMs / 1000)}s; retrieval runs lexical-only meanwhile`);
        return null;
    }
}

/**
 * @returns {Promise<{embed(texts): Promise<number[][]>, model: string} | null>}
 *          null = no embedder available; callers MUST degrade to lexical-only.
 */
async function getEmbedder() {
    if (_override) return _override;
    if (!_localPromise) {
        if (Date.now() < _nextRetryAt) return null;   // inside the backoff window
        _localPromise = _loadLocal();
    }
    return _localPromise;
}

/** Boot-time warm-up: load the model NOW and say LOUDLY whether vectors are
 *  live — a silent fail-open hid vec=false for a whole session (2026-08-31).
 *  Returns true when vectors are live. Never throws. */
async function warmEmbedder() {
    const t0 = Date.now();
    try {
        const e = await getEmbedder();
        if (e) {
            console.log(`[embedder] ✅ vectors LIVE — ${e.model} ready in ${Date.now() - t0}ms`);
            return true;
        }
        console.warn('[embedder] ⚠️ vectors OFF — retrieval is LEXICAL-ONLY (load failed or package missing; retries continue in the background)');
        return false;
    } catch (err) {
        console.warn(`[embedder] ⚠️ warm-up error (${err.message}) — retrieval is LEXICAL-ONLY for now`);
        return false;
    }
}

module.exports = { getEmbedder, setEmbedder, warmEmbedder, LOCAL_MODEL };
