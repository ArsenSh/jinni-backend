const { isPremiumActive, premiumDaysRemaining } = require('../utils/premium');
const mongoose = require('mongoose');

/* ── Free-tier daily allowances ─────────────────────────────────────────────
 * These are the FLOOR, not merely the default for new records. `default:`
 * only applies when a document is created, so every existing user still
 * carries whatever number was in force the day they signed up — raising the
 * default alone would change nothing for them. The effective limit is
 * therefore resolved as max(stored, floor) at read time: no migration, and a
 * deliberately-raised per-user limit is still honoured.
 */
const FREE_DAILY_PLACES = 100;
const FREE_DAILY_TOKENS = 10000;

/* Admin-configurable tier limits (Limits tab → AppConfig → setTierConfig).
 * Free values replace the hardcoded floors; premium values, when present,
 * override the per-user premiumBenefits. Hydrated from AppConfig once the
 * DB connects, refreshed on every admin save. */
let TIER = { freeTokens: FREE_DAILY_TOKENS, freePlaces: FREE_DAILY_PLACES, premiumTokens: null, premiumPlaces: null };

const userAILimitSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        unique: true 
    },
    dailyUsage: {
        tokensUsed: { type: Number, default: 0 },
        placesViewed: { type: Number, default: 0 },
        queriesMade: { type: Number, default: 0 },
        lastResetDate: { type: Date, default: Date.now }
    },    
    currentSession: {
        tokensUsed: { type: Number, default: 0 },
        placesViewed: { type: Number, default: 0 },
        sessionStart: { type: Date, default: Date.now }
    },    
    limits: {
        dailyTokens: { type: Number, default: FREE_DAILY_TOKENS },
        dailyPlaces: { type: Number, default: FREE_DAILY_PLACES },
        maxSessionDuration: { type: Number, default: 4 * 60 * 60 * 1000 } // 4 hours in milliseconds
    },    
    onCooldown: { type: Boolean, default: false },
    cooldownUntil: { type: Date },
    cooldownReason: { type: String },    
    isPremium: { type: Boolean, default: false },
    premiumBenefits: {
        dailyTokens: { type: Number, default: 50000 }, // 50K tokens for premium
        dailyPlaces: { type: Number, default: 200 }, // 200 places for premium
        noCooldown: { type: Boolean, default: false }
    },    
    statistics: {
        totalTokensUsed: { type: Number, default: 0 },
        totalPlacesViewed: { type: Number, default: 0 },
        totalQueriesMade: { type: Number, default: 0 },
        avgTokensPerQuery: { type: Number, default: 0 },
        peakUsageDay: { type: Date }
    }
}, { timestamps: true });

