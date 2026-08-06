const express = require('express');
const auth = require('../middleware/auth');
const router = express.Router();

// OpenRouteService directions proxy.
// Keeps ORS_API_KEY server-side and normalises the response to the small shape
// the map needs: { geometry, distance, duration }.
//
// Mount in your app entry, e.g.:
//   app.use('/api/routing', require('./routes/routingRoutes'));
// Env:
//   ORS_API_KEY=...    (free key from https://openrouteservice.org/dev/#/signup)

const ORS_BASE = 'https://api.openrouteservice.org/v2/directions';
const ALLOWED_PROFILES = new Set(['driving-car', 'foot-walking', 'cycling-regular', 'wheelchair']);

// Fail loudly at boot so a missing key is obvious in the logs, not a silent 500.
if (!process.env.ORS_API_KEY) {
    console.warn('[routing] ORS_API_KEY is not set — /api/routing/directions will return 500 until it is configured.');
}

function isLatLng(p) {
    return p
        && Number.isFinite(p.lat) && Number.isFinite(p.lng)
        && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

// POST /api/routing/directions
// body: { from: { lat, lng }, to: { lat, lng }, profile? }
// 200:  { success: true, geometry: <GeoJSON LineString>, distance: <metres>, duration: <seconds>, profile }
router.post('/directions', auth, async (req, res) => {
    try {
        const apiKey = process.env.ORS_API_KEY;
        if (!apiKey) {
            console.error('[routing] blocked: ORS_API_KEY missing in this environment');
            return res.status(500).json({ success: false, error: 'routing_not_configured', message: 'Routing service is not configured.' });
        }

        const { from, to } = req.body || {};
        let { profile, language } = req.body || {};
        if (!isLatLng(from) || !isLatLng(to)) {
            return res.status(400).json({ success: false, error: 'invalid_coordinates', message: 'Valid from/to coordinates are required.' });
        }
        if (!ALLOWED_PROFILES.has(profile)) profile = 'driving-car';
        // Only forward a plausible language tag (e.g. "en", "hy", "ru", "en-us").
        if (typeof language !== 'string' || !/^[a-z]{2}(-[a-z]{2})?$/i.test(language)) language = null;

        // ORS wants [lng, lat] order, and the key goes straight in Authorization (no "Bearer").
        // instructions:true makes ORS return per-step turn guidance (left/right/
        // roundabout/…) inside properties.segments[].steps[].
        const orsBody = {
            coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
            instructions: true,
            instructions_format: 'text',
        };
        if (language) orsBody.language = language;
        const orsRes = await fetch(`${ORS_BASE}/${profile}/geojson`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify(orsBody),
        });

        if (!orsRes.ok) {
            const text = await orsRes.text().catch(() => '');
            console.error('[routing] ORS error', orsRes.status, text.slice(0, 300));
            // 403 = daily quota exhausted, 429 = per-minute limit
            if (orsRes.status === 403 || orsRes.status === 429) {
                return res.status(503).json({ success: false, error: 'routing_rate_limited', message: 'Routing is busy right now. Please try again shortly.' });
            }
            return res.status(502).json({ success: false, error: 'routing_failed', message: 'Could not calculate a route for these points.' });
        }

        const data = await orsRes.json();
        const feature = data && data.features && data.features[0];
        if (!feature || !feature.geometry) {
            return res.status(422).json({ success: false, error: 'no_route', message: 'No route found between these points.' });
        }

        const summary = (feature.properties && feature.properties.summary) || {};
        // Flatten the per-segment steps into one ordered list. Each step's
        // way_points are [startIdx, endIdx] into geometry.coordinates, so the
        // client can locate exactly where each maneuver happens on the line.
        const segments = (feature.properties && feature.properties.segments) || [];
        const steps = [];
        for (const seg of segments) {
            for (const s of (seg.steps || [])) {
                steps.push({
                    type: s.type,                 // ORS maneuver code (0=left, 1=right, 7=roundabout, 9=u-turn, 10=arrive, 11=depart, …)
                    instruction: s.instruction || '',
                    name: s.name && s.name !== '-' ? s.name : '',
                    distance: s.distance ?? null, // metres for this step
                    duration: s.duration ?? null, // seconds for this step
                    way_points: Array.isArray(s.way_points) ? s.way_points : null,
                });
            }
        }
        return res.json({
            success: true,
            geometry: feature.geometry,          // GeoJSON LineString, [lng, lat] pairs
            distance: summary.distance ?? null,  // metres
            duration: summary.duration ?? null,  // seconds
            steps,                               // ordered turn-by-turn guidance
            profile,
        });
    } catch (error) {
        console.error('[routing] directions failed:', error);
        return res.status(500).json({ success: false, error: 'routing_failed', message: error.message });
    }
});


