// Jinni V2 Engine — event-listing parsing & verification (JSON-LD + og:image).
// COPIED from routes/aiRoutes.js (v1, lines ~4531–4772 + _htmlToText ~4875) per the
// copy-not-cut rule (engine/ENGINE.md). Deviations: imports from engine modules
// instead of file-local references; otherwise behavior-identical.

const { _fetchListingHtml, _fetchUnavailable } = require('../utils/safeFetch');
const { namesPlausiblyMatch } = require('../places/matching');
const { _extractOgImage } = require('./matching');

const EVENT_LISTING_TTL_MS    = 6 * 60 * 60 * 1000;
const EVENT_LISTING_CACHE_MAX = 500;

// url → { at, data }. Listing pages change rarely and the same few URLs recur
// across taps and users, so this removes almost all repeat fetches.
const _eventListingCache = new Map();

// schema.org Event and its subtypes. Anchored so "EventVenue" can't match.
const _LD_EVENT_TYPE = /^(Event|MusicEvent|Festival|MusicFestival|TheaterEvent|DanceEvent|ComedyEvent|SportsEvent|ScreeningEvent|ExhibitionEvent|EducationEvent|SocialEvent|FoodEvent|LiteraryEvent|BusinessEvent|ChildrensEvent|VisualArtsEvent|DeliveryEvent|PublicationEvent|Hackathon)$/;

function _collectLdEvents(node, out, depth = 0) {
    if (!node || depth > 8 || out.length > 200) return;
    if (Array.isArray(node)) { for (const n of node) _collectLdEvents(n, out, depth + 1); return; }
    if (typeof node !== 'object') return;
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some(x => typeof x === 'string' && _LD_EVENT_TYPE.test(x.replace(/^.*\//, '')))) out.push(node);
    // Containers a listing page wraps its events in.
    for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'subEvents', 'events', 'mainEntity', 'mainEntityOfPage']) {
        if (node[key]) _collectLdEvents(node[key], out, depth + 1);
    }
}

function _extractLdEvents(html) {
    const out = [];
    const re = /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }   // one malformed block never kills the rest
        _collectLdEvents(parsed, out);
    }
    return out;
}

/* A date-ONLY value must stay date-only: the past-event filter reads "exactly
 * midnight UTC" as "all day, so it lives out its whole day", and a real clock
 * time as "expires at that instant". A timed value that happens to land on
 * midnight UTC is nudged 1 ms so it cannot masquerade as all-day. */
function _ldDate(v) {
    const s = typeof v === 'string' ? v.trim() : (typeof v?.['@value'] === 'string' ? v['@value'].trim() : '');
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    let ms = d.getTime();
    if (ms % 86400000 === 0) ms += 1;
    return new Date(ms).toISOString();
}

function _ldImage(v, depth = 0) {
    if (!v || depth > 4) return null;
    if (typeof v === 'string') return /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
    if (Array.isArray(v)) { for (const i of v) { const r = _ldImage(i, depth + 1); if (r) return r; } return null; }
    if (typeof v === 'object') return _ldImage(v.contentUrl || v.url || v['@id'], depth + 1);
    return null;
}

function _ldText(v) {
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v)) { for (const i of v) { const r = _ldText(i); if (r) return r; } return null; }
    if (v && typeof v === 'object') return _ldText(v['@value'] ?? v.name);
    return null;
}

function _ldAddress(a) {
    if (!a) return null;
    if (typeof a === 'string') return a.trim() || null;
    if (Array.isArray(a)) return _ldAddress(a[0]);
    if (typeof a === 'object') {
        const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry]
            .map(p => _ldText(p)).filter(Boolean);
        return parts.length ? parts.join(', ') : null;
    }
    return null;
}

function _normalizeLdEvent(node) {
    const loc = Array.isArray(node.location) ? node.location[0] : node.location;
    // `url` is the per-event page. On an index feed it is the only way back to
    // the individual listing, and it becomes the card's "check the listing" link.
    const url = typeof node.url === 'string' && /^https?:\/\//i.test(node.url.trim())
        ? node.url.trim() : null;
    return {
        name: _ldText(node.name),
        startDate: _ldDate(node.startDate),
        endDate: _ldDate(node.endDate),
        image: _ldImage(node.image),
        url,
        venueName: loc && typeof loc === 'object' ? _ldText(loc.name) : _ldText(loc),
        venueAddress: loc && typeof loc === 'object' ? _ldAddress(loc.address) : null
    };
}

