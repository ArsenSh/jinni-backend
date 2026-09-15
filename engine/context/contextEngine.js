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
    let periods = openingHours?.periods;
    // Rows written before 2026-09-16 hold only Google's display lines; read
    // them on the fly so coverage does not wait on the backfill script.
    if ((!Array.isArray(periods) || periods.length === 0) && Array.isArray(openingHours?.weekday_text)) {
        periods = parseWeekdayText(openingHours.weekday_text);
    }
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
 * Applied only on "right now" intents (nearby mode / late-night asks); a trip
 * planned for next week never filters. Unknown hours are exempt by
 * construction (null ≠ false) — outdoor viewpoints and unfilled validator
 * entries survive because they carry NO hours, not because of a category pass.
 * Policy (tightened 2026-08-22 after the live test carded a KNOWN-closed
 * theater on a tonight ask): everything droppable EXCEPT
 *  - hotels: front desks run 24h; hours data on hotels is noise;
 *  - events: carry their OWN dates — the event pipeline owns their time logic. */
const _NEVER_DROP_WHEN_CLOSED = new Set(['hotels', 'events']);
function shouldDropWhenClosed(category) {
    return !_NEVER_DROP_WHEN_CLOSED.has(String(category || '').toLowerCase());
}

/* Business/Destination hours use a day-name schedule
 * ({is24Hours, days:[{day:'Monday', closed, open:'HH:MM', close:'HH:MM'}]}) —
 * this converts it to Google's periods shape so ALL three sources (PlaceCache,
 * Business, Destination) feed the SAME isOpenAt math. Close ≤ open on a day
 * means an overnight span → close rolls to the next day. Junk rows are
 * skipped; nothing valid → null (unknown → kept, per the trust rule). */
const _DAY_NAME_TO_NUM = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
function scheduleToPeriods(openingHours) {
    if (!openingHours) return null;
    if (openingHours.is24Hours) return { periods: [{ open: { day: 0, time: '0000' } }] };
    const periods = [];
    for (const row of (Array.isArray(openingHours.days) ? openingHours.days : [])) {
        if (!row || row.closed) continue;
        const day = _DAY_NAME_TO_NUM[row.day];
        const o = /^(\d{2}):(\d{2})$/.exec(row.open || '');
        const c = /^(\d{2}):(\d{2})$/.exec(row.close || '');
        if (day === undefined || !o || !c) continue;
        const openTime = o[1] + o[2], closeTime = c[1] + c[2];
        const overnight = closeTime <= openTime;
        periods.push({
            open: { day, time: openTime },
            close: { day: overnight ? (day + 1) % 7 : day, time: closeTime },
        });
    }
    return periods.length ? { periods } : null;
}

/** The traveler's date, spelled out for the narrator, with the relative
 *  words it will meet already resolved. Live 2026-09-13: "tickets to Moscow
 *  this week" and "tomorrow" both came back "no fares" while "15 September"
 *  found one — the prompt never said what day it was, so the model guessed
 *  the dates it asked the fare API for. A date the model resolves from THIS
 *  line is a date; one it resolves from memory is a guess.
 *
 *  Weeks: "this week" runs from today to the coming Sunday (a full seven days
 *  when today IS Sunday); "next week" is the Monday–Sunday after that. */
