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

/**
 * @param {object} args { center:{lat,lng}|null, placeNames?:string[] }
 * @returns {Promise<{city:string|null, country:string|null, place:string|null}>}
 */
async function resolveRegion({ center = null, placeNames = [] } = {}, deps = {}) {
    // A place named in THIS message becomes an extra scope: "do I need a visa
    // for Armenia" asked from Dubai is a question about Armenia.
    const place = (Array.isArray(placeNames) ? placeNames : [])
        .map(p => String(p || '').trim()).find(Boolean) || null;

    let city = null, country = null;
    if (center && center.lat != null && center.lng != null) {
        const key = `${Number(center.lat).toFixed(2)},${Number(center.lng).toFixed(2)}`;
        if (CACHE.has(key)) {
            ({ city, country } = CACHE.get(key));
        } else {
            try {
                const detect = deps.detectUserRegion
                    || require('../../services/googleService').detectUserRegion;
                const r = await detect({ lat: center.lat, lng: center.lng });
                city = r?.city || null;
                country = (r?.country && r.country !== 'Unknown') ? r.country : null;
                if (CACHE.size >= MAX_CACHE) CACHE.clear();
                CACHE.set(key, { city, country });
            } catch (err) {
                console.warn(`[region] reverse geocode failed: ${err.message}`);
            }
        }
    }
    return { city, country, place };
}

module.exports = { resolveRegion, _CACHE: CACHE };
