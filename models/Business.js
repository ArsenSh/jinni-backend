const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    type: {
        type: [String],
        required: true,
        enum: [
            // User interests
            'cultural', 'history', 'adventure', 'relaxation',
            'nature', 'art', 'nightlife', 'food&drink', 'family', 'romantic', 
            // User styles
            'luxury', 'budget',
            // Primary categories
            'restaurants', 'hotels', 'events', 'historical', 'hidden_gems',
            // Activities — ONE primary, deliberately with NO sub-types (unlike
            // shopping). A spa and a club do not pick different chips: Google's
            // own types carry the kind, and the interests the user already set
            // at onboarding do the narrowing (V3 §10.2, Arsen 2026-08-26).
            'activities',
            // Shopping sub-categories. There is deliberately NO 'shopping' tag:
            // "Shopping" is only the quick-action button, which makes the user
            // pick one of these before any search runs. A listing is always a
            // concrete kind of shop, so admins tag it accordingly.
            //   souvenirs | clothing | market | mall | jewelry | food
            'souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food',
            // Photo spots. The Photo Spots action normally derives results from
            // scenic destinations + AI, but this tag lets an admin explicitly
            // curate a business as a photo spot for internal/manual use; when
            // tagged it surfaces directly under the Photo Spots action.
            'photo_spots'
        ]
    },
    isHiddenGem: { type: Boolean, default: false },
    location: {
        city: String,
        region: String,
        country: String,
        coordinates: { lat: Number, lng: Number },
        address: String,
        geoPoint: {
            type: { type: String, enum: ['Point'], default: 'Point' },
            coordinates: { type: [Number], default: [0, 0] }
        }
    },
    contact: {
        email: String,
        showEmail: { type: Boolean, default: false },
        phone: String,
        website: String,
        socialMedia: { facebook: String, instagram: String, tripadvisor: String, booking: String }
    },
    description: {
        short: String,
        detailed: String,
        highlights: [String]
    },
    images: [String],
    // ── Opening Hours (Spotlight + Signature only) ────────────────────────────
    openingHours: {
        is24Hours: { type: Boolean, default: false },
        days: [{
            day:    { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] },
            closed: { type: Boolean, default: false },
            open:   { type: String },   // "HH:MM" 24-hour
            close:  { type: String },   // "HH:MM" 24-hour
        }]
    },
    pricing: {
        isFree:   { type: Boolean, default: false },
        min:      { type: Number, default: null },
        max:      { type: Number, default: null },
        average:  { type: Number, default: null },
        currency: { type: String, default: 'USD' },
    },
    partnership: {
        tier: { type: String, enum: ['verified', 'spotlight', 'signature'], default: 'verified' },
        subscriptionStart: Date,
        subscriptionEnd: Date,
        monthlyFee: { type: Number, default: 0 },
        priorityScore: { type: Number, default: 1 }
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'frozen', 'waitlisted', 'rejected', 'expired'],
        default: 'pending'
    },
    verification: {
        aiScore: Number,
        aiNotes: String,
        staffApproved: { type: Boolean, default: false },
        staffNotes: String,
        verifiedAt: Date,
        // Real ref → can populate verifier name/email/role in admin views.
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        // Explicit action — verifiedBy alone can't tell approved vs rejected.
        verifiedAction: { type: String, enum: ['approved', 'rejected', null], default: null },
        // Lightweight audit trail. Every approve/reject is appended; rejected
        // listings that get re-approved keep both events for traceability.
        history: [{
            // 'downgraded' = an admin converted a permanent (hard) rejection
            // back to a soft one so the owner can edit + resubmit again.
            action:    { type: String, enum: ['approved', 'rejected', 'reassigned', 'reset', 'downgraded'] },
            by:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            byRole:    { type: String, enum: ['staff', 'admin', 'owner'] },
            notes:     String,
            at:        { type: Date, default: Date.now }
        }],

        // ── Rejection kind (only meaningful while status === 'rejected') ──────
        //
        //   'soft' — the standard rejection. The owner sees the reviewer note
        //            on their dashboard, can edit the listing, and resubmitting
        //            returns it to 'pending'. This is the default for any reject.
        //   'hard' — a PERMANENT rejection for abuse / bad-faith listings. The
        //            owner cannot edit or resubmit (PUT /:id refuses), and every
        //            fingerprint (email, phone, name+city, ip, userId) is pushed
        //            to the blocklist at 'block' severity so the same actor can't
        //            re-apply from scratch either. An admin can later downgrade a
        //            hard rejection back to 'soft' (see the downgrade endpoint),
        //            which lifts the block entries this rejection created.
        //    null  — not rejected (or legacy doc rejected before this field
        //            existed; treated as 'soft' by the resubmit guard).
        rejectionKind:  { type: String, enum: ['soft', 'hard', null], default: null },
        // Timestamp of the hard rejection. Set on hard reject, cleared on
        // downgrade. Lets the downgrade path know there is a block to lift.
        hardRejectedAt: { type: Date, default: null },

        // ── Abuse-prevention fields ──────────────────────────────────────────
        //
        // applyIp: snapshot of the submission IP captured at /apply time. Stays
        //   on the doc indefinitely so a future rejection can fingerprint by IP
        //   via the blocklistService (without needing to re-derive it).
        //
        // watchFlags: blocklist hits matched at apply-time or later (e.g. when
        //   a rejected→edited listing crosses the repeat-edit threshold). Shown
        //   to staff as a warning banner in the validation queue. Cleared on
        //   approval — they're consumed once staff has decided.
        //
        // rejectedEditCount: how many times the owner has clicked Save on this
        //   listing while it was in `status: 'rejected'`. Bumped by the
        //   PUT /:id re-pend logic. Crossing the repeat-edit threshold triggers
        //   an automatic 'watch' fingerprint via blocklistService.
        //
        applyIp: { type: String, default: null },
        watchFlags: [{
            type:     { type: String },                                  // 'email' | 'phone' | 'name+city' | 'ip' | 'userId' | 'repeat-edit'
            severity: { type: String, enum: ['watch', 'block'], default: 'watch' },
            reason:   { type: String, default: '' },
            hitCount: { type: Number, default: 0 }
        }],
        rejectedEditCount: { type: Number, default: 0 }
    },
    // ── Zone ─────────────────────────────────────────────────────
    // Format: "restaurants:40.179:44.499"
    // Rounded to ~220m grid so nearby businesses share the same key
    zoneKey: { type: String, index: true },
    // Waitlist info when zone was full at registration.
    // NOTE: legacy field — the live waitlist mechanism is now `auction` below.
    // Kept for backward compatibility with existing routes; safe to remove
    // once businessRoutes.js no longer references it.
    waitlist: {
        isWaiting: { type: Boolean, default: false },
        position: Number,
        reservedAt: Date,
        targetZoneKey: String
    },
    // ── Zone Auction (full-Signature zones only) ──────────────────────────────
    // The single waitlist mechanism on the platform. See plan.txt → "Zone
    // Auction" and services/zoneAuction.js. A business uses this subdoc either
    // as a challenger (isBidding) bidding on a full 3-Signature zone, or as an
    // incumbent (mustDefend) defending its slot at the quarterly renewal.
    auction: {
        // ── Challenger side ──
        isBidding:     { type: Boolean, default: false },
        targetZoneKey: { type: String },                  // zone being bid on
        maxBid:        { type: Number, default: null },   // $/month, must be > 49 floor
        bidAt:         { type: Date },                    // first bid — FIFO tie-break
        bidUpdatedAt:  { type: Date },

        // ── Incumbent / defend side ──
        mustDefend:     { type: Boolean, default: false },
        bidToBeat:      { type: Number, default: null },  // must be strictly beaten to stay
        defendOpenedAt: { type: Date },
        defendDeadline: { type: Date },                   // defendOpenedAt + 72h

        // ── Resolution outcome ──
        wonAtPrice:     { type: Number, default: null },  // locked monthly price after win/defense
        lockUntil:      { type: Date },                   // price locked for 3 months (one quarter)
        forfeitedAt:    { type: Date },
        lastResolvedAt: { type: Date },

        // Set when a bidder WINS a slot but has not yet passed staff
        // verification: the won-slot data (tier/price/lock) is written and the
        // business is parked in status:'pending', reserving the slot. Cleared
        // when staff approves it (→ active) so the marker never lingers.
        // getReservedSignatures() in zoneAuction.js keys off this to count the
        // slot as occupied so it isn't promised to another bidder.
        awaitingApprovalSince: { type: Date, default: null },

        // ── Cancellation → clean handoff ──
        cancelled:   { type: Boolean, default: false },
        cancelledAt: { type: Date },
        vacancyDate: { type: Date },                      // slot frees cleanly on this date
    },
    analytics: {
        views: { type: Number, default: 0 },
        saves: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        conversions: { type: Number, default: 0 },
        revenue: { type: Number, default: 0 },
        likes: { type: Number, default: 0 },
        dislikes: { type: Number, default: 0 },
        shares: { type: Number, default: 0 },
        // Engagement actions (main tiles)
        aiAsk:      { type: Number, default: 0 },   // user clicked "Ask AI" on this listing
        moreImages: { type: Number, default: 0 },   // user clicked "More Images"
        // Conversion actions (contact/navigation intent)
        directionClicks:   { type: Number, default: 0 },
        phoneClicks:       { type: Number, default: 0 },
        websiteClicks:     { type: Number, default: 0 },
        searchClicks:      { type: Number, default: 0 },
        instagramClicks:   { type: Number, default: 0 },
        facebookClicks:    { type: Number, default: 0 },
        tripadvisorClicks: { type: Number, default: 0 },
        // Weekly snapshots for trend display (last 8 weeks stored)
        weeklyViews:  { type: [Number], default: [] },
        weeklyClicks: { type: [Number], default: [] },
        // Cross-territory: users who also interacted with nearby businesses
        crossInteractions: { type: Number, default: 0 },
        performanceScore: { type: Number, default: 0 },
        performanceUpdatedAt: Date
    },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    // ── Event schedule (events category only) ────────────────────
    eventSchedule: {
        type: {
            startDate: Date,
            endDate:   Date,
            isRecurring: { type: Boolean, default: false },
            // The venue's IANA timezone (e.g. "Europe/Moscow"), resolved by
            // tz-lookup at apply time. Required to render event times correctly
            // on every surface (owner dashboard, admin, chat) regardless of who
            // is viewing. Defaults to UTC so a value is never missing.
            timezone: { type: String, default: 'UTC' }
        },
        default: undefined
    },

    // ── Semantic embedding (v2 retrieval; mirrors PlaceCache — battery fix #3:
    // curated rows were INVISIBLE to semantic ranking, the Sirelis/Mamma Mia
    // finding). Written ONLY by scripts/embedPlaceCache.js; no default so docs
    // without one carry no empty array. embeddingModel names the model so a
    // future model change knows which rows to re-embed. ──
    embedding: { type: [Number], default: undefined },
    embeddingModel: { type: String, default: null }
}, { timestamps: true });

