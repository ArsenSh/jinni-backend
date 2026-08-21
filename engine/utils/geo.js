// Jinni V2 Engine — geo math.
// COPIED from routes/aiRoutes.js (v1, _haversineKm ~1983) per the copy-not-cut
// rule (engine/ENGINE.md). v1 defines it twice (1983 and 9346 — a documented
// shadowing hazard); the engine defines it ONCE, here.

function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

module.exports = { haversineKm };
