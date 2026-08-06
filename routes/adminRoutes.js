const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const UserAILimit = require('../models/UserAILimit');
const Business = require('../models/Business');
const Analytics = require('../models/Analytics');
const ChatSession = require('../models/ChatSession');
const TravelQuery = require('../models/TravelQuery');
const PlaceCache = require('../models/PlaceCache');
const { priceTier, priceTierLabel, priceLevelDollars } = require('../services/priceTier');
const GoogleApiStats = require('../models/GoogleAPIStats');
const AiDailyStats = require('../models/AiDailyStats');
const Destination = require('../models/Destination');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const emailService = require('../services/emailService');
const mongoBilling = require('../services/mongoBilling');
const zoneAuction = require('../services/zoneAuction');
const BlockedFingerprint = require('../models/BlockedFingerprint');
const blocklistService   = require('../services/blocklistService');
const AppConfig = require('../models/AppConfig');
const AiProviderDailyStats = require('../models/AiProviderDailyStats');

// All routes require auth + admin
router.use(auth, admin);

// ── Helpers ───────────────────────────────────────────────────────────────
// Populate paths for verification metadata. The admin modal renders
// "verified by" labels and audit-history "by" labels using these populated
// User refs (name + email + role). Without populate, the frontend gets raw
// ObjectIds which it can't display.
const VERIFICATION_POPULATE = [
    { path: 'verification.verifiedBy', select: 'name email role' },
    { path: 'verification.history.by', select: 'name email role' },
];

// ─── OVERVIEW STATS ───────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last7Days = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        const last30Days = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const [
            totalUsers, premiumUsers, newUsersToday, newUsersWeek, newUsersMonth,
            activeUsersWeek, totalChatSessions, totalBusinesses, activeBusinesses,
        ] = await Promise.all([
            User.countDocuments({ isActive: true }),
            User.countDocuments({ isPremium: true, isActive: true }),
            User.countDocuments({ createdAt: { $gte: today } }),
            User.countDocuments({ createdAt: { $gte: last7Days } }),
            User.countDocuments({ createdAt: { $gte: last30Days } }),
            User.countDocuments({ 'analytics.lastActive': { $gte: last7Days } }),
            ChatSession.countDocuments({}),
            Business.countDocuments({}),
            Business.countDocuments({ isActive: true }),
        ]);
        const tokenAgg = await UserAILimit.aggregate([{ $group: { _id: null, totalTokens: { $sum: '$statistics.totalTokensUsed' }, totalQueries: { $sum: '$statistics.totalQueriesMade' } } }]);
        res.json({
            success: true,
            data: {
                users: { total: totalUsers, premium: premiumUsers, free: totalUsers - premiumUsers, newToday: newUsersToday, newThisWeek: newUsersWeek, newThisMonth: newUsersMonth, activeThisWeek: activeUsersWeek },
                ai: { totalTokensUsed: tokenAgg[0]?.totalTokens || 0, totalQueries: tokenAgg[0]?.totalQueries || 0 },
                businesses: { total: totalBusinesses, active: activeBusinesses },
                chatSessions: totalChatSessions
            }
        });
    } catch (error) {
        console.error('Admin overview error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch overview stats' });
    }
});

// ─── USER STATS ───────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
    try {
        const { page = 1, limit = 20, sort = 'createdAt', order = 'desc', search = '', filter = 'all' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = { isActive: true };
        if (search) { query.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }] }
        if (filter === 'premium') query.isPremium = true;
        if (filter === 'free') query.isPremium = false;
        if (filter === 'active') query['analytics.lastActive'] = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
        const sortObj = { [sort]: order === 'asc' ? 1 : -1 };
        const [users, total] = await Promise.all([
            User.find(query).select('name email isPremium onboardingCompleted analytics settings createdAt').populate('aiLimits', 'statistics dailyUsage onCooldown isPremium').sort(sortObj).skip(skip).limit(parseInt(limit)).lean(),
            User.countDocuments(query)
        ]);
        res.json({ success: true, data: { users, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
});

// User location breakdown — home locations AND travel destinations
router.get('/users/locations', async (req, res) => {
    try {
        const [byCountry, byCity, byDestCountry, byDestCity] = await Promise.all([
            // Home/current location — by country
            User.aggregate([
                { $match: { isActive: true, 'settings.location.countryName': { $nin: ['', 'Select a country', null] } } },
                { $group: { _id: '$settings.location.countryName', count: { $sum: 1 }, premium: { $sum: { $cond: ['$isPremium', 1, 0] } } } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            // Home/current location — by city
            User.aggregate([
                { $match: { isActive: true, 'settings.location.city': { $nin: ['', 'Select a city', null] } } },
                { $group: { _id: '$settings.location.city', country: { $first: '$settings.location.countryName' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]),
            // Travel destinations — by country
            User.aggregate([
                { $match: { isActive: true, 'preferences.destination.countryName': { $nin: ['', null] } } },
                { $group: { _id: '$preferences.destination.countryName', count: { $sum: 1 }, premium: { $sum: { $cond: ['$isPremium', 1, 0] } } } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            // Travel destinations — by city
            User.aggregate([
                { $match: { isActive: true, 'preferences.destination.city': { $nin: ['', null] } } },
                { $group: { _id: '$preferences.destination.city', country: { $first: '$preferences.destination.countryName' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ])
        ]);

        const homeTotal = byCountry.reduce((s, c) => s + c.count, 0);
        const destTotal = byDestCountry.reduce((s, c) => s + c.count, 0);

        res.json({
            success: true,
            data: {
                byCountry,
                byCity,
                total: homeTotal,
                destinations: {
                    byCountry: byDestCountry,
                    byCity: byDestCity,
                    total: destTotal
                }
            }
        });
    } catch (error) {
        console.error('User locations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch location data' });
    }
});

// User registrations over time (last 30 days)
router.get('/users/registrations', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const data = await User.aggregate([
            { $match: { createdAt: { $gte: startDate } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, premium: { $sum: { $cond: ['$isPremium', 1, 0] } } } },
            { $sort: { _id: 1 } }
        ]);
        res.json({ success: true, data });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to fetch registration data' }) }
});

// Single user detail
router.get('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password').populate('aiLimits').lean();
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        const [sessionCount, queryCount] = await Promise.all([ChatSession.countDocuments({ userId: user._id }), TravelQuery.countDocuments({ userId: user._id })]);
        res.json({ success: true, data: { ...user, sessionCount, queryCount } });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to fetch user' }) }
});

// Toggle user premium status
router.patch('/users/:id/premium', async (req, res) => {
    try {
        const { isPremium } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { isPremium }, { new: true }).select('name email isPremium');
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        res.json({ success: true, data: user });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to update user' }) }
});

// Toggle cooldown for a user
router.patch('/users/:id/cooldown', async (req, res) => {
    try {
        const { onCooldown } = req.body;
        const aiLimit = await UserAILimit.findOne({ userId: req.params.id });
        if (!aiLimit) return res.status(404).json({ success: false, error: 'AI limit record not found' });
        aiLimit.onCooldown = onCooldown;
        if (onCooldown) {
            aiLimit.cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            aiLimit.cooldownReason = 'Manual cooldown applied by admin';
        } else {
            aiLimit.cooldownUntil = null;
            aiLimit.cooldownReason = null;
        }
        await aiLimit.save();
        res.json({ success: true, data: { onCooldown: aiLimit.onCooldown } });
    } catch (error) {
        console.error('Toggle cooldown error:', error);
        res.status(500).json({ success: false, error: 'Failed to update cooldown' });
    }
});

// Delete a user
router.delete('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        await UserAILimit.deleteOne({ userId: req.params.id });
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: `User "${user.name}" deleted` });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
    }
});

// ─── AI USAGE STATS ───────────────────────────────────────────────────────────
router.get('/ai-usage', async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [usageData, total, topUsersAgg, cooldownUsers] = await Promise.all([
            UserAILimit.find({}).populate('userId', 'name email isPremium').select('userId statistics dailyUsage onCooldown cooldownUntil cooldownReason isPremium updatedAt').sort({ 'statistics.totalTokensUsed': -1 }).skip(skip).limit(parseInt(limit)).lean(),
            UserAILimit.countDocuments({}),
            UserAILimit.aggregate([
                { $group: {
                    _id: null,
                    avgTokensPerQuery: { $avg: '$statistics.avgTokensPerQuery' },
                    totalTokens: { $sum: '$statistics.totalTokensUsed' },
                    totalPlaces: { $sum: '$statistics.totalPlacesViewed' },
                    totalQueries: { $sum: '$statistics.totalQueriesMade' },
                    usersOnCooldown: { $sum: { $cond: ['$onCooldown', 1, 0] } },
                    todayTokens: { $sum: '$dailyUsage.tokensUsed' },
                    todayQueries: { $sum: '$dailyUsage.queriesMade' },
                    todayActiveUsers: { $sum: { $cond: [{ $gt: ['$dailyUsage.queriesMade', 0] }, 1, 0] } }
                }}
            ]),
            UserAILimit.countDocuments({ onCooldown: true })
        ]);
        res.json({ success: true, data: {users: usageData, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), summary: { ...topUsersAgg[0], usersOnCooldown: cooldownUsers }} });
    } catch (error) {
        console.error('AI usage error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch AI usage' });
    }
});

// Clear cooldown for a specific user (from AI usage tab)
router.patch('/ai-usage/:userId/clear-cooldown', async (req, res) => {
    try {
        const limit = await UserAILimit.findOneAndUpdate({ userId: req.params.userId }, { onCooldown: false, cooldownUntil: null, cooldownReason: null }, { new: true });
        if (!limit) return res.status(404).json({ success: false, error: 'User limit not found' });
        res.json({ success: true, message: 'Cooldown cleared' });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to clear cooldown' }) }
});

// Daily breakdown for the AI chart — last N days from AiDailyStats
router.get('/ai-usage/daily', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days + 1);
        const startStr = startDate.toISOString().slice(0, 10);

        const rows = await AiDailyStats.find({ date: { $gte: startStr } })
            .sort({ date: 1 })
            .select('date tokens queries')
            .lean();

        const filled = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            const found = rows.find(r => r.date === dateStr);
            filled.push({
                date:    dateStr,
                label:   dateStr.slice(5),
                tokens:  found?.tokens  || 0,
                queries: found?.queries || 0,
            });
        }
        res.json({ success: true, data: filled });
    } catch (error) {
        console.error('AI daily stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch AI daily stats' });
    }
});