userAILimitSchema.pre('save', function(next) {
    const now = new Date();
    const lastReset = this.dailyUsage.lastResetDate;    
    const isNewDay = lastReset.getUTCFullYear() !== now.getUTCFullYear() || lastReset.getUTCMonth() !== now.getUTCMonth() || lastReset.getUTCDate() !== now.getUTCDate();
    if (isNewDay) {
        console.log('🔄 New day detected - resetting daily limits');
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;
    }    
    const sessionAge = now - this.currentSession.sessionStart;
    if (sessionAge > this.limits.maxSessionDuration) {
        this.currentSession.tokensUsed = 0;
        this.currentSession.placesViewed = 0;
        this.currentSession.sessionStart = now;
    }    
    if (this.onCooldown && this.cooldownUntil && now >= this.cooldownUntil) {
        console.log('✅ Cooldown period has expired - resetting daily usage');
        this.onCooldown = false;
        this.cooldownUntil = null;
        this.cooldownReason = null;
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;
    }
    next();
});
userAILimitSchema.methods.checkAndUpdateUsage = async function(tokensToAdd = 0, placesToAdd = 0, queriesToAdd = 0) {
    const now = new Date();    
    const lastReset = this.dailyUsage.lastResetDate;
    const isNewDay = lastReset.getUTCFullYear() !== now.getUTCFullYear() || lastReset.getUTCMonth() !== now.getUTCMonth() || lastReset.getUTCDate() !== now.getUTCDate();
    if (isNewDay) {
        console.log('🔄 New day detected - resetting daily limits');
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;        
        this.onCooldown = false;
        this.cooldownUntil = null;
        this.cooldownReason = null;
    }    
    if (this.onCooldown && this.cooldownUntil && now >= this.cooldownUntil) {
        console.log('✅ Cooldown period has expired - resetting daily usage');
        this.onCooldown = false;
        this.cooldownUntil = null;
        this.cooldownReason = null;
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;
    }    
    const User = mongoose.model('User');
    // Select the TERM too: this method re-queries the user rather than using
    // req.user, so without premiumUntil it would keep honouring a lapsed
    // subscription even after auth had downgraded it.
    const user = await User.findById(this.userId).select('isPremium premiumUntil');
    // `this.isPremium` is only a mirror of the user flag and carries no term,
    // so it may never OVERRIDE an expired user record — it can only stand in
    // when the user document is missing.
    const isPremium = user ? isPremiumActive(user) : this.isPremium;
    // Floor the stored values at the current free-tier allowance (see the
    // constants at the top) so existing records inherit raises automatically.
    const dailyTokenLimit = isPremium ? (TIER.premiumTokens ?? this.premiumBenefits.dailyTokens) : Math.max(this.limits.dailyTokens || 0, TIER.freeTokens);
    const dailyPlaceLimit = isPremium ? (TIER.premiumPlaces ?? this.premiumBenefits.dailyPlaces) : Math.max(this.limits.dailyPlaces || 0, TIER.freePlaces);    
    if (this.onCooldown) {
        const hoursLeft = this.cooldownUntil ? Math.ceil((this.cooldownUntil - now) / (1000 * 60 * 60)) : 4;
        throw new Error(`AI services are on cooldown. Available in ${hoursLeft} hours.`);
    }    
    if (this.dailyUsage.tokensUsed + tokensToAdd > dailyTokenLimit) {
        if (!isPremium) {
            this.onCooldown = true;
            this.cooldownUntil = new Date(now.getTime() + (4 * 60 * 60 * 1000));
            this.cooldownReason = 'daily_token_limit_exceeded';
            await this.save();
        }
        throw new Error(`Daily token limit reached. ${isPremium ? '' : 'AI services will be available again in 4 hours.'}`);
    }
    if (this.dailyUsage.placesViewed + placesToAdd > dailyPlaceLimit) {
        if (!isPremium) {
            this.onCooldown = true;
            this.cooldownUntil = new Date(now.getTime() + (4 * 60 * 60 * 1000));
            this.cooldownReason = 'daily_place_limit_exceeded';
            await this.save();
        }
        throw new Error(`Daily place viewing limit reached. ${isPremium ? '' : 'AI services will be available again in 4 hours.'}`);
    }    
    this.dailyUsage.tokensUsed += tokensToAdd;
    this.dailyUsage.placesViewed += placesToAdd;
    this.dailyUsage.queriesMade += queriesToAdd;  
    this.currentSession.tokensUsed += tokensToAdd;
    this.currentSession.placesViewed += placesToAdd;
    this.statistics.totalTokensUsed += tokensToAdd;
    this.statistics.totalPlacesViewed += placesToAdd;
    this.statistics.totalQueriesMade += queriesToAdd;
    this.statistics.avgTokensPerQuery = this.statistics.totalQueriesMade > 0
        ? this.statistics.totalTokensUsed / this.statistics.totalQueriesMade
        : 0;
    await this.save();
    // Requests-denominated view of the token budget (what users think in).
    // Per-request cost: the observed average when we have one, clamped to a
    // sane band (context growth makes later requests cost more than early ones).
    const _avgPerRequest = Math.min(4000, Math.max(800, this.statistics.avgTokensPerQuery || 1200));
    return {
        dailyTokensUsed: this.dailyUsage.tokensUsed,
        dailyTokensRemaining: dailyTokenLimit - this.dailyUsage.tokensUsed,
        estimatedRequestsRemaining: Math.max(0, Math.floor((dailyTokenLimit - this.dailyUsage.tokensUsed) / _avgPerRequest)),
        dailyPlacesViewed: this.dailyUsage.placesViewed,
        dailyPlacesRemaining: dailyPlaceLimit - this.dailyUsage.placesViewed,
        onCooldown: this.onCooldown,
        cooldownUntil: this.cooldownUntil,
        isPremium
    };
};
// Free-tier laundering defense (2026-09-01): a fresh limit doc for an email
// whose account died TODAY resumes the dead account's same-day usage
// (salted-hash tombstone, 48h TTL) instead of starting a zero meter. Call
// right after `new UserAILimit(...)`, before save. Fail-open: a tombstone
// problem must never block a legitimate registration.
userAILimitSchema.statics.seedFromTombstone = async function (doc, { email = null, userId = null } = {}) {
    try {
        let addr = email;
        if (!addr && userId) {
            addr = (await mongoose.model('User').findById(userId).select('email').lean())?.email;
        }
        if (!addr) return;
        const Tomb = require('./UsageTombstone');
        const t = await Tomb.findOne({ emailHash: Tomb.hashEmail(addr), day: Tomb.utcDay() })
            .sort({ createdAt: -1 }).lean();
        if (!t) return;
        doc.dailyUsage.tokensUsed = Math.max(doc.dailyUsage.tokensUsed || 0, t.tokensUsed || 0);
        doc.dailyUsage.placesViewed = Math.max(doc.dailyUsage.placesViewed || 0, t.placesViewed || 0);
        console.log(`[limits] tombstone resumed for re-registered email: tok=${t.tokensUsed} places=${t.placesViewed}`);
    } catch (e) { console.warn('[limits] tombstone seed failed (fail-open):', e.message); }
};