businessSchema.index({ 'location.geoPoint': '2dsphere' });
businessSchema.index({ zoneKey: 1, status: 1 });
businessSchema.index({ 'partnership.tier': 1, status: 1 });
// Zone Auction queries (see services/zoneAuction.js):
//   - bid book lookup: isBidding + targetZoneKey
//   - forfeit sweep:   mustDefend + defendDeadline
businessSchema.index({ 'auction.isBidding': 1, 'auction.targetZoneKey': 1 });
businessSchema.index({ 'auction.mustDefend': 1, 'auction.defendDeadline': 1 });

businessSchema.methods.getMainCategory = function () {
    const cats = ['restaurants', 'historical', 'hotels', 'events', 'hidden_gems', 'activities', 'souvenirs', 'clothing', 'jewelry', 'food'];
    return this.type.find(t => cats.includes(t)) || null;
};

// ── Event expiry detection ────────────────────────────────────────────────────
//
//  Returns true when this listing is a non-recurring event whose end (or start,
//  if there's no end) is in the past. Recurring events never expire — a weekly
//  Friday concert is perpetually upcoming.
//
//  Used by:
//    - GET /business/:id and the dashboard fetch — to lazily flip the listing's
//      status to 'expired' on read (no cron required).
//    - Discovery / zone-check filters — to keep ended one-time events out of
//      results between expiry-time and the moment the owner next opens their
//      dashboard.
//
//  Strict semantics: the moment endDate (or startDate fallback) is in the past,
//  the event is expired. No grace period. Owners who want a buffer can extend
//  endDate in onboarding.
//
businessSchema.methods.isEventExpired = function () {
    if (!Array.isArray(this.type) || !this.type.includes('events')) return false;
    if (this.eventSchedule?.isRecurring) return false;
    const end = this.eventSchedule?.endDate || this.eventSchedule?.startDate;
    if (!end) return false;
    return new Date(end).getTime() < Date.now();
};

