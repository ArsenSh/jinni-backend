// ── Cache refresh sweep ──────────────────────────────────────────────────────
// Keeps PlaceCache rows current WITHOUT hiding them. Until 2026-10-11 the v3
// deck query dropped any row whose lastFetched was older than 30 days, and only
// the v1 quick-action paths ever bumped lastFetched — so a row the chat had not
// dealt for a month went dark for good (258 of Yerevan's 413 image-bearing
// rows, 214 of them staff-verified; 1,441 of 1,970 across all cities). The
// coverage gate still counted those rows as warm, so Google was never asked
// either. Founder's call: the gate goes, freshness becomes this job.
//
// What a refresh touches: rating, opening_hours (unless staff curated them),
// business_status, types, primaryType, priceLevel, website, phones, and
// lastFetched. Photos, stored images, coordinates, address, staff tags and
// interests are never written — the row keeps everything that was bought.
//
// Cost: one Place Details call per row (the standard field mask, so the same
// data the warm path stores). A batch is bounded (CACHE_REFRESH_LIMIT, default
// 500 ≈ $2.5 at the Details tier) and runs weekly; the one-off backlog is
// cleared from the CLI (scripts/refreshStaleCache.js).
//
// Controls:
//     CACHE_REFRESH_ENABLED=false     → do not schedule the sweep
//     CACHE_REFRESH_SWEEP_MS=…        → cadence (default 7 days)
//     CACHE_REFRESH_LIMIT=…           → rows per run (default 500)
//     CACHE_REFRESH_DAYS=…            → "stale" threshold (default 30)
//
// Single-instance assumption, like the other sweeps in server.js: every
// instance would run its own batch. The work is idempotent, only the spend
// would double.
const STALE_DAYS = Number(process.env.CACHE_REFRESH_DAYS ?? 30);
const BATCH_LIMIT = Number(process.env.CACHE_REFRESH_LIMIT ?? 500);
const SWEEP_INTERVAL_MS = Number(process.env.CACHE_REFRESH_SWEEP_MS ?? 7 * 24 * 60 * 60 * 1000);
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;   // let boot traffic settle first
const PACE_MS = 150;                         // between Details calls (the status script's pace)

/** The rows a sweep considers: owned (images stored), stale, not recently failed. */
function staleQuery({ olderThanDays = STALE_DAYS, now = Date.now() } = {}) {
    const cutoff = new Date(now - olderThanDays * 24 * 60 * 60 * 1000);
    return {
        imagesStored: true,
        // Mirrors of our own Destinations / Businesses (scripts/mirrorLegacyImages:
        // placeId dest_… / biz_…) carry images but no Google identity — the first
        // backlog run (2026-10-11) spent 60 calls learning that from 400s.
        placeId: { $not: /^(dest|biz)_/ },
        $and: [
            { $or: [{ lastFetched: { $lt: cutoff } }, { lastFetched: null }, { lastFetched: { $exists: false } }] },
            { $or: [{ refreshFailedAt: null }, { refreshFailedAt: { $exists: false } }, { refreshFailedAt: { $lt: cutoff } }] },
        ],
    };
}

/** The $set a refresh writes — pure, so the test can read it. */
function refreshUpdate(row, details, now = new Date()) {
    const set = {
        rating: details.rating ?? null,
        website: details.website || null,
        formatted_phone_number: details.formatted_phone_number || null,
        international_phone_number: details.international_phone_number || null,
        // Staff-curated hours outrank a Google refresh (validator, 2026-09-16).
        opening_hours: (row.hoursCurated && row.opening_hours) ? row.opening_hours : (details.opening_hours || null),
        business_status: details.business_status || null,
        types: Array.isArray(details.types) ? details.types : [],
        primaryType: details.primaryType || null,
        priceLevel: details.price_level || null,
        hasDetailedInfo: true,
        lastFetched: now,
        refreshFailedAt: null,
    };
    return { $set: set, $inc: { fetchCount: 1 } };
}