userAILimitSchema.statics.syncUserPremium = async function(userId, isPremium) {
    return this.findOneAndUpdate(
        { userId },
        { isPremium },
        { upsert: true, new: true }
    );
};
userAILimitSchema.methods.getUsageStatus = async function() {
    const now = new Date();
    const lastReset = this.dailyUsage.lastResetDate;
    const isNewDay = lastReset.getUTCFullYear() !== now.getUTCFullYear() ||
                     lastReset.getUTCMonth()    !== now.getUTCMonth()    ||
                     lastReset.getUTCDate()     !== now.getUTCDate();
    if (isNewDay) {
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;
        this.onCooldown = false;
        this.cooldownUntil = null;
        this.cooldownReason = null;
        await this.save();
    } else if (this.onCooldown && this.cooldownUntil && now >= this.cooldownUntil) {
        this.onCooldown = false;
        this.cooldownUntil = null;
        this.cooldownReason = null;
        this.dailyUsage.tokensUsed = 0;
        this.dailyUsage.placesViewed = 0;
        this.dailyUsage.queriesMade = 0;
        this.dailyUsage.lastResetDate = now;
        await this.save();
    }
    // Self-heal a legacy/edge state: flagged on cooldown but with no end timestamp
    // (older docs, or a cooldown set without a window). Left as-is it sends
    // until=null / hoursRemaining=0, so the client can only show "Unknown" and the
    // time-based expiry can never fire. Give it the standard 4-hour window from now
    // so the user sees a concrete reactivation time and it auto-clears normally.
    if (this.onCooldown && !this.cooldownUntil) {
        this.cooldownUntil = new Date(now.getTime() + 4 * 60 * 60 * 1000);
        try { await this.save(); } catch (e) { /* non-fatal: still returns a derived time below */ }
    }
    const User = mongoose.model('User');
    // Select the TERM too: this method re-queries the user rather than using
    // req.user, so without premiumUntil it would keep honouring a lapsed
    // subscription even after auth had downgraded it.
    const user = await User.findById(this.userId).select('isPremium premiumUntil');
    // `this.isPremium` is only a mirror of the user flag and carries no term,
    // so it may never OVERRIDE an expired user record — it can only stand in
    // when the user document is missing.
    const isPremium = user ? isPremiumActive(user) : this.isPremium;
    // Floor the stored values at the current free-tier allowance (see the
    // constants at the top) so existing records inherit raises automatically.
    const dailyTokenLimit = isPremium ? (TIER.premiumTokens ?? this.premiumBenefits.dailyTokens) : Math.max(this.limits.dailyTokens || 0, TIER.freeTokens);
    const dailyPlaceLimit = isPremium ? (TIER.premiumPlaces ?? this.premiumBenefits.dailyPlaces) : Math.max(this.limits.dailyPlaces || 0, TIER.freePlaces);
    return {
        daily: {
            tokens: {
                used: this.dailyUsage.tokensUsed,
                limit: dailyTokenLimit,
                remaining: Math.max(0, dailyTokenLimit - this.dailyUsage.tokensUsed),
                percentage: Math.min(100, Math.round((this.dailyUsage.tokensUsed / dailyTokenLimit) * 100))
            },
            places: {
                viewed: this.dailyUsage.placesViewed,
                limit: dailyPlaceLimit,
                remaining: Math.max(0, dailyPlaceLimit - this.dailyUsage.placesViewed),
                percentage: Math.min(100, Math.round((this.dailyUsage.placesViewed / dailyPlaceLimit) * 100))
            },
            // Token budget translated into requests — the unit users think in.
            // "estimated" because later requests carry more conversation context
            // and therefore cost more tokens than early ones; the per-request
            // figure is the user's own observed average, clamped to [800, 4000].
            requests: (() => {
                const avg = Math.min(4000, Math.max(800, this.statistics.avgTokensPerQuery || 1200));
                const remainingTokens = Math.max(0, dailyTokenLimit - this.dailyUsage.tokensUsed);
                return {
                    estimatedRemaining: Math.floor(remainingTokens / avg),
                    avgTokensPerRequest: Math.round(avg)
                };
            })()
        },
        currentSession: {
            tokensUsed: this.currentSession.tokensUsed,
            placesViewed: this.currentSession.placesViewed,
            sessionStart: this.currentSession.sessionStart,
            sessionAge: now - this.currentSession.sessionStart
        },
        cooldown: {
            active: this.onCooldown && (!this.cooldownUntil || now < this.cooldownUntil),
            until: this.cooldownUntil,
            reason: this.cooldownReason,
            hoursRemaining: this.cooldownUntil && now < this.cooldownUntil ? Math.ceil((this.cooldownUntil - now) / (1000 * 60 * 60)) : 0
        },
        isPremium,
        // Term info for the UI: when premium runs out, and how long is left.
        // Both null for free accounts and for grandfathered no-expiry ones.
        premiumUntil: isPremium ? (user?.premiumUntil || null) : null,
        premiumDaysRemaining: isPremium ? premiumDaysRemaining(user) : null,
        limits: { dailyTokens: dailyTokenLimit, dailyPlaces: dailyPlaceLimit, maxSessionHours: this.limits.maxSessionDuration / (1000 * 60 * 60) }
    };
};
/* Apply admin-configured tier limits (Limits tab). Values <= 0 or missing
 * fall back: free → the hardcoded floors, premium → each user's stored
 * premiumBenefits. */