// ── Performance Score ─────────────────────────────────────────────────────────
//
//  Four pillars, each scored 0–100, then combined with fixed weights:
//
//  ┌─────────────────────────────┬────────┬──────────────────────────────────┐
//  │ Pillar                      │ Weight │ What it rewards                  │
//  ├─────────────────────────────┼────────┼──────────────────────────────────┤
//  │ 1. Recent Activity          │  30 %  │ Views in the last 4 weeks        │
//  │ 2. Engagement Quality       │  25 %  │ Saves, AI asks, image browsing   │
//  │ 3. Conversion Actions       │  30 %  │ Clicks that signal real intent    │
//  │ 4. Profile Completeness     │  15 %  │ Filled-in listing fields         │
//  └─────────────────────────────┴────────┴──────────────────────────────────┘
//
businessSchema.methods.recalcPerformanceScore = function () {
    const a = this.analytics;

    // ── 1. Recent Activity (30%) ──────────────────────────────────────────────
    const recentWeeks = (a.weeklyViews || []).slice(-4);
    const recentAvg   = recentWeeks.length
        ? recentWeeks.reduce((sum, v) => sum + v, 0) / recentWeeks.length
        : 0;
    const recentScore = Math.min((recentAvg / 100) * 100, 100);

    // ── 2. Engagement Quality (25%) ───────────────────────────────────────────
    const engagementRaw =
        (a.saves      || 0) * 3 +
        (a.aiAsk      || 0) * 2 +
        (a.moreImages || 0) * 1;
    const engagementScore = Math.min((engagementRaw / 300) * 100, 100);

    // ── 3. Conversion Actions (30%) ───────────────────────────────────────────
    const conversionRaw =
        (a.directionClicks   || 0) +
        (a.phoneClicks       || 0) +
        (a.websiteClicks     || 0) +
        (a.searchClicks      || 0) +
        (a.instagramClicks   || 0) +
        (a.facebookClicks    || 0) +
        (a.tripadvisorClicks || 0);
    const conversionScore = Math.min((conversionRaw / 150) * 100, 100);

    // ── 4. Profile Completeness (15%) ─────────────────────────────────────────
    let completeness = 0;
    if (this.description?.short)                            completeness += 20;
    if (this.description?.detailed)                         completeness += 20;
    if ((this.images || []).length >= 3)                    completeness += 20;
    if (this.contact?.phone || this.contact?.website)       completeness += 20;
    if ((this.description?.highlights || []).length >= 2)   completeness += 20;

    // ── Final weighted score ──────────────────────────────────────────────────
    const score =
        (recentScore      * 0.30) +
        (engagementScore  * 0.25) +
        (conversionScore  * 0.30) +
        (completeness     * 0.15);

    this.analytics.performanceScore      = Math.round(score);
    this.analytics.performanceUpdatedAt  = new Date();
    return this.analytics.performanceScore;
};

