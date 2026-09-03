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
const { haversineKm } = require('../utils/geo');

// A stated position resolving absurdly far from the traveler's GPS is almost
// always the WRONG namesake, not a teleporting traveler ("Republic Square"
// resolved to a Texan strip mall, live 2026-09-03). Not a hard block — they may
// really be asking about another country — but it must be one grep away.
const FAR_FROM_GPS_KM = 300;
function _warnIfFar(result, near) {
    if (result && near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
        const km = haversineKm(near.lat, near.lng, result.lat, result.lng);
        if (km > FAR_FROM_GPS_KM) {
            console.warn(`[whereAmI] stated "${result.name}" (${result.source}) resolved ${Math.round(km)}km from the traveler's GPS — namesake risk`);
        }
    }
    return result;
}

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
    //    A hit ABSURDLY far from the traveler's GPS is almost always the
    //    wrong namesake, so it only wins as the LAST resort: "near Cascade"
    //    from Yerevan resolved to Cascade, SEYCHELLES — 5,115 km away — and
    //    poisoned the session centre for the following turns (live
    //    2026-09-04). The nearer tiers (own corpus by nearest match, Google
    //    with a location bias) get their chance first.
    let farGazetteerHit = null;
    try {
        const gz = deps.gazetteer === null ? null : (deps.gazetteer || require('./gazetteer'));
        if (gz) {
            const hit = await gz.lookupPlace(wanted, { near });
            if (hit) {
                const r = { lat: hit.lat, lng: hit.lng, name: hit.name, source: 'gazetteer' };
                const km = (near && Number.isFinite(near.lat) && Number.isFinite(near.lng))
                    ? haversineKm(near.lat, near.lng, r.lat, r.lng) : null;
                if (km != null && km > FAR_FROM_GPS_KM) {
                    farGazetteerHit = r;
                    console.log(`[whereAmI] gazetteer "${r.name}" is ${Math.round(km)}km away — deferring to nearer sources`);
                } else {
                    return r;
                }
            }
        }
    } catch { /* fail-open to the next tier */ }

    // 3. Our own place corpus — free, and where landmarks actually live.
    //    NEVER by name alone: the cache holds namesakes from every city a test
    //    ever ran in, and findOne's natural order picked the Texan "Republic
    //    Square" over the Yerevan one 500m away (live 2026-09-03). All matches
    //    are fetched and the one nearest the traveler's GPS wins — the same
    //    `near` the gazetteer and Google tiers already respect.
    try {
        const find = deps.placeCache || (async (n) => {
            const PlaceCache = require('../../models/PlaceCache');
            const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return PlaceCache.find({
                $or: [{ searchName: String(n).toLowerCase() }, { name: new RegExp(`^${esc}$`, 'i') }],
                'details.geometry.location.lat': { $ne: null },
            }).select('name details.geometry.location').limit(8).lean();
        });
        const res = await find(wanted);
        // Injected deps may still return a single doc — both shapes are fine.
        const docs = (Array.isArray(res) ? res : [res]).filter(d => {
            const loc = d?.details?.geometry?.location;
            return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
        });
        if (docs.length) {
            const at = (d) => d.details.geometry.location;
            const best = (near && Number.isFinite(near.lat) && Number.isFinite(near.lng))
                ? docs.reduce((a, b) =>
                    haversineKm(near.lat, near.lng, at(a).lat, at(a).lng)
                        <= haversineKm(near.lat, near.lng, at(b).lat, at(b).lng) ? a : b)
                : docs[0];
            const loc = at(best);
            return _warnIfFar({ lat: loc.lat, lng: loc.lng, name: best.name || wanted, source: 'cache' }, near);
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
                return _warnIfFar({ lat: loc.lat, lng: loc.lng, name: first.name || wanted, source: 'google' }, near);
            }
        }
    } catch { /* fall through */ }

    // Nothing nearer knew the name — the far gazetteer hit may be a genuine
    // ask about another country. Accept it last, with the namesake warning.
    if (farGazetteerHit) return _warnIfFar(farGazetteerHit, near);

    return null;
}

module.exports = { resolveStatedLocation, _sameName };
