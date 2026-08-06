// services/mongoBilling.js
// ────────────────────────────────────────────────────────────────────────────
// Fetches real, current-period billing data from the MongoDB Atlas Admin API.
//
// Why this exists:
//   The Prices tab used to hardcode "M0 free tier · 512 MB". The project is now
//   on Atlas Flex, which has dynamic pricing: $8 base + tiered ops/sec usage,
//   capped at $30/month. The only way to know the *actual* spend is to ask
//   Atlas directly via the pending-invoice endpoint, which returns the
//   month-to-date amount in real time (updated roughly hourly upstream).
//
// Endpoint:
//   GET https://cloud.mongodb.com/api/atlas/v2/orgs/{ORG_ID}/invoices/pending
//   Auth: HTTP Digest with a Programmatic API Key (public + private)
//   Role required on the key: Organization Billing Viewer (minimum)
//
// Required env vars:
//   ATLAS_ORG_ID         — 24-hex org id (Atlas → Organization → Settings)
//   ATLAS_API_PUBLIC_KEY — public part of the API key
//   ATLAS_API_PRIVATE_KEY — private part of the API key
//
// Caching:
//   Atlas updates billing data ~hourly and rate-limits the Admin API. We cache
//   the parsed result for 60 minutes so the admin dashboard can poll freely
//   without hammering Atlas. Use forceRefresh=true to bypass.
// ────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const AxiosDigestAuth = require('@mhoc/axios-digest-auth').default;
const logger = require('../utils/logger');

const BASE_URL = 'https://cloud.mongodb.com/api/atlas/v2';
const ACCEPT_HEADER = 'application/vnd.atlas.2023-01-01+json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = { data: null, fetchedAt: 0, error: null };

function envOk() {
    return !!(process.env.ATLAS_ORG_ID && process.env.ATLAS_API_PUBLIC_KEY && process.env.ATLAS_API_PRIVATE_KEY);
}

// Build a digest-auth client. We re-create it per call because the lib is
// lightweight and storing the secret in module scope feels worse than the cost.
function makeClient() {
    return new AxiosDigestAuth({
        username: process.env.ATLAS_API_PUBLIC_KEY,
        password: process.env.ATLAS_API_PRIVATE_KEY,
    });
}

// Group line items by SKU and sum cents. Atlas SKUs for Flex include things
// like ATLAS_FLEX_INSTANCE, ATLAS_FLEX_OPERATIONS, ATLAS_BACKUP_STORAGE, etc.
// We don't hardcode the SKU list — we just surface whatever Atlas returns so
// new SKUs (e.g. Atlas Search if you enable it) show up automatically.
function summariseLineItems(lineItems) {
    const bySku = {};
    let totalCents = 0;
    for (const li of lineItems || []) {
        const sku = li.sku || 'UNKNOWN';
        const cents = li.totalPriceCents || 0;
        bySku[sku] = (bySku[sku] || 0) + cents;
        totalCents += cents;
    }
    // Sort SKUs by spend desc so the biggest line shows first in the UI.
    const breakdown = Object.entries(bySku)
        .map(([sku, cents]) => ({ sku, cost: cents / 100 }))
        .sort((a, b) => b.cost - a.cost);
    return { totalCost: totalCents / 100, breakdown };
}

async function fetchPendingInvoice() {
    if (!envOk()) {
        throw new Error('Atlas billing env vars missing (ATLAS_ORG_ID / ATLAS_API_PUBLIC_KEY / ATLAS_API_PRIVATE_KEY)');
    }
    const url = `${BASE_URL}/orgs/${process.env.ATLAS_ORG_ID}/invoices/pending`;
    const client = makeClient();
    // Note: digest auth makes 2 round trips (challenge + response). 15s timeout
    // is generous — Atlas usually answers in well under a second.
    const res = await client.request({
        method: 'GET',
        url,
        headers: { Accept: ACCEPT_HEADER },
        timeout: 15000,
    });
    return res.data;
}

/**
 * Returns current-month Atlas spend.
 *
 * Shape:
 *   {
 *     totalCost: 12.34,                // USD, month-to-date
 *     breakdown: [{ sku, cost }, ...], // per-SKU breakdown, USD, sorted desc
 *     periodStart: '2026-05-01T00:00:00Z',
 *     periodEnd:   '2026-06-01T00:00:00Z',
 *     fetchedAt:   1715000000000,      // ms since epoch
 *     stale:       false,              // true if we served from cache after TTL due to a fetch error
 *   }
 *
 * On failure (missing env, network, 4xx/5xx) we return an object with
 *   { available: false, reason: '...' }
 * so the frontend can render a "billing API not configured" hint rather than
 * blowing up the whole Prices tab.
 */
async function getCurrentMonthSpend(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
        return cache.data;
    }
    try {
        const invoice = await fetchPendingInvoice();
        const { totalCost, breakdown } = summariseLineItems(invoice.lineItems);
        const result = {
            available: true,
            totalCost: parseFloat(totalCost.toFixed(2)),
            breakdown: breakdown.map(b => ({ sku: b.sku, cost: parseFloat(b.cost.toFixed(2)) })),
            periodStart: invoice.startDate || null,
            periodEnd:   invoice.endDate   || null,
            fetchedAt:   now,
            stale:       false,
        };
        cache = { data: result, fetchedAt: now, error: null };
        return result;
    } catch (err) {
        const reason = err.response
            ? `Atlas API ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
            : err.message;
        logger.error('Atlas billing fetch failed: ' + reason);
        cache.error = reason;
        // If we have stale data, return it with a stale flag — better than nothing.
        if (cache.data) {
            return { ...cache.data, stale: true, staleReason: reason };
        }
        return { available: false, reason };
    }
}

function clearCache() { cache = { data: null, fetchedAt: 0, error: null } }

module.exports = { getCurrentMonthSpend, clearCache };