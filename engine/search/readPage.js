// Jinni V2 Engine — the general web reader (Arsen 2026-08-23: "i need a tool
// that can enter any web an read" … "it may take images also, infos also").
//
// This is ChatGPT-style page reading wrapped in Jinni's rules:
//   • ENTER: the SSRF-guarded fetcher (per-hop public-host validation, honest
//     bot UA, browser-grade Accept headers) with a PATIENCE knob — in-turn
//     callers stay snappy, background callers (cron, forced hunts) may wait
//     out slow hosts like tomsarkgh.am (the 4.5s-abort lesson).
//   • READ: title + description + og:image + first content images + clean
//     body text, capped to a model-friendly length.
//   • UNDERSTAND: extractEventsFromPage lets the cheap model read the text
//     and emit candidate events — accepted ONLY with a parseable date, window
//     -checked by code, and labeled sourceTier 'extracted' (the trust
//     ladder's honest name for model-read data; validators moderate it).
//     ChatGPT reads without guarantees; Jinni reads and then verifies.

const { _fetchListingHtml } = require('../utils/safeFetch');
const { _htmlToText } = require('../events/listing');

const DEFAULT_TIMEOUT_MS = 15000;   // background-read default; pass less in-turn
const DEFAULT_MAX_CHARS = 18000;    // ~4-5k tokens of page text for the model
const MAX_IMAGES = 6;

function _pick(re, html) {
    const m = String(html).match(re);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Absolute https image URLs from og:image + the first <img> tags. */
function _pageImages(html, baseUrl) {
    const out = [];
    const push = (src) => {
        try {
            const abs = new URL(src, baseUrl).toString();
            if (/^https:\/\//i.test(abs) && !out.includes(abs)) out.push(abs);
        } catch { /* unparseable src */ }
    };
    const og = _pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i, html);
    if (og) push(og);
    const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = imgRe.exec(html)) && out.length < MAX_IMAGES) {
        const src = m[1];
        // Skip obvious chrome: icons, logos, pixels, svg sprites.
        if (/logo|icon|sprite|pixel|avatar|\.svg(\?|$)/i.test(src)) continue;
        push(src);
    }
    return out.slice(0, MAX_IMAGES);
}

/**
 * Fetch + reduce any public page to readable info. null on any failure.
 * @returns {Promise<{url,title,description,image,images,text}|null>}
 */
async function readPage(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxChars = DEFAULT_MAX_CHARS, deps = {} } = {}) {
    try {
        const fetchHtml = deps.fetchHtml || _fetchListingHtml;
        const html = await fetchHtml(url, { timeoutMs });
        if (!html) return null;
        const title = _pick(/<title[^>]*>([\s\S]*?)<\/title>/i, html)
            || _pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i, html);
        const description = _pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i, html)
            || _pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i, html);
        const images = _pageImages(html, url);
        const text = String(_htmlToText(html) || '').slice(0, maxChars);
        if (!text.trim() && !title) return null;
        return { url, title, description, image: images[0] || null, images, text };
    } catch (err) {
        console.warn(`[read] ${String(url).slice(0, 90)}: ${err.message}`);
        return null;
    }
}

/**
 * Model-read events from a page (the 'extracted' trust tier). The model
 * proposes; CODE disposes: only events with a parseable ISO date inside the
 * asked window survive. The page's lead image rides along as the poster.
 * [] fail-open.
 */
async function extractEventsFromPage(page, { city = null, window: win = null } = {}, deps = {}) {
    if (!page || !page.text || !win) return [];
    try {
        const narrator = deps.narrator || require('../narrator');
        const out = await narrator.stream({
            messages: [{
                role: 'user',
                content:
                    `Below is the text of a web page. List ONLY events that the page EXPLICITLY dates`
                    + ` (a concrete calendar date${city ? `, in or near ${city}` : ''}). Never guess or infer dates.\n`
                    + `Reply with ONLY a JSON array: [{"name":"…","startDate":"YYYY-MM-DD","time":"HH:MM or null","venueName":"… or null"}]\n`
                    + `Empty array [] if the page dates no events.\n\nPAGE TITLE: ${page.title || ''}\n\nPAGE TEXT:\n${page.text}`,
            }],
            maxTokens: 600,
            temperature: 0,
        });
        const m = String(out.text || '').match(/\[[\s\S]*\]/);
        if (!m) return [];
        let arr;
        try { arr = JSON.parse(m[0]); } catch { return []; }
        if (!Array.isArray(arr)) return [];
        const wStart = new Date(win.start), wEnd = new Date(win.end);
        const events = [];
        for (const e of arr.slice(0, 20)) {
            if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
            if (typeof e.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.startDate)) continue;
            const time = (typeof e.time === 'string' && /^\d{2}:\d{2}$/.test(e.time)) ? e.time : '12:00';
            const start = new Date(`${e.startDate}T${time}:00Z`);
            if (Number.isNaN(start.getTime())) continue;
            if (start > wEnd || start < new Date(wStart.getTime() - 12 * 3600 * 1000)) continue;   // window brake
            events.push({
                name: e.name.trim().slice(0, 120),
                startDate: start,
                endDate: null,
                image: page.image || null,
                url: page.url,
                venueName: (typeof e.venueName === 'string' && e.venueName.trim()) ? e.venueName.trim().slice(0, 80) : null,
                venueAddress: null,
                _tier: 'extracted',
            });
        }
        return events;
    } catch (err) {
        console.warn(`[read] extract failed for ${String(page.url).slice(0, 60)}: ${err.message}`);
        return [];
    }
}

module.exports = { readPage, extractEventsFromPage, DEFAULT_TIMEOUT_MS };
