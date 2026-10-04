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
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const Guide = require('../models/Guide');
const GuidePick = require('../models/GuidePick');
const svc = require('../services/guideService');
const videoSvc = require('../services/guideVideoService');
const multer = require('multer');
const os = require('os');

const router = express.Router();

// Guide moderation = admin, or staff the admin gave the "Validate guides"
// permission (2026-10-02 founder: a separate option when adding staff).
const canValidateGuides = (u) => !!u && (u.role === 'admin' || u.isAdmin === true
    || (u.role === 'staff' && u.staffAssignment?.permissions?.validateGuides === true));
const NO_PERM = { success: false, error: 'You do not have permission to validate guides' };
const MAX_PICKS = 150;

// Behind Cloudflare + Coolify, req.ip is a proxy — key on the visitor's real
// address exactly like server.js's apiLimiter, or every user shares one budget.
const clientKey = (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown');
const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : clientKey(req)),
    message: { error: 'Too many applications. Please try again later.' } });
const editLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : clientKey(req)) });
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });

// Express 4 does not catch a rejected async handler: the request would hang
// until timeout. Every route goes through wrap() — errors answer 500, cleanly.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`[guides] ${req.method} ${req.originalUrl} failed:`, err && err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});
const validId = (id) => mongoose.isValidObjectId(id) && String(id).length === 24;
const STALE_PENDING_MS = 14 * 864e5;   // an unverified application stops holding its name after 14 days

const ownGuide = (req) => Guide.findOne({ user: req.user._id });

const CAT_WORDS = { restaurant: 'restaurant', hidden_gem: 'hidden gem', photo_spot: 'photo spot', activity: 'activity' };
/** null when the guide may file this place under `category`, else the reason to show them. */
function categoryProblem(place, category) {
    const rules = svc.categoryRules(place._rules);
    if (rules.allowed.includes(category)) return null;
    if (rules.outOfScope) return { code: 'out_of_scope', error: 'Hotels and events are booked through Jinni itself, so they can\'t be guide picks.' };
    if (rules.curated) {
        const ok = rules.allowed.map(c => CAT_WORDS[c]).join(', ');
        return { code: 'team_category', allowed: rules.allowed, error: ok
            ? `Jinni's team has listed this place as: ${ok}. Please choose one of those — or ask us to add another category.`
            : 'Jinni\'s team has not listed this place under a guide category yet. Ask us to add one.' };
    }
    if (category === 'restaurant') return { code: 'not_food', allowed: rules.allowed, error: 'Only places that serve food or drink can be a restaurant pick.' };
    return { code: 'not_allowed', allowed: rules.allowed, error: 'Please choose another category for this place.' };
}

// What the guide themselves sees (includes their verification code and status).
const selfView = (g) => g && ({
    ...svc.publicGuide(g),
    status: g.status,
    verificationCode: g.verification?.code || null,
    staffNotes: g.status === 'rejected' ? (g.verification?.staffNotes || '') : '',
    createdAt: g.createdAt,
});

// ── PUBLIC: handle availability + the public page ───────────────────────────

router.get('/handle-available/:handle', lookupLimiter, wrap(async (req, res) => {
    const raw = String(req.params.handle || '').trim().replace(/^@+/, '').toLowerCase();
    const handle = svc.normalizeHandle(raw);
    // A well-formed name that is one of the app's own words gets its own reason,
    // so the form can say "reserved" instead of a format rule it already meets.
    if (!handle) return res.json({ available: false, reason: /^[a-z0-9._]{3,30}$/.test(raw) && svc.RESERVED.has(raw) ? 'reserved' : 'invalid' });
    const taken = await Guide.exists({ handle });
    res.json({ available: !taken, handle });
}));

