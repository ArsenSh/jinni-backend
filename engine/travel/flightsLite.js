// Jinni V3 Engine — BOOKABLE flights via liteAPI (Nuitee Connect).
// Arsen 2026-09-23, after the hotel partner went live: "can i add something
// for flight so users can book ticket of airplane from my app".
//
// WHY A SECOND FLIGHT SOURCE. engine/travel/flights.js (Travelpayouts /
// Aviasales) stays exactly as it is: it is a CACHE of fares other travelers
// were recently shown, it covers the low-cost carriers that actually fly out
// of Yerevan (Wizz, FlyOne), it costs nothing and it carries no liability —
// a traveler leaves for aviasales.com to buy. liteAPI is the opposite trade:
// fewer sources, but a LIVE fare with an offerId that can be verified,
// prebooked and ticketed, returning a real airline record locator.
//
// THE RULE THAT KEEPS BOTH HONEST (founder 2026-09-23, the same rule the
// hotel cards follow): a price shown with a Book action must be a price we
// can SELL at. So a liteAPI fare may carry a Book action; an Aviasales fare
// is a link that says it is leaving the app. The two are never blended into
// one number — quoting the cheaper source and charging the other is the worst
// version of a broken promise.
//
// FARES ARE NOT DATA. Every offer carries its own `expiration`, and their
// docs say plainly: "Always verify before prebooking to avoid price
// discrepancies." Nothing here is ever persisted. The memo below is minutes
// long and never outlives an offer's own expiry, and verifyOffer() re-asks
// the provider before any money is discussed.
//
// Setup (Coolify backend env):
//   HOTEL_PRICES_TOKEN   the SAME liteAPI key the hotels use — one key
//                        authenticates all of Nuitee Connect.
//   LITE_FLIGHTS=true    the switch. Flights are NOT enabled by default on a
//                        liteAPI account (their console: "Open a support
//                        ticket to enable Flights API access for Production"),
//                        so without this flag we never call an endpoint that
//                        would answer 403 on every flight turn.
// Without either, every function here fails open and Jinni answers flights
// exactly as it does today, through Travelpayouts.

const BASE = 'https://api.liteapi.travel/v3.0';
const TIMEOUT_MS = 12000;          // a fare search fans out to several providers
const RATES_TTL_MS = 5 * 60e3;     // minutes, never hours — and see _stillFresh
const AIRPORT_TTL_MS = 30 * 864e5; // airports do not move
const MAX_MEMO = 200;

const _memo = new Map();           // key → { at, ttlMs, value, expiresAt }

function liteFlightsEnabled(env = process.env) {
    return !!env.HOTEL_PRICES_TOKEN && String(env.LITE_FLIGHTS || '').toLowerCase() === 'true';
}

function _remember(key, value, ttlMs, expiresAt = null) {
    if (_memo.size >= MAX_MEMO) _memo.delete(_memo.keys().next().value);
    _memo.set(key, { at: Date.now(), ttlMs, value, expiresAt });
    return value;
}
/** A cached search is only usable while its OWN offers are still valid. */
function _stillFresh(hit) {
    if (!hit) return false;
    if (Date.now() - hit.at >= hit.ttlMs) return false;
    if (hit.expiresAt && Date.now() >= hit.expiresAt) return false;
    return true;
}

let _lastError = null;             // { path, status } — surfaced in diag, never to a traveler

