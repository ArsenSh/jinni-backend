// Jinni V2 Engine — events from the JSON a page fetched for itself.
//
// Arsen 2026-08-24: "i think some kind of better tool might exist in github for
// that kind of websites". The better tool turned out to be something we already
// had and were discarding.
//
// platinumlist and ticketmaster.ae are single-page apps: the HTML is a shell,
// and the listing arrives afterwards as JSON from their own API. We rendered
// the shell, found no dated events, and concluded Dubai had no readable
// sources — while the browser had already been handed clean, structured data
// with names, dates, venues, prices and poster URLs, and thrown it away.
//
// This is not extra access. The page asked for those responses in order to draw
// itself; we keep what it was given. One page load, our own User-Agent, no
// fingerprint spoofing, nothing a visitor's browser would not have fetched.
//
// READ BY SHAPE, NOT BY NAME. Every site names its fields differently and
// renames them on redesign, so nothing here depends on a particular key. An
// object is an event if it carries something that reads like a NAME and
// something that parses as a DATE. That rule found allevents' rows when a
// key-name parser reported "proposed 0", and it is the same rule here.
//
// HONESTY. An event still needs a name and a real date or it is dropped —
// never defaulted, never guessed. Prices are carried only when the API actually
// stated one, because an unknown must look unknown.
//
// Returns the SAME event shape as engine/events/adapters/*, so hunt stores
// these exactly as it stores an adapter's rows.

const MAX_DEPTH = 8;                  // deep enough for {data:{page:{props:{events:[…]}}}}
const MAX_NODES = 20000;              // a runaway payload must not stall a turn
const MAX_EVENTS = 200;

// Candidate keys, ordered by how specific they are. These are hints for WHICH
// value to prefer when an object has several — never a requirement that any of
// them be present, and never a filter on the object itself.
const NAME_KEYS = ['name', 'title', 'eventname', 'headline', 'label', 'displayname'];
const DATE_KEYS = ['startdate', 'startsat', 'startdatetime', 'datestart', 'eventdate',
    'begindate', 'start', 'date', 'datetime', 'from'];
const END_KEYS = ['enddate', 'endsat', 'dateend', 'end', 'until', 'to'];
const URL_KEYS = ['url', 'link', 'permalink', 'href', 'eventurl', 'weburl', 'canonicalurl', 'slug'];
const IMAGE_KEYS = ['image', 'imageurl', 'poster', 'posterurl', 'banner', 'bannerurl',
    'thumbnail', 'thumb', 'cover', 'coverimage', 'photo', 'picture', 'artwork'];
const VENUE_KEYS = ['venue', 'venuename', 'location', 'place', 'hall', 'address',
    'locationname', 'theatre', 'theater'];
const PRICE_KEYS = ['price', 'minprice', 'pricefrom', 'fromprice', 'lowestprice',
    'ticketprice', 'startingprice', 'amount'];
const CURRENCY_KEYS = ['currency', 'currencycode', 'pricecurrency'];

// Underscores and dashes are stripped, so 'start_date' and 'startDate' are one key.
const _norm = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, '');

/** A value that could be a human-readable title. */
function _nameish(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (t.length < 2 || t.length > 300) return null;
    if (/^https?:\/\//i.test(t)) return null;                 // a URL is not a name
    if (/^[\d\s./:-]+$/.test(t)) return null;                 // nor is a bare date
    return t;
}

/**
 * A value that parses as a real calendar moment. Accepts ISO strings, epoch
 * seconds and epoch milliseconds — the three forms these APIs actually use.
 * Anything ambiguous is refused: a wrong date is worse than no card.
 */
function _dateish(v) {
    if (v == null) return null;
    if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        // 1e11 separates epoch SECONDS from epoch MILLISECONDS for every date
        // either unit could plausibly mean.
        const ms = n < 1e11 ? n * 1000 : n;
        return _plausible(new Date(ms));
    }
    if (typeof v !== 'string') return null;
    const t = v.trim();
    // Require a 4-digit year, so "19:30" and "12" are not mistaken for dates.
    if (!/\d{4}/.test(t)) return null;
    return _plausible(new Date(t));
}

/** Between five years back and five years ahead, else the parse failed. A 1970
 *  epoch slip or a year-3025 typo is not an event. */
function _plausible(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    const span = 5 * 365 * 24 * 3600 * 1000;
    const now = Date.now();
    return (d.getTime() > now - span && d.getTime() < now + span) ? d : null;
}

/** The most specific key present whose VALUE has the right shape. */
function _pick(obj, keys, shape) {
    const seen = new Map();
    for (const [k, v] of Object.entries(obj)) seen.set(_norm(k), v);
    for (const k of keys) {
        if (!seen.has(k)) continue;
        const got = shape(seen.get(k));
        if (got) return got;
    }
    return null;
}