router.get('/public/:handle', lookupLimiter, wrap(async (req, res) => {
    try {
        const handle = svc.normalizeHandle(req.params.handle);
        if (!handle) return res.status(404).json({ success: false, error: 'Guide not found' });
        const g = await Guide.findOne({ handle, status: 'active' }).lean();
        if (!g) return res.status(404).json({ success: false, error: 'Guide not found' });
        const picks = await GuidePick.find({ guide: g._id }).sort({ createdAt: -1 }).lean();
        // Hidden places and deleted Destinations drop out (the pick stays, unseen).
        const byId = await svc.loadPickPlaces(picks.map(p => p.placeId));
        res.json({
            success: true,
            guide: svc.publicGuide(g),
            picks: picks.filter(p => byId.has(p.placeId)).map(p => {
                const r = byId.get(p.placeId);
                return {
                    id: String(p._id), placeId: p.placeId, name: r.name, category: p.category, note: p.note || '',
                    reelUrl: p.reelUrl || null, embedUrl: p.reelUrl ? (svc.parseInstagramPost(p.reelUrl)?.embedUrl || null) : null,
                    ...(() => { const v = videoSvc.videoView(p); return v && v.status === 'ready' ? { videoUrl: v.videoUrl, posterUrl: v.posterUrl } : {}; })(),
                    tour: p.tour || null, rating: r.rating ?? null,
                    address: r.address, image: r.image, lat: r.lat, lng: r.lng,
                };
            }),
        });
    } catch (err) {
        console.error('[guides] public page error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load guide' });
    }
}));

// ── GUIDE: apply, own profile, picks ────────────────────────────────────────

router.post('/apply', auth, applyLimiter, wrap(async (req, res) => {
    try {
        const clean = svc.sanitizeApplication(req.body || {});
        if (clean.error) return res.status(400).json({ success: false, error: clean.error });
        const existing = await ownGuide(req);
        if (existing && existing.status === 'active') return res.status(400).json({ success: false, error: 'You already have an active guide page.' });
        if (existing && existing.status === 'suspended') return res.status(403).json({ success: false, error: 'This guide page is suspended. Please contact support.' });
        const clash = await Guide.findOne({ handle: clean.handle, user: { $ne: req.user._id } }).select('_id status updatedAt').lean();
        if (clash) {
            // A never-verified application stops squatting a name after 14 days.
            const stale = clash.status === 'pending' && Date.now() - new Date(clash.updatedAt).getTime() > STALE_PENDING_MS;
            if (!stale) return res.status(409).json({ success: false, error: `jinni.travel/@${clean.handle} is taken. Please choose another page name.` });
            await Guide.deleteOne({ _id: clash._id, status: 'pending' });
            console.log(`[guides] released stale pending name @${clean.handle}`);
        }
        // One Instagram account = one live guide page (impersonation guard;
        // staff still check the bio code on every application).
        const igTaken = await Guide.exists({ instagram: clean.instagram, status: 'active', user: { $ne: req.user._id } });
        if (igTaken) return res.status(409).json({ success: false, error: `@${clean.instagram} already has a guide page on Jinni. If it's yours, please contact us.` });
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
}));

router.get('/me', auth, wrap(async (req, res) => {
    const g = await ownGuide(req);
    if (!g) return res.json({ success: true, guide: null, picks: [] });
    const picks = g.status === 'active' || g.status === 'pending'
        ? await GuidePick.find({ guide: g._id }).sort({ createdAt: -1 }).lean() : [];
    const places = await svc.loadPickPlaces(picks.map(p => p.placeId));
    res.json({ success: true, guide: selfView(g), picks: picks.map(p => {
        const place = places.get(p.placeId);
        return { ...p, id: String(p._id), _id: undefined, guide: undefined, video: videoSvc.videoView(p),
            // The place left Jinni (hidden / deleted) → the guide sees it is no longer shown.
            placeGone: !place, image: place?.image || null, address: place?.address || null,
            categories: place ? svc.categoryRules(place._rules) : null };
    }) });
}));

router.put('/me', auth, editLimiter, wrap(async (req, res) => {
    const g = await ownGuide(req);
    if (!g) return res.status(404).json({ success: false, error: 'No guide profile' });
    Object.assign(g, svc.sanitizeProfileEdit(req.body || {}));
    await g.save();
    res.json({ success: true, guide: selfView(g) });
}));

// Picks need an ACTIVE page; a pending guide can see the dashboard but not publish.
async function activeGuide(req, res) {
    const g = await ownGuide(req);
    if (!g) { res.status(404).json({ success: false, error: 'No guide profile' }); return null; }
    if (g.status !== 'active') { res.status(403).json({ success: false, error: 'Your guide page is not approved yet.' }); return null; }
    return g;
}

router.get('/me/place-search', auth, editLimiter, wrap(async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    res.json({ success: true, places: await svc.placeSearch(req.query.q) });
}));