// ─── BUSINESS STATS ───────────────────────────────────────────────────────────
router.get('/businesses', async (req, res) => {
    try {
        const { page = 1, limit = 20, sort = 'analytics.views', order = 'desc', search = '', partner = '', status = '', location = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = {};
        if (search) query.name = { $regex: search, $options: 'i' };
        if (partner === 'true') query['partnership.tier'] = { $in: ['spotlight', 'signature'] };
        if (partner === 'false') query['partnership.tier'] = 'verified';
        // Status filter: only accept the documented enum values to avoid bogus regex queries
        const allowedStatuses = ['pending', 'active', 'frozen', 'waitlisted', 'rejected'];
        if (status && allowedStatuses.includes(status)) query.status = status;
        // Location filter: case-insensitive substring match against city / region / country / address.
        // Escapes regex metacharacters so user input like "St. Louis" doesn't break the query.
        if (location && location.trim()) {
            const safe = location.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(safe, 'i');
            query.$or = [
                { 'location.city':    rx },
                { 'location.region':  rx },
                { 'location.country': rx },
                { 'location.address': rx },
            ];
        }
        const sortObj = { [sort]: order === 'asc' ? 1 : -1 };
        const [businesses, total, revenueAgg, interactionAgg] = await Promise.all([
            Business.find(query)
                .sort(sortObj).skip(skip).limit(parseInt(limit))
                // Include all fields the edit modal renders, including verification
                // (with populated refs below) so the modal doesn't have to refetch.
                .select('name type location contact description images pricing analytics partnership status isActive createdAt openingHours eventSchedule isHiddenGem verification auction')
                .populate(VERIFICATION_POPULATE)
                .lean(),
            Business.countDocuments(query),
            Business.aggregate([{ $group: {
                _id: null,
                // Monthly revenue = sum of monthlyFee for all active spotlight/signature partners
                monthlyRevenue: { $sum: { $cond: [{ $and: [{ $in: ['$partnership.tier', ['spotlight', 'signature']] }, { $eq: ['$isActive', true] }] }, { $ifNull: ['$partnership.monthlyFee', 0] }, 0] } },
                // All-time revenue kept for backwards compat (analytics.revenue field)
                totalRevenue: { $sum: { $ifNull: ['$analytics.revenue', 0] } },
                totalViews: { $sum: '$analytics.views' },
                totalClicks: { $sum: '$analytics.clicks' },
                totalConversions: { $sum: '$analytics.conversions' },
                partnerCount: { $sum: { $cond: [{ $in: ['$partnership.tier', ['spotlight', 'signature']] }, 1, 0] } },
                activePartnerCount: { $sum: { $cond: [{ $and: [{ $in: ['$partnership.tier', ['spotlight', 'signature']] }, { $eq: ['$isActive', true] }] }, 1, 0] } }
            } }]),
            Analytics.aggregate([
                { $match: { type: 'place_interaction', 'metadata.verifiedId': { $exists: true, $ne: null } } },
                { $group: {
                    _id: { id: '$metadata.verifiedId', type: '$metadata.interactionType' },
                    count: { $sum: 1 }
                }}
            ])
        ]);

        // Build a map: verifiedId → { map_open, website_click, phone_click }
        const interactionMap = {};
        interactionAgg.forEach(({ _id, count }) => {
            if (!_id.id) return;
            const key = _id.id.toString();
            if (!interactionMap[key]) interactionMap[key] = { map_open: 0, website_click: 0, phone_click: 0 };
            if (_id.type === 'map_open') interactionMap[key].map_open = count;
            else if (_id.type === 'website_click') interactionMap[key].website_click = count;
            else if (_id.type === 'phone_click') interactionMap[key].phone_click = count;
        });

        // Attach to each business
        const enriched = businesses.map(b => ({
            ...b,
            interactions: interactionMap[b._id.toString()] || { map_open: 0, website_click: 0, phone_click: 0 }
        }));

        res.json({ success: true, data: { businesses: enriched, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), summary: revenueAgg[0] || {} } });
    } catch (error) {
        console.error('Businesses error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch businesses' });
    }
});

// Business analytics breakdown by type
router.get('/businesses/by-type', async (req, res) => {
    try {
        const data = await Business.aggregate([
            { $unwind: '$type' },
            { $group: { _id: '$type', count: { $sum: 1 }, totalViews: { $sum: '$analytics.views' }, totalClicks: { $sum: '$analytics.clicks' }, avgConversions: { $avg: '$analytics.conversions' } } },
            { $sort: { count: -1 } }
        ]);
        res.json({ success: true, data });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to fetch business types' }) }
});

// ─── UPDATE BUSINESS (full edit) ─────────────────────────────────────────────
router.patch('/businesses/:id', async (req, res) => {
    try {
        // Admin can edit everything except the verification.history audit trail
        // (that's append-only, written by the dedicated approve/freeze/reject routes).
        // verification.aiScore / aiNotes / staffApproved / staffNotes are editable
        // so admins can override staff decisions.
        const allowed = [
            'name', 'type', 'location', 'contact', 'description', 'images',
            'pricing', 'partnership', 'openingHours', 'eventSchedule',
            'isHiddenGem', 'isActive', 'status', 'verification'
        ];
        const updates = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

        // Strip history out of any verification update — admins should use the
        // dedicated approve/freeze/reject routes to add audit entries.
        if (updates.verification && 'history' in updates.verification) {
            const { history, ...rest } = updates.verification;
            updates.verification = rest;
        }

        // Normalise legacy tier names → valid enum values
        if (updates.partnership?.tier) {
            const tierMap = {
                basic: 'verified', free: 'verified',
                premium: 'spotlight',
                featured: 'signature', enterprise: 'signature'
            }
            updates.partnership.tier = tierMap[updates.partnership.tier] ?? updates.partnership.tier
        }

        const biz = await Business.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true })
            .populate(VERIFICATION_POPULATE);
        if (!biz) return res.status(404).json({ success: false, error: 'Business not found' });
        res.json({ success: true, data: biz });
    } catch (error) {
        console.error('Update business error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to update business' });
    }
});

// Toggle business active status
router.patch('/businesses/:id/toggle', async (req, res) => {
    try {
        const biz = await Business.findById(req.params.id);
        if (!biz) return res.status(404).json({ success: false, error: 'Business not found' });
        biz.isActive = !biz.isActive;
        await biz.save();
        res.json({ success: true, data: { isActive: biz.isActive } });
    } catch (error) {
        console.error('Toggle business error:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle business' });
    }
});