// ── Zone radius / grid constants ──────────────────────────────────────────────
const IMAGE_CONSTRAINTS = {
    minWidth:     400,
    minHeight:    300,
    maxWidth:    4000,
    maxHeight:   3000,
    maxBytes:    5 * 1024 * 1024,
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
};

const ZONE_RADIUS_M = {
    restaurants: 300,
    hotels:      900,
    events:      300,
    historical:  500,
    hidden_gems: 900,
    // Activities: venue-scale, like hidden gems — a spa or a karting track
    // draws from across the city, not from the street it sits on.
    activities:  900,
    // Shop sub-categories: street-level zones like restaurants.
    souvenirs:   300,
    clothing:    300,
    jewelry:     300,
    food:        300,
};

const ZONE_GRID_STEP = {
    restaurants: 0.003,
    hotels:      0.009,
    events:      0.003,
    historical:  0.005,
    hidden_gems: 0.009,
    activities:  0.009,
    souvenirs:   0.003,
    clothing:    0.003,
    jewelry:     0.003,
    food:        0.003,
};

/* Admin-configurable visibility radii (Limits tab → AppConfig.zoneRadiusM).
 * MUTATES the shared table in place — businessRoutes destructures the object
 * reference at require time, so reassignment would silently disconnect it.
 * The zone GRID step stays hardcoded (it keys auction slots). */