// POST /api/routing/itinerary-route
// Multi-waypoint sibling of /directions: takes an ORDERED list of a single
// day's stops and returns one connected route through all of them (used by
// ItineraryMap to draw the day's path with a total distance/time).
//
// body: { coordinates: [{ lat, lng }, ...], profile? }
// 200 success: { success: true, geometry: <GeoJSON LineString>, distance, duration, profile }
// 200 soft-fail: { success: false, message } — the map falls back to dashed
//   straight segments, so an unroutable day is not a hard error.
router.post('/itinerary-route', auth, async (req, res) => {
    try {
        const apiKey = process.env.ORS_API_KEY;
        if (!apiKey) {
            console.error('[routing] blocked: ORS_API_KEY missing in this environment');
            // Soft-fail (200) so the client draws its straight-line fallback
            // instead of surfacing an error for a non-critical overlay.
            return res.status(200).json({ success: false, message: 'Routing service is not configured.' });
        }

        let { profile } = req.body || {};
        const { coordinates } = req.body || {};
        if (!ALLOWED_PROFILES.has(profile)) profile = 'driving-car';

        const coords = Array.isArray(coordinates)
            ? coordinates
                .filter(isLatLng)            // reuse the same validator as /directions
                .slice(0, 25)               // sane per-day ceiling (ORS free tier allows ~50)
                .map(p => [p.lng, p.lat])   // ORS wants [lng, lat]
            : [];
        if (coords.length < 2) {
            return res.status(400).json({ success: false, error: 'invalid_coordinates', message: 'Need at least 2 valid stops.' });
        }

        // No per-step instructions here — the itinerary path is an overview,
        // not turn-by-turn — so we keep the payload small.
        const orsRes = await fetch(`${ORS_BASE}/${profile}/geojson`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
            body: JSON.stringify({ coordinates: coords }),
        });

        if (!orsRes.ok) {
            const text = await orsRes.text().catch(() => '');
            console.error('[routing] ORS itinerary error', orsRes.status, text.slice(0, 300));
            // Soft-fail for everything: a missing overview route just means the
            // map shows dashed straight segments. Never block the itinerary UI.
            return res.status(200).json({ success: false, message: 'Could not calculate a route for these stops.' });
        }

        const data = await orsRes.json();
        const feature = data && data.features && data.features[0];
        if (!feature || !feature.geometry) {
            return res.status(200).json({ success: false, message: 'No route found between these stops.' });
        }

        const summary = (feature.properties && feature.properties.summary) || {};
        return res.json({
            success: true,
            geometry: feature.geometry,          // GeoJSON LineString, L.geoJSON-ready
            distance: summary.distance ?? null,  // metres
            duration: summary.duration ?? null,  // seconds
            profile,
        });
    } catch (error) {
        console.error('[routing] itinerary-route failed:', error);
        // Soft-fail so the map degrades gracefully rather than erroring.
        return res.status(200).json({ success: false, message: 'Routing unavailable.' });
    }
});

module.exports = router;