/**
 * One sweep. Returns a summary; never throws for a single row.
 * deps: { find(query, limit) → rows, getPlaceDetails(placeId) → details|null,
 *         updateOne(filter, update), sleep(ms), now() } — all injectable.
 */
async function runCacheRefresh({ olderThanDays = STALE_DAYS, limit = BATCH_LIMIT, dryRun = false, log = console.log } = {}, deps = {}) {
    const PlaceCache = deps.PlaceCache || require('../models/PlaceCache');
    const find = deps.find || (async (query, n) => PlaceCache.find(query)
        .select('placeId name hoursCurated opening_hours lastFetched')
        .sort({ lastFetched: 1 }).limit(n).allowDiskUse(true).lean());
    const getPlaceDetails = deps.getPlaceDetails
        || ((placeId) => require('./googleService').getPlaceDetails(placeId, false, 'cache-refresh'));
    const updateOne = deps.updateOne || ((filter, update) => PlaceCache.updateOne(filter, update));
    const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const now = deps.now || (() => new Date());

    const query = staleQuery({ olderThanDays, now: now().getTime() });
    const rows = await find(query, Math.max(1, limit));
    const summary = { considered: rows.length, refreshed: 0, failed: 0, nonOperational: [], dryRun };
    if (dryRun) {
        log(`[cache-refresh] DRY-RUN: ${rows.length} row(s) older than ${olderThanDays}d would be refreshed (limit ${limit})`);
        return summary;
    }
    for (const row of rows) {
        try {
            const details = await getPlaceDetails(row.placeId);
            if (!details) {
                summary.failed++;
                await updateOne({ _id: row._id }, { $set: { refreshFailedAt: now() } });
            } else {
                await updateOne({ _id: row._id }, refreshUpdate(row, details, now()));
                summary.refreshed++;
                if (details.business_status && details.business_status !== 'OPERATIONAL') {
                    summary.nonOperational.push(`${row.name} (${details.business_status})`);
                }
            }
        } catch (err) {
            summary.failed++;
            log(`[cache-refresh] ${row.name}: ${err.message}`);
            try { await updateOne({ _id: row._id }, { $set: { refreshFailedAt: now() } }); } catch { /* logged above */ }
        }
        if (PACE_MS) await sleep(PACE_MS);
    }
    log(`[cache-refresh] refreshed ${summary.refreshed} · failed ${summary.failed} · non-operational ${summary.nonOperational.length}`
        + (summary.nonOperational.length ? `: ${summary.nonOperational.join(', ')}` : ''));
    return summary;
}

let sweepTimer = null;
let inFlight = false;

function startCacheRefresh() {
    if (process.env.CACHE_REFRESH_ENABLED === 'false') {
        console.log('[cache-refresh] disabled via CACHE_REFRESH_ENABLED=false');
        return null;
    }
    if (sweepTimer) return sweepTimer;
    const safeRun = async () => {
        if (inFlight) { console.warn('[cache-refresh] previous sweep still running — skipping this tick'); return; }
        inFlight = true;
        try { await runCacheRefresh(); }
        catch (err) { console.error('[cache-refresh] sweep failed:', err.message); }
        finally { inFlight = false; }
    };
    const firstRun = setTimeout(safeRun, Math.min(FIRST_RUN_DELAY_MS, SWEEP_INTERVAL_MS));
    if (firstRun.unref) firstRun.unref();
    sweepTimer = setInterval(safeRun, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
    console.log(`[cache-refresh] scheduled every ${Math.round(SWEEP_INTERVAL_MS / 3600000)}h — up to ${BATCH_LIMIT} row(s) older than ${STALE_DAYS}d per run`);
    return sweepTimer;
}

function stopCacheRefresh() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = { runCacheRefresh, staleQuery, refreshUpdate, startCacheRefresh, stopCacheRefresh, STALE_DAYS, BATCH_LIMIT, SWEEP_INTERVAL_MS };
