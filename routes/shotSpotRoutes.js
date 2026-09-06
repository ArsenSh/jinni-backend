// ─────────────────────────────────────────────────────────────────────────────
//  shotSpotRoutes.js — "Jinni Shot Spots" API (Stage 1)
//
//  Mounted at /api/shotspots in server.js (single line — the only touch this
//  feature makes outside its own files; delete the mount + the files and the
//  feature is gone, per the founder's easily-deletable requirement).
//
//  Traveler side (public GETs — active spots only, no photo bytes inline):
//    GET  /                 list active spots (?city= filter)
//    GET  /:id              one active spot
//    GET  /:id/photo        hero photo bytes (long-cached)
//
//  Staff side (auth + staffOrAdmin, same gate contract as staffRoutes.js —
//  the gate is a local copy so this router stays dependency-free):
//    GET    /staff/list     all spots incl. drafts
//    POST   /staff          create (photo as base64 data URL in JSON)
//    PATCH  /staff/:id      edit fields / replace photo / toggle status
//    DELETE /staff/:id
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const ShotSpot = require('../models/ShotSpot');
const ShotRecreation = require('../models/ShotRecreation');
const Destination = require('../models/Destination');
const PlaceCache = require('../models/PlaceCache');
const User = require('../models/User');
const auth = require('../middleware/auth');

