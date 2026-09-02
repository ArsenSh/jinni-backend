// "I'm at Khor Virap" — turning a STATED position into coordinates.
//
// Live 2026-09-02: that exact message was answered about Gyumri, 200 km away,
// with cards labelled "just 1 km away". intentService cannot help, and should
// not: its rules forbid putting a landmark in place_names precisely so that a
// restaurant cannot hijack the search centre (the Paphos bug). So the name is
// parsed in code (tuning.parseAtLocation) and resolved here.
//
// CHEAPEST SOURCE FIRST. A landmark the traveler just spoke about is almost
// always already in this conversation or in our own corpus; Google is the last
// resort, not the first. In the live case Khor Virap was in BOTH the session
// and PlaceCache, so this costs nothing at all.
//
// Engine rules: no express, injectable deps, and it NEVER throws — a failure
// returns null and the caller falls back to its normal centre.

const { normalizePlaceName } = require('../places/matching');

const _sameName = (a, b) => {
    const x = normalizePlaceName(a), y = normalizePlaceName(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
};

/**
 * @param {string} name           what the traveler said they are at
 * @param {object} ctx            { sessionCards?: [], near?: {lat,lng} }
 * @param {object} deps           { gazetteer?, placeCache?, findPlaces? } — all optional
 * @returns {Promise<{lat,lng,name,source}|null>}
 */
async function resolveStatedLocation(name, { sessionCards = [], near = null } = {}, deps = {}) {
    const wanted = String(name || '').trim();
    if (wanted.length < 3) return null;

    // 1. A card already shown in THIS conversation — free, and the most likely
    //    hit: they are usually standing at something Jinni just showed them.
    for (const c of sessionCards) {
        if (!c || !_sameName(c.name, wanted)) continue;
        const lat = c.latitude ?? c.lat, lng = c.longitude ?? c.lng;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat, lng, name: c.name, source: 'session' };
        }
    }

    // 2. The gazetteer — catches "I'm in Dilijan" for free. It holds
    //    settlements only, so a monastery or a lake misses here by design.
    try {
        const gz = deps.gazetteer === null ? null : (deps.gazetteer || require('./gazetteer'));
        if (gz) {
            const hit = await gz.lookupPlace(wanted, { near });
            if (hit) return { lat: hit.lat, lng: hit.lng, name: hit.name, source: 'gazetteer' };
        }
    } catch { /* fail-open to the next tier */ }

    // 3. Our own place corpus — free, and where landmarks actually live.
    try {
        const find = deps.placeCache || (async (n) => {
            const PlaceCache = require('../../models/PlaceCache');
            const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return PlaceCache.findOne({
                $or: [{ searchName: String(n).toLowerCase() }, { name: new RegExp(`^${esc}$`, 'i') }],
                'details.geometry.location.lat': { $ne: null },
            }).select('name details.geometry.location').lean();
        });
        const doc = await find(wanted);
        const loc = doc?.details?.geometry?.location;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            return { lat: loc.lat, lng: loc.lng, name: doc.name || wanted, source: 'cache' };
        }
    } catch { /* fail-open to the next tier */ }

    // 4. Google — LAST. One Text Search, and only because the traveler told us
    //    where they are and we would otherwise answer about the wrong city.
    try {
        if (typeof deps.findPlaces === 'function') {
            const found = await deps.findPlaces(wanted, near || null);
            const first = (found || [])[0];
            const loc = first?.geometry?.location;
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
                return { lat: loc.lat, lng: loc.lng, name: first.name || wanted, source: 'google' };
            }
        }
    } catch { /* fall through */ }

    return null;
}

module.exports = { resolveStatedLocation, _sameName };