router.post('/me/picks', auth, editLimiter, wrap(async (req, res) => {
    try {
        const g = await activeGuide(req, res); if (!g) return;
        const clean = svc.sanitizePick(req.body || {});
        if (clean.error) return res.status(400).json({ success: false, error: clean.error });
        if (await GuidePick.countDocuments({ guide: g._id }) >= MAX_PICKS) return res.status(400).json({ success: false, error: `A page holds up to ${MAX_PICKS} picks.` });
        const place = (await svc.loadPickPlaces([clean.placeId])).get(clean.placeId);
        if (!place) return res.status(400).json({ success: false, error: 'That place is not in Jinni yet. Choose it from the search results.' });
        const problem = categoryProblem(place, clean.category);
        if (problem) return res.status(400).json({ success: false, ...problem });
        const pick = await GuidePick.create({ ...clean, guide: g._id, placeName: String(place.name).slice(0, 160) });
        res.json({ success: true, pick: { ...pick.toObject(), id: String(pick._id), video: null } });
    } catch (err) {
        if (err && err.code === 11000) return res.status(409).json({ success: false, error: 'You already picked this place in that category.' });
        console.error('[guides] add pick error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save pick' });
    }
}));

router.put('/me/picks/:id', auth, editLimiter, wrap(async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    if (!validId(req.params.id)) return res.status(404).json({ success: false, error: 'Pick not found' });
    const pick = await GuidePick.findOne({ _id: req.params.id, guide: g._id });
    if (!pick) return res.status(404).json({ success: false, error: 'Pick not found' });
    const clean = svc.sanitizePick({ ...pick.toObject(), ...req.body, placeId: pick.placeId });
    if (clean.error) return res.status(400).json({ success: false, error: clean.error });
    if (clean.category !== pick.category) {
        const place = (await svc.loadPickPlaces([pick.placeId])).get(pick.placeId);
        if (!place) return res.status(400).json({ success: false, error: 'This place is no longer on Jinni, so its category can\'t change. You can remove the pick.' });
        const problem = categoryProblem(place, clean.category);
        if (problem) return res.status(400).json({ success: false, ...problem });
    }
    Object.assign(pick, { category: clean.category, note: clean.note, reelUrl: clean.reelUrl, tour: clean.tour });
    await pick.save();
    res.json({ success: true, pick: { ...pick.toObject(), id: String(pick._id), video: videoSvc.videoView(pick) } });
}));

router.delete('/me/picks/:id', auth, editLimiter, wrap(async (req, res) => {
    const g = await activeGuide(req, res); if (!g) return;
    if (!validId(req.params.id)) return res.status(404).json({ success: false, error: 'Pick not found' });
    const pick = await GuidePick.findOne({ _id: req.params.id, guide: g._id }).select('video').lean();
    const r = await GuidePick.deleteOne({ _id: req.params.id, guide: g._id });
    if (r.deletedCount === 1 && pick?.video) await videoSvc.removeVideoFiles(pick.video);
    res.json({ success: r.deletedCount === 1 });
}));

