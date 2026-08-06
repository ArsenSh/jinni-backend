const UserAILimit = require('../models/UserAILimit');
const mongoose = require('mongoose');

/**
 * Loads (or creates) the caller's quota record onto `req.userLimit`.
 *
 * FAIL CLOSED. This used to swallow every error, set `req.userLimit = null`
 * and call next() — and because `passUsageGate` treats a missing record as
 * "no limits apply", a transient Mongo blip handed every user unlimited AI
 * and Google spend for as long as it lasted. The failure was invisible: no
 * 5xx, no alert, just an unmetered window.
 *
 * A quota system that cannot read the quota must refuse the work, not grant
 * it. The cost of being wrong in this direction is a retry; the cost of the
 * other direction is money.
 *
 * The 503 carries a distinct code so clients can say "temporarily
 * unavailable" rather than the flatly untrue "you have reached your limit".
 */
const usageTracker = async (req, res, next) => {
    // Every route mounting this middleware puts `auth` in front of it, so an
    // absent user means the chain was wired wrong. Refuse rather than run the
    // request unmetered — same reasoning as the catch block below.
    if (!req.user) {
        console.error('Usage tracker reached without an authenticated user — check the middleware order on this route.');
        return res.status(503).json({
            success: false,
            error: 'usage_tracking_unavailable',
            message: 'Service temporarily unavailable. Please try again.'
        });
    }
    try {
        let userLimit = await UserAILimit.findOne({ userId: req.user.id });
        if (!userLimit) {
            userLimit = new UserAILimit({ userId: req.user.id, isPremium: req.user.isPremium || false });
            await userLimit.save();
            await mongoose.model('User').findByIdAndUpdate(req.user.id, { aiLimits: userLimit._id });
        }
        if (userLimit.isPremium !== req.user.isPremium) {
            userLimit.isPremium = req.user.isPremium;
            await userLimit.save();
        }
        req.userLimit = userLimit;
        next();
    } catch (error) {
        // Loud on purpose: an unreadable quota store is an incident, and the
        // old code logged it at the same level as a routine miss.
        console.error('Usage tracker FAILED — refusing the request rather than serving it unmetered:', error);
        res.status(503).json({
            success: false,
            error: 'usage_tracking_unavailable',
            message: 'Service temporarily unavailable. Please try again.'
        });
    }
};

const estimateTokens = (text) => {
    if (!text) return 0;
    // Rough estimation: ~4 characters per token for English
    return Math.ceil(text.length / 4);
};

const trackUsage = async (userId, tokens = 0, places = 0) => {
    try {
        const userLimit = await UserAILimit.findOne({ userId });
        if (!userLimit) return null;
        return await userLimit.checkAndUpdateUsage(tokens, places);
    } catch (error) {
        console.error('Track usage error:', error);
        throw error;
    }
};

module.exports = { usageTracker, estimateTokens, trackUsage };