// ── Admin moderation actions (Approve / Freeze / Reject) ────────────────────
//
// These mirror the staff endpoints (POST /business/:id/approve|reject) but with
// admin authority: no scoping checks, can act on any listing in any state, and
// freeze is admin-only (staff can't freeze — they can only approve/reject from
// the pending queue).
//
// Each action:
//  1. updates business.status
//  2. updates verification.{verifiedAt, verifiedBy, verifiedAction, staffNotes}
//  3. appends a new entry to verification.history (audit trail)
//  4. for approve → also flips isActive=true; for freeze/reject → isActive=false
//
// Note: this admin approve does NOT run the zone-allocation logic that the
// staff route does (where a business can land in 'waitlisted' if its zone is
// full). If you need that behaviour from the admin side too, lift the helper
// out of the staff route and call it here. For now admin approve sets
// status='active' directly, which is the right call when an admin is
// overriding a staff decision or unfreezing.
async function applyModeration(req, res, action) {
    try {
        const biz = await Business.findById(req.params.id);
        if (!biz) return res.status(404).json({ success: false, error: 'Business not found' });

        const notes = (req.body?.notes || req.body?.reason || '').trim();
        if (action === 'reject' && !notes) {
            return res.status(400).json({ success: false, error: 'A reason is required when rejecting.' });
        }
        // Permanent (hard) reject — owner can't resubmit, all fingerprints are
        // blocked. Only relevant when action === 'reject'.
        const isHardReject = action === 'reject' && (req.body?.permanent === true || req.body?.permanent === 'true');

        // 1. status + isActive
        // 'pending' and 'waitlist' are test-only actions used to seed states
        // that normally only happen via the staff queue or zone-allocation logic.
        if (action === 'approve')  { biz.status = 'active';     biz.isActive = true;  }
        if (action === 'freeze')   { biz.status = 'frozen';     biz.isActive = false; }
        if (action === 'reject')   { biz.status = 'rejected';   biz.isActive = false; }
        if (action === 'pending')  { biz.status = 'pending';    biz.isActive = false; }
        if (action === 'waitlist') { biz.status = 'waitlisted'; biz.isActive = false; }

        // ── Bid-book cleanup on reject ────────────────────────────────────
        // Parity with the staff reject route — without this, an admin-rejected
        // Signature auction bidder stays in the bid book and could still win
        // a slot at the next quarterly resolution.
        if (action === 'reject' && biz.auction) {
            if (biz.auction.isBidding || biz.auction.awaitingApprovalSince) {
                biz.auction.isBidding = false;
                biz.auction.awaitingApprovalSince = null;
            }
        }

        // ── Clear watchFlags on approve ───────────────────────────────────
        // These were a SIGNAL to staff during review; once an admin/staff has
        // decided to approve, the signal has been consumed.
        if (action === 'approve' && biz.verification?.watchFlags?.length) {
            biz.verification.watchFlags = [];
        }

        // 2. verification metadata
        // History enum is ['approved', 'rejected', 'reassigned', 'reset'].
        // 'reset' fits naturally for pending; 'reassigned' covers freeze + waitlist.
        const historyAction = action === 'approve'  ? 'approved'
                             : action === 'reject'  ? 'rejected'
                             : action === 'pending' ? 'reset'
                             : 'reassigned'; // freeze, waitlist
        biz.verification = biz.verification || {};
        biz.verification.verifiedAt = new Date();
        biz.verification.verifiedBy = req.user.id;
        // verifiedAction enum: 'approved' | 'rejected' | null. For non-final
        // states (freeze/pending/waitlist) we keep whatever was there before
        // — admins are not making a fresh approve/reject decision.
        if (action === 'approve') biz.verification.verifiedAction = 'approved';
        if (action === 'reject')  biz.verification.verifiedAction = 'rejected';
        // pending/waitlist: clear the prior decision, since the listing is back in moderation.
        if (action === 'pending' || action === 'waitlist') biz.verification.verifiedAction = null;
        if (notes) biz.verification.staffNotes = notes;
        if (action === 'approve') biz.verification.staffApproved = true;
        if (action === 'reject')  biz.verification.staffApproved = false;
        if (action === 'pending') biz.verification.staffApproved = false;

        // ── Rejection-kind markers ────────────────────────────────────────
        // Only set on reject. Cleared on any non-rejected outcome so a listing
        // that's re-approved / reset doesn't carry a stale 'hard' marker.
        if (action === 'reject') {
            biz.verification.rejectionKind  = isHardReject ? 'hard' : 'soft';
            biz.verification.hardRejectedAt = isHardReject ? new Date() : null;
        } else {
            biz.verification.rejectionKind  = null;
            biz.verification.hardRejectedAt = null;
        }

        // 3. audit trail entry
        biz.verification.history = biz.verification.history || [];
        biz.verification.history.push({
            action: historyAction,
            by: req.user.id,
            byRole: 'admin',
            notes: (isHardReject ? '[PERMANENT] ' : '') + (notes || (action === 'pending'  ? 'Reset to pending (admin/test)' :
                             action === 'waitlist' ? 'Moved to waitlist (admin/test)' :
                             action === 'freeze'   ? 'Frozen by admin' : '')),
            at: new Date()
        });

        await biz.save();

        // ── Side-effects on reject ────────────────────────────────────────
        // Run AFTER save so the rejection is durable even if a side-effect throws.
        if (action === 'reject') {
            if (isHardReject) {
                // Permanent reject → block ALL fingerprints (email, phone,
                // name+city, ip, userId) so the same actor can't re-apply.
                // promote:true lifts any existing 'watch' up to 'block'.
                try {
                    await blocklistService.flagFromBusiness({
                        business: biz,
                        rejectedByUserId: req.user.id,
                        reason: notes,
                        types: ['email', 'phone', 'name+city', 'ip', 'userId'],
                        severity: 'block',
                        promote: true
                    });
                } catch (e) { console.warn('Hard-reject blocklist (admin) failed:', e.message); }

                // ── Disable the owner's login ─────────────────────────────
                // A permanent reject locks the actor out, not just the listing.
                // Safety rail: never auto-deactivate an admin/staff account.
                if (biz.owner) {
                    try {
                        const owner = await User.findById(biz.owner).select('role isAdmin');
                        const privileged = owner && (owner.role === 'admin' || owner.role === 'staff' || owner.isAdmin === true);
                        if (owner && !privileged) {
                            await User.findByIdAndUpdate(owner._id, { $set: { isActive: false } });
                        }
                    } catch (e) { console.warn('Owner deactivation on admin hard reject failed:', e.message); }
                }
            } else {
                // (a) Auto-flag: if N+ rejected listings share the same phone/email,
                //     create or promote a fingerprint entry.
                try { await blocklistService.autoFlagFromRejection(biz); }
                catch (e) { console.warn('Auto-flag on admin rejection failed:', e.message); }

                // (b) Optional manual flag — admin checked a "flag this owner" box.
                if (req.body?.flagFingerprints) {
                    try {
                        await blocklistService.flagFromBusiness({
                            business: biz,
                            rejectedByUserId: req.user.id,
                            reason: notes,
                            types: Array.isArray(req.body.flagTypes) && req.body.flagTypes.length
                                ? req.body.flagTypes
                                : ['email', 'phone'],
                            severity: 'watch'
                        });
                    } catch (e) { console.warn('Manual flag on admin rejection failed:', e.message); }
                }
            }

            // (c) Email the owner so they know what happened. Soft → "fix and
            //     resubmit"; hard → neutral "declined / contact support" copy.
            if (biz.contact?.email) {
                try {
                    await emailService.sendRejectionEmail(
                        biz.contact.email,
                        biz.name,
                        notes,
                        biz._id,
                        { permanent: isHardReject }
                    );
                } catch (e) { console.warn('Admin rejection email failed:', e.message); }
            }
        }

        // Re-fetch with populated verification refs so the frontend can show
        // the verifier's name/email/role next to the new audit-history entry
        // (and in the "Last Verified" block) without a follow-up request.
        const populated = await Business.findById(biz._id).populate(VERIFICATION_POPULATE).lean();
        res.json({
            success: true,
            data: {
                status:       populated.status,
                isActive:     populated.isActive,
                verification: populated.verification
            }
        });
    } catch (error) {
        console.error(`Admin ${action} business error:`, error);
        res.status(500).json({ success: false, error: error.message || `Failed to ${action} business` });
    }
}

router.post('/businesses/:id/approve',  (req, res) => applyModeration(req, res, 'approve'));
router.post('/businesses/:id/freeze',   (req, res) => applyModeration(req, res, 'freeze'));
router.post('/businesses/:id/reject',   (req, res) => applyModeration(req, res, 'reject'));
router.post('/businesses/:id/pending',  (req, res) => applyModeration(req, res, 'pending'));
router.post('/businesses/:id/waitlist', (req, res) => applyModeration(req, res, 'waitlist'));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/businesses/:id/downgrade-rejection
// Admin-only (this whole router is gated by auth+admin). Converts a PERMANENT
// (hard) rejection back to a SOFT one so the owner can edit and resubmit again.
//
//   • status stays 'rejected' (soft) — the owner resubmits from their dashboard,
//     which re-pends the listing via PUT /business/:id.
//   • the blocklist entries this rejection created are lifted (see
//     blocklistService.liftHardRejectBlocks).
//   • an audit-trail entry (action 'downgraded') records who/when/why.
//   • the owner is emailed that they can resubmit.
//
// Body: { notes } — required, the justification (audit trail + owner email).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/businesses/:id/downgrade-rejection', async (req, res) => {
    try {
        const biz = await Business.findById(req.params.id);
        if (!biz) return res.status(404).json({ success: false, error: 'Business not found' });

        const notes = (req.body?.notes || req.body?.reason || '').trim();
        if (!notes) {
            return res.status(400).json({ success: false, error: 'A note is required to downgrade a permanent rejection.' });
        }
        if (biz.verification?.rejectionKind !== 'hard') {
            return res.status(400).json({
                success: false,
                error: 'This listing is not under a permanent rejection — nothing to downgrade.'
            });
        }

        // Lift the block entries created by the hard rejection. Runs before the
        // flag flip so that, even if it partially fails, we still record what we
        // attempted in the audit note.
        let lifted = [];
        try { lifted = await blocklistService.liftHardRejectBlocks(biz); }
        catch (e) { console.warn('liftHardRejectBlocks failed:', e.message); }

        biz.verification = biz.verification || {};
        biz.verification.rejectionKind  = 'soft';
        biz.verification.hardRejectedAt = null;
        // Keep status 'rejected' + verifiedAction 'rejected' so the owner sees
        // the reviewer note and the "fix & resubmit" path; the downgrade just
        // removes the permanence.
        biz.verification.history = biz.verification.history || [];
        biz.verification.history.push({
            action: 'downgraded',
            by:     req.user.id,
            byRole: 'admin',
            notes:  `Permanent rejection downgraded to soft. ${notes}${lifted.length ? ` (blocklist: ${lifted.join('; ')})` : ''}`,
            at:     new Date()
        });

        await biz.save();

        // Re-enable the owner's login. The hard reject deactivated it; a
        // downgrade re-opens the listing for editing/resubmission, which is
        // pointless if they can't log in. Only flip accounts that are currently
        // deactivated AND not privileged (we never touched admin/staff on the
        // way in, so we don't reactivate them here either).
        if (biz.owner) {
            try {
                const owner = await User.findById(biz.owner).select('role isAdmin isActive');
                const privileged = owner && (owner.role === 'admin' || owner.role === 'staff' || owner.isAdmin === true);
                if (owner && !privileged && owner.isActive === false) {
                    await User.findByIdAndUpdate(owner._id, { $set: { isActive: true } });
                }
            } catch (e) { console.warn('Owner reactivation on downgrade failed:', e.message); }
        }

        // Tell the owner they can resubmit now.
        if (biz.contact?.email) {
            try {
                await emailService.sendRejectionDowngradedEmail(
                    biz.contact.email, biz.name, notes, biz._id
                );
            } catch (e) { console.warn('Downgrade email failed:', e.message); }
        }

        const populated = await Business.findById(biz._id).populate(VERIFICATION_POPULATE).lean();
        res.json({
            success: true,
            data: {
                status:       populated.status,
                isActive:     populated.isActive,
                verification: populated.verification
            },
            liftedBlocklist: lifted
        });
    } catch (error) {
        console.error('Downgrade rejection error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to downgrade rejection' });
    }
});

