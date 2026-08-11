// ─────────────────────────────────────────────────────────────────────────────
//  utils/timezone.js — coordinate → IANA timezone resolution
// ─────────────────────────────────────────────────────────────────────────────
//
//  tz-lookup is an offline resolver (no API key, no network). We stamp event
//  listings with their venue's home timezone so event times are stored and
//  shown unambiguously regardless of who registered the listing or who is
//  viewing it.
//
//  Extracted from businessRoutes.js so staffRoutes (validator-added event
//  destinations) resolves timezones through exactly the same code path — two
//  implementations would eventually drift and produce events that render an
//  hour off on one surface but not the other.
//
//  Install with: npm install tz-lookup
// ─────────────────────────────────────────────────────────────────────────────

const tzLookup = require('tz-lookup')

// Resolve a venue's IANA timezone (e.g. "Europe/Moscow") from its coordinates.
// Falls back to 'UTC' when coordinates are missing or the lookup fails, so a
// listing is never left without a usable timezone.
function resolveTimezone(coordinates) {
    try {
        const lat = coordinates?.lat, lng = coordinates?.lng
        if (typeof lat === 'number' && typeof lng === 'number') {
            return tzLookup(lat, lng)
        }
    } catch (_e) { /* fall through to UTC */ }
    return 'UTC'
}

// ── End-of-day in a given zone ───────────────────────────────────────────────
//
//  Given an absolute instant and an IANA zone, returns the instant of 23:59:59
//  on THAT SAME calendar day as seen in that zone.
//
//  Used to give one-time events a sensible implicit end. An organiser who says
//  "the concert starts at 20:00" should not also have to type an end time just
//  to stop the listing vanishing the moment the concert begins — without this,
//  the expiry rule falls back to startDate and the event disappears at 20:00
//  sharp, while people are still on their way. Worse, an all-day event with no
//  time at all starts at local midnight and would be hidden for the whole day
//  it actually happens.
//
//  The offset is applied twice because a day that contains a DST transition
//  has a different offset at midnight than at 23:59; the second pass settles it.
//
function endOfDayInZone(instant, timeZone) {
    const d = instant instanceof Date ? instant : new Date(instant)
    if (isNaN(d.getTime())) return null
    const tz = timeZone || 'UTC'

    // Wall-clock parts of `d` as seen in `tz`.
    const partsIn = (date) => {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        })
        const p = {}
        for (const part of dtf.formatToParts(date)) {
            if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10)
        }
        if (p.hour === 24) p.hour = 0
        return p
    }
    const offsetMinutes = (date) => {
        const p = partsIn(date)
        return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000)
    }

    try {
        const p = partsIn(d)
        const utcGuess = Date.UTC(p.year, p.month - 1, p.day, 23, 59, 59, 999)
        let off = offsetMinutes(new Date(utcGuess))
        let result = new Date(utcGuess - off * 60000)
        const off2 = offsetMinutes(result)
        if (off2 !== off) result = new Date(utcGuess - off2 * 60000)
        return result
    } catch (_e) {
        // Unknown zone — fall back to end-of-day UTC rather than returning
        // nothing, so the event still gets a usable end bound.
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
    }
}

module.exports = { resolveTimezone, endOfDayInZone }
