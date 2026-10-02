// routes/guideRoutes.js — mounted at /api/guides
//
// Guide pages, Phase 1 (founder 2026-10-02: "lets build it"). Same shape as the
// Business flow — apply → staff approve/reject → dashboard — with these rules:
//   • A guide applies SIGNED IN (the profile is tied to their own account).
//   • Instagram ownership = a code in their bio, checked by staff by eye.
//     Nothing here ever fetches Instagram.
//   • Picks are REAL places from Jinni's own store, chosen from search.
//   • Guides cover restaurants, hidden gems, photo spots, activities (and,
//     in Phase 2, itineraries). Hotels/flights/events are never guide picks.

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const Guide = require('../models/Guide');
const GuidePick = require('../models/GuidePick');
const svc = require('../services/guideService');

const router = express.Router();

const isStaffOrAdmin = (u) => !!u && (u.role === 'staff' || u.role === 'admin' || u.isAdmin === true);
const MAX_PICKS = 150;

const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many applications from this connection. Please try again later.' } });
const editLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip });

const ownGuide = (req) => Guide.findOne({ user: req.user._id });

// What the guide themselves sees (includes their verification code and status).
const selfView = (g) => g && ({
    ...svc.publicGuide(g),
    status: g.status,
    verificationCode: g.verification?.code || null,
    staffNotes: g.status === 'rejected' ? (g.verification?.staffNotes || '') : '',
    createdAt: g.createdAt,
});

// ── PUBLIC: handle availability + the public page ───────────────────────────

router.get('/handle-available/:handle', async (req, res) => {
    const raw = String(req.params.handle || '').trim().replace(/^@+/, '').toLowerCase();
    const handle = svc.normalizeHandle(raw);
    // A well-formed name that is one of the app's own words gets its own reason,
    // so the form can say "reserved" instead of a format rule it already meets.
    if (!handle) return res.json({ available: false, reason: /^[a-z0-9._]{3,30}$/.test(raw) && svc.RESERVED.has(raw) ? 'reserved' : 'invalid' });
    const taken = await Guide.exists({ handle });
    res.json({ available: !taken, handle });
});

router.get('/public/:handle', async (req, res) => {
    try {
        const handle = svc.normalizeHandle(req.params.handle);
        if (!handle) return res.status(404).json({ success: false, error: 'Guide not found' });
        const g = await Guide.findOne({ handle, status: 'active' }).lean();
        if (!g) return res.status(404).json({ success: false, error: 'Guide not found' });
        const picks = await GuidePick.find({ guide: g._id }).sort({ createdAt: -1 }).lean();
        const PlaceCache = require('../models/PlaceCache');
        const rows = await PlaceCache.find({ placeId: { $in: picks.map(p => p.placeId) }, 'explore.status': { $ne: 'hidden' } })
            .select('placeId name rating details.formatted_address city imagesStored details.geometry.location').lean();
        const byId = new Map(rows.map(r => [r.placeId, r]));
        res.json({
            success: true,
            guide: svc.publicGuide(g),
            picks: picks.filter(p => byId.has(p.placeId)).map(p => {
                const r = byId.get(p.placeId);
                const loc = r.details?.geometry?.location;
                return {
                    id: String(p._id), placeId: p.placeId, name: r.name, category: p.category, note: p.note || '',
                    reelUrl: p.reelUrl || null, embedUrl: p.reelUrl ? (svc.parseInstagramPost(p.reelUrl)?.embedUrl || null) : null,
                    tour: p.tour || null, rating: r.rating ?? null,
                    address: r.details?.formatted_address || r.city || null,
                    image: r.imagesStored ? `/api/ai/place-image/${r.placeId}/0` : null,
                    lat: loc?.lat ?? null, lng: loc?.lng ?? null,
                };
            }),
        });
    } catch (err) {
        console.error('[guides] public page error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load guide' });
    }
});

// ── GUIDE: apply, own profile, picks ────────────────────────────────────────

