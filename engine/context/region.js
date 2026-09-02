// Which city/country is this turn about? — needed by the answer paths that
// SKIP retrieval (getting-around, visa, safety), because they still have to
// look up owned local facts.
//
// Live bug this fixes (2026-08-23): `center` carries only {lat,lng}; city and
// country were resolved deep inside the retrieval branch, so the transport and
// info branches looked facts up with an empty scope, always got nothing, and
// Jinni answered Yerevan transport from model memory — naming Uber and Bolt,
// neither of which operates there.
//
// Cost control: reverse geocoding is a paid Google call, so results are cached
// on a coarse (~1 km) grid for the process lifetime. A traveler asking five
// questions from the same neighbourhood pays for one lookup.

const CACHE = new Map();
const MAX_CACHE = 500;

const _key = (lat, lng) => `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;

/**
 * A coordinate → the names of the place it sits in, in COST order:
 * grid cache → gazetteer (ours, free) → Google Geocoding (paid).
 *
 * Both public functions below share this, so the cache is one cache and the
 * order is stated once. `raw` keeps Google's exact object for the caller that
 * needs its shape (see detectRegion).
 *
 * @returns {Promise<{city,region,country,source,raw}|null>}  never throws
 */
async function _placeAt(lat, lng, deps = {}, requestId = null) {
    const key = _key(lat, lng);
    if (CACHE.has(key)) return CACHE.get(key);

    let found = null;
    try {
        // ── Gazetteer FIRST (2026-09-01) ──
        // Which city a coordinate sits in is a fact we own
        // (models/GeoName.js). This ran up to 3× per turn against Google's
        // Geocoding API. Google stays the fallback for coordinates the
        // gazetteer will not place — mid-ocean, an unseeded server, an empty
        // collection — so an un-seeded deploy behaves exactly as it does
        // today. Pass deps.gazetteer === null to force the Google path.
        let local = null;
        try {
            const gz = deps.gazetteer === null ? null : (deps.gazetteer || require('../geo/gazetteer'));
            if (gz) local = await gz.regionAt({ lat, lng });
        } catch (gzErr) {
            console.warn(`[region] gazetteer failed: ${gzErr.message} — asking Google`);
        }
        if (local?.city) {
            found = {
                city: local.city,
                region: local.region || null,
                country: local.country || null,
                source: 'gazetteer',
                raw: null,
            };
            console.log(`User location: ${local.city}, ${local.region || 'Unknown'}, ${local.country || 'Unknown'} (gazetteer, no API call)`);
        } else {
            const detect = deps.detectUserRegion
                || require('../../services/googleService').detectUserRegion;
            const r = await detect({ lat, lng }, requestId);
            found = {
                city: r?.city || null,
                region: r?.region || null,
                country: r?.country || null,
                source: 'google',
                raw: r || null,
            };
        }
    } catch (err) {
        console.warn(`[region] reverse geocode failed: ${err.message}`);
        return null;                       // uncached: a transient failure must not stick
    }
    if (CACHE.size >= MAX_CACHE) CACHE.clear();
    CACHE.set(key, found);
    return found;
}

/**
 * @param {object} args { center:{lat,lng}|null, placeNames?:string[] }
 * @returns {Promise<{city:string|null, region:string|null, country:string|null, place:string|null}>}
 */
async function resolveRegion({ center = null, placeNames = [] } = {}, deps = {}) {
    // A place named in THIS message becomes an extra scope: "do I need a visa
    // for Armenia" asked from Dubai is a question about Armenia.
    const place = (Array.isArray(placeNames) ? placeNames : [])
        .map(p => String(p || '').trim()).find(Boolean) || null;

    let city = null, region = null, country = null;
    if (center && center.lat != null && center.lng != null) {
        const at = await _placeAt(center.lat, center.lng, deps);
        if (at) {
            city = at.city;
            region = at.region;
            // "Unknown" is Google's way of saying it failed; it must not reach
            // a fact lookup as if it were a country.
            country = (at.country && at.country !== 'Unknown') ? at.country : null;
        }
    }
    return { city, region, country, place };
}

/**
 * The same answer in googleService.detectUserRegion's shape, for the callers
 * that have always spoken it — proximityService filters owned rows on the
 * city and province names it returns.
 *
 * WHY this exists (founder, 2026-09-03: "are we using the github tool
 * correctly?"): proximityService called detectUserRegion directly, and that
 * function has no cache, so EVERY search was a live paid Geocoding request —
 * one per deck turn, and four on a corridor turn, because loadCandidates
 * recurses per segment. The gazetteer had been answering this for free since
 * 2026-09-01; this path simply never went through it.
 *
 * @returns {Promise<{country,region,city,formatted,source}|null>}  never throws
 */
async function detectRegion(userLocation, requestId = null, deps = {}) {
    const lat = Number(userLocation?.lat);
    const lng = Number(userLocation?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const at = await _placeAt(lat, lng, deps, requestId);
    if (!at) return null;
    // Google's own object, untouched, so its callers cannot tell the
    // difference on the fallback path.
    if (at.raw) return { ...at.raw, source: 'google' };
    return {
        country: at.country,
        region: at.region,
        city: at.city,
        formatted: [at.city, at.region, at.country].filter(Boolean).join(', '),
        source: at.source,
    };
}

module.exports = { resolveRegion, detectRegion, _CACHE: CACHE };
