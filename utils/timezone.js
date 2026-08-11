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

module.exports = { resolveTimezone }
