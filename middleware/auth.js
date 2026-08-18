const { isPremiumExpired } = require('../utils/premium');
const { recordActivity } = require('../services/userActivityService');
const UserAILimit = require('../models/UserAILimit');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

/* True when an error means "the database is unreachable right now" rather
 * than "this token/user is invalid". These MUST NOT become 401s: a 401 tells
 * the frontend the token is bad, so a 10-second Atlas blip was effectively
 * logging users out. A DB outage is a 503 — retryable, token untouched. */
const isDbOutage = (error) => {
    if (!error) return false;
    const name = error.name || '';
    if (name === 'MongoNetworkError' || name === 'MongoServerSelectionError' || name === 'MongoNetworkTimeoutError' || name === 'MongoTimeoutError') return true;
    const msg = String(error.message || '');
    return /buffering timed out|ETIMEDOUT|ECONNRESET|ReplicaSetNoPrimary|Server selection timed out|topology (was |is )?(destroyed|closed)/i.test(msg);
};

module.exports = async (req, res, next) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ Invalid authorization format');
            return res.status(401).json({ error: 'Invalid authorization format' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded || typeof decoded !== 'object') {
            console.log('❌ Invalid token structure - not an object');
            return res.status(401).json({ error: 'Invalid token structure' });
        }
        const userId = decoded.userId || decoded.id;
        if (!userId) {
            console.log('❌ No user ID found in token. Available fields:', Object.keys(decoded));
            return res.status(401).json({ error: 'Invalid token structure - no user ID' });
        }
        const user = await User.findById(userId.toString()).select('-password').exec();
        if (!user) {
            console.log('❌ User not found in database for ID:', userId);
            return res.status(401).json({ error: 'User not found' });
        }
        if (user.isActive === false) {
            console.log('❌ Account is deactivated:', user.email);
            return res.status(401).json({
                error: 'This account has been closed and can no longer be used. If you believe this is a mistake, please contact support.',
                code: 'account_disabled'
            });
        }
        // ── Premium expiry (lazy) ────────────────────────────────────────
        // Every authenticated request passes through here, which makes it the
        // one place guaranteed to see a lapsed term before anything reads
        // `req.user.isPremium`. Downgrade in memory FIRST so this request is
        // already correct, then persist. The write is fire-and-forget for the
        // same reason lastActive is below: a DB blip must not fail the
        // request, and the next request would just retry the downgrade.
        if (isPremiumExpired(user)) {
            user.isPremium = false;
            user.premiumUntil = null;
            User.updateOne({ _id: user._id }, { isPremium: false, premiumUntil: null })
                .catch(err => console.error('Premium expiry downgrade failed:', err.message));
            UserAILimit.updateOne({ userId: user._id }, { isPremium: false })
                .catch(err => console.error('Premium expiry limit sync failed:', err.message));
            console.log(`[premium] term lapsed for user ${user._id} — downgraded to free`);
        }

        req.user = user;
        req.userId = user._id;
        // Fire-and-forget: lastActive is analytics, not correctness. Awaiting it
        // added a write's latency to EVERY authed request and turned DB blips
        // into slow requests. Failures are logged and ignored.
        User.findByIdAndUpdate(user._id.toString(), { $set: { 'analytics.lastActive': new Date() } })
            .catch(updateError => console.log('⚠️ Warning: Could not update last active time:', updateError.message));
        // Day-level retention rollup (UserActivity) — throttled + fire-and-forget
        // inside the service; skips admin/staff/business roles. Body is passed
        // for the nearby-vs-discovery search-mode split (chat/quick-action).
        recordActivity(user, req.originalUrl, req.body);
        next();
    } catch (error) {
        // Database unreachable → 503, and DON'T log the full stack on every
        // request (one line is enough; the connection events in server.js
        // already tell the story). The frontend should treat 503 as "retry /
        // show a toast", never as "clear the token and sign out".
        if (isDbOutage(error)) {
            console.warn('⚠️ Auth deferred — database unreachable:', error.message);
            res.set('Retry-After', '5');
            return res.status(503).json({
                error: 'service_unavailable',
                message: 'The service is temporarily unreachable. Please retry in a moment.',
                code: 'db_unavailable'
            });
        }
        console.error('❌ Authentication error:', error);
        let errorMessage = 'Invalid token';
        if (error instanceof jwt.TokenExpiredError) {
            errorMessage = 'Token expired';
            console.log('❌ Token expired');
        } else if (error instanceof jwt.JsonWebTokenError) {
            errorMessage = 'Malformed token';
            console.log('❌ Malformed token');
        } else { console.log('❌ Other auth error:', error.message) }
        return res.status(401).json({ error: errorMessage });
    }
};