// Delete a business
router.delete('/businesses/:id', async (req, res) => {
    try {
        const biz = await Business.findById(req.params.id);
        if (!biz) return res.status(404).json({ success: false, error: 'Business not found' });

        // If this listing is an active Signature holding a zone slot, note the
        // zone so we can promote the top waitlisted bidder into the freed slot
        // AFTER deletion. An admin delete is an immediate clean vacancy — the
        // listing is gone, so the slot should free now and the highest bidder
        // enters right away. Without this, deleting from the admin page silently
        // empties the slot and no bidder is ever promoted (the auction scheduler
        // only resolves slots cancelled through the proper flow, not deletions).
        const freesSignatureSlot =
            biz.status === 'active' &&
            biz.partnership?.tier === 'signature' &&
            !!biz.zoneKey;
        const freedZoneKey = freesSignatureSlot ? biz.zoneKey : null;

        // Clean up analytics tied to this business to avoid orphaned references.
        try { await Analytics.deleteMany({ businessId: biz._id }); }
        catch (cleanupErr) { console.warn('Analytics cleanup on business delete failed:', cleanupErr.message); }

        await Business.findByIdAndDelete(req.params.id);

        // Promote the top bidder into the now-empty Signature slot. Best-effort
        // and isolated: a promotion failure must never fail the delete the admin
        // requested.
        let promotion = null;
        if (freedZoneKey) {
            try {
                const result = await zoneAuction._promoteTopBidder(freedZoneKey);
                if (result?.promoted) {
                    promotion = { promoted: true, winnerId: result.winnerId, price: result.price };
                    console.log(`⚖️ Promoted bidder ${result.winnerId} into zone ${freedZoneKey} at $${result.price}/mo after admin deletion of ${biz._id}.`);
                } else {
                    promotion = { promoted: false, reason: result?.reason || 'empty bid book' };
                    console.log(`⚖️ Slot freed in zone ${freedZoneKey} but no bidder promoted (${promotion.reason}).`);
                }
            } catch (promoteErr) {
                console.error('⚖️ Bidder promotion after admin deletion failed (slot left open):', promoteErr);
            }
        }

        res.json({
            success: true,
            message: `Business "${biz.name}" deleted`,
            ...(promotion ? { promotion } : {})
        });
    } catch (error) {
        console.error('Delete business error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete business' });
    }
});

// ─── BLOCKLIST (abuse-prevention registry) ───────────────────────────────────
//
// Backed by models/BlockedFingerprint.js. See services/blocklistService.js for
// normalization rules and lookup behaviour.

// List all blocklist entries with simple paging and optional filtering.
router.get('/blocklist', async (req, res) => {
    try {
        const { type, severity, q, limit = 50, skip = 0 } = req.query;
        const filter = {};
        if (type)     filter.type     = type;
        if (severity) filter.severity = severity;
        if (q)        filter.value    = { $regex: String(q).trim(), $options: 'i' };

        const [entries, total] = await Promise.all([
            BlockedFingerprint.find(filter)
                .sort({ lastHitAt: -1, createdAt: -1 })
                .limit(Math.min(parseInt(limit, 10) || 50, 200))
                .skip(parseInt(skip, 10) || 0)
                .populate('createdBy', 'email name')
                .populate('evidence.businessId', 'name location.city status')
                .lean(),
            BlockedFingerprint.countDocuments(filter)
        ]);
        res.json({ success: true, data: entries, total });
    } catch (e) {
        console.error('GET /admin/blocklist failed:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Create a manual blocklist entry (admin paste a phone/email/IP directly).
router.post('/blocklist', async (req, res) => {
    try {
        const { type, value, severity = 'watch', reason, expiresAt } = req.body;
        if (!type || !value) {
            return res.status(400).json({ success: false, error: 'type and value are required' });
        }
        const ALLOWED_TYPES = ['email', 'phone', 'name+city', 'ip', 'userId'];
        if (!ALLOWED_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: `type must be one of ${ALLOWED_TYPES.join(', ')}` });
        }
        if (!['watch', 'block'].includes(severity)) {
            return res.status(400).json({ success: false, error: 'severity must be watch or block' });
        }

        // Normalize the value through the same helpers /apply uses, so the
        // entry matches future lookups.
        let normalized = String(value).trim();
        if (type === 'email')      normalized = blocklistService.normalizeEmail(value);
        else if (type === 'phone') normalized = blocklistService.normalizePhone(value);
        else if (type === 'ip')    normalized = blocklistService.normalizeIp(value);
        if (!normalized) {
            return res.status(400).json({ success: false, error: 'value could not be normalized' });
        }

        const doc = await BlockedFingerprint.findOneAndUpdate(
            { type, value: normalized },
            {
                $set: {
                    severity,
                    reason: reason || '',
                    expiresAt: expiresAt ? new Date(expiresAt) : null,
                    createdBy: req.user.id
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json({ success: true, data: doc });
    } catch (e) {
        console.error('POST /admin/blocklist failed:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Update an existing entry (typical use: promote 'watch' → 'block', edit reason or expiry).
router.patch('/blocklist/:id', async (req, res) => {
    try {
        const updates = {};
        if (req.body.severity)  updates.severity  = req.body.severity;
        if (req.body.reason !== undefined) updates.reason = req.body.reason;
        if (req.body.expiresAt !== undefined) {
            updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
        }
        const doc = await BlockedFingerprint.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        );
        if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: doc });
    } catch (e) {
        console.error(`PATCH /admin/blocklist/${req.params.id} failed:`, e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Delete (false positive, or after the abuse situation has cooled off).
router.delete('/blocklist/:id', async (req, res) => {
    try {
        const result = await BlockedFingerprint.findByIdAndDelete(req.params.id);
        if (!result) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true });
    } catch (e) {
        console.error(`DELETE /admin/blocklist/${req.params.id} failed:`, e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Check whether a given fingerprint would currently be blocked. Useful for
// admin tooling — paste a phone/email and see what would happen.
router.post('/blocklist/check', async (req, res) => {
    try {
        const fingerprints = blocklistService.buildFingerprints(req.body || {});
        const hits = await blocklistService.checkFingerprints(fingerprints);
        res.json({
            success: true,
            wouldBlock: hits.some(h => h.severity === 'block'),
            hits
        });
    } catch (e) {
        console.error('POST /admin/blocklist/check failed:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});


/**
 * POST /api/admin/zones/:zoneKey/backfill
 * Promote the top waitlisted bidder(s) into a zone that is currently under-full
 * (fewer than 3 active Signatures). Useful to clean up slots that were emptied
 * before promotion-on-delete existed — e.g. a business deleted directly in the
 * DB or via the old admin delete route, leaving bidders stuck on the waitlist.
 *
 * Promotes repeatedly until the zone is full (3 Signatures) or the bid book is
 * empty. Pass ?dryRun=true to preview who WOULD be promoted without writing.
 */
router.post('/zones/:zoneKey/backfill', async (req, res) => {
    try {
        const { zoneKey } = req.params;
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

        const MAX_SLOTS = zoneAuction.ZONE_MAX_SLOTS || 3;
        const current = await zoneAuction.getZoneSignatures(zoneKey);
        let openSlots = MAX_SLOTS - current.length;
        if (openSlots <= 0) {
            return res.json({ success: true, zoneKey, message: 'Zone is already full — nothing to backfill.', promoted: [] });
        }

        const promoted = [];
        // Guard the loop so a bug can never spin forever: at most MAX_SLOTS tries.
        for (let i = 0; i < openSlots; i++) {
            const result = await zoneAuction._promoteTopBidder(zoneKey, new Date(), { dryRun });
            if (!result?.promoted) break; // bid book empty
            promoted.push(dryRun
                ? { plan: result.plan }
                : { winnerId: result.winnerId, price: result.price });
            // In dryRun the winner isn't actually moved into the zone, so a second
            // iteration would re-pick the same top bidder. Only loop for real runs.
            if (dryRun) break;
        }

        res.json({
            success: true,
            zoneKey,
            dryRun,
            openSlotsBefore: openSlots,
            promotedCount: dryRun ? undefined : promoted.length,
            promoted,
            message: dryRun
                ? 'Dry run — no changes made. Shows the next bidder that would be promoted.'
                : `Backfilled ${promoted.length} slot(s) in zone ${zoneKey}.`
        });
    } catch (error) {
        console.error('Zone backfill error:', error);
        res.status(500).json({ success: false, error: 'Failed to backfill zone' });
    }
});

// ─── DESTINATIONS ─────────────────────────────────────────────────────────────
router.get('/destinations', async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '', filter = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = {};
        if (search) query.name = { $regex: search, $options: 'i' };
        if (filter === 'active') query.isActive = true;
        if (filter === 'inactive') query.isActive = false;
        if (filter === 'hidden_gem') query.isHiddenGem = true;
        const [destinations, total, summaryAgg, interactionAgg] = await Promise.all([
            Destination.find(query)
                .populate('nearbyBusinesses', 'name')
                .populate('createdBy', 'name email role')
                .sort({ popularity: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Destination.countDocuments(query),
            Destination.aggregate([
                { $group: {
                    _id: null,
                    total: { $sum: 1 },
                    active: { $sum: { $cond: ['$isActive', 1, 0] } },
                    hiddenGems: { $sum: { $cond: ['$isHiddenGem', 1, 0] } },
                    avgPopularity: { $avg: '$popularity' },
                    totalBusinessLinks: { $sum: { $size: '$nearbyBusinesses' } },
                    totalViews: { $sum: '$analytics.views' },
                    totalClicks: { $sum: '$analytics.clicks' },
                    totalConversions: { $sum: '$analytics.conversions' }
                }}
            ]),
            Analytics.aggregate([
                { $match: { type: 'place_interaction', 'metadata.verifiedId': { $exists: true, $ne: null } } },
                { $group: {
                    _id: { id: '$metadata.verifiedId', type: '$metadata.interactionType' },
                    count: { $sum: 1 }
                }}
            ])
        ]);

        const interactionMap = {};
        interactionAgg.forEach(({ _id, count }) => {
            if (!_id.id) return;
            const key = _id.id.toString();
            if (!interactionMap[key]) interactionMap[key] = { map_open: 0, website_click: 0, phone_click: 0 };
            if (_id.type === 'map_open') interactionMap[key].map_open = count;
            else if (_id.type === 'website_click') interactionMap[key].website_click = count;
            else if (_id.type === 'phone_click') interactionMap[key].phone_click = count;
        });

        const enriched = destinations.map(d => ({
            ...d,
            interactions: interactionMap[d._id.toString()] || { map_open: 0, website_click: 0, phone_click: 0 }
        }));

        res.json({ success: true, data: { destinations: enriched, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), summary: summaryAgg[0] || {} } });
    } catch (error) {
        console.error('Destinations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch destinations' });
    }
});

// ─── CREATE DESTINATION (admin-authored) ─────────────────────────────────────
// New destinations are always created by an admin from the dashboard — there's
// no public submission flow like there is for businesses. We stamp createdBy
// with req.user.id so the admin table can show "added by …".
router.post('/destinations', async (req, res) => {
    try {
        const allowed = [
            'name', 'type', 'location', 'contact', 'description', 'images',
            'openingHours', 'pricing', 'bestTimeToVisit',
            'nearbyBusinesses', 'popularity', 'isHiddenGem', 'isActive'
        ];
        const payload = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

        if (!payload.name || !payload.name.trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        if (!Array.isArray(payload.type) || !payload.type.length) {
            return res.status(400).json({ success: false, error: 'At least one type is required' });
        }

        payload.createdBy = req.user.id;
        const dest = await Destination.create(payload);
        const populated = await Destination.findById(dest._id)
            .populate('nearbyBusinesses', 'name')
            .populate('createdBy', 'name email role')
            .lean();
        // Match the shape the GET route returns (interactions placeholder).
        populated.interactions = { map_open: 0, website_click: 0, phone_click: 0 };
        res.json({ success: true, data: populated });
    } catch (error) {
        console.error('Create destination error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create destination' });
    }
});

// ─── UPDATE DESTINATION (full edit) ──────────────────────────────────────────
router.patch('/destinations/:id', async (req, res) => {
    try {
        const allowed = [
            'name', 'type', 'location', 'contact', 'description', 'images',
            'openingHours', 'pricing', 'bestTimeToVisit',
            'nearbyBusinesses', 'popularity', 'isHiddenGem', 'isActive'
        ];
        const updates = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
        const dest = await Destination.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true })
            .populate('createdBy', 'name email role');
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });
        res.json({ success: true, data: dest });
    } catch (error) {
        console.error('Update destination error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to update destination' });
    }
});

router.patch('/destinations/:id/toggle', async (req, res) => {
    try {
        const dest = await Destination.findById(req.params.id);
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });
        dest.isActive = !dest.isActive;
        await dest.save();
        res.json({ success: true, data: { isActive: dest.isActive } });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to toggle destination' }) }
});

// Delete a destination
router.delete('/destinations/:id', async (req, res) => {
    try {
        const dest = await Destination.findById(req.params.id);
        if (!dest) return res.status(404).json({ success: false, error: 'Destination not found' });
        await Destination.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: `Destination "${dest.name}" deleted` });
    } catch (error) {
        console.error('Delete destination error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete destination' });
    }
});

// ─── ANALYTICS EVENTS ─────────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const data = await Analytics.aggregate([
            { $match: { date: { $gte: startDate } } },
            { $group: { _id: { type: '$type', date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } }, count: { $sum: 1 } } },
            { $group: { _id: '$_id.date', events: { $push: { type: '$_id.type', count: '$count' } }, total: { $sum: '$count' } } },
            { $sort: { _id: 1 } }
        ]);
        res.json({ success: true, data });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to fetch events' }) }
});

