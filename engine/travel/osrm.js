// Jinni V2 Engine — OSRM adapter (pure functions, no I/O).
//
// WHY (founder direction 2026-08-31: "by app instead of google or other
// service paying"): every route the maps draw goes through our ONE backend
// proxy (routes/routingRoutes.js). Today that proxy calls OpenRouteService's
// free cloud — quota-capped (~2000/day) and rate-limited, both of which we
// already hit and track. OSRM (github.com/Project-OSRM/osrm-backend, BSD-2)
// is a self-hostable routing engine: with the Armenia OpenStreetMap extract
// it runs in a tiny Docker container next to the backend, costs nothing per
// request, and has no quota. This module translates between OSRM's API and
// the ORS-shaped response our frontends already speak — so the maps need
// ZERO changes, and ORS remains the automatic fallback when no OSRM URL is
// configured or a call fails.
//
// SELF-HOST (Coolify, one container per profile — ~10 min, see Testbook
// 2026-08-31 OSRM entry for the exact commands):
//   1. download the Armenia extract:  armenia-latest.osm.pbf (Geofabrik)
//   2. preprocess (once):  osrm-extract -p /opt/car.lua  → partition → customize
//   3. serve:  osrm-routed --algorithm mld  (port 5000)
//   4. env:    OSRM_CAR_URL=http://<container>:5000   (and OSRM_FOOT_URL
//              from a second container built with /opt/foot.lua)
// Attribution duty: OSM data is ODbL — the maps must keep the
// "© OpenStreetMap contributors" credit (Leaflet already shows it).

/** Env-configured OSRM base for an ORS profile name; null = ORS handles it.
 *  Wheelchair stays ORS-only — OSRM ships no wheelchair profile. */
function osrmBaseFor(profile, env = process.env) {
    switch (profile) {
        case 'driving-car':     return env.OSRM_CAR_URL || null;
        case 'foot-walking':    return env.OSRM_FOOT_URL || null;
        case 'cycling-regular': return env.OSRM_BIKE_URL || null;
        default:                return null;
    }
}

/** GET url for OSRM's route service. Coordinates arrive as {lat,lng} (our
 *  shape); OSRM wants lng,lat pairs in the path. The /driving/ path token is
 *  cosmetic — a single-profile osrm-routed serves whatever it was built with. */
function buildOsrmRouteUrl(baseUrl, coords, { steps = false } = {}) {
    const path = coords.map(p => `${p.lng},${p.lat}`).join(';');
    const params = `overview=full&geometries=geojson${steps ? '&steps=true' : ''}`;
    return `${String(baseUrl).replace(/\/+$/, '')}/route/v1/driving/${path}?${params}`;
}

// ── ORS maneuver codes, which the frontends already render as icons ──
// (0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight
//  right, 6 straight, 7 enter roundabout, 8 exit roundabout, 9 u-turn,
//  10 arrive, 11 depart, 12 keep left, 13 keep right)
const _MODIFIER_TO_ORS = {
    'left': 0, 'right': 1, 'sharp left': 2, 'sharp right': 3,
    'slight left': 4, 'slight right': 5, 'straight': 6, 'uturn': 9,
};
function orsTypeFromOsrmManeuver(maneuver = {}) {
    const type = String(maneuver.type || '');
    const modifier = String(maneuver.modifier || '');
    if (type === 'depart') return 11;
    if (type === 'arrive') return 10;
    if (type === 'roundabout' || type === 'rotary') return 7;
    if (type === 'exit roundabout' || type === 'exit rotary') return 8;
    if (type === 'fork' || type === 'merge') {
        if (/left/.test(modifier)) return 12;
        if (/right/.test(modifier)) return 13;
        return 6;
    }
    return _MODIFIER_TO_ORS[modifier] ?? 6;
}

/** Plain-English instruction from an OSRM step (OSRM returns structured
 *  maneuvers, not sentences; ORS-served turns keep ORS's localized text —
 *  this covers the self-hosted path well enough for the nav overlay). */
function instructionFromOsrmStep(step = {}) {
    const name = step.name && step.name !== '-' ? step.name : '';
    const onto = name ? ` onto ${name}` : '';
    const m = step.maneuver || {};
    switch (orsTypeFromOsrmManeuver(m)) {
        case 11: return `Head out${onto}`;
        case 10: return 'You have arrived';
        case 7:  return `Enter the roundabout${onto}`;
        case 8:  return `Exit the roundabout${onto}`;
        case 9:  return `Make a U-turn${onto}`;
        case 0:  return `Turn left${onto}`;
        case 1:  return `Turn right${onto}`;
        case 2:  return `Sharp left${onto}`;
        case 3:  return `Sharp right${onto}`;
        case 4:  return `Slight left${onto}`;
        case 5:  return `Slight right${onto}`;
        case 12: return `Keep left${onto}`;
        case 13: return `Keep right${onto}`;
        default: return `Continue${onto}`;
    }
}

/** Index of the overview-geometry vertex nearest to [lng,lat] — the frontends
 *  locate each maneuver on the drawn line via way_points indices (ORS gives
 *  them natively; OSRM gives a maneuver location instead). Squared equirect
 *  distance is plenty at street scale. */
function nearestVertexIndex(coordinates = [], loc = []) {
    if (!Array.isArray(coordinates) || !coordinates.length || !Array.isArray(loc)) return 0;
    let best = 0, bestD = Infinity;
    const cosLat = Math.cos((loc[1] || 0) * Math.PI / 180);
    for (let i = 0; i < coordinates.length; i++) {
        const dx = (coordinates[i][0] - loc[0]) * cosLat;
        const dy = coordinates[i][1] - loc[1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/** OSRM /route JSON → the exact shape routingRoutes serves for ORS:
 *  { geometry, distance, duration, steps } — or null when unroutable. */
function normalizeOsrmRoute(json, { withSteps = false } = {}) {
    const route = json && json.code === 'Ok' && Array.isArray(json.routes) ? json.routes[0] : null;
    if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) return null;
    const out = {
        geometry: route.geometry,                      // GeoJSON LineString, [lng,lat]
        distance: route.distance ?? null,              // metres
        duration: route.duration ?? null,              // seconds
        steps: [],
    };
    if (withSteps) {
        for (const leg of (route.legs || [])) {
            for (const s of (leg.steps || [])) {
                const idx = nearestVertexIndex(route.geometry.coordinates, s.maneuver?.location);
                out.steps.push({
                    type: orsTypeFromOsrmManeuver(s.maneuver),
                    instruction: instructionFromOsrmStep(s),
                    name: s.name && s.name !== '-' ? s.name : '',
                    distance: s.distance ?? null,
                    duration: s.duration ?? null,
                    way_points: [idx, idx],
                });
            }
        }
    }
    return out;
}

module.exports = { osrmBaseFor, buildOsrmRouteUrl, orsTypeFromOsrmManeuver, instructionFromOsrmStep, nearestVertexIndex, normalizeOsrmRoute };