function describeDate(tz) {
    const iso = String(tz?.localISO || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return null;
    const today = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    const add = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
    const ymd = (d) => d.toISOString().slice(0, 10);
    const dow = Number.isFinite(tz.dayOfWeek) ? tz.dayOfWeek : today.getUTCDay();
    const toSunday = (7 - dow) % 7 || 7;
    const thisWeekEnd = add(today, toSunday);
    const nextWeekStart = add(thisWeekEnd, 1);
    const nextWeekEnd = add(thisWeekEnd, 7);
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
    const where = tz.timezone ? ` (${tz.timezone})` : (tz.source === 'utc' ? ' (UTC — the traveler\'s zone is unknown)' : ' (estimated from location)');
    return `${dayName} ${ymd(today)}, ${iso.slice(11, 16)} local time${where}. `
        + `"today" = ${ymd(today)}, "tomorrow" = ${ymd(add(today, 1))}, "this week" = ${ymd(today)} to ${ymd(thisWeekEnd)}, `
        + `"next week" = ${ymd(nextWeekStart)} to ${ymd(nextWeekEnd)}, "this weekend" = ${ymd(add(today, ((6 - dow) % 7)))} to ${ymd(add(today, ((6 - dow) % 7) + 1))}`;
}

/* ── Google's HOURS TEXT → periods (2026-09-16) ──
 * Live finding: 1,249 of 1,869 cached places carry opening hours, but ONLY
 * as Google's display lines ("Monday: 10:00 AM – 12:00 AM"); the mapper never
 * stored the structured periods, so isOpenAt read null for every one of them
 * and the 2 AM deck was filled from places the engine could not judge. The
 * lines are regular enough to parse exactly: "Open 24 hours", "Closed", one
 * or more "H[:MM] [AM|PM] – H:MM AM|PM" ranges, with Google's narrow spaces.
 * Anything else → null for that day (unknown, never a guess). */
const _DAY_NUM = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const _HHMM = (h, m) => `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;

function _clock(str, meridiemHint) {
    // "10:00 AM" / "12:00" (meridiem inherited from the range's end) / "9 PM"
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(str).trim());
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2] || 0);
    const mer = (m[3] || meridiemHint || '').toUpperCase();
    if (h < 1 || h > 12 || min > 59) return null;
    if (mer === 'AM' && h === 12) h = 0;
    else if (mer === 'PM' && h !== 12) h += 12;
    else if (!mer) return null;
    return { h, m: min };
}

/** One weekday line → array of {open:{day,time},close:{day,time}}, [] for
 *  closed, null when it cannot be read. `day` is Google's 0=Sunday. */
function parseHoursLine(line, day) {
    const text = String(line || '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
    const body = text.replace(/^[A-Za-z]+:\s*/, '');
    if (/^closed$/i.test(body)) return [];
    if (/^open 24 hours$/i.test(body)) return [{ open: { day, time: '0000' }, close: { day: (day + 1) % 7, time: '0000' } }];
    const out = [];
    for (const range of body.split(/\s*,\s*/)) {
        const r = /^(.+?)\s*[–—-]\s*(.+)$/.exec(range);
        if (!r) return null;
        const endMer = (/(AM|PM)\s*$/i.exec(r[2]) || [])[1];
        const a = _clock(r[1], endMer), b = _clock(r[2], null);
        if (!a || !b) return null;
        const openM = a.h * 60 + a.m, closeM = b.h * 60 + b.m;
        // Close at or before open = runs past midnight (8 PM – 2 AM).
        const closeDay = closeM <= openM ? (day + 1) % 7 : day;
        out.push({ open: { day, time: _HHMM(a.h, a.m) }, close: { day: closeDay, time: _HHMM(b.h, b.m) } });
    }
    return out.length ? out : null;
}

/** All seven lines → Google-shape periods, or null when NOTHING was readable.
 *  A place open 24/7 collapses to the canonical single open-only period. */
function parseWeekdayText(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    const periods = [];
    let readable = 0, allDay = 0;
    for (const line of lines) {
        const dayName = String(line || '').split(':')[0].trim().toLowerCase();
        const day = _DAY_NUM[dayName];
        if (day === undefined) continue;
        const parsed = parseHoursLine(line, day);
        if (parsed === null) continue;
        readable++;
        if (parsed.length === 1 && parsed[0].open.time === '0000' && parsed[0].close.time === '0000') allDay++;
        periods.push(...parsed);
    }
    if (!readable) return null;
    if (allDay === 7) return [{ open: { day: 0, time: '0000' } }];
    return periods;
}

/** A staff schedule → Google-style display lines ("Monday: 9:00 AM – 6:00 PM",
 *  "Open 24 hours", "Closed"), so curated hours render everywhere Google's do
 *  and round-trip through parseWeekdayText unchanged. */
function scheduleToWeekdayText(openingHours) {
    if (!openingHours) return null;
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    if (openingHours.is24Hours) return DAYS.map(d => `${d}: Open 24 hours`);
    const clock = (hhmm) => {
        const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
        if (!m) return null;
        let h = Number(m[1]); const min = m[2];
        const mer = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${min} ${mer}`;
    };
    const byDay = new Map((Array.isArray(openingHours.days) ? openingHours.days : []).map(r => [r?.day, r]));
    const out = [];
    for (const d of DAYS) {
        const row = byDay.get(d);
        if (!row || row.closed) { out.push(`${d}: Closed`); continue; }
        if (row.open === '00:00' && (row.close === '23:59' || row.close === '24:00' || row.close === '00:00')) { out.push(`${d}: Open 24 hours`); continue; }
        const a = clock(row.open), b = clock(row.close);
        out.push(a && b ? `${d}: ${a} – ${b}` : `${d}: Closed`);
    }
    return out;
}

/** Places API (New) regularOpeningHours.periods → the legacy shape isOpenAt
 *  reads. {open:{day,hour,minute},close:{…}}; a 24/7 place is one open-only
 *  period, which the legacy shape expresses the same way. */
function regularOpeningHoursToPeriods(roh) {
    const src = Array.isArray(roh?.periods) ? roh.periods : null;
    if (!src || !src.length) return null;
    const out = [];
    for (const p of src) {
        const o = p?.open;
        if (!o || !Number.isInteger(o.day)) continue;
        const open = { day: o.day, time: _HHMM(o.hour || 0, o.minute || 0) };
        if (!p.close) { out.push({ open }); continue; }
        const c = p.close;
        if (!Number.isInteger(c.day)) continue;
        out.push({ open, close: { day: c.day, time: _HHMM(c.hour || 0, c.minute || 0) } });
    }
    return out.length ? out : null;
}

module.exports = {
    buildTimeContext,
    describeDate,
    parseHoursLine,
    parseWeekdayText,
    regularOpeningHoursToPeriods,
    scheduleToWeekdayText,
    isOpenAt,
    annotateOpenNow,
    shouldDropWhenClosed,
    scheduleToPeriods,
    _daypartOf,
};
