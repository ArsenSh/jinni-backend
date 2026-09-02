// "Places between Yerevan and Dilijan" / "on the way from Yerevan to Tatev".
//
// Live 2026-09-02: both returned central Yerevan — six NIGHTCLUBS for the Tatev
// drive — because resolveDestination loops placeNames and RETURNS ON THE FIRST
// one it resolves. A corridor has two endpoints and everything interesting is
// in the middle, so one centre can never answer it.
//
// We sample points along the REAL ROAD (OSRM, already self-hosted for routing)
// rather than along the straight line: the Yerevan–Dilijan highway bends around
// the Sevan basin, and a straight line misses the places that are actually on
// the drive. If OSRM is unavailable we degrade to straight-line interpolation
// rather than failing the turn — a rough corridor still beats one city.
//
// Engine rules: no express, injectable deps, never throws.

const _lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

/** Evenly spaced fractions that EXCLUDE the endpoints — the cities themselves
 *  are not "between", and including them lets the bigger one flood the deck. */
function _fractions(samples) {
    const n = Math.max(2, Math.min(6, Number(samples) || 4));
    return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
}

/** Straight-line fallback centres. Pure. */
function interpolateCentres(from, to, samples = 4, radiusKm = 15) {
    return _fractions(samples).map(t => ({ ..._lerp(from, to, t), radiusKm, source: 'line' }));
}

/** Pick `samples` points spread evenly along an OSRM overview geometry.
 *  `coordinates` is GeoJSON order: [lng, lat]. Pure. */
function sampleRouteCentres(coordinates = [], samples = 4, radiusKm = 15) {
    const pts = (coordinates || []).filter(c => Array.isArray(c) && c.length >= 2);
    if (pts.length < 2) return [];
    return _fractions(samples).map(t => {
        const c = pts[Math.min(pts.length - 1, Math.round(t * (pts.length - 1)))];
        return { lat: c[1], lng: c[0], radiusKm, source: 'route' };
    });
}

/**
 * @param {object} args  { from:{lat,lng}, to:{lat,lng}, samples?, radiusKm? }
 * @param {object} deps  { fetchRoute?: (from,to) => coordinates[] }
 * @returns {Promise<Array<{lat,lng,radiusKm,source}>>}  never throws
 */
async function corridorCentres({ from, to, samples = 4, radiusKm = 15 } = {}, deps = {}) {
    if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(to.lat)) return [];
    try {
        const fetchRoute = deps.fetchRoute || (async (a, b) => {
            const axios = require('axios');
            const { osrmBaseFor, buildOsrmRouteUrl } = require('../travel/osrm');
            const url = buildOsrmRouteUrl(osrmBaseFor('driving'), [a, b]);
            const res = await axios.get(url, { timeout: 6000 });
            return res.data?.routes?.[0]?.geometry?.coordinates || [];
        });
        const coords = await fetchRoute(from, to);
        const onRoute = sampleRouteCentres(coords, samples, radiusKm);
        if (onRoute.length) return onRoute;
    } catch (err) {
        console.warn(`[corridor] route lookup failed: ${err.message} — using the straight line`);
    }
    return interpolateCentres(from, to, samples, radiusKm);
}

module.exports = { corridorCentres, sampleRouteCentres, interpolateCentres, _fractions };
