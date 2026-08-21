// Jinni V2 Engine — semantic query cache ("PlaceCache for the AI", ChatV2 §8).
// "Uzbek food Yerevan" and "Uzbek restaurant in Yerevan" should share one hit:
// match by query-EMBEDDING similarity, not exact string. Falls back to a
// normalized-string key when no embedder is available, so the cache still works
// lexical-only. In-process for now (plain-Mongo decision) — the persistent
// PlaceSearchCache upgrade happens at wiring time, not here.
//
// Scoping rule: a hit must come from the SAME params bucket (category, subType,
// mode, tap state, and a ~5 km rounded center) — a Yerevan answer must never
// serve a Dubai ask, however similar the wording.

const { cosineSimilarity } = require('./vector');
const { normalizePlaceName } = require('../places/matching');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX = 500;
const DEFAULT_THRESHOLD = 0.92;

class SemanticCache {
    constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, threshold = DEFAULT_THRESHOLD, nowFn = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.threshold = threshold;
        this.nowFn = nowFn;
        this._buckets = new Map();   // paramsKey → Array<{vector|null, textKey|null, result, at}>
        this._size = 0;
    }

    /** The non-linguistic identity of a request. Same bucket = comparable asks. */
    paramsKey({ category = null, subType = null, mode = null, tapState = null, center = null } = {}) {
        const lat = Number.isFinite(center?.lat) ? Math.round(center.lat * 20) / 20 : null;   // ~5 km buckets
        const lng = Number.isFinite(center?.lng) ? Math.round(center.lng * 20) / 20 : null;
        return JSON.stringify([category, subType, mode, tapState, lat, lng]);
    }

    /** @returns cached result or null. Never throws. */
    get(params, { queryVector = null, queryText = null } = {}) {
        const bucket = this._buckets.get(this.paramsKey(params));
        if (!bucket) return null;
        const now = this.nowFn();
        const textKey = queryText ? normalizePlaceName(queryText) : null;
        for (const e of bucket) {
            if (now - e.at >= this.ttlMs) continue;
            if (queryVector && e.vector && cosineSimilarity(queryVector, e.vector) >= this.threshold) return e.result;
            if (textKey && e.textKey && e.textKey === textKey) return e.result;
        }
        return null;
    }

    set(params, { queryVector = null, queryText = null } = {}, result) {
        const key = this.paramsKey(params);
        if (!this._buckets.has(key)) this._buckets.set(key, []);
        const bucket = this._buckets.get(key);
        bucket.push({
            vector: Array.isArray(queryVector) ? queryVector : null,
            textKey: queryText ? normalizePlaceName(queryText) : null,
            result,
            at: this.nowFn(),
        });
        this._size++;
        // Cheap global FIFO trim across buckets (insertion order preserved).
        while (this._size > this.max) {
            const firstKey = this._buckets.keys().next().value;
            const firstBucket = this._buckets.get(firstKey);
            firstBucket.shift();
            this._size--;
            if (!firstBucket.length) this._buckets.delete(firstKey);
        }
    }
}

module.exports = { SemanticCache, DEFAULT_THRESHOLD };
