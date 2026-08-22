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

const EVENT_HORIZON_DAYS = 14;   // "upcoming week" asks with margin
const MAX_AI_ROWS = 80;

function _dayStartUTC(now) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d; }

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
        city: e.city || null,
        country: e.country || null,
        geometry: (e.lat != null && e.lng != null) ? { lat: e.lat, lng: e.lng } : null,
        distanceKm: _dist(center, e.lat, e.lng),
        rating: null,
        // v1's exact card contract: eventSchedule present ⇒ the frontend
        // renders the date row (isEventRec). No timezone on pipeline finds —
        // the card falls back to UTC display, same as v1.
        eventSchedule: { startDate: e.startDate, endDate: e.endDate || null, isRecurring: !!e.isRecurring },
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
        eventSchedule: d.eventSchedule || null,
    };
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
    const horizon = new Date(now.getTime() + EVENT_HORIZON_DAYS * 86400000);
    const today = _dayStartUTC(now);

    const [destRows, aiRows] = await Promise.all([
        Destination.find({ type: 'events' }).lean()
            .catch(err => { console.warn('[events] destination tier failed:', err.message); return []; }),
        AiFoundEvent.find({
            status: 'new',
            startDate: { $lte: horizon },
            $or: [{ endDate: { $gte: now } }, { endDate: null, startDate: { $gte: today } }],
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
            if (end.getTime() < now.getTime()) continue;                        // ended
            if (s.startDate && new Date(s.startDate) > horizon) continue;       // too far out
        }
        out.push(destEventToCandidate(d, center));
    }
    for (const e of aiRows) out.push(aiEventToCandidate(e, center));

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
    const within = out.filter(c => c.distanceKm != null
        ? c.distanceKm <= radiusKm
        : (!!cityOf(c) && inRadiusCities.has(cityOf(c))));
    within.sort((a, b) => {
        const ta = a.eventSchedule?.startDate ? new Date(a.eventSchedule.startDate).getTime() : Infinity;
        const tb = b.eventSchedule?.startDate ? new Date(b.eventSchedule.startDate).getTime() : Infinity;
        return (ta - tb) || ((a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    });
    return within;
}

module.exports = { loadEventCandidates, aiEventToCandidate, destEventToCandidate, EVENT_HORIZON_DAYS };