// ─── GOOGLE PLACES CACHE ──────────────────────────────────────────────────────
router.get('/places', async (req, res) => {
    try {
        const { page = 1, limit = 24, search = '', sort = 'useCount', order = 'desc', hasImage = '', neverUsed = '', action = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = {};
        if (search) { query.$or = [{ name: { $regex: search, $options: 'i' } }, { 'details.formatted_address': { $regex: search, $options: 'i' } }] }
        if (hasImage === 'true')  query.imagesStored = true;
        if (hasImage === 'false') query.imagesStored = { $ne: true };
        if (neverUsed === 'true') query.useCount = { $lte: 1 };
        // Quick-action filter: show only places that have actually been SHOWN under
        // this action (the `actions` array is ground-truth, recorded at request time).
        // e.g. action=hotels → only places tagged as hotels in the cache.
        if (action) query.actions = action;
        const sortObj = { [sort]: order === 'asc' ? 1 : -1 };
        const [places, total, summaryAgg] = await Promise.all([
            PlaceCache.find(query).sort(sortObj).skip(skip).limit(parseInt(limit)).select('placeId name rating details.formatted_address photos.url photos.width photos.height photos.contentType imagesStored hasDetailedInfo fetchCount useCount lastFetched lastUsed createdAt actions likes dislikes eventSchedule priceLevel types primaryType').lean(),
            PlaceCache.countDocuments(query),
            PlaceCache.aggregate([
                { $sort: { createdAt: 1 } },
                { $group: {
                    _id: null,
                    totalPlaces: { $sum: 1 },
                    withImages: { $sum: { $cond: ['$imagesStored', 1, 0] } },
                    withDetails: { $sum: { $cond: ['$hasDetailedInfo', 1, 0] } },
                    totalFetches: { $sum: '$fetchCount' },
                    totalUses: { $sum: '$useCount' },
                    avgRating: { $avg: '$rating' },
                    oldestCreatedAt: { $min: '$createdAt' },
                    oldestPlaceName: { $first: '$name' }
                }}
            ])
        ]);
        // Attach the luxury↔budget tier (Step 2) for display — computed from the same
        // shared helper the recommendation ranking will use, so admin and runtime agree.
        const placesWithTier = places.map(p => {
            const { tier, source } = priceTier(p.types, p.primaryType, p.priceLevel);
            return { ...p, priceTier: tier, priceTierLabel: priceTierLabel(tier), priceTierSource: source, priceDollars: priceLevelDollars(p.priceLevel) };
        });
        res.json({ success: true, data: { places: placesWithTier, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), summary: summaryAgg[0] || {} } });
    } catch (error) {
        console.error('Admin places error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch places' });
    }
});

