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
function pub(doc) {
    const d = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(d._id),
        title: d.title, status: d.status, city: d.city, country: d.country,
        camera: d.camera, subject: d.subject, access: d.access, shooting: d.shooting,
        photo: {
            url: `/api/shotspots/${d._id}/photo`,
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
        res.json({ spots: spots.map(pub) });
    } catch (err) {
        console.error('[shotspots] list error:', err);
        res.status(500).json({ error: 'Failed to load shot spots' });
    }
});

router.get('/:id([0-9a-fA-F]{24})', async (req, res) => {
    try {
        const spot = await ShotSpot.findOne({ _id: req.params.id, status: 'active' }).lean();
        if (!spot) return res.status(404).json({ error: 'Not found' });
        res.json({ spot: pub(spot) });
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
        res.json({ spots: spots.map(pub) });
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
        const ph = decodePhoto(req.body.photoData);
        if (ph.error) return res.status(400).json({ error: ph.error });
        const spot = await ShotSpot.create({
            ...f,
            status: f.status || 'draft',
            photo: {
                data: ph.buf, contentType: ph.contentType,
                width: num(req.body.photoWidth, 1, 20000), height: num(req.body.photoHeight, 1, 20000),
                capturedAt: new Date(), source: 'jinni_staff',
            },
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
        const spot = await ShotSpot.findById(req.params.id);
        if (!spot) return res.status(404).json({ error: 'Not found' });
        const f = shapeFields(req.body);
        // Never let a partial edit blank out required capture coords.
        if (f.camera && (f.camera.lat === null || f.camera.lng === null)) delete f.camera;
        Object.assign(spot, f);
        if (req.body.photoData) {
            const ph = decodePhoto(req.body.photoData);
            if (ph.error) return res.status(400).json({ error: ph.error });
            spot.photo = {
                ...spot.photo, data: ph.buf, contentType: ph.contentType,
                width: num(req.body.photoWidth, 1, 20000), height: num(req.body.photoHeight, 1, 20000),
                capturedAt: new Date(), source: 'jinni_staff',
            };
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
        res.json({ ok: true });
    } catch (err) {
        console.error('[shotspots] delete error:', err);
        res.status(500).json({ error: 'Failed to delete shot spot' });
    }
});

module.exports = router;

// test hooks (never used by server code)
module.exports.__testables = { decodePhoto, shapeFields };