// ── Staff gate — same contract as staffRoutes.staffOrAdmin (local copy so
//    deleting either file never breaks the other) ────────────────────────────
async function staffOrAdmin(req, res, next) {
    try {
        const uid = req.user?.id || req.user?._id;
        if (!uid) return res.status(401).json({ error: 'Unauthenticated' });
        const u = await User.findById(uid).select('role isActive isAdmin name email').lean();
        if (!u) return res.status(401).json({ error: 'Unauthenticated' });
        if (u.isActive === false) return res.status(403).json({ error: 'Account is revoked' });
        const isAdmin = u.role === 'admin' || u.isAdmin === true;
        if (!isAdmin && u.role !== 'staff') return res.status(403).json({ error: 'Staff or admin only' });
        req.user = { ...u, id: String(u._id), isAdmin };
        next();
    } catch (err) {
        console.error('[shotspots] staff gate error:', err);
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// ── Photo payload decoding — base64 data URL from the capture page ──────────
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // decoded; JSON body cap (10mb) holds the base64
function decodePhoto(dataUrl) {
    if (typeof dataUrl !== 'string') return { error: 'photo required' };
    const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
    if (!m || !PHOTO_TYPES.has(m[1])) return { error: 'photo must be a jpeg/png/webp data URL' };
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch { return { error: 'photo is not valid base64' }; }
    if (!buf.length) return { error: 'photo is empty' };
    if (buf.length > PHOTO_MAX_BYTES) return { error: 'photo too large (8MB max after decode)' };
    return { buf, contentType: m[1] };
}

function haversineM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

// countDocuments truth per spot (the unique {spotId,userId} index means the
// count can never be inflated by re-confirming).
async function recreationCounts(ids) {
    if (!ids.length) return {};
    const rows = await ShotRecreation.aggregate([
        { $match: { spotId: { $in: ids } } },
        { $group: { _id: '$spotId', n: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(r => [String(r._id), r.n]));
}

const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Whitelist-shape the writable fields (never trust req.body wholesale).
function shapeFields(b) {
    const out = {};
    if (b.title !== undefined)   out.title   = str(b.title, 120);
    if (b.city !== undefined)    out.city    = str(b.city, 80);
    if (b.country !== undefined) out.country = str(b.country, 80);
    if (b.camera && typeof b.camera === 'object') {
        out.camera = {
            lat: num(b.camera.lat, -90, 90), lng: num(b.camera.lng, -180, 180),
            accuracyMeters: num(b.camera.accuracyMeters, 0, 100000),
            heading: num(b.camera.heading, 0, 360),
            pitch: num(b.camera.pitch, -90, 90),
            orientation: b.camera.orientation === 'landscape' ? 'landscape' : 'portrait',
        };
    }
    if (b.subject && typeof b.subject === 'object') {
        out.subject = { name: str(b.subject.name, 120), lat: num(b.subject.lat, -90, 90), lng: num(b.subject.lng, -180, 180) };
    }
    if (b.access && typeof b.access === 'object') {
        out.access = {
            nearestPlace: str(b.access.nearestPlace, 160),
            point: { lat: num(b.access?.point?.lat, -90, 90), lng: num(b.access?.point?.lng, -180, 180) },
            instructions: str(b.access.instructions, 600),
            walkMinutes: num(b.access.walkMinutes, 0, 600),
        };
    }
    if (b.shooting && typeof b.shooting === 'object') {
        const bt = ['sunrise', 'morning', 'midday', 'afternoon', 'sunset', 'blue_hour', 'night', 'any'];
        out.shooting = {
            bestTime: bt.includes(b.shooting.bestTime) ? b.shooting.bestTime : 'any',
            season: str(b.shooting.season, 120),
            notes: str(b.shooting.notes, 600),
        };
    }
    if (b.status === 'draft' || b.status === 'active') out.status = b.status;
    return out;
}

// Public JSON shape (adds photoUrl; camera/access pass through — the traveler
// UI needs every recorded sensor value to guide honestly).
function pub(doc, counts = {}) {
    const d = doc.toObject ? doc.toObject() : doc;
    const hasPhoto = d.hasPhoto === true || (d.hasPhoto === undefined && !!(d.photo && d.photo.capturedAt));
    return {
        id: String(d._id),
        title: d.title, status: d.status, city: d.city, country: d.country,
        camera: d.camera, subject: d.subject, access: d.access, shooting: d.shooting,
        recreationCount: counts[String(d._id)] || 0,
        aiFound: d.aiFound === true,
        evidence: d.evidence || [],
        photo: {
            // hasPhoto shim: docs older than the field carry capturedAt iff a
            // photo was uploaded. Scout drafts (desk-pinned, no photo yet)
            // report url:null so UIs show a pin placeholder, never a 404 img.
            hasPhoto,
            url: hasPhoto ? `/api/shotspots/${d._id}/photo` : null,
            width: d.photo?.width || null, height: d.photo?.height || null,
            capturedAt: d.photo?.capturedAt || null, source: d.photo?.source || 'jinni_staff',
        },
        updatedAt: d.updatedAt,
    };
}

// ── Traveler side ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const q = { status: 'active' };
        const city = str(req.query.city, 80);
        if (city) q.city = new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const spots = await ShotSpot.find(q).sort({ city: 1, createdAt: -1 }).limit(200).lean();
        const counts = await recreationCounts(spots.map(s => s._id));
        res.json({ spots: spots.map(s => pub(s, counts)) });
    } catch (err) {
        console.error('[shotspots] list error:', err);
        res.status(500).json({ error: 'Failed to load shot spots' });
    }
});

router.get('/:id([0-9a-fA-F]{24})', async (req, res) => {
    try {
        const spot = await ShotSpot.findOne({ _id: req.params.id, status: 'active' }).lean();
        if (!spot) return res.status(404).json({ error: 'Not found' });
        const counts = await recreationCounts([spot._id]);
        res.json({ spot: pub(spot, counts) });
    } catch (err) {
        console.error('[shotspots] detail error:', err);
        res.status(500).json({ error: 'Failed to load shot spot' });
    }
});

router.get('/:id([0-9a-fA-F]{24})/photo', async (req, res) => {
    try {
        const spot = await ShotSpot.findById(req.params.id).select('+photo.data photo status updatedAt').lean();
        if (!spot || !spot.photo?.data) return res.status(404).end();
        // Drafts are visible only through the staff page, which reads bytes
        // here too — harmless: a draft's photo leaks nothing sensitive and
        // ids are unguessable. Keeps the endpoint auth-free and CDN-cacheable.
        const etag = `"shot-${spot._id}-${new Date(spot.updatedAt).getTime()}"`;
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        res.set({
            'Content-Type': spot.photo.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=604800',
            'ETag': etag,
        });
        res.send(spot.photo.data.buffer ? Buffer.from(spot.photo.data.buffer) : spot.photo.data);
    } catch (err) {
        console.error('[shotspots] photo error:', err);
        res.status(500).end();
    }
});

// ── Staff side ──────────────────────────────────────────────────────────────
router.get('/staff/list', auth, staffOrAdmin, async (req, res) => {
    try {
        const spots = await ShotSpot.find({}).sort({ createdAt: -1 }).limit(500).lean();
        const counts = await recreationCounts(spots.map(s => s._id));
        res.json({ spots: spots.map(s => pub(s, counts)) });
    } catch (err) {
        console.error('[shotspots] staff list error:', err);
        res.status(500).json({ error: 'Failed to load shot spots' });
    }
});

router.post('/staff', auth, staffOrAdmin, async (req, res) => {
    try {
        const f = shapeFields(req.body);
        if (!f.title) return res.status(400).json({ error: 'title required' });
        if (!f.city) return res.status(400).json({ error: 'city required' });
        if (!f.camera || f.camera.lat === null || f.camera.lng === null) {
            return res.status(400).json({ error: 'camera lat/lng required (capture on site)' });
        }
        // Photo optional at create (scout drafts: staff pins coordinates from
        // the desk, shoots later) — but a photo-less spot is FORCED to draft;
        // only real photos publish. The camera point still comes from a human
        // decision either way (sensors on site, or a deliberate desk pin).
        let photo = null;
        if (req.body.photoData !== undefined) {
            const ph = decodePhoto(req.body.photoData);
            if (ph.error) return res.status(400).json({ error: ph.error });
            photo = {
                data: ph.buf, contentType: ph.contentType,
                width: num(req.body.photoWidth, 1, 20000), height: num(req.body.photoHeight, 1, 20000),
                capturedAt: new Date(), source: 'jinni_staff',
            };
        }
        const spot = await ShotSpot.create({
            ...f,
            status: photo ? (f.status || 'draft') : 'draft',
            hasPhoto: !!photo,
            ...(photo ? { photo } : {}),
            createdBy: req.user.id, createdByName: req.user.name || '',
        });
        res.status(201).json({ spot: pub(spot) });
    } catch (err) {
        console.error('[shotspots] create error:', err);
        res.status(500).json({ error: 'Failed to create shot spot' });
    }
});

router.patch('/staff/:id([0-9a-fA-F]{24})', auth, staffOrAdmin, async (req, res) => {
    try {
        // +photo.data: without it a photo replacement would save a doc whose
        // bytes were never loaded, and the publish guard below couldn't tell
        // a scout draft from a real spot.
        const spot = await ShotSpot.findById(req.params.id).select('+photo.data');
        if (!spot) return res.status(404).json({ error: 'Not found' });
        const f = shapeFields(req.body);
        // Never let a partial edit blank out required capture coords.
        if (f.camera && (f.camera.lat === null || f.camera.lng === null)) delete f.camera;
        Object.assign(spot, f);
        if (req.body.photoData) {
            const ph = decodePhoto(req.body.photoData);
            if (ph.error) return res.status(400).json({ error: ph.error });
            // Explicit object, not {...spot.photo}: spreading a Mongoose
            // subdocument leaks internals (same trap staffRoutes documents).
            spot.photo = {
                data: ph.buf, contentType: ph.contentType,
                width: num(req.body.photoWidth, 1, 20000), height: num(req.body.photoHeight, 1, 20000),
                capturedAt: new Date(), source: 'jinni_staff',
            };
        }
        spot.hasPhoto = !!(spot.photo && spot.photo.data && spot.photo.data.length);
        if (spot.status === 'active' && !spot.hasPhoto) {
            return res.status(400).json({ error: 'A spot needs a real photo before publishing' });
        }
        await spot.save();
        res.json({ spot: pub(spot) });
    } catch (err) {
        console.error('[shotspots] update error:', err);
        res.status(500).json({ error: 'Failed to update shot spot' });
    }
});

router.delete('/staff/:id([0-9a-fA-F]{24})', auth, staffOrAdmin, async (req, res) => {
    try {
        const gone = await ShotSpot.findByIdAndDelete(req.params.id);
        if (!gone) return res.status(404).json({ error: 'Not found' });
        await ShotRecreation.deleteMany({ spotId: gone._id });
        res.json({ ok: true });
    } catch (err) {
        console.error('[shotspots] delete error:', err);
        res.status(500).json({ error: 'Failed to delete shot spot' });
    }
});

// ── Stage 2: "I got the shot 📸" ────────────────────────────────────────────
// Any logged-in traveler; presence is verified SERVER-side against the spot's
// camera point (the client's arrival gate is a convenience, not a proof).
// Photos are staff-eyes-only until promoted — the public sees only the count.
router.post('/:id([0-9a-fA-F]{24})/recreations', auth, async (req, res) => {
    try {
        const uid = req.user?.id || req.user?._id;
        if (!uid) return res.status(401).json({ error: 'Unauthenticated' });
        const spot = await ShotSpot.findOne({ _id: req.params.id, status: 'active' }).lean();
        if (!spot) return res.status(404).json({ error: 'Not found' });
        const lat = num(req.body.lat, -90, 90), lng = num(req.body.lng, -180, 180);
        if (lat === null || lng === null) return res.status(400).json({ error: 'Your location is required' });
        const dist = haversineM({ lat, lng }, spot.camera);
        // 200m: generous for urban-canyon GPS, far too strict for a couch.
        if (dist > 200) return res.status(403).json({ error: 'too_far' });
        const doc = {
            spotId: spot._id, userId: uid, lat, lng,
            accuracyMeters: num(req.body.accuracyMeters, 0, 100000),
            heading: num(req.body.heading, 0, 360),
            pitch: num(req.body.pitch, -90, 90),
            distanceM: Math.round(dist),
        };
        if (req.body.photoData) {
            const ph = decodePhoto(req.body.photoData);
            if (ph.error) return res.status(400).json({ error: ph.error });
            doc.photo = {
                data: ph.buf, contentType: ph.contentType,
                width: num(req.body.photoWidth, 1, 20000), height: num(req.body.photoHeight, 1, 20000),
            };
            doc.hasPhoto = true;
        }
        await ShotRecreation.findOneAndUpdate(
            { spotId: spot._id, userId: uid }, { $set: doc }, { upsert: true }
        );
        const count = await ShotRecreation.countDocuments({ spotId: spot._id });
        res.json({ ok: true, count });
    } catch (err) {
        if (err && err.code === 11000) { // upsert race — the row exists, count is truth
            const count = await ShotRecreation.countDocuments({ spotId: req.params.id }).catch(() => null);
            return res.json({ ok: true, count });
        }
        console.error('[shotspots] recreation error:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// Staff moderation: list a spot's recreations, view one photo, promote one to
// hero (the "trusted contributor with GPS" tier — photo only; the staff
// camera point and instructions stay authoritative), or delete one.
router.get('/staff/:id([0-9a-fA-F]{24})/recreations', auth, staffOrAdmin, async (req, res) => {
    try {
        const recs = await ShotRecreation.find({ spotId: req.params.id })
            .sort({ createdAt: -1 }).limit(200).lean();
        res.json({ recreations: recs.map(r => ({
            id: String(r._id), createdAt: r.createdAt, distanceM: r.distanceM,
            accuracyMeters: r.accuracyMeters, heading: r.heading,
            hasPhoto: r.hasPhoto === true, promotedAt: r.promotedAt || null,
        })) });
    } catch (err) {
        console.error('[shotspots] recreations list error:', err);
        res.status(500).json({ error: 'Failed to load recreations' });
    }
});

router.get('/staff/recreations/:rid([0-9a-fA-F]{24})/photo', auth, staffOrAdmin, async (req, res) => {
    try {
        const rec = await ShotRecreation.findById(req.params.rid).select('+photo.data').lean();
        if (!rec || !rec.photo?.data) return res.status(404).end();
        res.set({ 'Content-Type': rec.photo.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        res.send(rec.photo.data.buffer ? Buffer.from(rec.photo.data.buffer) : rec.photo.data);
    } catch (err) { res.status(500).end(); }
});

router.post('/staff/recreations/:rid([0-9a-fA-F]{24})/promote', auth, staffOrAdmin, async (req, res) => {
    try {
        const rec = await ShotRecreation.findById(req.params.rid).select('+photo.data');
        if (!rec) return res.status(404).json({ error: 'Not found' });
        if (!rec.hasPhoto || !rec.photo?.data?.length) return res.status(400).json({ error: 'This recreation has no photo' });
        const spot = await ShotSpot.findById(rec.spotId);
        if (!spot) return res.status(404).json({ error: 'Spot not found' });
        spot.photo = {
            data: rec.photo.data, contentType: rec.photo.contentType,
            width: rec.photo.width, height: rec.photo.height,
            capturedAt: rec.createdAt, source: 'traveler',
        };
        spot.hasPhoto = true;
        rec.promotedAt = new Date();
        await spot.save(); await rec.save();
        res.json({ ok: true, spot: pub(spot) });
    } catch (err) {
        console.error('[shotspots] promote error:', err);
        res.status(500).json({ error: 'Failed to promote' });
    }
});

router.delete('/staff/recreations/:rid([0-9a-fA-F]{24})', auth, staffOrAdmin, async (req, res) => {
    try {
        const gone = await ShotRecreation.findByIdAndDelete(req.params.rid);
        if (!gone) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});

// ── Stage 3: leads miner (staff-only, EPHEMERAL) ────────────────────────────
// Founder rule (2026-09-06, after the Wikimedia rejection): mined data is
// EVIDENCE for staff scouting, NEVER the face. Nothing here is persisted or
// shown to travelers, and no third-party imagery is fetched — only
// coordinates and counts. A dense cluster of geotagged Commons FILE pages
// means "many photographers stood here": a proven vantage worth scouting.
const MINE_UA = 'JinniAI-ShotSpots-Leads/1.0 (staff scouting tool)';
async function mineLeads(lat, lng, radiusM) {
    // Honest failure per source: 'unavailable' is reported, never faked as
    // "no results" (the seeder's throttling lesson, 2026-09-05).
    const out = { viewpoints: [], clusters: [], sources: { osm: 'unavailable', commons: 'unavailable' } };

    try { // OSM viewpoints — where mappers say there is a view
        const q = `[out:json][timeout:25];node["tourism"="viewpoint"](around:${Math.round(radiusM)},${lat},${lng});out body 80;`;
        const r = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST', headers: { 'User-Agent': MINE_UA, 'Content-Type': 'text/plain' }, body: q,
        });
        if (r.ok) {
            const d = await r.json();
            out.viewpoints = (d.elements || []).filter(e => e.lat && e.lon).map(e => ({
                name: (e.tags && (e.tags.name || e.tags['name:en'])) || 'Unnamed viewpoint',
                lat: e.lat, lng: e.lon,
                distanceM: Math.round(haversineM({ lat, lng }, { lat: e.lat, lng: e.lon })),
            })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 40);
            out.sources.osm = 'ok';
        }
    } catch (e) { /* 'unavailable' stands */ }

    try { // Commons geotagged File pages = (usually) camera positions
        const url = 'https://commons.wikimedia.org/w/api.php?action=query&list=geosearch&gsnamespace=6'
            + `&gslimit=500&gsradius=${Math.round(radiusM)}&gscoord=${lat}%7C${lng}&format=json`;
        const r = await fetch(url, { headers: { 'User-Agent': MINE_UA } });
        if (r.ok) {
            const d = await r.json();
            const files = ((d.query && d.query.geosearch) || []).filter(f => f.lat && f.lon);
            const cells = new Map(); // ~70m grid cells
            for (const f of files) {
                const key = `${Math.round(f.lat / 0.00063)}:${Math.round(f.lon / 0.0009)}`;
                let c = cells.get(key);
                if (!c) { c = { lat: 0, lng: 0, n: 0, titles: [] }; cells.set(key, c); }
                c.lat += f.lat; c.lng += f.lon; c.n += 1;
                if (c.titles.length < 3) c.titles.push(String(f.title || '').replace(/^File:/, ''));
            }
            out.clusters = [...cells.values()].filter(c => c.n >= 3)
                .map(c => ({ lat: +(c.lat / c.n).toFixed(6), lng: +(c.lng / c.n).toFixed(6), photographers: c.n, sampleTitles: c.titles }))
                .map(c => ({ ...c, distanceM: Math.round(haversineM({ lat, lng }, c)) }))
                .sort((a, b) => b.photographers - a.photographers).slice(0, 15);
            out.sources.commons = 'ok';
        }
    } catch (e) { /* 'unavailable' stands */ }
    return out;
}

router.get('/staff/mine', auth, staffOrAdmin, async (req, res) => {
    const lat = num(req.query.lat, -90, 90), lng = num(req.query.lng, -180, 180);
    if (lat === null || lng === null) return res.status(400).json({ error: 'lat/lng required' });
    const radiusM = Math.min((num(req.query.radiusKm, 0.2, 15) || 3) * 1000, 10000);
    res.json(await mineLeads(lat, lng, radiusM));
});

// ── "Let Jinni hunt" — the AI finds candidates ITSELF; staff only verify ────
// (founder 2026-09-06: "if ai could find by himself then staff verify that is
// another thing"). Jinni turns the strongest evidence into draft ShotSpots
// (aiFound:true, evidence attached). They can NEVER publish themselves —
// hasPhoto stays false until a human stands there and shoots, so the face of
// the feature remains real photos while the FINDING is genuinely the AI's.
// Jinni resolves a city's center from data it ALREADY OWNS (destinations,
// then cached places) — no typed coordinates, no external geocoder. Average
// of known points is plenty for a hunt center.
async function resolveCityCenter(city) {
    const rx = new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    let pts = (await Destination.find({ 'location.city': rx })
        .select('location.coordinates').limit(300).lean())
        .map(d => d.location && d.location.coordinates)
        .filter(c => c && Number.isFinite(c.lat) && Number.isFinite(c.lng));
    if (!pts.length) {
        pts = (await PlaceCache.find({ city: rx })
            .select('details.geometry.location').limit(300).lean())
            .map(r => r.details && r.details.geometry && r.details.geometry.location)
            .filter(c => c && Number.isFinite(c.lat) && Number.isFinite(c.lng));
    }
    if (!pts.length) return null;
    return {
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
    };
}

router.post('/staff/hunt', auth, staffOrAdmin, async (req, res) => {
    try {
        let lat = num(req.body.lat, -90, 90), lng = num(req.body.lng, -180, 180);
        const city = str(req.body.city, 80);
        if (!city) return res.status(400).json({ error: 'city required (Jinni files candidates under it)' });
        if (lat === null || lng === null) {
            const center = await resolveCityCenter(city);
            if (!center) {
                return res.status(400).json({ error: `Jinni doesn't know "${city}" yet — no destinations or cached places there. Add a center coordinate for the first hunt.` });
            }
            lat = center.lat; lng = center.lng;
        }
        const radiusM = Math.min((num(req.body.radiusKm, 0.2, 15) || 5) * 1000, 10000);

        const leads = await mineLeads(lat, lng, radiusM);
        if (leads.sources.osm !== 'ok' && leads.sources.commons !== 'ok') {
            return res.status(502).json({ error: 'Evidence sources unavailable right now — try again later', sources: leads.sources });
        }

        const candidates = [
            ...leads.viewpoints.map(v => ({
                lat: v.lat, lng: v.lng,
                title: v.name === 'Unnamed viewpoint' ? 'Scenic viewpoint' : v.name,
                kind: 'osm_viewpoint',
                note: `Mapped viewpoint (OSM), ${v.distanceM}m from hunt center`,
            })),
            ...leads.clusters.map(c => ({
                lat: c.lat, lng: c.lng,
                title: `Photographers' vantage (${c.photographers} shots)`,
                kind: 'commons_cluster',
                note: `${c.photographers} geotagged photos cluster here. Samples: ${c.sampleTitles.join(' · ')}`,
            })),
        ];

        // Dedupe: never re-suggest a point a spot (any status) already covers,
        // and don't create twins within one hunt. 80m ≈ same vantage.
        const existing = await ShotSpot.find({}).select('camera.lat camera.lng').lean();
        const taken = existing.map(s => s.camera).filter(c => c && c.lat != null);
        const created = [];
        for (const c of candidates) {
            if (created.length >= 15) break; // one hunt = a reviewable batch
            const clash = [...taken, ...created].some(p => haversineM(p, c) < 80);
            if (clash) continue;
            const spot = await ShotSpot.create({
                title: c.title.slice(0, 120), city, country: str(req.body.country, 80),
                status: 'draft', aiFound: true, hasPhoto: false,
                camera: { lat: c.lat, lng: c.lng, accuracyMeters: null, heading: null, pitch: null, orientation: 'portrait' },
                access: { nearestPlace: '', point: { lat: null, lng: null }, instructions: '', walkMinutes: null },
                shooting: { bestTime: 'any', season: '', notes: '' },
                evidence: [{ kind: c.kind, note: c.note.slice(0, 500) }],
                createdBy: req.user.id, createdByName: 'Jinni (auto-hunt)',
            });
            created.push({ lat: c.lat, lng: c.lng, id: spot._id });
        }
        res.json({ created: created.length, considered: candidates.length, sources: leads.sources });
    } catch (err) {
        console.error('[shotspots] hunt error:', err);
        res.status(500).json({ error: 'Hunt failed' });
    }
});

module.exports = router;

// test hooks (never used by server code)
module.exports.__testables = { decodePhoto, shapeFields, haversineM };