// Bulk delete stale places — must be before /:placeId
router.delete('/places/stale/:days', async (req, res) => {
    try {
        const days = parseInt(req.params.days) || 30;
        const { neverUsed = 'false' } = req.query;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const query = { lastUsed: { $lt: cutoff } };
        if (neverUsed === 'true') query.useCount = { $lte: 1 };
        const result = await PlaceCache.deleteMany(query);
        const filterDesc = neverUsed === 'true' ? `not used in ${days} days AND never used (useCount ≤ 1)` : `not used in ${days} days`;
        res.json({ success: true, deleted: result.deletedCount, message: `Deleted ${result.deletedCount} places: ${filterDesc}` });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to purge stale places' }) }
});

// Delete a single cached place
router.delete('/places/:placeId', async (req, res) => {
    try {
        const result = await PlaceCache.findOneAndDelete({ placeId: req.params.placeId });
        if (!result) return res.status(404).json({ success: false, error: 'Place not found in cache' });
        res.json({ success: true, message: `"${result.name}" removed from cache` });
    } catch (error) { res.status(500).json({ success: false, error: 'Failed to delete cached place' }) }
});

router.get('/google-usage', async (req, res) => {
    try {
        const now = new Date();
        const todayStr  = now.toISOString().slice(0, 10);                                         // 'YYYY-MM-DD'
        const monthStr  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;  // 'YYYY-MM'

        // Billing rates per call — Places API (New) pricing as of March 2025.
        // The old $200 monthly credit was replaced with per-SKU free caps. Field
        // masks determine which SKU fires; we infer the SKU from how we call it
        // in googleService.js (see SKU column below). All rates are USD/call.
        //
        //   findPlaces: text search with `places.id,places.location` field mask
        //     → location is a Pro field → Text Search Pro: $0.032/call, 5,000 free
        //   getPlaceDetails: requests rating + phone (Enterprise fields)
        //     → Place Details Enterprise: $0.020/call, 1,000 free
        //   reverseGeocode: standard geocode call
        //     → Geocoding (Essentials): $0.005/call, 10,000 free
        //   imageDownload: place photo media fetch
        //     → Place Details Photos (Enterprise): $0.007/call, 1,000 free
        //
        // If you ever change the field masks in googleService.js, re-check the
        // SKU here — a single extra field can bump you to a more expensive tier.
        const FIND_RATE     = 0.032;  // Text Search Pro
        const DETAILS_RATE  = 0.020;  // Place Details Enterprise
        const GEOCODE_RATE  = 0.005;  // Geocoding Essentials
        const PHOTO_RATE    = 0.007;  // Place Details Photos (Enterprise)

        // Per-SKU free monthly thresholds. Each SKU has its own bucket — they
        // do NOT pool. Hit the cap on one and you pay for additional calls on
        // that SKU even if other SKUs are nowhere near their cap.
        const FIND_FREE     = 5000;   // Pro tier
        const DETAILS_FREE  = 1000;   // Enterprise tier
        const GEOCODE_FREE  = 10000;  // Essentials tier
        const PHOTO_FREE    = 1000;   // Enterprise tier

        // Helper: bill only calls above the free threshold for that SKU.
        const billable = (calls, free) => Math.max(0, (calls || 0) - free);

        const [statsAgg, placeCacheAgg, topPlaces] = await Promise.all([
            // Accurate call counts from GoogleApiStats (every real API call tracked here)
            GoogleApiStats.aggregate([
                { $group: {
                    _id: null,
                    totalFindPlaces:      { $sum: '$findPlaces' },
                    totalDetails:         { $sum: '$getPlaceDetails' },
                    totalGeocode:         { $sum: '$reverseGeocode' },
                    totalImages:          { $sum: '$imageDownload' },
                    // today
                    todayFindPlaces:      { $sum: { $cond: [{ $eq: ['$date', todayStr] }, '$findPlaces', 0] } },
                    todayDetails:         { $sum: { $cond: [{ $eq: ['$date', todayStr] }, '$getPlaceDetails', 0] } },
                    todayGeocode:         { $sum: { $cond: [{ $eq: ['$date', todayStr] }, '$reverseGeocode', 0] } },
                    todayImages:          { $sum: { $cond: [{ $eq: ['$date', todayStr] }, '$imageDownload', 0] } },
                    // this month
                    monthFindPlaces:      { $sum: { $cond: [{ $gte: ['$date', monthStr + '-01'] }, '$findPlaces', 0] } },
                    monthDetails:         { $sum: { $cond: [{ $gte: ['$date', monthStr + '-01'] }, '$getPlaceDetails', 0] } },
                    monthGeocode:         { $sum: { $cond: [{ $gte: ['$date', monthStr + '-01'] }, '$reverseGeocode', 0] } },
                    monthImages:          { $sum: { $cond: [{ $gte: ['$date', monthStr + '-01'] }, '$imageDownload', 0] } },
                }}
            ]),
            // PlaceCache for cache-health metrics (hit rate, stored places, etc.)
            PlaceCache.aggregate([{ $group: {
                _id: null,
                totalPlaces:        { $sum: 1 },
                withImages:         { $sum: { $cond: ['$imagesStored', 1, 0] } },
                totalUses:          { $sum: '$useCount' },
                totalFetches:       { $sum: '$fetchCount' },
                avgFetchesPerPlace: { $avg: '$fetchCount' },
            }}]),
            PlaceCache.find({}).sort({ fetchCount: -1 }).limit(10)
                .select('name fetchCount useCount imagesStored rating lastFetched details.formatted_address').lean()
        ]);

        const st = statsAgg[0] || {};
        const pc = placeCacheAgg[0] || {};

        // ── Totals ────────────────────────────────────────────────────────────
        const totalFindCalls    = st.totalFindPlaces || 0;
        const totalDetailsCalls = st.totalDetails    || 0;
        const totalGeocodeCalls = st.totalGeocode    || 0;
        const totalImageCalls   = st.totalImages     || 0;
        const totalBilledCalls  = totalFindCalls + totalDetailsCalls + totalGeocodeCalls + totalImageCalls;

        // ── Today ─────────────────────────────────────────────────────────────
        const todayFindCalls    = st.todayFindPlaces || 0;
        const todayDetailsCalls = st.todayDetails    || 0;
        const todayGeocodeCalls = st.todayGeocode    || 0;
        const todayImageCalls   = st.todayImages     || 0;
        const todayBilledCalls  = todayFindCalls + todayDetailsCalls + todayGeocodeCalls + todayImageCalls;

        // ── This month ────────────────────────────────────────────────────────
        const monthFindCalls    = st.monthFindPlaces || 0;
        const monthDetailsCalls = st.monthDetails    || 0;
        const monthGeocodeCalls = st.monthGeocode    || 0;
        const monthImageCalls   = st.monthImages     || 0;
        const monthBilledCalls  = monthFindCalls + monthDetailsCalls + monthGeocodeCalls + monthImageCalls;

        // ── Costs ─────────────────────────────────────────────────────────────
        // Total and today's costs are raw (no free threshold) — total is across
        // all time so the free cap was likely consumed many times over, and
        // today's is fractional. Monthly cost is the one that matters for the
        // bill, and it applies the per-SKU free caps before multiplying.
        const totalCost = (totalFindCalls * FIND_RATE) + (totalDetailsCalls * DETAILS_RATE) + (totalGeocodeCalls * GEOCODE_RATE) + (totalImageCalls * PHOTO_RATE);
        const todayCost = (todayFindCalls * FIND_RATE) + (todayDetailsCalls * DETAILS_RATE) + (todayGeocodeCalls * GEOCODE_RATE) + (todayImageCalls * PHOTO_RATE);
        const monthCost =
            (billable(monthFindCalls,    FIND_FREE)    * FIND_RATE) +
            (billable(monthDetailsCalls, DETAILS_FREE) * DETAILS_RATE) +
            (billable(monthGeocodeCalls, GEOCODE_FREE) * GEOCODE_RATE) +
            (billable(monthImageCalls,   PHOTO_FREE)   * PHOTO_RATE);

        // ── Cache health (from PlaceCache, unchanged) ─────────────────────────
        const cacheHitRate = pc.totalUses > 0
            ? Math.round(((pc.totalUses - pc.totalFetches) / pc.totalUses) * 100)
            : 0;

        res.json({ success: true, data: {
            summary: {
                // cache health
                totalPlaces:        pc.totalPlaces        || 0,
                withImages:         pc.withImages         || 0,
                avgFetchesPerPlace: pc.avgFetchesPerPlace || 0,
                totalUses:          pc.totalUses          || 0,
                cacheHitRate,
                // accurate call breakdown (from GoogleApiStats)
                totalFindCalls,
                totalDetailsCalls,
                totalGeocodeCalls,
                totalImageCalls,
                totalBilledCalls,
                todayFindCalls,
                todayDetailsCalls,
                todayGeocodeCalls,
                todayImageCalls,
                todayBilledCalls,
                monthFindCalls,
                monthDetailsCalls,
                monthGeocodeCalls,
                monthImageCalls,
                monthBilledCalls,
                // costs
                totalCost:  parseFloat(totalCost.toFixed(4)),
                todayCost:  parseFloat(todayCost.toFixed(4)),
                monthCost:  parseFloat(monthCost.toFixed(4)),
                // per-SKU rates and free thresholds, so the frontend can show
                // the breakdown without having to keep its own pricing tables
                // in sync. Cents-per-1K is convenient for the UI ($0.020/call
                // → "$20/1K", which matches Google's own pricing pages).
                pricing: {
                    find:    { rate: FIND_RATE,    free: FIND_FREE,    label: 'Text Search Pro',         per1k: FIND_RATE    * 1000 },
                    details: { rate: DETAILS_RATE, free: DETAILS_FREE, label: 'Place Details Enterprise', per1k: DETAILS_RATE * 1000 },
                    geocode: { rate: GEOCODE_RATE, free: GEOCODE_FREE, label: 'Geocoding Essentials',     per1k: GEOCODE_RATE * 1000 },
                    photo:   { rate: PHOTO_RATE,   free: PHOTO_FREE,   label: 'Place Photos Enterprise',  per1k: PHOTO_RATE   * 1000 },
                },
                // legacy aliases so Prices tab computed still works
                totalFetches: totalBilledCalls,
                todayFetches: todayBilledCalls,
                monthFetches: monthBilledCalls,
            },
            topPlaces
        }});
    } catch (error) {
        console.error('Google usage error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Google usage stats' });
    }
});

// Daily breakdown for the Google chart — last N days from GoogleApiStats.
// Note: the per-day `cost` here doesn't subtract free thresholds — those reset
// monthly, not daily, so per-day cost without the cap is the "raw" daily spend
// (what you'd pay if you had no free tier). The monthly total in /google-usage
// is what reflects actual billing.
router.get('/google-usage/daily', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        // Match the rates in /google-usage above — Places API (New) pricing.
        const FIND_RATE    = 0.032;  // Text Search Pro
        const DETAILS_RATE = 0.020;  // Place Details Enterprise
        const GEOCODE_RATE = 0.005;  // Geocoding Essentials
        const PHOTO_RATE   = 0.007;  // Place Details Photos

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days + 1);
        const startStr = startDate.toISOString().slice(0, 10);

        const rows = await GoogleApiStats.find({ date: { $gte: startStr } })
            .sort({ date: 1 })
            .select('date findPlaces getPlaceDetails reverseGeocode imageDownload')
            .lean();

        const filled = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            const found = rows.find(r => r.date === dateStr);
            const findPlaces      = found?.findPlaces      || 0;
            const getPlaceDetails = found?.getPlaceDetails || 0;
            const reverseGeocode  = found?.reverseGeocode  || 0;
            const imageDownload   = found?.imageDownload   || 0;
            const total = findPlaces + getPlaceDetails + reverseGeocode + imageDownload;
            const cost  = (findPlaces * FIND_RATE) + (getPlaceDetails * DETAILS_RATE) + (reverseGeocode * GEOCODE_RATE) + (imageDownload * PHOTO_RATE);
            filled.push({
                date: dateStr,
                label: dateStr.slice(5),
                findPlaces, getPlaceDetails, reverseGeocode, imageDownload, total,
                cost: parseFloat(cost.toFixed(4)),
            });
        }
        res.json({ success: true, data: filled });
    } catch (error) {
        console.error('Google daily stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Google daily stats' });
    }
});

router.get('/quick-action-stats', async (req, res) => {
    try {
        const ACTION_META = {
           restaurants:  { label: 'Restaurants',   icon: 'restaurant' },
            hotels:       { label: 'Hotels',         icon: 'hotel' },
            hidden_gems:  { label: 'Hidden Gems',    icon: 'gem' },
            historical:   { label: 'Historical',     icon: 'historical' },
            events:       { label: 'Local Events',   icon: 'events' },
        };
        const [quickActionAgg, chatAgg] = await Promise.all([
           Analytics.aggregate([{ $match: { type: 'quick_action_used' } }, { $group: { _id: '$metadata.action', count: { $sum: 1 } } }]),
           Analytics.aggregate([{ $match: { type: 'ai_chat_interaction', 'metadata.actionType': 'stream_chat' } }, { $group: { _id: 'chat_stream', count: { $sum: 1 } } }])
        ]);
        const qaCountMap = {};
        quickActionAgg.forEach(r => { if (r._id) qaCountMap[r._id] = r.count; });
        const actions = Object.entries(ACTION_META).map(([key, meta]) => ({action: key, label: meta.label, icon: meta.icon, count: qaCountMap[key] || 0})).sort((a, b) => b.count - a.count);
        const chatStreamCount = chatAgg[0]?.count || 0;
        const quickActionTotal = actions.reduce((s, a) => s + a.count, 0);
        res.json({success: true, data: {actions,chatStream: { label: 'Chat (AI Stream)', icon: 'chat', count: chatStreamCount },quickActionTotal,chatStreamTotal: chatStreamCount,grandTotal: quickActionTotal + chatStreamCount}});
    } catch (error) {
        console.error('Quick action stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch feature usage stats' });
    }
});