// ── A pick's VIDEO (founder 2026-10-05): the guide uploads their own clip and
// Jinni plays it in its own player — no Instagram box. The upload answers as
// soon as the file has arrived; conversion runs behind it and the dashboard
// asks /me until the video is ready.
const videoUpload = multer({
    storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_req, _file, cb) => cb(null, `jinni-gv-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) }),
    limits: { fileSize: videoSvc.MAX_UPLOAD_BYTES, files: 1 },
    fileFilter(_req, file, cb) {
        if (!videoSvc.ALLOWED_MIMES.includes(file.mimetype)) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Upload an MP4 or MOV video.'));
        cb(null, true);
    },
});
const videoLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : clientKey(req)),
    message: { success: false, error: 'Too many video uploads. Please try again later.' } });
// The pick is checked BEFORE the file is accepted, so a stranger can never fill the disk.
const ownPickFirst = wrap(async (req, res, next) => {
    const g = await activeGuide(req, res); if (!g) return;
    if (!validId(req.params.id)) return res.status(404).json({ success: false, error: 'Pick not found' });
    const pick = await GuidePick.findOne({ _id: req.params.id, guide: g._id });
    if (!pick) return res.status(404).json({ success: false, error: 'Pick not found' });
    req.guidePick = pick;
    next();
});

router.post('/me/picks/:id/video', auth, videoLimiter, ownPickFirst, (req, res, next) => {
    videoUpload.single('video')(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `The video is larger than ${Math.round(videoSvc.MAX_UPLOAD_BYTES / 1048576)} MB. Please upload a shorter or smaller one.`
            : (err instanceof multer.MulterError ? (err.field || 'Upload an MP4 or MOV video.') : 'The upload failed. Please try again.');
        res.status(400).json({ success: false, error: msg });
    });
}, wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Choose a video file.' });
    const pick = req.guidePick;
    const old = pick.video ? pick.video.toObject() : null;
    pick.video = { status: 'processing', uploadedAt: new Date() };
    await pick.save();
    if (old) await videoSvc.removeVideoFiles(old);
    videoSvc.processUpload(pick._id, req.file.path, req.file.mimetype);   // answers now; converts behind
    res.json({ success: true, video: { status: 'processing' } });
}));

router.delete('/me/picks/:id/video', auth, editLimiter, ownPickFirst, wrap(async (req, res) => {
    const pick = req.guidePick;
    const old = pick.video ? pick.video.toObject() : null;
    pick.video = null;
    await pick.save();
    if (old) await videoSvc.removeVideoFiles(old);
    res.json({ success: true });
}));

// PUBLIC: the clip and its poster. Only a ready video of an ACTIVE guide is served.
const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });
async function readyVideo(req, res) {
    if (!validId(req.params.pickId)) { res.status(404).json({ success: false, error: 'Not found' }); return null; }
    const pick = await GuidePick.findById(req.params.pickId).select('guide video').lean();
    if (!pick?.video || pick.video.status !== 'ready' || !pick.video.fileId || !(await Guide.exists({ _id: pick.guide, status: 'active' }))) {
        res.status(404).json({ success: false, error: 'Not found' }); return null;
    }
    return pick.video;
}
// ?v=<file version> changes whenever the guide replaces the clip, so the bytes can be cached.
router.get('/video/:pickId', mediaLimiter, wrap(async (req, res) => {
    const v = await readyVideo(req, res); if (!v) return;
    await videoSvc.streamFile(req, res, v.fileId, { contentType: 'video/mp4', cacheControl: 'public, max-age=604800' });
}));
router.get('/video/:pickId/poster', mediaLimiter, wrap(async (req, res) => {
    const v = await readyVideo(req, res); if (!v) return;
    if (!v.posterId) return res.status(404).json({ success: false, error: 'Not found' });
    await videoSvc.streamFile(req, res, v.posterId, { contentType: 'image/jpeg', cacheControl: 'public, max-age=604800' });
}));

// ── STAFF: queue, approve, reject, suspend ──────────────────────────────────

router.get('/staff/queue', auth, wrap(async (req, res) => {
    if (!canValidateGuides(req.user)) return res.status(403).json(NO_PERM);
    const status = ['pending', 'active', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await Guide.find({ status }).sort({ updatedAt: -1 }).limit(100).populate('user', 'email name').lean();
    const pickCounts = new Map((await GuidePick.aggregate([{ $match: { guide: { $in: rows.map(g => g._id) } } }, { $group: { _id: '$guide', n: { $sum: 1 } } }]))
        .map(r => [String(r._id), r.n]));
    const counts = Object.fromEntries(await Promise.all(['pending', 'active', 'rejected', 'suspended']
        .map(async s => [s, await Guide.countDocuments({ status: s })])));
    res.json({
        success: true, counts,
        guides: rows.map(g => ({
            id: String(g._id), ...svc.publicGuide(g), status: g.status,
            verificationCode: g.verification?.code, staffNotes: g.verification?.staffNotes || '',
            email: g.user?.email || null, accountName: g.user?.name || null,
            pickCount: pickCounts.get(String(g._id)) || 0,
            createdAt: g.createdAt, updatedAt: g.updatedAt,
        })),
    });
}));

async function staffAction(req, res, { from, to, action, needReason }) {
    if (!canValidateGuides(req.user)) return res.status(403).json(NO_PERM);
    if (!validId(req.params.id)) return res.status(404).json({ success: false, error: 'Guide not found' });
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

router.post('/staff/:id/approve', auth, wrap((req, res) => staffAction(req, res, { from: ['pending', 'rejected'], to: 'active', action: 'approve' })));
router.post('/staff/:id/reject', auth, wrap((req, res) => staffAction(req, res, { from: ['pending'], to: 'rejected', action: 'reject', needReason: true })));
router.post('/staff/:id/suspend', auth, wrap((req, res) => staffAction(req, res, { from: ['active'], to: 'suspended', action: 'suspend', needReason: true })));
router.post('/staff/:id/reinstate', auth, wrap((req, res) => staffAction(req, res, { from: ['suspended'], to: 'active', action: 'reinstate' })));

// ── STAFF: review a guide's picks (they go live at once — staff check after) ──

router.get('/staff/:id/picks', auth, wrap(async (req, res) => {
    if (!canValidateGuides(req.user)) return res.status(403).json(NO_PERM);
    if (!validId(req.params.id)) return res.status(404).json({ success: false, error: 'Guide not found' });
    const picks = await GuidePick.find({ guide: req.params.id }).sort({ createdAt: -1 }).lean();
    const places = await svc.loadPickPlaces(picks.map(p => p.placeId));
    res.json({
        success: true,
        picks: picks.map(p => {
            const place = places.get(p.placeId);
            return {
                id: String(p._id), placeId: p.placeId, placeName: p.placeName || '', category: p.category,
                note: p.note || '', reelUrl: p.reelUrl || null, tour: p.tour || null, createdAt: p.createdAt,
                videoUrl: videoSvc.videoView(p)?.videoUrl || null,
                source: svc.isDestRef(p.placeId) ? 'destination' : 'place',
                placeGone: !place,
                // Staff hint: Jinni's own data doesn't back this category.
                categoryMismatch: place ? svc.categoryMismatch(p.category, place._rules) : false,
                teamCategories: place?._rules?.actions || [],
            };
        }),
    });
}));

router.delete('/staff/picks/:pickId', auth, wrap(async (req, res) => {
    if (!canValidateGuides(req.user)) return res.status(403).json(NO_PERM);
    if (!validId(req.params.pickId)) return res.status(404).json({ success: false, error: 'Pick not found' });
    const pick = await GuidePick.findById(req.params.pickId);
    if (!pick) return res.status(404).json({ success: false, error: 'Pick not found' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    await pick.deleteOne();
    if (pick.video) await videoSvc.removeVideoFiles(pick.video);
    // Record it on the guide, so the history shows who removed what and why.
    await Guide.updateOne({ _id: pick.guide }, { $push: { 'verification.history': {
        action: 'pick_removed', by: req.user._id || req.user.id, notes: `${pick.placeName || pick.placeId} (${pick.category})${reason ? ': ' + reason : ''}`,
    } } });
    console.log(`[guides] pick ${pick._id} (${pick.placeName}) removed by ${req.user.email || req.user.id}`);
    res.json({ success: true });
}));

module.exports = router;
