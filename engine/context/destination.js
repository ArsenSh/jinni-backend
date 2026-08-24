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
//   4. GPS               — the default when nobody said otherwise.
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

/**
 * @returns {Promise<{center: {lat, lng}|null, source: string, city: string|null, remember: object|null}>}
 *   `source` is one of 'nearby' | 'named' | 'session' | 'gps' | 'none'.
 *   `remember` is non-null only when a newly named city should be persisted as
 *   the session's destination — the caller owns that write.
 */
async function resolveDestination({
    placeNames = [], gps = null, sessionDestination = null, nearbyMode = false,
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
            return {
                center: { lat: geo.lat, lng: geo.lng },
                source: 'named',
                city: geo.name,
                remember: { name: geo.name, latitude: geo.lat, longitude: geo.lng, placeId: geo.placeId, updatedAt: new Date() },
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

    // 4. Where they actually are.
    return { center: gpsCenter, source: gpsCenter ? 'gps' : 'none', city: null, remember: null };
}

module.exports = { resolveDestination, isGeographic, GEO_DESTINATION_TYPES };
