const mongoose = require('mongoose');

const PlaceCacheSchema = new mongoose.Schema({
    placeId: { 
        type: String, 
        required: true, 
        unique: true, 
        index: true 
    },
    searchName: { 
        type: String, 
        lowercase: true,
        trim: true,
        sparse: true,
        index: true
    },    
    name: { type: String, required: true },

    rating: { type: Number, min: 0, max: 5 },
    website: { type: String },
    formatted_phone_number: { type: String },
    international_phone_number: { type: String },
    opening_hours: {
        open_now: { type: Boolean },
        weekday_text: [String],
        periods: [mongoose.Schema.Types.Mixed]
    },

    photos: [{
        photoReference: String,
        url: String,
        width: Number,
        height: Number,
        imageData: { type: Buffer, required: false },
        contentType: String, 
        storedAt: { type: Date, default: Date.now }
    }],
    details: {
        formatted_address: String,
        geometry: mongoose.Schema.Types.Mixed
    },
    // ── Region (parsed from formatted_address via utils/addressRegion at write
    //    time; existing docs backfilled via POST /api/admin/places/backfill-regions).
    //    Used to scope staff explore-moderation queues — matched case-insensitively,
    //    same contract as Business.location.country/city. Null = unparsed/unknown,
    //    which keeps the place outside every staff scope (admin still sees it).
    country: { type: String, default: null, index: true },
    city:    { type: String, default: null, index: true },

    lastFetched: { type: Date, default: Date.now },
    lastUsed: { type: Date, default: Date.now },
    fetchCount: { type: Number, default: 0 },
    useCount: { type: Number, default: 0 },
    imagesStored: { type: Boolean, default: false },
    hasDetailedInfo: { type: Boolean, default: false },
    // Google place types of the resolved place (e.g. ['armenian_restaurant',
    // 'restaurant','food']). Used to verify a resolved place actually matches
    // the pressed action (a "restaurants" search shouldn't surface a brandy
    // house). Absent on legacy docs → treated leniently (not dropped).
    types: { type: [String], default: [] },
    primaryType: { type: String, default: null },
    // Google price bucket: 'PRICE_LEVEL_INEXPENSIVE' | '…MODERATE' | '…EXPENSIVE' |
    // '…VERY_EXPENSIVE' | '…FREE'. Well populated for restaurants/food/shopping;
    // usually absent for lodging & attractions (Google simply omits it there). The
    // priceTier() helper reads this when present and falls back to lodging subtypes
    // in `types` for hotels. Null on legacy/unpopulated docs → treated as unknown.
    priceLevel: { type: String, default: null },
    // Quick-action categories this place has actually been SHOWN under (e.g.
    // ['historical','photo_spots']). Recorded at request time — the action the
    // user pressed is ground truth — so the cache backfill can serve a place
    // only under categories it genuinely belongs to, instead of re-guessing the
    // category from Google types. Populated via $addToSet when a place survives
    // all filters and is sent to the user, so resolved-but-dropped places (a
    // school that came back for a Historical query then got filtered) are never
    // tagged and therefore never backfilled.
    actions: { type: [String], default: [] },
    // Event schedule — only meaningful for places shown under the 'events' action.
    // Captured at request time from the recommendation an event venue was shown as,
    // so the admin cache view can display WHEN a cached venue was last surfaced as
    // an event. Reflects the most recently shown event for that venue (a venue can
    // host many events; this is the latest one we served). Absent for non-event
    // places and for pure date-card festivals, which carry no placeId and are never
    // cached at all.
    eventSchedule: {
        startDate:   { type: Date,    default: null },
        endDate:     { type: Date,    default: null },
        isRecurring: { type: Boolean, default: false }
    },
    // Feedback counters — net totals across all users and sessions
    likes: { type: Number, default: 0 },
    dislikes: { type: Number, default: 0 },
    // ── Explore moderation (post-moderation model: everything shows by default) ──
    // status:
    //   'visible'  — default; shown on Explore, subject to the auto-quality rules
    //   'hidden'   — buried by admin/staff; never shown on Explore (chat unaffected)
    //   'verified' — human-checked; always shown, EXEMPT from auto-quality rules
    // Legacy docs have no `explore` field at all → read as 'visible' everywhere.
    explore: {
        status:     { type: String, enum: ['visible', 'hidden', 'verified'], default: 'visible' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        reviewedAt: { type: Date, default: null }
    }
}, { timestamps: true });

PlaceCacheSchema.index({ placeId: 1 });
PlaceCacheSchema.index({ searchName: 1 });
// Supports the cache-backfill bounding-box query (in-area lookup by lat/lng).
// Compound so the lat range is index-served; lng is an additional bound.
PlaceCacheSchema.index({ 'details.geometry.location.lat': 1, 'details.geometry.location.lng': 1 });
// Backfill filters by the quick-action category a place was shown under.
PlaceCacheSchema.index({ actions: 1 });
// No TTL — cache expiry is managed manually via the Admin > Places Cache > Purge Stale button.

module.exports = mongoose.model('PlaceCache', PlaceCacheSchema);