router.post('/apply', auth, applyLimiter, async (req, res) => {
    try {
        const clean = svc.sanitizeApplication(req.body || {});
        if (clean.error) return res.status(400).json({ success: false, error: clean.error });
        const existing = await ownGuide(req);
        if (existing && existing.status === 'active') return res.status(400).json({ success: false, error: 'You already have an active guide page.' });
        if (existing && existing.status === 'suspended') return res.status(403).json({ success: false, error: 'This guide page is suspended. Please contact support.' });
        const clash = await Guide.findOne({ handle: clean.handle, user: { $ne: req.user._id } }).select('_id').lean();
        if (clash) return res.status(409).json({ success: false, error: `jinni.travel/@${clean.handle} is taken. Please choose another page name.` });
        const g = existing || new Guide({ user: req.user._id, verification: { code: svc.makeVerificationCode() } });
        Object.assign(g, clean, { status: 'pending', termsAcceptedAt: new Date() });
        g.verification.history.push({ action: 'applied', by: req.user._id, notes: existing ? 're-applied' : '' });
        await g.save();
        console.log(`[guides] application ${existing ? 're-sent' : 'new'}: @${g.handle} (user ${req.user._id})`);
        res.json({ success: true, guide: selfView(g) });
    } catch (err) {
        if (err && err.code === 11000) return res.status(409).json({ success: false, error: 'That page name was just taken. Please choose another.' });
        console.error('[guides] apply error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to submit application' });
    }
});

router.get('/me', auth, async (req, res) => {
    const g = await ownGuide(req);
    if (!g) return res.json({ success: true, guide: null, picks: [] });
    const picks = g.status === 'active' || g.status === 'pending'
        ? await GuidePick.find({ guide: g._id }).sort({ createdAt: -1 }).lean() : [];
    res.json({ success: true, guide: selfView(g), picks: picks.map(p => ({ ...p, id: String(p._id), _id: undefined, guide: undefined })) });
});

router.put('/me', auth, editLimiter, async (req, res) => {
    const g = await ownGuide(req);
    if (!g) return res.status(404).json({ success: false, error: 'No guide profile' });
    Object.assign(g, svc.sanitizeProfileEdit(req.body || {}));
    await g.save();
    res.json({ success: true, guide: selfView(g) });
});

// Picks need an ACTIVE page; a pending guide can see the dashboard but not publish.
async function activeGuide(req, res) {
    const g = await ownGuide(req);
    if (!g) { res.status(404).json({ success: false, error: 'No guide profile' }); return null; }
    if (g.status !== 'active') { res.status(403).json({ success: false, error: 'Your guide page is not approved yet.' }); return null; }
    return g;
}

router.get('/me/place-search', auth, editLimiter, async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    res.json({ success: true, places: await svc.placeSearch(req.query.q) });
});

router.post('/me/picks', auth, editLimiter, async (req, res) => {
    try {
        const g = await activeGuide(req, res); if (!g) return;
        const clean = svc.sanitizePick(req.body || {});
        if (clean.error) return res.status(400).json({ success: false, error: clean.error });
        if (await GuidePick.countDocuments({ guide: g._id }) >= MAX_PICKS) return res.status(400).json({ success: false, error: `A page holds up to ${MAX_PICKS} picks.` });
        const place = await require('../models/PlaceCache').findOne({ placeId: clean.placeId, 'explore.status': { $ne: 'hidden' } }).select('placeId name').lean();
        if (!place) return res.status(400).json({ success: false, error: 'That place is not in Jinni yet. Choose it from the search results.' });
        const pick = await GuidePick.create({ ...clean, guide: g._id, placeName: place.name });
        res.json({ success: true, pick: { ...pick.toObject(), id: String(pick._id) } });
    } catch (err) {
        if (err && err.code === 11000) return res.status(409).json({ success: false, error: 'You already picked this place in that category.' });
        console.error('[guides] add pick error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save pick' });
    }
});

