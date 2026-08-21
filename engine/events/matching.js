// Jinni V2 Engine — event identity & title hygiene (pure functions).
// COPIED from routes/aiRoutes.js (v1, lines ~4399–4674) per the copy-not-cut rule
// (engine/ENGINE.md) — v1 keeps its own inline copies untouched.

const { normalizePlaceName } = require('../places/matching');

const PLACEHOLDER_VENUE_RE = /^(various|multiple|several|many|different|citywide|city-wide|nationwide|tba|tbd|n\/?a|online|virtual)\b|\b(venues|locations|churches|theatres|theaters|cinemas|halls|sites)\s*$/i;

/* A CITY is not a venue either — and this one shipped.
 *
 * The model answered "Yerevan" and "Yerevan city centre" as the venue/address
 * for three unrelated events. Both were sent to Google as if they were venues,
 * which returned an arbitrary establishment near the city centre: all three
 * events were pinned at 10 Tamanyan St and rendered with the SAME Cascade
 * photo. (The `[cache] rejected poisoned mapping "Yerevan" → …` guard fired,
 * proving the cache already distrusts such mappings — but the live lookup then
 * happily resolved it fresh.)
 *
 * "Somewhere in this city" carries no more location than "Various venues" does,
 * so it gets the same treatment: stay an honest date-card. Matches the bare
 * city or region name, optionally followed only by a centre/downtown-type word.
 */
const _CITY_QUALIFIER_RE = /^(city\s*)?(centre|center|downtown|city|old\s*town|central|area|region|province|outskirts|suburbs)$/i;
function isPlaceholderVenue(value, cityNames = []) {
    const v = String(value || '').trim();
    if (!v) return true;
    if (PLACEHOLDER_VENUE_RE.test(v)) return true;
    const norm = normalizePlaceName(v);
    if (!norm) return true;
    for (const city of cityNames) {
        const c = normalizePlaceName(city);
        if (!c || !norm.startsWith(c)) continue;
        const rest = norm.slice(c.length).trim();
        // Exactly the city ("Yerevan"), or the city plus only a generic
        // qualifier ("Yerevan city centre"). "Yerevan Opera House" has a real
        // remainder and is a genuine venue, so it passes.
        if (!rest || _CITY_QUALIFIER_RE.test(rest)) return true;
    }
    return false;
}

const _EVENT_STOPWORDS = new Set([
    'ticket', 'tickets', 'concert', 'concerts', 'show', 'shows', 'festival', 'fest',
    'party', 'live', 'tour', 'night', 'nights', 'event', 'events', 'performance',
    'presents', 'present', 'feat', 'featuring', 'gala', 'open', 'air', 'birthday',
    'the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'at', 'on', 'with', 'by', 's',
    'yerevan', 'armenia', 'am'
]);
const _eventTokens = (s) => normalizePlaceName(
        // Possessives first: normalizePlaceName strips the apostrophe and glues
        // the s on ("Asatryan's" → "asatryans"), which then fails to equal
        // "asatryan" now that multi-word titles must share TWO tokens.
        String(s || '').replace(/['’]s\b/gi, '')
    )
    .split(' ')
    .filter(t => t.length >= 3 && !_EVENT_STOPWORDS.has(t));

function eventNamesMatch(a, b) {
    const ta = _eventTokens(a), tb = _eventTokens(b);
    // No distinctive word on either side → refuse to guess. Silence beats a
    // confidently wrong date on somebody else's concert.
    if (!ta.length || !tb.length) return false;
    /* One shared word is enough only when one side has just one word to give
     * ("Spleen" vs "Tickets for the Spleen concert"). When BOTH titles are
     * multi-word, a single shared token is a coincidence, not an identity:
     * "Symphonic Yerevan International Music Festival" matched "Symphonic
     * Hayko. Ararat in the Heart" on the word "symphonic" alone, and shipped
     * the festival with the other concert's Aug-25 date. Two shared
     * distinctive words is the bar a multi-word pair must clear. */
    const shared = ta.filter(x => tb.includes(x)).length;
    const needed = Math.min(ta.length, tb.length) >= 2 ? 2 : 1;
    return shared >= needed;
}

// Feed titles are HTML-escaped and wrapped in selling words: "Tickets for
// Grisha Asatryan&apos;s concert". Users should see the event, not the shop.
const _HTML_ENTITIES = { amp: '&', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', nbsp: ' ', laquo: '«', raquo: '»' };
function _decodeEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&([a-z]+);/gi, (m, n) => _HTML_ENTITIES[n.toLowerCase()] ?? m);
}
function cleanEventTitle(raw) {
    let s = _decodeEntities(raw).trim();
    s = s.replace(/\s+in\s+[A-Z][\w'’-]*(?:\s*,\s*[A-Z][\w'’-]*)?\s*$/u, '');   // "… in Yerevan"
    s = s.replace(/^tickets?\s+(?:for|to)\s+(?:the\s+)?/i, '');                  // "Tickets for the …"
    s = s.replace(/\s+tickets?$/i, '');                                          // "… Tickets"
    // "concert "Symphonic Hayko…"" → the quoted title is the real name.
    const quoted = s.match(/^(?:concert|show|performance)\s*[«"'“]([^»"'”]+)/i);
    if (quoted) s = quoted[1];
    s = s.replace(/^[«"'“]|[»"'”]$/g, '').trim();
    return s || _decodeEntities(raw).trim();
}

// The poster lives in og:image on these listing pages, not in the JSON-LD.
// (Also the future imageless-business fallback: a business's OWN site's og:image.)
function _extractOgImage(html) {
    const m = html.match(/<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:image["']/i);
    const u = m && m[1] && m[1].trim();
    return u && /^https?:\/\//i.test(u) ? u : null;
}

module.exports = { isPlaceholderVenue, eventNamesMatch, cleanEventTitle, _eventTokens, _decodeEntities, _extractOgImage };
