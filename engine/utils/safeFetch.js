// Jinni V2 Engine — SSRF-guarded HTML fetching (the safety layer under every
// third-party page read: event listings, feeds, discovery probes, future
// business og:image fallback).
// COPIED from routes/aiRoutes.js (v1, lines ~4434–4529) per the copy-not-cut rule
// (engine/ENGINE.md). Only deviation: `net`/`dns` requires moved to module top
// (v1 required them inline because it lives in a routes file) — behavior identical.

const net = require('net');
const dns = require('dns').promises;

const EVENT_LISTING_TIMEOUT_MS   = 4500;
const EVENT_LISTING_MAX_BYTES    = 1500000;    // ~1.5 MB of HTML is plenty for a <head> full of JSON-LD
const EVENT_LISTING_MAX_REDIRECTS = 3;
const EVENT_LISTING_CONCURRENCY  = 4;          // polite, and bounds worst-case added latency

function _isPrivateIpAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127) return true;              // this-host, private, loopback
        if (a === 172 && b >= 16 && b <= 31) return true;               // private
        if (a === 192 && b === 168) return true;                        // private
        if (a === 169 && b === 254) return true;                        // link-local (cloud metadata)
        if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
        if (a >= 224) return true;                                      // multicast + reserved
        return false;
    }
    if (net.isIPv6(ip)) {
        const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
        if (s === '::1' || s === '::') return true;                     // loopback / unspecified
        if (/^fe[89ab]/.test(s)) return true;                           // link-local
        if (/^f[cd]/.test(s)) return true;                              // unique-local
        const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);         // IPv4-mapped
        if (mapped) return _isPrivateIpAddress(mapped[1]);
        return false;
    }
    return true;   // unparseable → refuse rather than resolve
}

async function _assertPublicHttpUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`blocked scheme ${url.protocol}`);
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error(`blocked port ${url.port}`);
    if (url.username || url.password) throw new Error('blocked credentials in URL');
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (!addrs.length) throw new Error('no DNS result');
    for (const a of addrs) {
        if (_isPrivateIpAddress(a.address)) throw new Error(`blocked private address ${a.address}`);
    }
    return url;
}

// Global fetch + web streams need Node 18+. Nothing in this repo pins a Node
// version (no Dockerfile, .nvmrc or engines field), so an older runtime is not
// impossible. Check once and let callers degrade honestly instead of one
// confusing warning per URL per tap.
const _fetchUnavailable = typeof fetch !== 'function';
if (_fetchUnavailable) {
    console.warn('[safeFetch] global fetch() unavailable on this Node runtime (needs 18+) — page reads disabled');
}

async function _fetchListingHtml(rawUrl) {
    let target = rawUrl;
    for (let hop = 0; hop <= EVENT_LISTING_MAX_REDIRECTS; hop++) {
        const url = await _assertPublicHttpUrl(target);   // re-validated on EVERY hop
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), EVENT_LISTING_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, {
                redirect: 'manual',
                signal: ac.signal,
                headers: {
                    // Identify honestly; some ticketing sites 403 an empty UA.
                    'User-Agent': 'JinniTravelBot/1.0 (+https://jinni.travel; event listing date verification)',
                    'Accept': 'text/html,application/xhtml+xml,application/ld+json;q=0.9,*/*;q=0.1',
                    'Accept-Language': 'en,hy;q=0.8,ru;q=0.8'
                }
            });
        } finally {
            clearTimeout(timer);
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const loc = res.headers.get('location');
            if (!loc) return null;
            target = new URL(loc, url).toString();
            continue;                                     // loop re-validates the new host
        }
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|application\/ld\+json/i.test(ct)) return null;

        // Streamed with a byte cap: Content-Length can lie or be absent, so the
        // cap has to be enforced on what actually arrives.
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > EVENT_LISTING_MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    return null;   // redirect budget exhausted
}

module.exports = {
    _isPrivateIpAddress,
    _assertPublicHttpUrl,
    _fetchListingHtml,
    _fetchUnavailable,
    EVENT_LISTING_TIMEOUT_MS,
    EVENT_LISTING_MAX_BYTES,
    EVENT_LISTING_MAX_REDIRECTS,
    EVENT_LISTING_CONCURRENCY,
};
