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
const MAX_IMAGE_PAIRS = 24;         // src+alt pairs offered to the model for matching

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

/** src+alt pairs from <img> tags (lazy-load data-src wins over placeholder
 *  src), so the model can match events to THEIR posters by caption/filename
 *  — a listing page's og:image is the site banner, and stamping it on every
 *  event gave N identical cards (Arsen live report 2026-08-23). */
function _imagePairs(html, baseUrl) {
    const out = [];
    const tagRe = /<img\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(html)) && out.length < MAX_IMAGE_PAIRS) {
        const tag = m[0];
        const src = (tag.match(/\bdata-src=["']([^"']+)["']/i) || tag.match(/\ssrc=["']([^"']+)["']/i) || [])[1];
        if (!src || /logo|icon|sprite|pixel|avatar|\.svg(\?|$)/i.test(src)) continue;
        const alt = ((tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
        try {
            const abs = new URL(src, baseUrl).toString();
            if (/^https:\/\//i.test(abs) && !out.some((p) => p.src === abs)) out.push({ src: abs, alt });
        } catch { /* unparseable src */ }
    }
    return out;
}

/** href+text pairs from <a> tags, so the model can point each event at ITS
 *  detail page — where the real poster (og:image) and exact schedule live.
 *  Listing thumbnails proved unmatchable by caption (allevents.in live,
 *  2026-08-23: 7 events extracted, 0 posters matched). */
const MAX_LINK_PAIRS = 30;
function _linkPairs(html, baseUrl) {
    const out = [];
    const aRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = aRe.exec(html)) && out.length < MAX_LINK_PAIRS) {
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length < 3 || text.length > 120) continue;              // nav chrome / walls of text
        if (/^(javascript|mailto|tel):/i.test(m[1])) continue;
        try {
            const abs = new URL(m[1], baseUrl).toString();
            if (/^https:\/\//i.test(abs) && !out.some((p) => p.href === abs)) out.push({ href: abs, text });
        } catch { /* unparseable href */ }
    }
    return out;
}

/** Reduce already-fetched HTML to the page shape. null when nothing readable. */
function _reducePage(html, url, maxChars = DEFAULT_MAX_CHARS) {
    if (!html) return null;
    const title = _pick(/<title[^>]*>([\s\S]*?)<\/title>/i, html)
        || _pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i, html);
    const description = _pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i, html)
        || _pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i, html);
    const images = _pageImages(html, url);
    const text = String(_htmlToText(html) || '').slice(0, maxChars);
    if (!text.trim() && !title) return null;
    return { url, title, description, image: images[0] || null, images, imagePairs: _imagePairs(html, url), linkPairs: _linkPairs(html, url), text };
}

/**
 * Fetch + reduce any public page to readable info. null on any failure.
 * @returns {Promise<{url,title,description,image,images,imagePairs,text}|null>}
 */
async function readPage(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxChars = DEFAULT_MAX_CHARS, deps = {} } = {}) {
    try {
        const fetchHtml = deps.fetchHtml || _fetchListingHtml;
        const html = await fetchHtml(url, { timeoutMs });
        return _reducePage(html, url, maxChars);
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
        // Event pages rarely print a year ("Sat, 30 Aug") — the asked window
        // supplies it. The model may resolve the YEAR from the window; the day
        // and month must still be printed on the page (live lesson 2026-08-23:
        // the old "never infer" wording made the model drop every yearless
        // date, so allevents.in read as empty).
        const winFrom = new Date(win.start).toISOString().slice(0, 10);
        const winTo = new Date(win.end).toISOString().slice(0, 10);
        // Offer the page's images (src + caption) so each event can get ITS
        // poster; without this every event inherited the page og:image and
        // Arsen saw N identical cards. The model may only pick from this
        // list — code checks membership below, so no invented URLs.
        const pairs = Array.isArray(page.imagePairs) ? page.imagePairs.slice(0, 24) : [];
        const imgBlock = pairs.length
            ? `\nIMAGES ON THE PAGE:\n${pairs.map((p, i) => `${i + 1}. ${p.src}${p.alt ? ` — "${p.alt}"` : ''}`).join('\n')}\n`
            : '';
        const links = Array.isArray(page.linkPairs) ? page.linkPairs.slice(0, 30) : [];
        const linkBlock = links.length
            ? `\nLINKS ON THE PAGE:\n${links.map((p, i) => `${i + 1}. ${p.href} — "${p.text}"`).join('\n')}\n`
            : '';
        const out = await narrator.stream({
            messages: [{
                role: 'user',
                content:
                    `Below is the text of a web page. The user asked about events between ${winFrom} and ${winTo}`
                    + `${city ? ` in or near ${city}` : ''}.\n`
                    + `List ONLY events whose DAY and MONTH the page explicitly prints (e.g. "30 Aug", "August 30").`
                    + ` If the page omits the year, resolve it so the date falls in or nearest to ${winFrom}..${winTo}.`
                    + ` Never invent a day or month the page does not print.\n`
                    + `Reply with ONLY a JSON array: [{"name":"…","startDate":"YYYY-MM-DD","time":"HH:MM or null","venueName":"… or null","image":"URL or null","url":"URL or null"}]\n`
                    + (pairs.length
                        ? `For "image", pick the URL from IMAGES ON THE PAGE whose caption or filename clearly belongs to that event; null if none matches. Never reuse one image for several events.\n`
                        : `Set "image" to null.\n`)
                    + (links.length
                        ? `For "url", pick the link from LINKS ON THE PAGE that is that event's own page; null if none matches.\n`
                        : `Set "url" to null.\n`)
                    + `Empty array [] if the page dates no events.\n\nPAGE TITLE: ${page.title || ''}\n${imgBlock}${linkBlock}\nPAGE TEXT:\n${page.text}`,
            }],
            maxTokens: 1100,
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
            // Poster: only an image the page actually contains. When images
            // were offered and none matched, no image beats the page banner
            // stamped on every card.
            const offered = pairs.length ? pairs.some((p) => p.src === e.image) : false;
            const ownLink = links.length && links.some((p) => p.href === e.url) ? e.url : null;
            events.push({
                name: e.name.trim().slice(0, 120),
                startDate: start,
                endDate: null,
                image: offered ? e.image : (pairs.length ? null : page.image || null),
                url: ownLink || page.url,
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

module.exports = { readPage, extractEventsFromPage, _reducePage, DEFAULT_TIMEOUT_MS };
