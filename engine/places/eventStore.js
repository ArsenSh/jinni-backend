// Jinni V2 Engine — events candidate source (battery fix #1, 2026-08-22).
//
// "Things to do this weekend" used to return the empty scaffold error: the
// canonical store deliberately serves NO cache rows for events (a cached
// venue is not a dated event) and nothing else was wired. This module is the
// owned-data events tier, per the trust ladder (validator > feed > listing >
// extracted > model):
//
//   Tier 1 — validator-approved events: Destinations typed 'events'
//            (created by a validator approving an AiFoundEvent, or curated
//            directly). Top trust, carry the full eventSchedule + timezone.
//   Tier 2 — moderated pipeline finds: AiFoundEvent rows with status 'new'
//            (validators haven't judged them yet). 'hidden' rows never serve
//            (the permanent blocklist); 'approved' rows are excluded here
//            because their Destination twin already serves them (no dupes).
//
// Both tiers are OWNED data — zero API cost. Google/web-search fallback for
// events is a separate, config-gated concern (see the cutover battery doc).
//
// Prior order: soonest-first, then nearest — "this weekend" wants what's
// happening NEXT, not what's most famous. RRF's proximity/lexical lists still
// blend on top of this prior like any other category.

const { haversineKm } = require('../utils/geo');

const EVENT_HORIZON_DAYS = 14;   // default window when the ask names no period
const MAX_AI_ROWS = 80;

function _dayStartUTC(now) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d; }

