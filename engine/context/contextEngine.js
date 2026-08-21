// Jinni V2 Engine — Context Engine: time-of-day + open-now (deterministic, $0).
// NEW capability (V3 blueprint §3.3), not a v1 copy — this is the box whose absence
// produced the 3 AM closed-restaurants bug (Testbook 2026-08-21: "4 AM test
// recommended closed restaurants"). Designed pure so the SAME module can be
// back-ported under v1's chat grounding as the production fix.
//
// Rules inherited from the docs:
// - Trust ladder: unknown NEVER renders as fact — missing hours means _openNow=null
//   and the place is KEPT (ranked lower), never dropped on absent data.
// - Timezone lesson (Events-Handoff round 42): only trust a timezone the client
//   actually sent. 'UTC' as a silent default made the longitude fallback
//   unreachable dead code — so here `timezone: null` means MISSING, and the
//   longitude estimate (Math.round(lng/15), same as v1's) genuinely runs.
// - Cached `open_now` booleans are STALE by definition — always compute from
//   `opening_hours.periods` (Google shape: day 0=Sunday, time "HHMM"; a place
//   open 24/7 is one period {open:{day:0,time:"0000"}} with NO close).

const MIN_WEEK = 7 * 24 * 60;   // minutes in a week

const _WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local wall-clock parts for an instant in an IANA timezone. Throws on a bad tz
 *  (callers catch and fall through to the longitude estimate). */
function _localPartsInZone(timezone, now) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, hour12: false, weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
    return {
        // en-CA hour12:false can print midnight as "24" — normalize.
        hour: Number(p.hour) % 24,
        minute: Number(p.minute),
        dayOfWeek: _WEEKDAY_TO_NUM[p.weekday] ?? 0,
        localISO: `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`,
    };
}

/** Local parts from a longitude-estimated offset (Math.round(lng/15) hours —
 *  v1's documented fallback). Uses UTC getters on a shifted instant. */
function _localPartsFromLongitude(lng, now) {
    const offsetH = Math.round(lng / 15);
    const shifted = new Date(now.getTime() + offsetH * 3600000);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        dayOfWeek: shifted.getUTCDay(),
        localISO: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
                + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
    };
}

function _daypartOf(hour) {
    if (hour >= 5 && hour <= 11) return 'morning';
    if (hour >= 12 && hour <= 16) return 'afternoon';
    if (hour >= 17 && hour <= 21) return 'evening';
    return 'night';
}

/**
 * Build the request's time context.
 * @param {object} opts
 * @param {string|null} opts.timezone  IANA zone the CLIENT sent, or null when missing.
 *                                     Never default this to 'UTC' — see round-42 lesson.
 * @param {number|null} opts.lng       search-center longitude (fallback estimate)
 * @param {Date}        [opts.now]     injectable for tests
 */
function buildTimeContext({ timezone = null, lng = null, now = new Date() } = {}) {
    let parts = null, source = 'utc', usedTz = null;
    if (timezone) {
        try {
            parts = _localPartsInZone(timezone, now);
            source = 'client-tz';
            usedTz = timezone;
        } catch { /* invalid tz string → fall through to the estimate */ }
    }
    if (!parts && Number.isFinite(lng)) {
        parts = _localPartsFromLongitude(lng, now);
        source = 'longitude-estimate';
    }
    if (!parts) {
        parts = _localPartsFromLongitude(0, now);   // plain UTC, honestly labeled
        source = 'utc';
    }
    const daypart = _daypartOf(parts.hour);
    return {
        ...parts,
        daypart,
        // "Late night" is the 3 AM zone: most dining is shut, nightlife is not.
        isLateNight: parts.hour >= 23 || parts.hour < 5,
        timezone: usedTz,
        source,
        now,
    };
}

/**
 * Is a place open at the context's local time, per Google `opening_hours.periods`?
 * @returns {boolean|null} true/false when periods answer it; null when hours are
 *                         UNKNOWN (missing/malformed) — the caller must keep nulls.
 */
function isOpenAt(openingHours, ctx) {
    const periods = openingHours?.periods;
    if (!Array.isArray(periods) || periods.length === 0) return null;

    // 24/7: one period, open day 0 time "0000", no close.
    if (periods.length === 1 && periods[0]?.open?.time === '0000'
        && periods[0]?.open?.day === 0 && !periods[0]?.close) {
        return true;
    }

    const nowM = ctx.dayOfWeek * 1440 + ctx.hour * 60 + ctx.minute;
    let sawValidPeriod = false;
    for (const p of periods) {
        const o = p?.open, c = p?.close;
        if (!o || typeof o.time !== 'string' || !Number.isInteger(o.day)) continue;
        if (!c || typeof c.time !== 'string' || !Number.isInteger(c.day)) continue;
        const openM = o.day * 1440 + Number(o.time.slice(0, 2)) * 60 + Number(o.time.slice(2));
        let closeM = c.day * 1440 + Number(c.time.slice(0, 2)) * 60 + Number(c.time.slice(2));
        if (!Number.isFinite(openM) || !Number.isFinite(closeM)) continue;
        sawValidPeriod = true;
        // Overnight (Fri 20:00 → Sat 02:00) and week-wrap (Sat 22:00 → Sun 01:00)
        // both mean close < open in minutes-of-week: unwrap by a week and test
        // the instant in both frames.
        if (closeM <= openM) closeM += MIN_WEEK;
        if ((nowM >= openM && nowM < closeM) || (nowM + MIN_WEEK >= openM && nowM + MIN_WEEK < closeM)) {
            return true;
        }
    }
    // Malformed-only periods → unknown, not closed (never drop on bad data).
    return sawValidPeriod ? false : null;
}

/**
 * Stamp `_openNow: true|false|null` on each place (underscore = internal field,
 * stripped before the response like v1's other _fields). Reads `opening_hours`
 * (Google/PlaceCache shape) or `openingHours`. Never throws, never drops.
 */
function annotateOpenNow(places, ctx) {
    for (const place of places || []) {
        if (!place) continue;
        place._openNow = isOpenAt(place.opening_hours || place.openingHours, ctx);
    }
    return places;
}

/* Which categories may be DROPPED when known-closed at the moment of asking?
 * Policy table, read by the pipeline — and only for "right now" intents
 * (nearby mode / a late-night "tonight" ask). A trip planned for next week
 * never applies this. Unknown hours are exempt by construction (null ≠ false).
 *  - dining/shopping/activities: a closed door right now is a useless answer.
 *  - hotels: front desks run 24h; hours data on hotels is noise.
 *  - events: carry their OWN dates — the event pipeline owns their time logic.
 *  - historical/photo_spots/hidden_gems: usually outdoor/always-viewable;
 *    a wrong "closed" from stale hours would hide a perfectly good viewpoint. */
const _DROP_WHEN_CLOSED = new Set(['restaurants', 'shopping', 'activities']);
function shouldDropWhenClosed(category) {
    return _DROP_WHEN_CLOSED.has(String(category || '').toLowerCase());
}

module.exports = {
    buildTimeContext,
    isOpenAt,
    annotateOpenNow,
    shouldDropWhenClosed,
    _daypartOf,
};
