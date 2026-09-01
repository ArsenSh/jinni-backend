// Jinni V2 Engine — where the search is centred.
//
// Live 2026-08-24: the traveler set the destination to Dubai and asked for
// events there. Every card came back Armenian ("Tashir Arena · 1.1 km away"),
// because v2 treated a chosen destination as a FALLBACK for missing GPS — so
// standing in Yerevan meant searching Yerevan, whatever you had chosen. It
// also never geocoded a city named in the message at all.
//
// v1 got this right and v2 dropped it on the way over. The precedence below is
// v1's, ported into the engine (aiRoutes ~815–895) rather than imported, since
// v1 stays frozen:
//
//   1. nearbyMode        — an explicit "around me" always means GPS.
//   2. a city named NOW  — "events in dubai" re-centres, and is remembered.
//   3. the session's     — a Paphos conversation stays in Paphos even when the
//      chosen destination  traveler is physically elsewhere.
//   4. the SAVED          — the destination set in Settings. Arsen 2026-08-24:
//      destination         "destination is set dubai, it always starts from
//                          armenia, and always same scenario". Choosing a
//                          destination in the app has to mean something on the
//                          very first message of a fresh chat, before any
//                          conversation history exists to carry it.
//   5. GPS               — the default when nobody said otherwise.
//
// The type gate in rule 2 is v1's hard-won one: asking about a RESTAURANT is
// not a destination change. Geocoding a venue name biased to the user's GPS
// once matched a harbour near Yerevan and hijacked a Paphos session to
// Armenia — wrong proximity, wrong partners, and the wrong point saved as the
// session destination. Only geographic types may move the centre.
const GEO_DESTINATION_TYPES = new Set([
    'locality', 'sublocality', 'postal_town', 'administrative_area_level_1',
    'administrative_area_level_2', 'administrative_area_level_3', 'administrative_area_level_4',
    'country', 'natural_feature', 'archipelago', 'colloquial_area', 'political', 'continent',
]);

// How big is the thing they named? The types were already fetched for
// isGeographic() and then thrown away — which is why a COUNTRY was re-centred
// on its geometric centroid and then searched with the 15 km cap meant for a
// single town (analysis 2026-09-01: "best places to visit in Armenia" searched
// a 15 km circle near Lake Sevan, ~47 km from Yerevan). 'political' is generic
// and must never decide a scale. Pure.
const SCALE_BY_TYPE = {
    continent: 'continent',
    country: 'country',
    administrative_area_level_1: 'region',
    administrative_area_level_2: 'region',
    archipelago: 'region',
    colloquial_area: 'region',
};
function scaleOf(geo) {
    // The gazetteer states its own scale; Google only implies it through types.
    if (geo && typeof geo.scale === 'string' && geo.scale) return geo.scale;
    for (const t of (geo?.types || [])) {
        const s = SCALE_BY_TYPE[String(t).toLowerCase()];
        if (s) return s;
    }
    return 'town';   // locality / sublocality / postal_town / natural_feature
}

const MEMO_TTL_MS = 60 * 60 * 1000;
const MEMO_CAP = 500;
const _memo = new Map();

function _memoKey(name, gps) {
    const near = gps && gps.lat != null ? `${Number(gps.lat).toFixed(1)},${Number(gps.lng).toFixed(1)}` : 'none';
    return `${String(name).toLowerCase().trim()}|${near}`;
}

/** Geocode through the injected finder, with a 1h memo — a repeated "Dubai"
 *  in one conversation must not cost a Google call per turn. */
