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
                ? { validateBusinesses: true, manageDestinations: true }
                : (u.staffAssignment?.permissions || { validateBusinesses: true, manageDestinations: false })
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
        const { page = 1, limit = 20, search = '', filter = '', mine = '' } = req.query;
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
        const populated = await Destination.findById(dest._id)
            .populate('createdBy', 'name email role')
            .lean();
        res.json({ success: true, data: populated });
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

        const updated = await Destination.findByIdAndUpdate(
            req.params.id, { $set: updates }, { new: true, runValidators: true }
        ).populate('createdBy', 'name email role');
        res.json({ success: true, data: updated });
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