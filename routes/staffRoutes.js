// ─────────────────────────────────────────────────────────────────────────────
//  staffRoutes.js — staff-scoped API
// ─────────────────────────────────────────────────────────────────────────────
//
//  Mounted at /api/staff in server.js:
//    app.use('/api/staff', require('./routes/staffRoutes'));
//
//  Why a separate router from adminRoutes:
//    adminRoutes uses `router.use(auth, admin)` which rejects anyone whose
//    role isn't 'admin'. Staff users need their own gateway: authenticated,
//    role === 'staff' or 'admin', and gated by per-action permissions in
//    `user.staffAssignment.permissions`.
//
//  Scope:
//    /me                         — read own profile (permissions, scope)
//    /destinations  CRUD         — staff who has manageDestinations=true can
//                                  add / edit / toggle / delete destinations
//                                  inside their assigned countries / cities.
//
//  Business validation is NOT here — it already lives in businessRoutes.js,
//  which has its own `isStaffOrAdmin` helper and scope filter. We only add
//  the destination half of the staff capability here.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Destination = require('../models/Destination');
const PlaceCache = require('../models/PlaceCache');
const auth = require('../middleware/auth');

// ── Auth gate ───────────────────────────────────────────────────────────────
// Allows admin (full access) or active staff. Always hydrates the user via
// .lean() — req.user from the upstream auth middleware can be a Mongoose
// document, and spreading those leaks internal fields ($__, _doc, $isNew)
// instead of the actual data. Costs one extra query per request; cheap, and
// guarantees a plain-object shape every handler downstream can rely on.
async function staffOrAdmin(req, res, next) {
    try {
        // Accept either { id } or { _id } from the upstream auth middleware.
        // Mongoose documents expose `.id` as a virtual; raw JWT payloads use
        // either, depending on how the token was signed.
        const uid = req.user?.id || req.user?._id;
        if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

        const u = await User.findById(uid)
            .select('role isActive isAdmin staffAssignment name email')
            .lean();

        if (!u) return res.status(401).json({ error: 'Unauthenticated' });
        if (u.isActive === false) return res.status(403).json({ error: 'Account is revoked' });

        const isAdmin = u.role === 'admin' || u.isAdmin === true;
        const isStaff = u.role === 'staff';
        if (!isAdmin && !isStaff) return res.status(403).json({ error: 'Staff or admin only' });

        // Replace req.user with the lean doc. Adding `id` as a string for
        // any downstream code that expects it (the Mongoose virtual is gone
        // once we go .lean()).
        req.user = { ...u, id: String(u._id), isAdmin };
        next();
    } catch (err) {
        console.error('[staffOrAdmin] error:', err);
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// Permission gate factory. Admin always passes; staff needs the named flag.
function requirePermission(flag) {
    return function (req, res, next) {
        if (req.user?.isAdmin) return next();
        const p = req.user?.staffAssignment?.permissions || {};
        if (p[flag] === true) return next();
        return res.status(403).json({
            error: `You do not have permission to ${flag.replace(/([A-Z])/g, ' $1').toLowerCase()}`
        });
    };
}

// All routes require auth + staffOrAdmin
router.use(auth, staffOrAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/staff/me
// Returns the calling user's role, scope and permissions. The staff frontend
// uses this to decide which tabs to render (Validation / Destinations).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
    const u = req.user;
    res.json({
        success: true,
        user: {
            _id: u._id || u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            isAdmin: u.isAdmin === true,
            staffAssignment: u.staffAssignment || null,
            // Convenience: flatten permissions so the frontend doesn't have to
            // know about the nested location. Admin always gets both true.
            permissions: u.isAdmin
                ? { validateBusinesses: true, manageDestinations: true, moderateExplore: true }
                : {
                    // Spread over defaults so legacy permission docs (created
                    // before moderateExplore existed) still yield all three keys.
                    validateBusinesses: true, manageDestinations: false, moderateExplore: false,
                    ...(u.staffAssignment?.permissions ? JSON.parse(JSON.stringify(u.staffAssignment.permissions)) : {})
                  }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope helpers
// ─────────────────────────────────────────────────────────────────────────────
// Builds a Mongo filter that restricts destinations to a staff member's
// assigned countries / cities. Mirrors businessRoutes.buildStaffScopeFilter
// so the two halves of the staff job feel consistent.
//
// Returns:
//   - {}    for admin / no scope restriction
//   - null  for staff with no assignment yet (caller treats as "empty list")
//   - { $or: [...] } otherwise
function buildDestinationScopeFilter(user) {
    if (user.isAdmin) return {};
    const a = user.staffAssignment || {};
    const countries = (a.countries || []).filter(Boolean);
    const cities    = (a.cities    || []).filter(Boolean);
    if (!countries.length && !cities.length) return null;

    const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ors = [];
    if (countries.length) ors.push({ 'location.country': { $in: countries.map(c => new RegExp(`^${escape(c)}$`, 'i')) } });
    if (cities.length)    ors.push({ 'location.city':    { $in: cities.map(c    => new RegExp(`^${escape(c)}$`, 'i')) } });
    return { $or: ors };
}

// Same idea for PlaceCache — its region lives in top-level `country` / `city`
// (parsed from formatted_address). Same return contract as above.
function buildPlaceScopeFilter(user) {
    if (user.isAdmin) return {};
    const a = user.staffAssignment || {};
    const countries = (a.countries || []).filter(Boolean);
    const cities    = (a.cities    || []).filter(Boolean);
    if (!countries.length && !cities.length) return null;

    const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ors = [];
    if (countries.length) ors.push({ country: { $in: countries.map(c => new RegExp(`^${escape(c)}$`, 'i')) } });
    if (cities.length)    ors.push({ city:    { $in: cities.map(c    => new RegExp(`^${escape(c)}$`, 'i')) } });
    return { $or: ors };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORE MODERATION — hide / verify cached places within the staff's region.
// Post-moderation queue over PlaceCache: everything is 'visible' by default;
// staff bury garbage ('hidden') or endorse good places ('verified').
// ─────────────────────────────────────────────────────────────────────────────
const EXPLORE_MOD_CATEGORIES = ['restaurants', 'hotels', 'historical', 'events', 'photo_spots', 'hidden_gems', 'shopping'];

// GET /api/staff/explore-places
// Query: page, limit, search, status ('', 'visible', 'hidden', 'verified'),
//        category (one of EXPLORE_MOD_CATEGORIES).
// Default sort is suspicion-first (most disliked → lowest rated → newest) so
// likely garbage surfaces at the top of the queue.
router.get('/explore-places', requirePermission('moderateExplore'), async (req, res) => {
    try {
        const { page = 1, limit = 24, search = '', status = '', category = '' } = req.query;
        const scope = buildPlaceScopeFilter(req.user);
        if (scope === null) {
            return res.json({ success: true, places: [], total: 0, totalPages: 0, noScope: true, counts: { visible: 0, hidden: 0, verified: 0 } });
        }

        const and = [{ actions: { $in: EXPLORE_MOD_CATEGORIES } }];
        if (scope.$or) and.push(scope);
        if (search) {
            and.push({ $or: [
                { name: { $regex: search, $options: 'i' } },
                { 'details.formatted_address': { $regex: search, $options: 'i' } }
            ] });
        }
        if (category && EXPLORE_MOD_CATEGORIES.includes(category)) and.push({ actions: category });
        if (status === 'hidden' || status === 'verified') and.push({ 'explore.status': status });
        else if (status === 'visible') and.push({ 'explore.status': { $nin: ['hidden', 'verified'] } });

        const query = { $and: and };
        const lim = Math.min(parseInt(limit) || 24, 100);
        const skip = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
        // Scope-wide status counts (ignores search/category/status filters) for the tab chips.
        const countBase = [{ actions: { $in: EXPLORE_MOD_CATEGORIES } }, ...(scope.$or ? [scope] : [])];

        const [places, total, hidden, verified, all] = await Promise.all([
            PlaceCache.find(query)
                .sort({ dislikes: -1, rating: 1, createdAt: -1 })
                .skip(skip).limit(lim)
                .select('placeId name rating country city details.formatted_address details.geometry imagesStored actions likes dislikes useCount fetchCount explore createdAt lastUsed website formatted_phone_number international_phone_number opening_hours.weekday_text types primaryType priceLevel eventSchedule')
                .lean(),
            PlaceCache.countDocuments(query),
            PlaceCache.countDocuments({ $and: [...countBase, { 'explore.status': 'hidden' }] }),
            PlaceCache.countDocuments({ $and: [...countBase, { 'explore.status': 'verified' }] }),
            PlaceCache.countDocuments({ $and: countBase }),
        ]);

        res.json({
            success: true,
            places,
            total,
            page: Math.max(parseInt(page) || 1, 1),
            totalPages: Math.ceil(total / lim),
            counts: { visible: all - hidden - verified, hidden, verified }
        });
    } catch (err) {
        console.error('[staff explore-places] error:', err);
        res.status(500).json({ success: false, error: 'Failed to load places' });
    }
});

// PATCH /api/staff/explore-places/:placeId/actions   Body: { actions: [...] }
// Curate which Explore categories a cached place appears under — the AI's
// original tagging is sometimes wrong (a church tagged 'events'). Same scope
// enforcement as the status route. An empty array removes the place from
// Explore entirely (no category → no rail).
router.patch('/explore-places/:placeId/actions', requirePermission('moderateExplore'), async (req, res) => {
    try {
        const actions = Array.isArray(req.body?.actions)
            ? req.body.actions.filter(a => EXPLORE_MOD_CATEGORIES.includes(a))
            : null;
        if (!actions) return res.status(400).json({ success: false, error: 'actions must be an array of valid categories' });
        const scope = buildPlaceScopeFilter(req.user);
        if (scope === null) return res.status(403).json({ success: false, error: 'No region assigned yet — ask your admin' });
        const filter = scope.$or
            ? { $and: [{ placeId: req.params.placeId }, scope] }
            : { placeId: req.params.placeId };
        const doc = await PlaceCache.findOneAndUpdate(filter, { $set: { actions } }, { new: true })
            .select('placeId name actions').lean();
        if (!doc) return res.status(404).json({ success: false, error: 'Place not found in your region' });
        res.json({ success: true, place: doc, message: `"${doc.name}" categories updated` });
    } catch (err) {
        console.error('[staff explore-actions] error:', err);
        res.status(500).json({ success: false, error: 'Failed to update categories' });
    }
});

// PATCH /api/staff/explore-places/:placeId/status   Body: { status }
// The scope filter is part of the update query, so staff can only touch
// places inside their assigned region — out-of-scope placeIds read as 404.
router.patch('/explore-places/:placeId/status', requirePermission('moderateExplore'), async (req, res) => {
    try {
        const { status } = req.body || {};
        if (!['visible', 'hidden', 'verified'].includes(status)) {
            return res.status(400).json({ success: false, error: 'status must be visible | hidden | verified' });
        }
        const scope = buildPlaceScopeFilter(req.user);
        if (scope === null) return res.status(403).json({ success: false, error: 'No region assigned yet — ask your admin' });

        const filter = scope.$or
            ? { $and: [{ placeId: req.params.placeId }, scope] }
            : { placeId: req.params.placeId };
        const doc = await PlaceCache.findOneAndUpdate(
            filter,
            { $set: { 'explore.status': status, 'explore.reviewedBy': req.user._id || req.user.id || null, 'explore.reviewedAt': new Date() } },
            { new: true }
        ).select('placeId name explore').lean();
        if (!doc) return res.status(404).json({ success: false, error: 'Place not found in your region' });
        res.json({ success: true, place: doc, message: `"${doc.name}" → ${status}` });
    } catch (err) {
        console.error('[staff explore-status] error:', err);
        res.status(500).json({ success: false, error: 'Failed to update place status' });
    }
});

// Checks whether a single destination's location falls inside the user's scope.
// Used on create/update to refuse out-of-scope writes. Returns true for admin.
function isWithinScope(user, location) {
    if (user.isAdmin) return true;
    const a = user.staffAssignment || {};
    const countries = (a.countries || []).map(s => s.toLowerCase());
    const cities    = (a.cities    || []).map(s => s.toLowerCase());
    if (!countries.length && !cities.length) return false;
    const c = (location?.country || '').toLowerCase();
    const ct = (location?.city || '').toLowerCase();
    if (countries.length && c && countries.includes(c)) return true;
    if (cities.length    && ct && cities.includes(ct)) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// DESTINATIONS — staff-scoped CRUD
// All routes below require manageDestinations permission.
// ─────────────────────────────────────────────────────────────────────────────
const destGate = requirePermission('manageDestinations');

const ALLOWED_FIELDS = [
    'name', 'type', 'location', 'contact', 'description', 'images',
    'openingHours', 'pricing', 'bestTimeToVisit',
    'nearbyBusinesses', 'popularity', 'isHiddenGem', 'isActive'
];

// ── GET /api/staff/destinations ─────────────────────────────────────────────
// Lists destinations within the staff member's scope. Supports the same
// search / filter / pagination params as the admin route so the frontend can
// reuse query-building code.
//
// `mine=true` further restricts to destinations the staff member created.
router.get('/destinations', destGate, async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '', filter = '', mine = '', types = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const scope = buildDestinationScopeFilter(req.user);
        if (scope === null) {
            // Staff with no territory — return an empty page with a flag so
            // the UI can show the same "ask admin to assign you" banner the
            // validation page uses.
            return res.json({
                success: true,
                noScope: true,
                data: { destinations: [], total: 0, page: 1, totalPages: 0, summary: {} }
            });
        }

        const query = { ...scope };
        if (search) query.name = { $regex: search, $options: 'i' };
        if (filter === 'active')     query.isActive = true;
        if (filter === 'inactive')   query.isActive = false;
        if (filter === 'hidden_gem') query.isHiddenGem = true;
        if (mine === 'true' && !req.user.isAdmin) query.createdBy = req.user.id;
        // Type/preference filter — comma-separated tags from the `type` array
        // (category like 'restaurants' and/or preference like 'romantic');
        // $all so combining both narrows the list.
        const typeTags = String(types).split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
        if (typeTags.length) query.type = { $all: typeTags };

        const [destinations, total, summaryAgg] = await Promise.all([
            Destination.find(query)
                .populate('createdBy', 'name email role')
                .sort({ createdAt: -1 })
                .skip(skip).limit(parseInt(limit))
                .lean(),
            Destination.countDocuments(query),
            Destination.aggregate([
                { $match: query.$or ? { $or: query.$or } : {} },
                { $group: {
                    _id: null,
                    total:        { $sum: 1 },
                    active:       { $sum: { $cond: ['$isActive', 1, 0] } },
                    hiddenGems:   { $sum: { $cond: ['$isHiddenGem', 1, 0] } },
                    totalViews:   { $sum: '$analytics.views' },
                    totalClicks:  { $sum: '$analytics.clicks' }
                }}
            ])
        ]);

        res.json({
            success: true,
            data: {
                destinations,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                summary: summaryAgg[0] || { total: 0, active: 0, hiddenGems: 0, totalViews: 0, totalClicks: 0 }
            }
        });
    } catch (err) {
        console.error('[staff destinations list] error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch destinations' });
    }
});

// ── POST /api/staff/destinations ────────────────────────────────────────────
// Creates a destination. Location must fall inside the staff's scope; admin
// has no such restriction. `createdBy` is stamped server-side.
// ── Destination images: mirror + auto-fetch ─────────────────────────────────
// Option A — validator-provided URLs are downloaded at save time and their
// BYTES stored under a synthetic PlaceCache entry (placeId `dest_<id>`), then
// dest.images points at our own proxy (/api/ai/place-image/dest_<id>/<i>).
// The external host can die later without anyone noticing — and a URL that is
// broken TODAY fails right here, where the validator can see it.
// Option B — no URLs given → look the place up on Google by name + address
// and store ITS photos the same way. URLs always take precedence, so a wrong
// Google match can be corrected by simply pasting the right URLs.
const EXTERNAL_URL = (u) => /^https?:\/\//i.test(u) && !u.includes('/api/ai/place-image/');
const hasRealImages = (arr) => Array.isArray(arr) && arr.some(u => String(u || '').trim());

async function storeDestinationUrlImages(destId, urls) {
    const axios = require('axios');
    const clean = (urls || []).map(u => String(u || '').trim()).filter(EXTERNAL_URL).slice(0, 8);
    if (!clean.length) return { stored: 0, failed: [] };
    const failed = [];
    const photos = [];
    for (const u of clean) {
        try {
            const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 12000, maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0 (Jinni image mirror)' } });
            const ct = r.headers['content-type'] || '';
            if (!ct.startsWith('image/')) { failed.push(u); continue; }
            photos.push({ photoReference: u, imageData: Buffer.from(r.data), contentType: ct, storedAt: new Date() });
        } catch (e) { failed.push(u); }
    }
    if (photos.length) {
        const key = `dest_${destId}`;
        await PlaceCache.findOneAndUpdate({ placeId: key }, { $set: { name: `dest:${destId}`, photos, imagesStored: true } }, { upsert: true });
        await Destination.findByIdAndUpdate(destId, { $set: { images: photos.map((_, i) => `/api/ai/place-image/${key}/${i}`) } });
    }
    if (failed.length) console.warn(`[dest-images] ${failed.length} URL(s) failed to mirror for ${destId}:`, failed.map(f => f.slice(0, 60)));
    return { stored: photos.length, failed };
}

async function autoFetchDestinationImages(destId, src) {
    try {
        const googleService = require('../services/googleService');
        const imageStorageService = require('../services/imageStorageService');
        const q = [src.name, src.location?.address, src.location?.city, src.location?.country].filter(Boolean).join(', ');
        const c = src.location?.coordinates;
        const coords = (c && Number.isFinite(+c.lat) && Number.isFinite(+c.lng) && +c.lat !== 0) ? { lat: +c.lat, lng: +c.lng } : null;
        const places = await googleService.findPlaces(q, coords);
        if (!places || !places.length) { console.log(`[dest-images] Google found nothing for "${q}"`); return 0; }
        const placeId = places[0].place_id;
        const details = await googleService.getPlaceDetails(placeId, false);
        if (!details || !details.photos || !details.photos.length) { console.log(`[dest-images] no Google photos for "${src.name}"`); return 0; }
        const stored = await imageStorageService.downloadAndStoreImages(placeId, details.photos, 8);
        const ok = Array.isArray(stored) ? stored.filter(p => p && p.imageData).length : 0;
        if (!ok) return 0;
        await Destination.findByIdAndUpdate(destId, { $set: { images: Array.from({ length: ok }, (_, i) => `/api/ai/place-image/${placeId}/${i}`) } });
        console.log(`[dest-images] "${src.name}" → ${ok} Google photos stored (${placeId})`);
        return ok;
    } catch (e) {
        console.warn('[dest-images] auto-fetch failed:', e.message);
        return 0;
    }
}

router.post('/destinations', destGate, async (req, res) => {
    try {
        const payload = {};
        ALLOWED_FIELDS.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

        if (!payload.name || !String(payload.name).trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        if (!Array.isArray(payload.type) || !payload.type.length) {
            return res.status(400).json({ success: false, error: 'At least one type is required' });
        }
        if (!isWithinScope(req.user, payload.location)) {
            return res.status(403).json({
                success: false,
                error: 'This destination is outside your assigned countries / cities'
            });
        }

        payload.createdBy = req.user.id;
        const dest = await Destination.create(payload);
        // Provided URLs → mirror their bytes now (Option A). None provided
        // (or none mirrored successfully) → fetch from Google by name+address.
        let imageReport = null;
        if (hasRealImages(payload.images)) { imageReport = await storeDestinationUrlImages(dest._id, payload.images); }
        if (!imageReport || !imageReport.stored) { await autoFetchDestinationImages(dest._id, payload); }
        const populated = await Destination.findById(dest._id)
            .populate('createdBy', 'name email role')
            .lean();
        res.json({ success: true, data: populated, imageReport });
    } catch (err) {
        console.error('[staff destination create] error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to create destination' });
    }
});

// ── PATCH /api/staff/destinations/:id ───────────────────────────────────────
// Staff can edit a destination they created. Admin can edit any. The new
// location (if changed) must remain in scope for staff.
router.patch('/destinations/:id', destGate, async (req, res) => {
    try {
        const dest = await Destination.findById(req.params.id);
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });

        // Authorship check (skipped for admin).
        if (!req.user.isAdmin) {
            const owner = dest.createdBy?.toString();
            if (owner !== req.user.id) {
                return res.status(403).json({ success: false, error: 'You can only edit destinations you created' });
            }
        }

        const updates = {};
        ALLOWED_FIELDS.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

        // Validate location-in-scope when location is being changed.
        if (updates.location && !isWithinScope(req.user, updates.location)) {
            return res.status(403).json({
                success: false,
                error: 'New location is outside your assigned countries / cities'
            });
        }

        let updated = await Destination.findByIdAndUpdate(
            req.params.id, { $set: updates }, { new: true, runValidators: true }
        ).populate('createdBy', 'name email role');
        // New external URLs → mirror their bytes (Option A). Images cleared /
        // still empty → refill from Google by name + address.
        let imageReport = null;
        if (updated && Array.isArray(updated.images) && updated.images.some(u => EXTERNAL_URL(String(u || '')))) {
            imageReport = await storeDestinationUrlImages(updated._id, updated.images);
            if (imageReport.stored) updated = await Destination.findById(updated._id).populate('createdBy', 'name email role');
        }
        if (updated && !hasRealImages(updated.images)) {
            const n = await autoFetchDestinationImages(updated._id, updated);
            if (n) updated = await Destination.findById(updated._id).populate('createdBy', 'name email role');
        }
        res.json({ success: true, data: updated, imageReport });
    } catch (err) {
        console.error('[staff destination update] error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to update destination' });
    }
});

// ── PATCH /api/staff/destinations/:id/toggle ────────────────────────────────
// Same authorship rule as edit.
router.patch('/destinations/:id/toggle', destGate, async (req, res) => {
    try {
        const dest = await Destination.findById(req.params.id);
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });
        if (!req.user.isAdmin && dest.createdBy?.toString() !== req.user.id) {
            return res.status(403).json({ success: false, error: 'You can only toggle destinations you created' });
        }
        dest.isActive = !dest.isActive;
        await dest.save();
        res.json({ success: true, data: { isActive: dest.isActive } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to toggle destination' });
    }
});

// ── DELETE /api/staff/destinations/:id ──────────────────────────────────────
// Same authorship rule.
router.delete('/destinations/:id', destGate, async (req, res) => {
    try {
        const dest = await Destination.findById(req.params.id);
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });
        if (!req.user.isAdmin && dest.createdBy?.toString() !== req.user.id) {
            return res.status(403).json({ success: false, error: 'You can only delete destinations you created' });
        }
        await Destination.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: `Destination "${dest.name}" deleted` });
    } catch (err) {
        console.error('[staff destination delete] error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete destination' });
    }
});

module.exports = router;