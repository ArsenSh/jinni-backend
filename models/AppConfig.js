// models/AppConfig.js
//
// A single-document settings store for app-wide config. You don't currently
// have a general config model (every setting today lives on User/Business),
// so this is the new home for the AI provider toggle you flip from the admin
// page.
//
// It is read on the hot path (every chat / quick-action request), so reads are
// served from a short in-memory cache and only refreshed every TTL or when the
// admin saves a change (which calls updateConfig and refreshes the cache).

const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema({
    // Always the single doc with key 'global'.
    key: { type: String, default: 'global', unique: true, index: true },

    // ── Provider routing ──────────────────────────────────────────────────
    // Independent per endpoint so you can, e.g., run Claude on quick-action
    // (cheap, easy) while leaving chat-stream on DeepSeek, or vice versa.
    aiProviderChat:        { type: String, enum: ['deepseek', 'claude'], default: 'deepseek' },
    aiProviderQuickAction: { type: String, enum: ['deepseek', 'claude'], default: 'deepseek' },

    // ── Claude options (ignored entirely when provider is 'deepseek') ──────
    claudeModel:            { type: String,  default: 'claude-haiku-4-5-20251001' },
    claudeWebSearch:        { type: Boolean, default: false },  // master switch for web search
    claudeWebSearchMaxUses: { type: Number,  default: 3 },      // cap searches per request ($0.01 each)
    /* Which sites the web search may read.
     *
     * These were never sent. claudeService.buildTools() has always accepted
     * allowedDomains/blockedDomains and set them on the tool, but aiRoutes
     * passed neither — so every search ran completely unrestricted and the
     * model read whatever happened to rank. A concert date was taken from a
     * homeexchange.com blog post while the ticket seller's own page went
     * unread, because nothing told it which sources are authoritative.
     *
     * Configured here, not hardcoded, because the right sources differ by
     * country (tomsarkgh.am and tkt.am in Armenia; something else in France).
     * Both are editable from the admin page — no deploy needed to retune.
     *
     * blocked wins over allowed at the API, so keep the two disjoint.
     * ALLOWED is a hard whitelist: non-empty means the search may read ONLY
     * those domains. That is exactly the "just use the good sites" behaviour,
     * and it is also easy to over-narrow into finding nothing — set it
     * deliberately, and watch the searches= count after you do. */
    /* How far ahead an events tap may look, in days.
     *
     * Unbounded, the model and the ticketing feed both happily returned events
     * in October for a tap made in August — a concert seven weeks out is not
     * "what's on", it is a catalogue. Applies to AI- and feed-sourced events
     * only: a validator's curated record is a deliberate human decision and is
     * never hidden by this. 0 disables the limit. */
    eventHorizonDays: { type: Number, default: 7 },
    /* Discover each country's event sources automatically (one small AI call
     * per country per week, verified before use). A manual
     * claudeWebSearchAllowedDomains always wins where it is set; this only
     * fills the countries you have not configured. false = manual only. */
    eventSourceAutoDiscover: { type: Boolean, default: true },
    claudeWebSearchBlockedDomains: { type: [String], default: [] },
    claudeWebSearchAllowedDomains: { type: [String], default: [] },
    // Explicit allowlist of quick-actions that may web-search on their FIRST
    // tap (when claudeWebSearch is true). An action searches only if it is
    // present here. Empty array = NO action searches (use the claudeWebSearch
    // master switch to disable entirely). Managed from the admin dashboard's
    // per-action picker. Default seeds events, where freshness matters most.
    claudeWebSearchActions: { type: [String], default: ['events'] },

    // ── Google candidate prefetch (quick-action shortlist) ─────────────────
    // Master switch: when on, quick-action-stream runs ONE Google Text Search
    // per request and hands the model a shortlist of real places to rank/filter
    // (reduces AI hallucination; the kept names carry a real placeId so
    // enrichment skips the per-name findPlaces call). Off by default.
    googlePrefetch:        { type: Boolean, default: false },
    // Which actions get the prefetch. Default to the dense-coverage actions;
    // hidden_gems / photo_spots / historical stay on the curated + AI path.
    // Empty array = all actions (when googlePrefetch is true).
    googlePrefetchActions: { type: [String], default: ['restaurants', 'hotels', 'shopping'] },
    // How many candidates to request from Text Search (1–20).
    googlePrefetchCount:   { type: Number, default: 12 },
    // Result-set cache TTL in minutes (protects the Text Search quota).
    googlePrefetchTtlMin:  { type: Number, default: 1440 },
    // Which quick-action LAYERS the prefetch runs on. Layer 1 = first tap; layers
    // 2–4 = the three "View More" refill taps. Because the result set is area-cached
    // for 24h, listing 2,3,4 costs the SAME single Text Search as listing just 2 —
    // the later taps page through the cached pool. Empty array = all layers.
    googlePrefetchLayers:  { type: [Number], default: [2, 3, 4] },
    // How the prefetch candidates are USED:
    //   'resolve'  → build a name→placeId index only. The model's chosen names that
    //                match a candidate carry its real placeId (enrichment skips the
    //                findPlaces resolution call), but unmatched candidates are NOT
    //                injected as recommendations. Best for thin / well-known markets
    //                where the model already names the right places (e.g. luxury
    //                hotels in a small city) — Google verifies, it doesn't suggest.
    //   'suggest'  → the above PLUS inject unmatched candidates as recommendations.
    //                Best for dense / unfamiliar markets where Google's pool genuinely
    //                beats the model's recall (e.g. restaurants in a large city).
    googlePrefetchMode:    { type: String, enum: ['resolve', 'suggest'], default: 'suggest' },

    // ── Cache curation ──────────────────────────────────────────────────────
    // On the FIRST tap (the call that runs WITH web search), show the model a
    // capped, ranked slice of the places we ALREADY hold for this action+area and
    // ask it to suggest strong places BEYOND them — so its output COMPLEMENTS the
    // cache instead of regenerating the same local "top N", widening per-grid
    // variety and growing the cache. Off by default. Skipped when googlePrefetch
    // supplied a shortlist for the same request (avoid mixed prompt signals).
    cacheCuration:         { type: Boolean, default: false },
    // Empty array = all actions (when cacheCuration is true). Defaults to the
    // price/dense actions where the cache fills fastest.
    cacheCurationActions:  { type: [String], default: ['restaurants', 'hotels', 'shopping', 'hidden_gems'] },
    // How many known names to show the model (capped to keep the prompt lean).
    cacheCurationCount:    { type: Number, default: 15 },

    // OPTIONAL global ceiling (km) on how far an AI/Google-resolved quick-action
    // place may be. 0 = off (default): the per-user search radius (nearby vs
    // discovery, from each user's settings) is the cap. Set a positive value only
    // to clamp ALL users below their own radius (e.g. force a city-only product).
    quickActionMaxDistanceKm: { type: Number, default: 0 },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// ── In-memory cache ─────────────────────────────────────────────────────────
let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30 * 1000;

// Read config (cached). Creates the global doc on first call.
appConfigSchema.statics.getConfig = async function () {
    if (_cache && (Date.now() - _cacheAt) < TTL_MS) return _cache;
    let doc = await this.findOne({ key: 'global' }).lean();
    if (!doc) {
        try { doc = (await this.create({ key: 'global' })).toObject(); }
        catch (e) { doc = await this.findOne({ key: 'global' }).lean(); } // race-safe
    }
    _cache = doc;
    _cacheAt = Date.now();
    return doc;
};

// Patch config from the admin page and refresh the cache immediately.
appConfigSchema.statics.updateConfig = async function (patch = {}, userId = null) {
    const allowed = [
        'aiProviderChat', 'aiProviderQuickAction', 'claudeModel',
        'claudeWebSearch', 'claudeWebSearchMaxUses', 'claudeWebSearchActions',
        'claudeWebSearchBlockedDomains', 'claudeWebSearchAllowedDomains',
        'eventHorizonDays', 'eventSourceAutoDiscover',
        'googlePrefetch', 'googlePrefetchActions', 'googlePrefetchCount', 'googlePrefetchTtlMin', 'googlePrefetchLayers', 'googlePrefetchMode',
        'cacheCuration', 'cacheCurationActions', 'cacheCurationCount',
        'quickActionMaxDistanceKm',
    ];
    const set = {};
    for (const k of allowed) if (patch[k] !== undefined) set[k] = patch[k];
    set.updatedBy = userId;

    const doc = await this.findOneAndUpdate(
        { key: 'global' }, { $set: set },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    _cache = doc;
    _cacheAt = Date.now();
    return doc;
};

appConfigSchema.statics.invalidateCache = function () { _cache = null; _cacheAt = 0; };

module.exports = mongoose.model('AppConfig', appConfigSchema);