// ─── ONBOARDING PREFERENCE STATS ─────────────────────────────────────────────
// Aggregates from User collection directly (reflects current saved preferences)
router.get('/preference-stats', async (req, res) => {
    try {
        const [travelStyles, interestsAgg, currenciesAgg, locationModeAgg, budgetAgg, onboardingAgg] = await Promise.all([
            // Travel style distribution
            User.aggregate([
                { $match: { onboardingCompleted: true, 'preferences.travelStyle': { $exists: true, $ne: null, $ne: '' } } },
                { $group: { _id: '$preferences.travelStyle', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]),
            // Interest frequency (unwind array)
            User.aggregate([
                { $match: { onboardingCompleted: true, 'preferences.interests.0': { $exists: true } } },
                { $unwind: '$preferences.interests' },
                { $group: { _id: '$preferences.interests', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]),
            // Currency distribution
            User.aggregate([
                { $match: { onboardingCompleted: true, 'preferences.budget.currency': { $exists: true, $ne: null } } },
                { $group: { _id: '$preferences.budget.currency', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 8 }
            ]),
            // Location mode: did user set a travel destination vs. using current location
            User.aggregate([
                { $match: { onboardingCompleted: true } },
                { $group: {
                    _id: null,
                    destination: { $sum: { $cond: [{ $and: [
                        { $ne: ['$preferences.destination.countryName', ''] },
                        { $ne: ['$preferences.destination.countryName', null] }
                    ] }, 1, 0] } },
                    currentLocation: { $sum: { $cond: [{ $or: [
                        { $eq: ['$preferences.destination.countryName', ''] },
                        { $eq: ['$preferences.destination.countryName', null] }
                    ] }, 1, 0] } }
                }}
            ]),
            // Budget bucketing by midpoint of min+max range
            User.aggregate([
                { $match: { onboardingCompleted: true, 'preferences.budget.max': { $exists: true, $gt: 0 } } },
                { $addFields: {
                    budgetMid: {
                        $divide: [
                            { $add: [{ $ifNull: ['$preferences.budget.min', 0] }, '$preferences.budget.max'] },
                            2
                        ]
                    }
                }},
                { $group: {
                    _id: {
                        $switch: {
                            branches: [
                                { case: { $lte: ['$budgetMid', 300] },  then: 'Budget' },
                                { case: { $lte: ['$budgetMid', 1000] }, then: 'Mid-range' }
                            ],
                            default: 'Luxury'
                        }
                    },
                    count: { $sum: 1 }
                }},
                { $sort: { count: -1 } }
            ]),
            // Onboarding completion stats
            User.aggregate([
                { $group: {
                    _id: null,
                    total: { $sum: 1 },
                    completed: { $sum: { $cond: ['$onboardingCompleted', 1, 0] } }
                }}
            ])
        ]);

        const locMode = locationModeAgg[0] || { destination: 0, currentLocation: 0 };
        const ob = onboardingAgg[0] || { total: 0, completed: 0 };

        res.json({
            success: true,
            data: {
                travelStyles,
                interests: interestsAgg,
                currencies: currenciesAgg,
                locationMode: [
                    { _id: 'Set Destination', count: locMode.destination },
                    { _id: 'Current Location', count: locMode.currentLocation }
                ],
                budgetBuckets: budgetAgg,
                onboarding: {
                    total: ob.total,
                    completed: ob.completed,
                    pending: ob.total - ob.completed,
                    completionRate: ob.total > 0 ? Math.round((ob.completed / ob.total) * 100) : 0
                }
            }
        });
    } catch (error) {
        console.error('Preference stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch preference stats' });
    }
});

// ─── MONGODB DB STATS ─────────────────────────────────────────────────────────
// Cluster is now Atlas Flex (was M0). Flex includes 5 GB storage in the base
// $8/month price; extra storage is billed separately via the API. The pct bar
// here is just a visual reference against the included quota — going over
// doesn't break anything, it just adds to the pending invoice.
router.get('/db-stats', async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const [dbStats, collectionNames] = await Promise.all([
            db.stats({ scale: 1 }), // bytes
            db.listCollections().toArray()
        ]);

        const FLEX_INCLUDED_STORAGE_MB = 5 * 1024; // 5 GB included in Flex base price
        const totalCapacityBytes = FLEX_INCLUDED_STORAGE_MB * 1024 * 1024;
        const storageBytes = dbStats.totalSize || (dbStats.storageSize || 0) + (dbStats.indexSize || 0); // totalSize matches Atlas
        const collectionCount = collectionNames.length;
        const usedMB = (storageBytes / (1024 * 1024)).toFixed(2);
        const usedPct = Math.round((storageBytes / totalCapacityBytes) * 100);

        res.json({
            success: true,
            data: {
                usedMB: parseFloat(usedMB),
                capacityMB: FLEX_INCLUDED_STORAGE_MB,
                usedPct,
                collections: collectionCount,
                objects: dbStats.objects || 0,
                indexes: dbStats.indexes || 0,
                tier: 'Flex',
            }
        });
    } catch (error) {
        console.error('DB stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch DB stats' });
    }
});

// ─── MONGODB ATLAS BILLING (real spend via Admin API) ─────────────────────────
// Returns month-to-date cost from the Atlas pending-invoice endpoint, with a
// per-SKU breakdown. The service layer caches for 1 hour; pass ?refresh=1 to
// bypass the cache (use sparingly — Atlas rate-limits the Admin API).
router.get('/mongo-billing', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === '1';
        const data = await mongoBilling.getCurrentMonthSpend(forceRefresh);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Atlas billing error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Atlas billing' });
    }
});

// ─── STAFF MANAGEMENT ─────────────────────────────────────────────────────────
// Admin creates / lists / revokes staff accounts. Staff can validate businesses
// (see businessRoutes.js) but cannot access any other admin function.
//
// Account creation: admin supplies email + name + temp password. Backend creates
// a normal user with role='staff'. Optionally emails the credentials to the
// staff member with a strong recommendation to change the password immediately
// (via the existing Forgot-password flow).
//
// Note: this whole router uses `router.use(auth, admin)` at the top, so every
// route below is admin-only.

const STAFF_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateStaffPassword(pw) {
    if (typeof pw !== 'string') return 'Password must be a string';
    if (pw.length < 8)          return 'Password must be at least 8 characters';
    if (!/[A-Za-z]/.test(pw))   return 'Password must include a letter';
    if (!/[0-9]/.test(pw))      return 'Password must include a number';
    return null;
}

/**
 * POST /api/admin/staff
 * Body: { email, name?, tempPassword, sendEmail? }
 * Creates a staff user (role='staff'). Password is the temp password the admin
 * supplied — staff will use it to log in normally. If sendEmail=true, emails
 * the credentials with a recommendation to change the password immediately.
 */
router.post('/staff', async (req, res) => {
    try {
        const { email, name, tempPassword, sendEmail } = req.body || {};

        if (!email || !STAFF_EMAIL_RE.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' });
        }
        const pwErr = validateStaffPassword(tempPassword);
        if (pwErr) return res.status(400).json({ success: false, error: pwErr });

        const cleanEmail = email.toLowerCase().trim();
        const existing = await User.findOne({ email: cleanEmail });
        if (existing) {
            return res.status(409).json({ success: false, error: 'A user with this email already exists' });
        }

        // Create the staff user. Password is hashed by the User pre-save hook.
        // onboardingCompleted=true so the router doesn't redirect to traveler onboarding.
        // mustChangePassword=true so the staff is forced to rotate the temp password.
        const splitToArray = v => Array.isArray(v)
            ? v.map(s => String(s).trim()).filter(Boolean)
            : [];

        const countries         = splitToArray(req.body.countries);
        const cities            = splitToArray(req.body.cities);
        // Priority arrays must be subsets of their parent — silently filter invalid.
        const priorityCountries = splitToArray(req.body.priorityCountries).filter(c => countries.includes(c));
        const priorityCities    = splitToArray(req.body.priorityCities).filter(c => cities.includes(c));

        // ── Permissions ───────────────────────────────────────────────────
        // Admin chooses what this staff member is allowed to do. Default to
        // validate-only (the original behaviour) if the field is missing or
        // shaped unexpectedly. At least one must be true — a staff member
        // with nothing enabled would have nothing to do.
        const pIn = req.body.permissions && typeof req.body.permissions === 'object' ? req.body.permissions : {};
        let permissions = {
            validateBusinesses: pIn.validateBusinesses !== false,   // default true
            manageDestinations: pIn.manageDestinations === true     // default false
        };
        if (!permissions.validateBusinesses && !permissions.manageDestinations) {
            return res.status(400).json({
                success: false,
                error: 'Staff must have at least one permission (validate businesses or manage destinations)'
            });
        }

        const staff = new User({
            email: cleanEmail,
            password: tempPassword,
            name: (name && name.trim()) || cleanEmail.split('@')[0],
            role: 'staff',
            onboardingCompleted: true,
            isActive: true,
            mustChangePassword: true,
            staffAssignment: {
                countries,
                cities,
                priorityCountries,
                priorityCities,
                assignedAt: (countries.length || cities.length) ? new Date() : null,
                assignedBy: (countries.length || cities.length) ? req.user.id : null,
                notes: typeof req.body.notes === 'string' ? req.body.notes : '',
                permissions
            }
        });
        await staff.save();

        // Optionally email credentials. Don't fail the request if email errors.
        let emailSent = false;
        if (sendEmail) {
            try {
                await emailService.sendStaffCredentialsEmail(cleanEmail, staff.name, tempPassword);
                emailSent = true;
            } catch (e) {
                console.warn('[staff create] credentials email failed:', e.message);
            }
        }

        return res.status(201).json({
            success: true,
            emailSent,
            staff: {
                _id: staff._id,
                email: staff.email,
                name: staff.name,
                role: staff.role,
                isActive: staff.isActive,
                mustChangePassword: staff.mustChangePassword,
                staffAssignment: staff.staffAssignment,
                createdAt: staff.createdAt,
            },
        });
    } catch (err) {
        console.error('[staff create] error:', err);
        return res.status(500).json({ success: false, error: 'Failed to create staff account' });
    }
});