businessSchema.statics.setZoneRadiusConfig = function (m = {}) {
    for (const k of Object.keys(ZONE_RADIUS_M)) {
        const v = Number(m[k]);
        if (Number.isFinite(v) && v >= 50 && v <= 5000) ZONE_RADIUS_M[k] = v;
    }
};
businessSchema.statics.ZONE_RADIUS_M  = ZONE_RADIUS_M;
businessSchema.statics.ZONE_GRID_STEP = ZONE_GRID_STEP;

// Builds zone key from category + coordinates, snapped to the category's grid
businessSchema.statics.buildZoneKey = function (category, lat, lng) {
    const step = ZONE_GRID_STEP[category] ?? 0.003;
    const latR = (Math.round(lat / step) * step).toFixed(3);
    const lngR = (Math.round(lng / step) * step).toFixed(3);
    return `${category}:${latR}:${lngR}`;
};

businessSchema.statics.TIER_PRIORITY  = { verified: 1, spotlight: 2, signature: 3 };
businessSchema.statics.TIER_FEE       = { verified: 0, spotlight: 29, signature: 49 };
businessSchema.statics.ZONE_MAX_SLOTS = 3;

module.exports              = mongoose.model('Business', businessSchema);
module.exports.ZONE_RADIUS_M     = ZONE_RADIUS_M;
module.exports.ZONE_GRID_STEP    = ZONE_GRID_STEP;
module.exports.IMAGE_CONSTRAINTS = IMAGE_CONSTRAINTS;

/* Hydrate configured zone radii once the DB connects (survives restarts). */
const hydrateZoneRadii = async () => {
    try {
        const cfg = await require('./AppConfig').getConfig();
        if (cfg.zoneRadiusM) module.exports.setZoneRadiusConfig(cfg.zoneRadiusM);
        console.log('[limits] zone radii hydrated from AppConfig');
    } catch (e) { console.warn('[limits] zone radii hydrate failed (using defaults):', e.message); }
};
if (mongoose.connection.readyState === 1) { hydrateZoneRadii(); }
else { mongoose.connection.once('connected', hydrateZoneRadii); }