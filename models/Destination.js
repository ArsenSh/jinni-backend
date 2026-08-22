const mongoose = require('mongoose');

const destinationSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: {
        type: [String],
        required: true,
        enum: [
            // User interests
            'cultural', 'history', 'adventure', 'relaxation',
            'nature', 'art', 'nightlife', 'food&drink', 'family', 'romantic', 
            // User styles
            'luxury', 'budget',
            // Action buttons
            'restaurants', 'hotels', 'historical', 'events', 'hidden_gems',
            // Shopping sub-categories (parity with Business). No 'shopping' tag:
            // "Shopping" is only the button; the user picks a concrete sub-type,
            // so a shop/market modelled as a destination is tagged accordingly
            // (e.g. a historic covered bazaar tagged 'market').
            'souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food',
            // Photo spots. Results are usually derived from scenic/landmark
            // destinations, but this explicit tag lets an admin hand-curate a
            // destination as a photo spot (internal use); when set it surfaces
            // directly under the Photo Spots action.
            'photo_spots'
        ]
    },
    location: {
        city: String,
        region: String,
        country: String,
        coordinates: { lat: Number, lng: Number },
        address: String
    },
    // ── Contact (mirrors Business.contact) ────────────────────────────────────
    // Destinations are typically public sites (parks, monuments, viewpoints)
    // but many do have an official phone/website (e.g. national park HQ).
    // Same shape as Business so the admin form can be reused 1:1.
    contact: {
        email: String,
        showEmail: { type: Boolean, default: false },
        phone: String,
        website: String,
        socialMedia: {
            facebook: String,
            instagram: String,
            tripadvisor: String,
            booking: String
        }
    },
    description: String,
    images: [String],
    // ── Opening Hours (mirrors Business.openingHours) ─────────────────────────
    // A destination like a museum has hours; a mountain pass doesn't. The
    // is24Hours flag lets admin mark always-open sites cleanly without filling
    // 7 rows of identical times.
    openingHours: {
        is24Hours: { type: Boolean, default: false },
        days: [{
            day:    { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] },
            closed: { type: Boolean, default: false },
            open:   { type: String },   // "HH:MM" 24-hour
            close:  { type: String },   // "HH:MM" 24-hour
        }]
    },
    // ── Pricing (mirrors Business.pricing) ────────────────────────────────────
    // Most destinations are free (parks, viewpoints, public squares) but some
    // charge entry fees (museums, monuments, paid trails). isFree=true clears
    // min/max/average and renders as "Free entry" in user-facing views.
    // Same shape as Business.pricing so the admin form can be reused.
    pricing: {
        isFree:   { type: Boolean, default: true },     // most destinations are free
        min:      { type: Number,  default: null },
        max:      { type: Number,  default: null },
        average:  { type: Number,  default: null },
        currency: { type: String,  default: 'USD' }
    },
    // ── Analytics (mirrors Business.analytics) ────────────────────────────────
    // Same metric set as Business so the admin Analytics panel renders the
    // same way for both. Extra signals (saves, weekly snapshots, performance
    // score) make destinations comparable to listings in dashboards.
    analytics: {
        views: { type: Number, default: 0 },
        saves: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        conversions: { type: Number, default: 0 },
        likes: { type: Number, default: 0 },
        dislikes: { type: Number, default: 0 },
        shares: { type: Number, default: 0 },
        // Engagement actions
        aiAsk:      { type: Number, default: 0 },
        moreImages: { type: Number, default: 0 },
        // Conversion actions (contact / navigation intent)
        directionClicks:   { type: Number, default: 0 },
        phoneClicks:       { type: Number, default: 0 },
        websiteClicks:     { type: Number, default: 0 },
        searchClicks:      { type: Number, default: 0 },
        instagramClicks:   { type: Number, default: 0 },
        facebookClicks:    { type: Number, default: 0 },
        tripadvisorClicks: { type: Number, default: 0 },
        // Weekly snapshots for trend display (last 8 weeks)
        weeklyViews:  { type: [Number], default: [] },
        weeklyClicks: { type: [Number], default: [] },
        // Derived performance score (0–100), same formula as Business
        performanceScore: { type: Number, default: 0 },
        performanceUpdatedAt: Date
    },
    isActive: { type: Boolean, default: true },
    // ── Event schedule (destinations tagged 'events' only) ────────────────────
    // Mirrors Business.eventSchedule field-for-field so a validator-curated
    // event (a city concert, a one-off festival) behaves exactly like an
    // owner-registered one: same storage shape, same expiry rule, same
    // rendering on every surface.
    //
    // startDate/endDate are absolute UTC instants. They only mean a wall-clock
    // time when paired with `timezone` — the venue's IANA zone, resolved from
    // the coordinates at save time via utils/timezone. Storing both is what
    // lets a Yerevan concert read as "20:00" to a traveler in London.
    //
    // `default: undefined` keeps the field off non-event destinations entirely
    // rather than writing an object full of nulls onto every park and museum.
    eventSchedule: {
        type: {
            startDate: Date,
            endDate:   Date,
            isRecurring: { type: Boolean, default: false },
            timezone: { type: String, default: 'UTC' }
        },
        default: undefined
    },
    bestTimeToVisit: String,
    nearbyBusinesses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Business' }],
    popularity: { type: Number, default: 0 },
    isHiddenGem: { type: Boolean, default: false },
    // ── Authorship ────────────────────────────────────────────────────────────
    // Set once when an admin creates the destination through the dashboard.
    // Populated as { name, email, role } in admin views so the table / edit
    // panel can show "added by …".
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Semantic embedding (v2 retrieval; mirrors PlaceCache — battery fix #3:
    // curated rows were INVISIBLE to semantic ranking, the Sirelis/Mamma Mia
    // finding). Written ONLY by scripts/embedPlaceCache.js; no default so docs
    // without one carry no empty array. embeddingModel names the model so a
    // future model change knows which rows to re-embed. ──
    embedding: { type: [Number], default: undefined },
    embeddingModel: { type: String, default: null }
}, { timestamps: true });