userAILimitSchema.statics.setTierConfig = function (cfg = {}) {
    TIER = {
        freeTokens: cfg.limitFreeDailyTokens > 0 ? cfg.limitFreeDailyTokens : FREE_DAILY_TOKENS,
        freePlaces: cfg.limitFreeDailyPlaces > 0 ? cfg.limitFreeDailyPlaces : FREE_DAILY_PLACES,
        premiumTokens: cfg.limitPremiumDailyTokens > 0 ? cfg.limitPremiumDailyTokens : null,
        premiumPlaces: cfg.limitPremiumDailyPlaces > 0 ? cfg.limitPremiumDailyPlaces : null
    };
};
userAILimitSchema.statics.getTierConfig = function () { return { ...TIER }; };

const UserAILimitModel = mongoose.model('UserAILimit', userAILimitSchema);

/* Hydrate the tier config from AppConfig once the DB is reachable, so a
 * server restart doesn't silently fall back to the hardcoded defaults. */
const hydrateTiers = async () => {
    try {
        const cfg = await require('./AppConfig').getConfig();
        UserAILimitModel.setTierConfig(cfg);
        console.log('[limits] tier config hydrated from AppConfig');
    } catch (e) { console.warn('[limits] tier hydrate failed (using defaults):', e.message); }
};
if (mongoose.connection.readyState === 1) { hydrateTiers(); }
else { mongoose.connection.once('connected', hydrateTiers); }

module.exports = UserAILimitModel;