/** A venue may be a string, or {name}, or {venue: {name}}. */
function _venue(obj) {
    const seen = new Map();
    for (const [k, v] of Object.entries(obj)) seen.set(_norm(k), v);
    for (const k of VENUE_KEYS) {
        const v = seen.get(k);
        if (!v) continue;
        if (typeof v === 'string') {
            const n = _nameish(v);
            if (n) return n;
        } else if (typeof v === 'object') {
            const n = _pick(v, NAME_KEYS, _nameish);
            if (n) return n;
        }
    }
    return null;
}

function _price(obj, depth = 0) {
    if (depth > 2) return null;
    const seen = new Map();
    for (const [k, v] of Object.entries(obj)) seen.set(_norm(k), v);
    let amount = null;
    for (const k of PRICE_KEYS) {
        const v = seen.get(k);
        if (v == null) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {       // {amount, currency}
            const inner = _price(v, depth + 1);
            if (inner) return inner;
            continue;
        }
        const n = Number(String(v).replace(/[^\d.]/g, ''));
        // Zero means "free" on some sites and "unset" on others, and we cannot
        // tell which. An ambiguous number is not a fact.
        if (Number.isFinite(n) && n > 0) { amount = n; break; }
    }
    if (amount == null) return null;
    for (const k of CURRENCY_KEYS) {
        const c = seen.get(k);
        if (typeof c === 'string' && /^[A-Za-z]{3}$/.test(c.trim())) {
            return `${amount} ${c.trim().toUpperCase()}`;
        }
    }
    return String(amount);
}

function _absolute(u, base) {
    if (!u || typeof u !== 'string') return null;
    try { return new URL(u, base || undefined).toString(); } catch { return null; }
}

function _imageValue(v) {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return _pick(v, ['url', 'src', 'href', ...IMAGE_KEYS], x => (typeof x === 'string' ? x.trim() || null : null));
    }
    return null;
}

/** One JSON node → an event, or null. */
function _asEvent(node, base) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const name = _pick(node, NAME_KEYS, _nameish);
    if (!name) return null;
    const startDate = _pick(node, DATE_KEYS, _dateish);
    if (!startDate) return null;                               // undated ⇒ unverifiable ⇒ skip
    const rawUrl = _pick(node, URL_KEYS, v => (typeof v === 'string' && v.trim() ? v.trim() : null));
    return {
        name,
        startDate,
        endDate: _pick(node, END_KEYS, _dateish),
        url: _absolute(rawUrl, base),
        image: _absolute(_pick(node, IMAGE_KEYS, _imageValue), base),
        venueName: _venue(node),
        price: _price(node),
    };
}

/**
 * Every event-shaped object anywhere in one API payload.
 * @param {any} data parsed JSON
 * @param {string} base the page URL, for resolving relative links
 */
function eventsFromJson(data, base = '') {
    const out = [];
    const stack = [{ node: data, depth: 0 }];
    let nodes = 0;
    while (stack.length && out.length < MAX_EVENTS && nodes < MAX_NODES) {
        const { node, depth } = stack.pop();
        nodes++;
        if (!node || typeof node !== 'object' || depth > MAX_DEPTH) continue;
        if (Array.isArray(node)) {
            for (const item of node) stack.push({ node: item, depth: depth + 1 });
            continue;
        }
        const ev = _asEvent(node, base);
        if (ev) out.push(ev);
        // Descend regardless: a listing object often carries both its own
        // fields and a nested array of sessions or related events.
        for (const v of Object.values(node)) {
            if (v && typeof v === 'object') stack.push({ node: v, depth: depth + 1 });
        }
    }
    return out;
}

/**
 * Events from every captured response, de-duplicated.
 * @param {Array<{url: string, data: any}>} api what renderPageFull collected
 * @param {string} base the page URL
 */
function eventsFromApi(api, base = '') {
    const seen = new Set();
    const out = [];
    for (const resp of api || []) {
        let found;
        try {
            found = eventsFromJson(resp.data, base || resp.url);
        } catch {
            continue;                                          // one bad payload is not a failure
        }
        for (const ev of found) {
            // The same event usually arrives in several responses — a listing
            // call and a detail call, or a paginated repeat.
            const key = `${ev.name.toLowerCase()}|${ev.startDate.toISOString().slice(0, 10)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(ev);
            if (out.length >= MAX_EVENTS) return out;
        }
    }
    return out;
}

module.exports = { eventsFromApi, eventsFromJson, _dateish, _nameish, _price, _venue };