// ── Event expiry detection ───────────────────────────────────────────────────
//
//  Identical rule to Business.isEventExpired() — deliberately duplicated rather
//  than shared, because the two models are queried independently and a single
//  helper would need a model-agnostic shim for no real gain. If you change the
//  rule here, change it there too.
//
//  Returns true when this destination is a non-recurring event whose end (or
//  start, if there's no end) is in the past. Recurring destinations never
//  expire — a weekly Sunday market is perpetually upcoming.
//
//  Note the asymmetry with Business: destinations have no `status` field, so
//  there is nothing to flip to 'expired'. Expiry is enforced purely at query
//  time by proximityService.eventFreshnessClause(), which drops ended events
//  from discovery. This method exists for display flags (_isExpired) and for
//  the staff table's "Ended" badge.
//
destinationSchema.methods.isEventExpired = function () {
    if (!Array.isArray(this.type) || !this.type.includes('events')) return false;
    if (this.eventSchedule?.isRecurring) return false;
    const end = this.eventSchedule?.endDate || this.eventSchedule?.startDate;
    if (!end) return false;
    return new Date(end).getTime() < Date.now();
};

// Supports the event-freshness clause on the Events quick-action query: the
// discovery filter narrows by `type` then bounds on the schedule dates.
destinationSchema.index({ type: 1, 'eventSchedule.endDate': 1, 'eventSchedule.startDate': 1 });

// ── Performance Score (same formula as Business.recalcPerformanceScore) ──────
// Kept identical so a destination and a business with the same engagement
// numbers get the same score; the admin can compare them directly.
//
//   30% Recent Activity (avg weekly views, last 4 weeks vs 100/week benchmark)
//   25% Engagement     (saves×3 + aiAsk×2 + moreImages×1 vs 300 benchmark)
//   30% Conversions    (sum of all conversion clicks vs 150 benchmark)
//   15% Completeness   (description / images / contact filled)
destinationSchema.methods.recalcPerformanceScore = function () {
    const a = this.analytics || {};

    // 1. Recent Activity (30%)
    const recentWeeks = (a.weeklyViews || []).slice(-4);
    const recentAvg = recentWeeks.length
        ? recentWeeks.reduce((sum, v) => sum + v, 0) / recentWeeks.length
        : 0;
    const recentScore = Math.min((recentAvg / 100) * 100, 100);

    // 2. Engagement Quality (25%)
    const engagementRaw =
        (a.saves      || 0) * 3 +
        (a.aiAsk      || 0) * 2 +
        (a.moreImages || 0) * 1;
    const engagementScore = Math.min((engagementRaw / 300) * 100, 100);

    // 3. Conversion Actions (30%)
    const conversionRaw =
        (a.directionClicks   || 0) +
        (a.phoneClicks       || 0) +
        (a.websiteClicks     || 0) +
        (a.searchClicks      || 0) +
        (a.instagramClicks   || 0) +
        (a.facebookClicks    || 0) +
        (a.tripadvisorClicks || 0);
    const conversionScore = Math.min((conversionRaw / 150) * 100, 100);

    // 4. Profile Completeness (15%)
    //    Destinations don't have highlights/accessibility anymore — those
    //    were removed as low-value admin chores. Description carries the
    //    most weight (40), images medium (20), and contact splits 40 across
    //    bestTimeToVisit, phone, and website so the max stays at 100.
    let completeness = 0;
    if (this.description)                       completeness += 40;
    if ((this.images || []).length >= 3)        completeness += 20;
    if (this.bestTimeToVisit)                   completeness += 15;
    if (this.contact?.phone)                    completeness += 12;
    if (this.contact?.website)                  completeness += 13;
    // completeness is already 0–100

    const score =
        (recentScore     * 0.30) +
        (engagementScore * 0.25) +
        (conversionScore * 0.30) +
        (completeness    * 0.15);

    this.analytics.performanceScore     = Math.round(score);
    this.analytics.performanceUpdatedAt = new Date();
    return this.analytics.performanceScore;
};

module.exports = mongoose.model('Destination', destinationSchema);