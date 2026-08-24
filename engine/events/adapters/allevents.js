// Adapter — allevents.in listing pages.
//
// WHY THIS ONE EXISTS (the rule for every adapter): it was written against a
// real page the generic ladder got wrong, never speculatively. allevents
// publishes no schema.org on its listing, so the model read it — and the model
// cannot see which title, link, image and time belong together in a wall of
// HTML. Live 2026-08-24 that produced "TOUR EXPO 2026" wearing another event's
// listing URL, another event's banner AND another event's 21:00 start.
//
// The page itself has no such ambiguity. Every event is ONE <li> carrying its
// own data-name, data-link and banner, with its date inside the same block. So
// the adapter reads per block, and borrowing between events becomes impossible
// by construction rather than by luck.

const CARD_RE = /<li[^>]*class="[^"]*event-card[^"]*"[^>]*>[\s\S]*?(?=<li[^>]*class="[^"]*event-card|<\/ul>)/gi;
const ATTR = (block, name) => (block.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || null;

const _decode = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Fri, 04 Sep, 2026 - 11:00 AM" → Date, or null when the shape is unfamiliar.
 *  The printed time is the venue's WALL CLOCK; it is stored as such (the same
 *  convention the epoch attributes on detail pages turned out to use), so a
 *  card shows the hour the listing shows. */
function _parseCardDate(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const d = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/);
    if (!d) return null;
    const month = MONTHS[d[2].toLowerCase()];
    if (month == null) return null;
    let hour = 0, minute = 0;
    const time = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (time) {
        hour = Number(time[1]) % 12;
        minute = Number(time[2]);
        if (/pm/i.test(time[3] || '')) hour += 12;
        if (!time[3]) hour = Number(time[1]);            // 24-hour clock, no meridiem
    }
    const dt = new Date(Date.UTC(Number(d[3]), month, Number(d[1]), hour, minute));
    return Number.isNaN(dt.getTime()) ? null : dt;
}

/** The poster. allevents serves banners through a resizing proxy whose path
 *  carries the ORIGINAL url base64'd — decoding it gets the full-resolution
 *  image instead of the 500px thumbnail (the blurry cards, 2026-08-24). */
function _poster(block) {
    const bg = (block.match(/background\s*:\s*url\(([^)]+)\)/i) || [])[1];
    if (!bg) return null;
    const proxied = bg.replace(/^["']|["']$/g, '');
    const seg = (proxied.match(/\/([A-Za-z0-9_-]{40,})\.(?:avif|webp|jpe?g|png)/) || [])[1];
    if (seg) {
        try {
            const decoded = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            if (/^https?:\/\/\S+$/i.test(decoded)) return decoded;
        } catch { /* keep the proxy url */ }
    }
    return proxied;
}

function extract(html, { url = null } = {}) {
    const out = [];
    for (const m of String(html || '').matchAll(CARD_RE)) {
        const block = m[0];
        const link = ATTR(block, 'data-link');
        // The <h3> inside the card holds the REAL title. data-name is
        // allevents' own Latin-only copy of it: the Armenian event
        // "Դանդաղ արտասահմանյան vol. 25" arrives there as " vol. 25", and that
        // is what reached a card (live 2026-08-24). Both live in this same
        // block, so preferring the heading borrows nothing.
        const heading = (block.match(/class="title"[\s\S]{0,300}?<h3[^>]*>([^<]{1,160})<\/h3>/i) || [])[1];
        const name = _decode((heading || ATTR(block, 'data-name') || '').trim());
        if (!name || !link) continue;
        const dateText = (block.match(/class="date"[^>]*>([\s\S]*?)<\/div>/i) || [])[1];
        const startDate = _parseCardDate(dateText);
        if (!startDate) continue;                        // undated ⇒ unverifiable ⇒ skip
        out.push({
            name,
            startDate,
            endDate: null,
            url: link,                                   // ITS OWN listing, never a neighbour's
            image: _poster(block),
            venueName: null,                             // the detail page carries it; the card does not
            price: null,
        });
    }
    return out;
}

module.exports = { name: 'allevents', hosts: ['allevents.in'], extract, _parseCardDate, _poster };