// ── Asked-period parsing (Arsen 2026-08-22: "for upcoming weekend not — it
//    automatically finds the next 7 day period only"). The WINDOW comes from
//    the ask itself: tonight ⇒ rest of today, weekend ⇒ the actual Sat–Sun,
//    next week ⇒ Mon–Sun after this one. Six app languages; Latin \b group +
//    boundary-free non-Latin group (the Cyrillic lesson). Day math is UTC —
//    at day granularity the ±4h Yerevan offset only matters at midnight edges.
const DAY_MS = 24 * 60 * 60 * 1000;
const _RE_TODAY = /\b(today|tonight|this evening|ce soir|aujourd'hui)\b|сегодня|вечером|今天|今晚|اليوم|الليلة|այսօր|այս երեկո/i;
const _RE_TOMORROW = /\b(tomorrow|demain)\b|завтра|明天|غدا|غداً|վաղը/i;
const _RE_WEEKEND = /\b(weekend|week-end)\b|выходн|уик-?энд|周末|نهاية الأسبوع|ուիքենդ|հանգստյան օր/i;
const _RE_NEXT_WEEK = /\bnext week\b|\bla semaine prochaine\b|следующ\S* недел|на той неделе|下周|下星期|الأسبوع القادم|հաջորդ շաբաթ/i;
// Numeric spans — "next 3 days", "ближайшие 3 дня", "未来3天", "les 3
// prochains jours", "الأيام الـ3 القادمة", "առաջիկա 3 օրը" (Arsen 2026-08-23:
// "what if user asks for next 3 days?"). Capture the number, cap at 30.
const _RE_N_DAYS = /(?:next|coming|следующие|ближайшие|prochains?|القادمة|առաջիկա|未来|接下来)\D{0,6}?(\d{1,2})\s*(?:days?|дня|дней|день|jours?|أيام|يوم|օր|天)|(\d{1,2})\s*(?:days?|дня|дней|jours?|أيام|օր|天)/i;

const _endOfDay = (d) => new Date(d.getTime() + DAY_MS - 1);

// Shared date math — one implementation serves BOTH the AI brain
// (windowFromPeriod: the intent model NAMES the period, this code computes
// and clamps it) and the regex fallback (parseEventWindow).
const _WINDOWS = {
    today: (now, today) => ({ start: new Date(now), end: _endOfDay(today), label: 'today' }),
    tomorrow: (now, today) => {
        const t = new Date(today.getTime() + DAY_MS);
        return { start: t, end: _endOfDay(t), label: 'tomorrow' };
    },
    weekend: (now, today) => {
        // Upcoming Sat–Sun; already inside the weekend ⇒ now through Sunday.
        const dow = today.getUTCDay();                        // 0 Sun … 6 Sat
        const daysToSat = dow === 0 ? -1 : (6 - dow);          // Sunday counts as ongoing weekend
        const sat = new Date(today.getTime() + Math.max(0, daysToSat) * DAY_MS);
        const sun = new Date(sat.getTime() + (dow === 0 ? 0 : DAY_MS));
        const start = (dow === 0 || dow === 6) ? new Date(now) : sat;
        return { start, end: _endOfDay(sun), label: 'weekend' };
    },
    nextWeek: (now, today) => {
        const dow = today.getUTCDay();
        const daysToNextMon = ((8 - dow) % 7) || 7;
        const mon = new Date(today.getTime() + daysToNextMon * DAY_MS);
        return { start: mon, end: _endOfDay(new Date(mon.getTime() + 6 * DAY_MS)), label: 'next-week' };
    },
    nDays: (now, today, n) => ({
        // "next 3 days" = today, tomorrow, the day after.
        start: new Date(now), end: _endOfDay(new Date(today.getTime() + (n - 1) * DAY_MS)), label: `next-${n}-days`,
    }),
};

/**
 * The AI-brain path (Arsen 2026-08-23: "ai should understand itself... gas
 * and brake pedals"): the intent model names a validated period string —
 * today | tomorrow | weekend | next_week | Ndays | YYYY-MM-DD..YYYY-MM-DD —
 * and this deterministic code turns it into a clamped window. null ⇒ caller
 * falls back to the regex parser.
 */
function windowFromPeriod(period, now = Date.now()) {
    if (!period || typeof period !== 'string') return null;
    const p = period.trim().toLowerCase();
    const today = _dayStartUTC(new Date(now));
    if (p === 'today') return _WINDOWS.today(now, today);
    if (p === 'tomorrow') return _WINDOWS.tomorrow(now, today);
    if (p === 'weekend') return _WINDOWS.weekend(now, today);
    if (p === 'next_week') return _WINDOWS.nextWeek(now, today);
    const nd = p.match(/^(\d{1,2})days$/);
    if (nd) return _WINDOWS.nDays(now, today, Math.min(30, Math.max(1, Number(nd[1]))));
    const rng = p.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (rng) {
        const start = new Date(`${rng[1]}T00:00:00Z`);
        const end = new Date(`${rng[2]}T23:59:59Z`);
        // Brakes: valid dates, ordered, not in the past, span ≤ 90 days.
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
        if (end < start || end.getTime() < now || (end - start) > 90 * DAY_MS) return null;
        return { start: start.getTime() < now ? new Date(now) : start, end, label: `range-${rng[1]}` };
    }
    return null;
}

/** Regex FALLBACK (LLM-timeout path): what period does the message ask about? */
function parseEventWindow(message, now = Date.now()) {
    const msg = String(message || '');
    const today = _dayStartUTC(new Date(now));
    if (_RE_TODAY.test(msg)) return _WINDOWS.today(now, today);
    if (_RE_TOMORROW.test(msg)) return _WINDOWS.tomorrow(now, today);
    if (_RE_WEEKEND.test(msg)) return _WINDOWS.weekend(now, today);
    if (_RE_NEXT_WEEK.test(msg)) return _WINDOWS.nextWeek(now, today);
    const nd = msg.match(_RE_N_DAYS);
    if (nd) return _WINDOWS.nDays(now, today, Math.min(30, Math.max(1, Number(nd[1] || nd[2]))));
    return { start: new Date(now), end: new Date(now + EVENT_HORIZON_DAYS * DAY_MS), label: 'default' };
}

function _dist(center, lat, lng) {
    return (center && lat != null && lng != null)
        ? haversineKm(center.lat, center.lng, lat, lng) : null;
}

/** AiFoundEvent row → retrieval candidate. */
function aiEventToCandidate(e, center) {
    return {
        name: e.name,
        placeId: e.placeId || null,
        verifiedId: null,
        source: 'event',
        primaryType: 'event',
        types: ['event'],
        text: [e.name, e.description, e.venueName, e.city].filter(Boolean).join(' '),
        description: e.description || null,
        image: e.image || null,                       // the poster the card showed
        address: e.address || e.venueName || null,
        // The venue, kept SEPARATE from the address. An event has no photos of
        // its own, so "more images" has to ask about the room it happens in —
        // asking about the event's TITLE instead returned photos of unrelated
        // places (live 2026-08-24: Google searched for "Սև ու սպիտակ մածուն").
        venueName: e.venueName || null,
        city: e.city || null,
        country: e.country || null,
        geometry: (e.lat != null && e.lng != null) ? { lat: e.lat, lng: e.lng } : null,
        distanceKm: _dist(center, e.lat, e.lng),
        rating: null,
        // v1's exact card contract: eventSchedule present ⇒ the frontend
        // renders the date row (isEventRec). No timezone on pipeline finds —
        // the card falls back to UTC display, same as v1.
        eventSchedule: { startDate: e.startDate, endDate: e.endDate || null, isRecurring: !!e.isRecurring },
        // Where the event was found — the frontend renders it as a source
        // link below the card (Arsen 2026-08-23: "source it can show below
        // card, i already have in front").
        sourceUrl: e.sourceUrl || null,
        // Ticket price as the SOURCE printed it; null when it printed none.
        price: e.price || null,
    };
}

/** Validator event Destination → retrieval candidate. */
function destEventToCandidate(d, center) {
    const lat = d.location?.coordinates?.lat, lng = d.location?.coordinates?.lng;
    return {
        name: d.name,
        placeId: null,
        verifiedId: String(d._id),
        source: 'destination',                        // "verified by Jinni staff" fact
        primaryType: 'event',
        types: Array.isArray(d.type) ? d.type : ['event'],
        text: [d.name, d.description, d.location?.city].filter(Boolean).join(' '),
        description: d.description || null,
        image: Array.isArray(d.images) && d.images.length ? d.images[0] : null,
        address: d.location?.address || null,
        city: d.location?.city || null,
        country: d.location?.country || null,
        geometry: (lat != null && lng != null) ? { lat, lng } : null,
        distanceKm: _dist(center, lat, lng),
        rating: d.rating || null,
        website: d.contact?.website || null,
        phone: d.contact?.phone || null,
        // Same backfill covers event Destinations → semantic ranking works
        // over curated events too (vec=true once embedded).
        vector: Array.isArray(d.embedding) ? d.embedding : undefined,
        eventSchedule: d.eventSchedule || null,
    };
}

// ── One event, many listings (live 2026-08-29): a Dubai refill served FOUR
//    cards of the same expo — "Middle East Energy 2026", "2026 Middle East
//    Energy", "…(Booth: Z2.L09)!", "…exhibition" — four allevents listings of
//    one event. The hunt's store key and mergeAndDedupe both use EXACT
//    normalized names, so listings that differ by a word all survive.
//    eventNamesMatch (the two-shared-distinctive-tokens matcher, rounds
//    44/46) collapses them; the same-start-day + non-conflicting-city
//    requirements keep it from merging genuinely different events
//    ("Candlelight: Vivaldi" vs "Candlelight: Edith Piaf" share one token —
//    verified apart). ──

const _eventDayKey = (c) => {
    const sd = c?.eventSchedule?.startDate;
    if (!sd) return null;                        // recurring/undated → never fuzzy-merged
    const d = new Date(sd);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Which duplicate listing deserves the card: a validator row always, then the
 *  one with a real start time (midnight = the honest "All day" unknown), a
 *  poster, a map pin, a price, a description. */
function _listingRichness(c) {
    let s = 0;
    if (c.source === 'destination') s += 100;    // validator rows never lose to a listing
    const sd = c.eventSchedule?.startDate ? new Date(c.eventSchedule.startDate) : null;
    if (sd && (sd.getUTCHours() !== 0 || sd.getUTCMinutes() !== 0)) s += 4;
    if (c.image) s += 2;
    if (c.placeId || c.geometry) s += 2;
    if (c.price) s += 1;
    if (c.description) s += 1;
    return s;
}

function dedupeEventListings(list) {
    const { eventNamesMatch } = require('../events/matching');
    const _city = (c) => String(c.city || '').trim().toLowerCase();
    const kept = [];
    let dropped = 0;
    for (const c of list) {
        const day = _eventDayKey(c);
        const dup = day ? kept.find(k => _eventDayKey(k) === day
            // Cities must not CONFLICT — same-day near-namesakes in two
            // different cities are two instances, not one event.
            && (!_city(k) || !_city(c) || _city(k) === _city(c))
            && eventNamesMatch(k.name, c.name)) : null;
        if (!dup) { kept.push(c); continue; }
        dropped++;
        // Keep the SLOT (order encodes trust: validator rows come first),
        // upgrade its occupant when the newcomer carries more facts.
        if (_listingRichness(c) > _listingRichness(dup)) kept[kept.indexOf(dup)] = c;
    }
    if (dropped) console.log(`[events] collapsed ${dropped} duplicate listing(s) of the same event(s)`);
    return kept;
}

/**
 * The events branch of loadCandidates. Fail-open per tier; never throws.
 * Returns upcoming (or recurring) events within radius, soonest first.
 */
async function loadEventCandidates(params = {}, deps = {}) {
    const { center = null, radiusKm = 50 } = params;
    if (!center || center.lat == null || center.lng == null) return [];
    const AiFoundEvent = deps.AiFoundEvent || require('../../models/AiFoundEvent');
    const Destination = deps.Destination || require('../../models/Destination');
    const now = deps.nowFn ? new Date(deps.nowFn()) : new Date();
    // The asked period rules the query (params.eventWindow from the route's
    // parseEventWindow); absent ⇒ the default now→+14d horizon.
    const win = params.eventWindow || parseEventWindow('', now.getTime());
    const wStart = new Date(win.start), wEnd = new Date(win.end);
    const wStartDay = _dayStartUTC(wStart);

    const [destRows, aiRows] = await Promise.all([
        Destination.find({ type: 'events' }).lean()
            .catch(err => { console.warn('[events] destination tier failed:', err.message); return []; }),
        AiFoundEvent.find({
            status: 'new',
            startDate: { $lte: wEnd },
            $or: [{ endDate: { $gte: wStart } }, { endDate: null, startDate: { $gte: wStartDay } }],
        }).limit(MAX_AI_ROWS).lean()
            .catch(err => { console.warn('[events] pipeline tier failed:', err.message); return []; }),
    ]);

    const out = [];
    for (const d of destRows) {
        const s = d.eventSchedule;
        // A destination typed 'events' with no schedule is malformed — skip
        // rather than show an undated "event" card.
        if (!s || (!s.startDate && !s.isRecurring)) continue;
        if (!s.isRecurring) {
            const end = new Date(s.endDate || s.startDate);
            if (end.getTime() < wStart.getTime()) continue;                     // over before the window
            if (s.startDate && new Date(s.startDate) > wEnd) continue;          // starts after the window
        }
        out.push(destEventToCandidate(d, center));
    }
    for (const e of aiRows) out.push(aiEventToCandidate(e, center));

    // One event, many listings → one card (see dedupeEventListings above).
    const uniq = dedupeEventListings(out);

    // Radius is soft-edged for events: rows without coords (city-only finds)
    // survive — a city-wide festival with no venue pin is still an answer.
    // BUT only when their city matches somewhere actually in radius (caught
    // live 2026-08-22: a coordless DUBAI comedy show served in a Yerevan ask).
    // No in-radius city evidence → the coordless row drops; wrong-city cards
    // are worse than a missed festival.
    const cityOf = (c) => String(c.city || '').trim().toLowerCase();
    const inRadiusCities = new Set(out
        .filter(c => c.distanceKm != null && c.distanceKm <= radiusKm)
        .map(cityOf).filter(Boolean));
    // The search centre's own city is in-radius BY DEFINITION. Without this
    // seed, a city whose shelf events are ALL coordless (every hunted row
    // starts venue-unpinned) could never enter the set, so the entire shelf
    // dropped, the shelf always read "thin", and the hunt re-read every
    // source on EVERY ask — live 2026-08-29: Dubai held 24 fresh events from
    // a 15-minute-old sweep and the turn still spent 32s re-reading 9 sources.
    if (params.regionCity) inRadiusCities.add(String(params.regionCity).trim().toLowerCase());
    // Radius filters the DEDUPED list; the city-evidence set above still reads
    // the full list — a dropped duplicate's venue pin may be the only thing
    // vouching that its city is in radius.
    const within = uniq.filter(c => c.distanceKm != null
        ? c.distanceKm <= radiusKm
        : (!!cityOf(c) && inRadiusCities.has(cityOf(c))));
    within.sort((a, b) => {
        const ta = a.eventSchedule?.startDate ? new Date(a.eventSchedule.startDate).getTime() : Infinity;
        const tb = b.eventSchedule?.startDate ? new Date(b.eventSchedule.startDate).getTime() : Infinity;
        return (ta - tb) || ((a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    });
    return within;
}

module.exports = { loadEventCandidates, aiEventToCandidate, destEventToCandidate, parseEventWindow, windowFromPeriod, EVENT_HORIZON_DAYS, dedupeEventListings };