async function _geocode(name, gps, deps) {
    const key = _memoKey(name, gps);
    const hit = _memo.get(key);
    if (hit && (Date.now() - hit.ts) < MEMO_TTL_MS) return hit.value;

    let value = null;
    // ── Gazetteer FIRST (2026-09-01) ──
    // "Where is Yerevan" is a fact we own (models/GeoName.js), and it used to
    // cost a Places TEXT SEARCH — the priciest SKU, drawn from the same
    // 10k/mo free quota real place searches need. Google is kept for the one
    // thing only it can do: resolve a VENUE name ("Nairi", a restaurant). A
    // gazetteer MISS is itself evidence the name is not a place on the map.
    // Pass deps.gazetteer === null to force the Google path (tests).
    try {
        const gz = deps.gazetteer === null ? null : (deps.gazetteer || require('../geo/gazetteer'));
        if (gz) {
            const local = await gz.lookupPlace(name, { near: gps || null });
            if (local) {
                console.log(`[destination] "${name}" → gazetteer (${local.scale}, pop=${local.population})`);
                value = local;
            }
        }
    } catch (err) {
        console.warn(`[destination] gazetteer lookup failed: ${err.message} — asking Google`);
    }
    if (value) {
        if (_memo.size >= MEMO_CAP) _memo.delete(_memo.keys().next().value);
        _memo.set(key, { value, ts: Date.now() });
        return value;
    }
    try {
        const found = await deps.findPlaces(name, gps || null);
        const first = (found || [])[0];
        const loc = first?.geometry?.location;
        if (loc && loc.lat != null && loc.lng != null) {
            value = {
                lat: loc.lat, lng: loc.lng,
                name: first.name || name,
                placeId: first.place_id || null,
                types: [first.primaryType, ...(first.types || [])].filter(Boolean),
            };
        }
    } catch (err) {
        console.warn(`[destination] geocode "${name}" failed: ${err.message}`);
        return null;                                   // fail-open: keep the old centre
    }
    if (_memo.size >= MEMO_CAP) _memo.delete(_memo.keys().next().value);
    _memo.set(key, { value, ts: Date.now() });
    return value;
}

/** True when this geocode result is a PLACE ON THE MAP rather than a venue.
 *  A result with no types at all counts as geographic — that is the legacy
 *  shape, and refusing it would silently break re-centring. */
function isGeographic(geo) {
    if (!geo) return false;
    if (!Array.isArray(geo.types) || !geo.types.length) return true;
    return geo.types.some(t => GEO_DESTINATION_TYPES.has(String(t).toLowerCase()));
}

/** Loose name equality for places: "T'bilisi" vs "Tbilisi", "Armenia" vs
 *  "armenia". Accents and marks removed, case folded, punctuation dropped. */
function _samePlace(a, b) {
    const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '');
    return !!norm(a) && norm(a) === norm(b);
}

/**
 * @returns {Promise<{center: {lat, lng}|null, source: string, city: string|null, remember: object|null}>}
 *   `source` is one of 'nearby' | 'named' | 'here' | 'session' | 'gps' | 'none'.
 *   'here' means the named place is where we already are, so nothing moved.
 *   `remember` is non-null only when a newly named city should be persisted as
 *   the session's destination — the caller owns that write.
 */