/**
 * GET /api/admin/staff
 * Returns all staff accounts (active and revoked).
 */
router.get('/staff', async (req, res) => {
    try {
        const staff = await User.find({ role: 'staff' })
            .select('email name role isActive mustChangePassword staffAssignment createdAt analytics.lastActive')
            .populate('staffAssignment.assignedBy', 'name email')
            .sort({ createdAt: -1 })
            .lean();
        return res.json({ success: true, staff, total: staff.length });
    } catch (err) {
        console.error('[staff list] error:', err);
        return res.status(500).json({ success: false, error: 'Failed to list staff' });
    }
});

/**
 * PATCH /api/admin/staff/:id/assignment
 * Updates a staff member's territorial scope.
 * Body: { countries?, cities?, priorityCountries?, priorityCities?, notes? }
 * Each field is replaced wholesale when provided (pass [] to clear).
 * Priority arrays are silently filtered to subsets of their parent arrays.
 */
router.patch('/staff/:id/assignment', async (req, res) => {
    try {
        const target = await User.findById(req.params.id);
        if (!target) return res.status(404).json({ success: false, error: 'Staff member not found' });
        if (target.role !== 'staff') {
            return res.status(400).json({ success: false, error: 'User is not a staff member' });
        }

        const a = target.staffAssignment || {};
        const cleanArr = v => v.map(s => String(s).trim()).filter(Boolean);

        if (Array.isArray(req.body.countries))         a.countries         = cleanArr(req.body.countries);
        if (Array.isArray(req.body.cities))            a.cities            = cleanArr(req.body.cities);
        if (Array.isArray(req.body.priorityCountries)) a.priorityCountries = cleanArr(req.body.priorityCountries);
        if (Array.isArray(req.body.priorityCities))    a.priorityCities    = cleanArr(req.body.priorityCities);
        if (typeof req.body.notes === 'string')        a.notes             = req.body.notes;

        // Permissions: only overwrite when an object is supplied, so a PATCH
        // that only edits scope leaves permissions untouched.
        if (req.body.permissions && typeof req.body.permissions === 'object') {
            const current = a.permissions || {};
            const next = {
                validateBusinesses: req.body.permissions.validateBusinesses !== undefined
                    ? !!req.body.permissions.validateBusinesses
                    : (current.validateBusinesses !== false),
                manageDestinations: req.body.permissions.manageDestinations !== undefined
                    ? !!req.body.permissions.manageDestinations
                    : !!current.manageDestinations
            };
            if (!next.validateBusinesses && !next.manageDestinations) {
                return res.status(400).json({
                    success: false,
                    error: 'Staff must keep at least one permission enabled'
                });
            }
            a.permissions = next;
        }

        // Enforce subset rule. If a country/city is removed, drop it from priority too.
        a.priorityCountries = (a.priorityCountries || []).filter(c => (a.countries || []).includes(c));
        a.priorityCities    = (a.priorityCities    || []).filter(c => (a.cities    || []).includes(c));

        a.assignedAt = new Date();
        a.assignedBy = req.user.id;
        target.staffAssignment = a;
        target.markModified('staffAssignment');
        await target.save();

        return res.json({ success: true, staffAssignment: target.staffAssignment });
    } catch (err) {
        console.error('[staff assignment] error:', err);
        return res.status(500).json({ success: false, error: 'Failed to update assignment' });
    }
});

/**
 * DELETE /api/admin/staff/:id
 * Soft-revoke: sets isActive=false. Audit trail preserved.
 * The auth middleware blocks any future requests from inactive users, so the
 * staff member's existing JWT stops working on their next API call.
 */
router.delete('/staff/:id', async (req, res) => {
    try {
        const target = await User.findById(req.params.id);
        if (!target) return res.status(404).json({ success: false, error: 'Staff member not found' });
        if (target.role !== 'staff') {
            return res.status(400).json({ success: false, error: 'User is not a staff member' });
        }
        target.isActive = false;
        await target.save();
        return res.json({ success: true, id: target._id, isActive: false });
    } catch (err) {
        console.error('[staff revoke] error:', err);
        return res.status(500).json({ success: false, error: 'Failed to revoke staff' });
    }
});

// ── GET current AI provider config ───────────────────────────────────────────
router.get('/ai-provider', async (req, res) => {
    try {
        const cfg = await AppConfig.getConfig();
        res.json({
            success: true,
            data: {
                aiProviderChat:         cfg.aiProviderChat,
                aiProviderQuickAction:  cfg.aiProviderQuickAction,
                claudeModel:            cfg.claudeModel,
                claudeWebSearch:        cfg.claudeWebSearch,
                claudeWebSearchMaxUses: cfg.claudeWebSearchMaxUses,
                claudeWebSearchActions: cfg.claudeWebSearchActions,
                googlePrefetch:         cfg.googlePrefetch,
                googlePrefetchActions:  cfg.googlePrefetchActions,
                googlePrefetchCount:    cfg.googlePrefetchCount,
                googlePrefetchTtlMin:   cfg.googlePrefetchTtlMin,
                googlePrefetchLayers:   cfg.googlePrefetchLayers,
                googlePrefetchMode:     cfg.googlePrefetchMode,
                updatedAt:              cfg.updatedAt,
            },
        });
    } catch (error) {
        console.error('Get ai-provider error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch AI provider config' });
    }
});
 
// ── PATCH AI provider config (the admin toggle saves here) ───────────────────
router.patch('/ai-provider', async (req, res) => {
    try {
        const {
            aiProviderChat, aiProviderQuickAction, claudeModel,
            claudeWebSearch, claudeWebSearchMaxUses, claudeWebSearchActions,
            googlePrefetch, googlePrefetchActions, googlePrefetchCount, googlePrefetchTtlMin, googlePrefetchLayers, googlePrefetchMode,
        } = req.body;
 
        // Light validation — only accept known providers.
        const validProvider = v => v === undefined || v === 'deepseek' || v === 'claude';
        if (!validProvider(aiProviderChat) || !validProvider(aiProviderQuickAction)) {
            return res.status(400).json({ success: false, error: 'provider must be "deepseek" or "claude"' });
        }
        // Layers must be a subset of 1–4 (1 = first tap, 2–4 = View More refills).
        if (googlePrefetchLayers !== undefined) {
            if (!Array.isArray(googlePrefetchLayers) || googlePrefetchLayers.some(n => ![1, 2, 3, 4].includes(n))) {
                return res.status(400).json({ success: false, error: 'googlePrefetchLayers must be an array of layer numbers 1–4' });
            }
        }
        // Mode must be one of the two known values.
        if (googlePrefetchMode !== undefined && !['resolve', 'suggest'].includes(googlePrefetchMode)) {
            return res.status(400).json({ success: false, error: 'googlePrefetchMode must be "resolve" or "suggest"' });
        }
 
        const cfg = await AppConfig.updateConfig({
            aiProviderChat, aiProviderQuickAction, claudeModel,
            claudeWebSearch, claudeWebSearchMaxUses, claudeWebSearchActions,
            googlePrefetch, googlePrefetchActions, googlePrefetchCount, googlePrefetchTtlMin, googlePrefetchLayers, googlePrefetchMode,
        }, req.user?.id || null);
 
        res.json({ success: true, data: cfg });
    } catch (error) {
        console.error('Update ai-provider error:', error);
        res.status(500).json({ success: false, error: 'Failed to update AI provider config' });
    }
});

// ── GET per-provider daily AI usage (DeepSeek vs Claude) ─────────────────────
// Returns: { summary: { deepseek:{tokens,queries,searches}, claude:{...} },
//            daily: [ { date, deepseek:{...}, claude:{...} }, ... ] }
router.get('/ai-usage/by-provider', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days + 1);
        const startStr = startDate.toISOString().slice(0, 10);
 
        const rows = await AiProviderDailyStats.find({ date: { $gte: startStr } })
            .select('date provider endpoint tokens queries searches')
            .lean();
 
        const blank = () => ({ tokens: 0, queries: 0, searches: 0 });
        const summary = { deepseek: blank(), claude: blank() };
        const dailyMap = {};
 
        for (const r of rows) {
            const p = r.provider === 'claude' ? 'claude' : 'deepseek';
            summary[p].tokens   += r.tokens   || 0;
            summary[p].queries  += r.queries  || 0;
            summary[p].searches += r.searches || 0;
            if (!dailyMap[r.date]) dailyMap[r.date] = { date: r.date, deepseek: blank(), claude: blank() };
            dailyMap[r.date][p].tokens   += r.tokens   || 0;
            dailyMap[r.date][p].queries  += r.queries  || 0;
            dailyMap[r.date][p].searches += r.searches || 0;
        }
 
        // Fill gaps so the chart has one entry per day.
        const daily = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const ds = d.toISOString().slice(0, 10);
            daily.push(dailyMap[ds] || { date: ds, deepseek: blank(), claude: blank() });
        }
 
        res.json({ success: true, data: { summary, daily } });
    } catch (error) {
        console.error('AI by-provider stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch provider stats' });
    }
});


module.exports = router;