function _htmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .split('\n').map(t => t.trim()).filter(Boolean).join('\n').slice(0, 12000);
}

/* Fetch one listing URL and return the schema.org Event that best corresponds
 * to `eventName`. A ticketing page often lists MANY events (a "what's on" rail
 * in the footer), so taking the first one would import a neighbouring concert's
 * date — worse than the model's guess. Requires a name match; falls back to the
 * page's single event only when the page has exactly one. */
async function fetchEventListing(rawUrl, eventName) {
    if (_fetchUnavailable) return null;
    const key = String(rawUrl).slice(0, 500);
    const hit = _eventListingCache.get(key);
    if (hit && (Date.now() - hit.at) < EVENT_LISTING_TTL_MS) return hit.data;

    let data = null;
    try {
        const html = await _fetchListingHtml(rawUrl);
        /* Say WHY nothing came back. The first production run reported
         * "0 date(s) corrected" on every tap with no other line — accurate but
         * unactionable, since it could equally have meant a blocked fetch, a
         * page with no JSON-LD, or events that didn't match. Probing the URLs
         * by hand settled it (visityerevan.am and tkt.am publish no JSON-LD at
         * all; only ticket-am.com does). That probe should not have been
         * necessary, so each outcome now names itself. */
        if (!html) {
            console.log(`[listing] no usable body from ${String(rawUrl).slice(0, 120)} (blocked, non-HTML, or oversized)`);
        } else {
            const nodes = _extractLdEvents(html);
            const normalized = nodes.map(_normalizeLdEvent).filter(e => e.startDate || e.image);
            if (!nodes.length) {
                /* No structured data — but the POSTER is usually still there, in
                 * og:image. Tbilisi proved the cost of ignoring it: tkt.ge pages
                 * carry the artwork and every card rendered with a blank calendar
                 * icon, because this path only ever looked at JSON-LD.
                 *
                 * Image ONLY. A date read off an unstructured page would be a
                 * guess, and guessed dates are the thing this whole pass exists to
                 * eliminate. Restricted to a DEEP url (a specific event page), so
                 * a category or home page cannot donate its site banner as if it
                 * were event artwork. */
                let path = '';
                try { path = new URL(rawUrl).pathname.replace(/\/+$/, ''); } catch {}
                const looksSpecific = path.split('/').filter(Boolean).length >= 2;
                const og = looksSpecific ? _extractOgImage(html) : null;
                if (og) {
                    data = { name: null, startDate: null, endDate: null, image: og, url: null, venueName: null, venueAddress: null };
                    console.log(`[listing] no JSON-LD on ${String(rawUrl).slice(0, 90)} — taking og:image only (no date from an unstructured page)`);
                } else {
                    console.log(`[listing] no schema.org/Event JSON-LD on ${String(rawUrl).slice(0, 120)} — this source cannot verify dates`);
                }
            } else if (!normalized.length) {
                console.log(`[listing] ${nodes.length} Event block(s) on ${String(rawUrl).slice(0, 90)} but none carried a date or image`);
            } else if (normalized.length === 1) {
                data = normalized[0];
            } else {
                data = normalized.find(e => e.name && namesPlausiblyMatch(eventName, e.name)) || null;
                if (!data) console.log(`[listing] ${normalized.length} events on page, none matching "${eventName}" — ignoring rather than guessing`);
            }
        }
    } catch (err) {
        // Never let a slow, hostile or malformed third-party page fail the tap.
        console.warn(`[listing] fetch failed for ${String(rawUrl).slice(0, 120)}: ${err.message}`);
        data = null;
    }

    if (_eventListingCache.size >= EVENT_LISTING_CACHE_MAX) {
        // Cheap FIFO trim — insertion order is Map's iteration order.
        const oldest = _eventListingCache.keys().next().value;
        _eventListingCache.delete(oldest);
    }
    _eventListingCache.set(key, { at: Date.now(), data });
    return data;
}

module.exports = {
    _extractLdEvents,
    _collectLdEvents,
    _normalizeLdEvent,
    _ldDate,
    _ldImage,
    _ldText,
    _ldAddress,
    _htmlToText,
    fetchEventListing,
    EVENT_LISTING_TTL_MS,
};