async function resolveDestination({
    placeNames = [], gps = null, sessionDestination = null, savedDestination = null,
    nearbyMode = false, currentRegion = null,
} = {}, deps = {}) {
    const gpsCenter = (gps && gps.lat != null && gps.lng != null) ? { lat: gps.lat, lng: gps.lng } : null;

    // 1. "near me" is not ambiguous.
    if (nearbyMode) return { center: gpsCenter, source: gpsCenter ? 'nearby' : 'none', city: null, remember: null };

    // 2. A city named in THIS message wins, and is remembered.
    if (typeof deps.findPlaces === 'function') {
        for (const name of (placeNames || []).slice(0, 3)) {
            if (!name) continue;
            const geo = await _geocode(name, gpsCenter, deps);
            if (!geo) continue;
            if (!isGeographic(geo)) {
                console.log(`[destination] "${name}" resolved to a venue ("${geo.name}") — not re-centring`);
                continue;
            }
            // Naming the place you are ALREADY in is not a move. "find in
            // armenia" from Yerevan re-centred on the country's centroid in
            // Ararat Province, and every card then read "46 km away" from a
            // traveler who could walk to them (live 2026-08-24). A country
            // centroid is a worse centre than the street you are standing on.
            if (currentRegion && (_samePlace(geo.name, currentRegion.country) || _samePlace(geo.name, currentRegion.city))) {
                console.log(`[destination] "${name}" is where we already are — keeping the current centre`);
                // REMEMBER it anyway. Naming where you already are still moves
                // the conversation there, and returning remember:null meant it
                // did not stick: "find events in yerevan armenia" answered
                // about Yerevan, then "another ones" fell back to the saved
                // Dubai and replied "every upcoming event I have in Dubai"
                // (live 2026-08-24: "armenia braked also"). What is remembered
                // is the CURRENT position, never the country centroid — that is
                // the whole reason this branch exists.
                return {
                    center: gpsCenter,
                    source: 'here',
                    scale: scaleOf(geo),
                    population: geo.population || 0,
                    city: currentRegion.city || geo.name,
                    remember: gpsCenter ? {
                        name: currentRegion.city || geo.name,
                        latitude: gpsCenter.lat, longitude: gpsCenter.lng,
                        placeId: null, updatedAt: new Date(),
                    } : null,
                };
            }
            const scale = scaleOf(geo);
            return {
                center: { lat: geo.lat, lng: geo.lng },
                source: 'named',
                scale,
                population: geo.population || 0,
                city: geo.name,
                // singleTown records whether the town was named ALONE — the
                // 15km named-town radius cap keys off it, and a REFILL turn
                // (centre=session) must inherit the same cap: "find 5 more"
                // after "hotels in Dilijan" ran at r=50km and seated
                // Tsaghkadzor/Dzoraget again (live 2026-08-31). Multi-town
                // asks stay wide — the traveler drew the bigger map.
                remember: {
                    name: geo.name, latitude: geo.lat, longitude: geo.lng, placeId: geo.placeId,
                    // …and a COUNTRY is not a town boundary at all. Letting
                    // "Armenia" set this flag made every later refill in the
                    // session inherit a 15 km cap on a country-wide ask.
                    singleTown: scale === 'town' && (placeNames || []).filter(Boolean).length === 1,
                    scale,
                    updatedAt: new Date(),
                },
            };
        }
    }

    // 3. The destination this conversation already chose — ABOVE GPS, which is
    //    the whole point of choosing one.
    if (sessionDestination && sessionDestination.latitude != null && sessionDestination.longitude != null) {
        return {
            center: { lat: sessionDestination.latitude, lng: sessionDestination.longitude },
            source: 'session',
            city: sessionDestination.name || null,
            remember: null,
        };
    }

    // 4. The destination chosen in Settings. A fresh chat has no session
    //    destination, so without this the setting was invisible on exactly the
    //    turn that matters most — the first one.
    const saved = _savedCentre(savedDestination);
    if (saved) {
        return { center: { lat: saved.lat, lng: saved.lng }, source: 'saved', city: saved.name, remember: null };
    }

    // 5. Where they actually are.
    return { center: gpsCenter, source: gpsCenter ? 'gps' : 'none', city: null, remember: null };
}

/** The Settings destination, or null when it is unset. `coordinates` defaults
 *  to {lat: 0, lng: 0} in the schema, and 0,0 is the Gulf of Guinea — treating
 *  the default as a location would send every traveler to the Atlantic. */
function _savedCentre(saved) {
    const c = saved?.coordinates || saved || {};
    const lat = Number(c.lat ?? c.latitude);
    const lng = Number(c.lng ?? c.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null;
    const name = saved?.city || saved?.countryName || saved?.name || null;
    return { lat, lng, name };
}

module.exports = { resolveDestination, isGeographic, scaleOf, _samePlace, _savedCentre, GEO_DESTINATION_TYPES, SCALE_BY_TYPE };