router.put('/me/picks/:id', auth, editLimiter, async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    const pick = await GuidePick.findOne({ _id: req.params.id, guide: g._id });
    if (!pick) return res.status(404).json({ success: false, error: 'Pick not found' });
    const clean = svc.sanitizePick({ ...pick.toObject(), ...req.body, placeId: pick.placeId });
    if (clean.error) return res.status(400).json({ success: false, error: clean.error });
    Object.assign(pick, { category: clean.category, note: clean.note, reelUrl: clean.reelUrl, tour: clean.tour });
    await pick.save();
    res.json({ success: true, pick: { ...pick.toObject(), id: String(pick._id) } });
});

router.delete('/me/picks/:id', auth, editLimiter, async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    const r = await GuidePick.deleteOne({ _id: req.params.id, guide: g._id });
    res.json({ success: r.deletedCount === 1 });
});

// ── STAFF: queue, approve, reject, suspend ──────────────────────────────────

router.get('/staff/queue', auth, async (req, res) => {
    if (!isStaffOrAdmin(req.user)) return res.status(403).json({ success: false, error: 'Staff only' });
    const status = ['pending', 'active', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await Guide.find({ status }).sort({ updatedAt: -1 }).limit(100).populate('user', 'email name').lean();
    const counts = Object.fromEntries(await Promise.all(['pending', 'active', 'rejected', 'suspended']
        .map(async s => [s, await Guide.countDocuments({ status: s })])));
    res.json({
        success: true, counts,
        guides: rows.map(g => ({
            id: String(g._id), ...svc.publicGuide(g), status: g.status,
            verificationCode: g.verification?.code, staffNotes: g.verification?.staffNotes || '',
            email: g.user?.email || null, accountName: g.user?.name || null,
            createdAt: g.createdAt, updatedAt: g.updatedAt,
        })),
    });
});

async function staffAction(req, res, { from, to, action, needReason }) {
    if (!isStaffOrAdmin(req.user)) return res.status(403).json({ success: false, error: 'Staff only' });
    const g = await Guide.findById(req.params.id).populate('user', 'email');
    if (!g) return res.status(404).json({ success: false, error: 'Guide not found' });
    if (!from.includes(g.status)) return res.status(400).json({ success: false, error: `Cannot ${action} a ${g.status} guide.` });
    const notes = String(req.body?.reason || req.body?.staffNotes || '').trim().slice(0, 500);
    if (needReason && !notes) return res.status(400).json({ success: false, error: 'A reason is required.' });
    g.status = to;
    g.verification.staffNotes = notes;
    g.verification.verifiedAt = new Date();
    g.verification.verifiedBy = req.user._id || req.user.id;
    if (action === 'approve' || action === 'reject') g.verification.verifiedAction = action === 'approve' ? 'approved' : 'rejected';
    g.verification.history.push({ action: { approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated' }[action], by: req.user._id || req.user.id, notes });
    await g.save();
    console.log(`[guides] @${g.handle} ${action} by ${req.user.email || req.user.id}`);
    const email = g.user?.email;
    if (email) {
        const mail = require('../services/emailService');
        const send = action === 'approve' ? mail.sendGuideApprovedEmail?.(email, g.displayName, g.handle)
            : action === 'reject' ? mail.sendGuideRejectedEmail?.(email, g.displayName, notes) : null;
        if (send && send.catch) send.catch(err => console.warn(`[guides] ${action} email failed:`, err.message));
    }
    res.json({ success: true, status: g.status });
}

router.post('/staff/:id/approve', auth, (req, res) => staffAction(req, res, { from: ['pending', 'rejected'], to: 'active', action: 'approve' }));
router.post('/staff/:id/reject', auth, (req, res) => staffAction(req, res, { from: ['pending'], to: 'rejected', action: 'reject', needReason: true }));
router.post('/staff/:id/suspend', auth, (req, res) => staffAction(req, res, { from: ['active'], to: 'suspended', action: 'suspend', needReason: true }));
router.post('/staff/:id/reinstate', auth, (req, res) => staffAction(req, res, { from: ['suspended'], to: 'active', action: 'reinstate' }));

module.exports = router;