async function _call(path, { method = 'GET', query = null, body = null, ttlMs = 0 } = {}, deps = {}) {
    const env = deps.env || process.env;
    const qs = query ? '?' + Object.entries(query).filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    const url = `${BASE}${path}${qs}`;
    const key = `${method} ${url} ${body ? JSON.stringify(body) : ''}`;
    if (ttlMs) { const hit = _memo.get(key); if (_stillFresh(hit)) return hit.value; }
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs || TIMEOUT_MS);
    let res;
    try {
        res = await doFetch(url, {
            method, signal: ac.signal,
            headers: {
                'X-API-Key': env.HOTEL_PRICES_TOKEN,
                accept: 'application/json',
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    } catch (err) {
        _lastError = { path, status: err.name === 'AbortError' ? 'timeout' : err.message };
        return null;
    } finally { clearTimeout(timer); }
    if (!res.ok) {
        // A 403 on a flights path is the one worth saying aloud: it means the
        // account has flights documented but not switched on.
        _lastError = { path, status: res.status };
        if (res.status === 403) console.warn(`[flightsLite] 403 on ${path} — flights are not enabled on this liteAPI account yet`);
        return null;
    }
    const data = await res.json().catch(() => null);
    if (data && ttlMs) _remember(key, data, ttlMs, _earliestExpiry(data));
    return data;
}

/** The soonest offer expiry in a rates response — the cache may not outlive it. */
function _earliestExpiry(payload) {
    let soonest = null;
    for (const set of (Array.isArray(payload?.data) ? payload.data : [])) {
        for (const j of (Array.isArray(set?.journeys) ? set.journeys : [])) {
            // cheapestOffer is included deliberately: a journey may carry ONLY
            // that one, and it is the offer we quote — the cache must not
            // outlive any fare it could serve.
            const offers = [...(Array.isArray(j?.offers) ? j.offers : []), ...(j?.cheapestOffer ? [j.cheapestOffer] : [])];
            for (const o of offers) {
                const t = Date.parse(o?.expiration || '');
                if (Number.isFinite(t) && (soonest == null || t < soonest)) soonest = t;
            }
        }
    }
    return soonest;
}

const _min = (d) => (Number.isFinite(+d?.minutes) ? +d.minutes : null);
const _iso = (s) => (typeof s === 'string' && s ? s : null);
const _carrierName = (c) => (typeof c === 'string' ? c : (c?.name || c?.code || null));

/** One provider journey → the compact shape the narrator and the cards read.
 *  Deliberately close to engine/travel/flights.js's offer shape (price,
 *  airline, flightNumber, departureAt, transfers, durationMin) so the two
 *  sources can be merged and sorted without a translation layer — plus the
 *  fields only a bookable fare has: offerId, expiration, seatsRemaining. */
function normalizeJourney(j) {
    const segs = Array.isArray(j?.segments) ? j.segments : [];
    const first = segs[0] || null;
    const last = segs[segs.length - 1] || null;
    const best = j?.cheapestOffer || (Array.isArray(j?.offers) ? j.offers[0] : null) || null;
    const price = best?.pricing?.total ?? best?.pricing?.amount ?? best?.price ?? null;
    const currency = best?.pricing?.currency ?? best?.currency ?? null;
    // Connections are changes of aircraft; a technical stop inside a segment
    // keeps the same flight number and is NOT a transfer (their docs are
    // explicit, and a traveler feels the two differently).
    const transfers = Math.max(0, segs.length - 1);
    const technicalStops = segs.reduce((n, s) => n + (Number.isFinite(+s?.stopCount) ? +s.stopCount : 0), 0);
    const carrier = first?.carrier?.marketing || first?.carrier?.operating || null;
    return {
        source: 'liteapi',
        journeyKey: j?.journeyKey || null,
        offerId: best?.offerId || null,
        expiration: _iso(best?.expiration),
        price: Number.isFinite(+price) ? +price : null,
        currency: currency || null,
        airline: _carrierName(carrier),
        airlineCode: (carrier && typeof carrier === 'object' ? carrier.code : null) || null,
        flightNumber: first?.flight?.marketing || first?.flight?.operating || null,
        originCode: first?.originCode || null,
        destinationCode: last?.destinationCode || null,
        departureAt: _iso(first?.departureTime),
        arrivalAt: _iso(last?.arrivalTime),
        transfers,
        technicalStops,
        durationMin: _min(j?.totalDuration) ?? _min(first?.duration),
        seatsRemaining: (Array.isArray(best?.segmentFares) && Number.isFinite(+best.segmentFares[0]?.seatsRemaining))
            ? +best.segmentFares[0].seatsRemaining : null,
        cabin: (Array.isArray(best?.segmentFares) ? best.segmentFares[0]?.cabin : null) || null,
        refundable: best?.terms?.refundable ?? null,
        // A fare with an offerId can be sold; the route decides whether to put
        // a Book action on it. Never true for an Aviasales row.
        bookable: !!best?.offerId,
        segments: segs.map(s => ({
            from: s?.originCode || null, to: s?.destinationCode || null,
            departureAt: _iso(s?.departureTime), arrivalAt: _iso(s?.arrivalTime),
            flightNumber: s?.flight?.marketing || null,
            airline: _carrierName(s?.carrier?.marketing),
            durationMin: _min(s?.duration),
            stopCount: Number.isFinite(+s?.stopCount) ? +s.stopCount : 0,
        })),
    };
}

/** Every journey across every provider batch, cheapest first. */
function normalizeRates(payload) {
    const out = [];
    for (const set of (Array.isArray(payload?.data) ? payload.data : [])) {
        for (const j of (Array.isArray(set?.journeys) ? set.journeys : [])) {
            const n = normalizeJourney(j);
            if (n.price != null) out.push(n);
        }
    }
    return out.sort((a, b) => a.price - b.price);
}

const _isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Live, bookable fares. The itinerary is legs-only — their API rejects a
 * top-level origin/destination/departureDate, and a round trip is two legs in
 * travel order, not a returnDate.
 *
 * @param {{legs:Array<{origin,destination,date,direction?}>, adults?, children?, infants?,
 *          childrenAges?, infantAges?, cabinClass?, currency?, country?}} a
 * @returns {Promise<{ok:boolean, reason?:string, journeys:Array, cheapest:object|null}>}
 */
async function searchLiteFlights(a = {}, deps = {}) {
    const env = deps.env || process.env;
    if (!liteFlightsEnabled(env)) return { ok: false, reason: 'lite_flights_disabled', journeys: [], cheapest: null };
    const legs = (Array.isArray(a.legs) ? a.legs : [])
        .map(l => ({
            origin: String(l?.origin || '').toUpperCase().slice(0, 3),
            destination: String(l?.destination || '').toUpperCase().slice(0, 3),
            date: _isDay(l?.date) ? l.date : null,
            ...(l?.direction === 'INBOUND' || l?.direction === 'OUTBOUND' ? { direction: l.direction } : {}),
        }))
        .filter(l => l.origin.length === 3 && l.destination.length === 3 && l.date);
    if (!legs.length) return { ok: false, reason: 'no_valid_legs', journeys: [], cheapest: null };
    const adults = Math.min(9, Math.max(1, Math.round(+a.adults || 1)));
    const body = {
        legs, adults,
        ...(Number.isFinite(+a.children) && +a.children > 0 ? { children: Math.round(+a.children) } : {}),
        ...(Number.isFinite(+a.infants) && +a.infants > 0 ? { infants: Math.round(+a.infants) } : {}),
        ...(Array.isArray(a.childrenAges) && a.childrenAges.length ? { childrenAges: a.childrenAges.map(Number) } : {}),
        ...(Array.isArray(a.infantAges) && a.infantAges.length ? { infantAges: a.infantAges.map(Number) } : {}),
        ...(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(a.cabinClass) ? { cabinClass: a.cabinClass } : {}),
        currency: String(a.currency || 'USD').toUpperCase().slice(0, 3),
        ...(a.country ? { country: String(a.country).toUpperCase().slice(0, 2) } : {}),
    };
    const payload = await _call('/flights/rates', { method: 'POST', body, ttlMs: RATES_TTL_MS }, deps);
    if (!payload) {
        return { ok: false, reason: `rates_call_failed${_lastError ? ` ${_lastError.status}` : ''}`, journeys: [], cheapest: null };
    }
    const journeys = normalizeRates(payload);
    const route = legs.map(l => `${l.origin}→${l.destination}`).join(' / ');
    console.log(`[flightsLite] ${route} ${legs[0].date} pax=${adults} → ${journeys.length} journey(s)${journeys.length ? ` from ${journeys[0].price} ${journeys[0].currency}` : ''}`);
    return { ok: true, journeys, cheapest: journeys[0] || null };
}

/**
 * Airport lookup for turning "Dubai" into DXB. Memoised for a month — airports
 * do not move, and this is the call that would otherwise run every turn.
 * Returns [] rather than throwing, so a failed lookup degrades to the existing
 * Travelpayouts resolver.
 */
async function searchAirports(q, deps = {}) {
    const query = String(q || '').trim();
    if (query.length < 2) return [];
    if (!liteFlightsEnabled(deps.env || process.env)) return [];
    const payload = await _call('/data/flights/airports', { query: { q: query.slice(0, 60) }, ttlMs: AIRPORT_TTL_MS }, deps);
    const out = [];
    for (const set of (Array.isArray(payload?.data) ? payload.data : [])) {
        for (const ap of (Array.isArray(set?.airports) ? set.airports : [])) {
            if (ap?.iata) {
                out.push({
                    iata: ap.iata, name: ap.name || null, city: ap.city || null,
                    country: ap.country || null, lat: ap.lat ?? null, lng: ap.lon ?? null, tz: ap.tz || null,
                });
            }
        }
    }
    return out;
}

/**
 * Re-ask the provider whether an offer still stands, and at what price. Their
 * docs: "Always verify before prebooking to avoid price discrepancies." Never
 * cached — the whole point is that it is fresh.
 *
 * `changed` is what the traveler must be told before paying: the fare moved,
 * or the cabin/fare family did. A 404 means the offer expired, which is an
 * ANSWER ("that fare is gone"), never a silent re-quote.
 */
async function verifyOffer(offerId, deps = {}) {
    if (!offerId) return { ok: false, reason: 'no_offer_id' };
    if (!liteFlightsEnabled(deps.env || process.env)) return { ok: false, reason: 'lite_flights_disabled' };
    const payload = await _call('/flights/verify', { method: 'POST', body: { offerId: String(offerId) } }, deps);
    if (!payload) {
        const gone = _lastError && _lastError.status === 404;
        return { ok: false, reason: gone ? 'offer_expired' : `verify_failed${_lastError ? ` ${_lastError.status}` : ''}` };
    }
    const row = (Array.isArray(payload.data) ? payload.data[0] : null) || {};
    const journey = row.journey ? normalizeJourney(row.journey) : null;
    const changes = row.changes || null;
    return {
        ok: true,
        journey,
        changed: !!changes,
        changes,
        // The one sentence a traveler needs when the number moved under them.
        changeNote: changes
            ? (Array.isArray(changes.messages) ? changes.messages.join(' ') : (changes.message || 'This fare changed since it was quoted.'))
            : null,
    };
}

module.exports = {
    liteFlightsEnabled, searchLiteFlights, searchAirports, verifyOffer,
    normalizeJourney, normalizeRates, _memo, _stillFresh, _earliestExpiry, BASE,
};
