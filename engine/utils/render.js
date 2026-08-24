// Jinni V2 Engine — render a page the way a browser would.
//
// Many pages that look "blocked" are not blocked at all: they are JavaScript.
// The HTML our fetcher receives is a shell, the listing is injected on load,
// and our reader correctly reports "no dated events" on a page a person sees
// full of them. Rendering is ordinary reading — it asks for exactly what a
// visitor's browser asks for. It is NOT a way past a bot check, and nothing
// here tries to be: no fingerprint spoofing, no proxies, no CAPTCHA handling.
// A site that refuses us still refuses us, and that is its right.
//
// OPTIONAL BY DESIGN. Playwright and its browser are a ~300MB install, so this
// module loads it lazily and returns null when it is absent — every caller
// already treats null as "nothing to read" and falls back to plain fetch. The
// app runs unchanged until the dependency is deliberately added.
//
// Because a render costs seconds where a fetch costs milliseconds, callers
// ESCALATE to it rather than starting with it: fetch, read, and only render
// when the plain HTML yielded nothing.

const { _assertPublicHttpUrl } = require('./safeFetch');

const RENDER_TIMEOUT_MS = 20000;
const IDLE_MS = 1500;                 // quiet network before we take the DOM
const MAX_CONCURRENT = 2;             // a browser page is expensive; skip the rest

let _playwright;                      // undefined = not tried, null = unavailable
let _browser = null;
let _launching = null;
let _inFlight = 0;
let _warned = false;

function _load() {
    if (_playwright !== undefined) return _playwright;
    try {
        _playwright = require('playwright');
    } catch {
        _playwright = null;
        if (!_warned) {
            _warned = true;
            console.log('[render] playwright not installed — JS-rendered pages will be read as plain HTML');
        }
    }
    return _playwright;
}

/** Whether rendering can be attempted at all. Callers use it to decide whether
 *  escalation is even worth a log line. */
let _saidOnce = false;
function renderAvailable() {
    const on = process.env.RENDER_JS !== 'off' && !!_load();
    // Silence was indistinguishable from "never asked": a whole Dubai run
    // produced no [render] line at all and neither of us could tell whether the
    // browser was missing or simply unused (live 2026-08-24).
    if (!_saidOnce) {
        _saidOnce = true;
        console.log(on ? '[render] rendering is ON (playwright present)'
            : `[render] rendering is OFF (${process.env.RENDER_JS === 'off' ? 'RENDER_JS=off' : 'playwright not installed'})`);
    }
    return on;
}

async function _browserOnce() {
    if (_browser) return _browser;
    if (_launching) return _launching;
    const pw = _load();
    if (!pw) return null;
    _launching = pw.chromium
        .launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
        .then((b) => {
            _browser = b;
            // A crashed browser must not poison every later call.
            b.on('disconnected', () => { _browser = null; });
            return b;
        })
        .catch((err) => {
            console.warn(`[render] browser launch failed: ${err.message} — falling back to plain fetch`);
            _playwright = null;                       // do not retry this all night
            return null;
        })
        .finally(() => { _launching = null; });
    return _launching;
}

/**
 * @returns {Promise<string|null>} the rendered HTML, or null for every failure
 *   — unavailable, refused, timed out, too busy. Null always means "read it the
 *   plain way", never "this page is empty".
 */
async function renderPage(url, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
    if (!renderAvailable()) return null;
    if (_inFlight >= MAX_CONCURRENT) {
        console.log(`[render] busy — skipping ${String(url).slice(0, 60)}`);
        return null;
    }
    let safe;
    try {
        safe = await _assertPublicHttpUrl(url);       // the same guard as any fetch
    } catch (err) {
        console.warn(`[render] refused ${String(url).slice(0, 60)}: ${err.message}`);
        return null;
    }
    const browser = await _browserOnce();
    if (!browser) return null;
    console.log(`[render] loading ${String(url).slice(0, 70)}`);

    _inFlight++;
    let context = null;
    try {
        context = await browser.newContext({
            // Identify ourselves, exactly as the plain fetcher does. A site that
            // wants to refuse Jinni must be able to recognise Jinni.
            userAgent: 'Mozilla/5.0 (compatible; JinniBot/1.0; +https://jinni.travel)',
            locale: 'en-US',
            viewport: { width: 1280, height: 1600 },
        });
        const page = await context.newPage();
        // We want the DOM, not the pictures. Blocking heavy assets cuts a render
        // to roughly a third and spares the site the bandwidth.
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
        });
        await page.goto(String(safe), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: IDLE_MS }).catch(() => { /* good enough */ });
        const html = await page.content();
        console.log(`[render] ${String(url).slice(0, 60)} → ${html ? html.length : 0} chars`);
        return html && html.length > 500 ? html : null;
    } catch (err) {
        console.warn(`[render] ${String(url).slice(0, 60)}: ${err.message}`);
        return null;
    } finally {
        _inFlight--;
        if (context) await context.close().catch(() => {});
    }
}

/** For tests and graceful shutdown. */
async function closeBrowser() {
    const b = _browser;
    _browser = null;
    if (b) await b.close().catch(() => {});
}

module.exports = { renderPage, renderAvailable, closeBrowser };
