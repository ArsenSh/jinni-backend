const mongoose = require('mongoose');

/**
 * SavedPlace — a recommendation bookmarked by a user from the chat.
 *
 * Source of truth for which record this points to:
 *
 *   verifiedId + verifiedModel  →  a record in our DB (Business or Destination)
 *                                  verifiedModel = 'business' | 'destination'
 *   googlePlaceId               →  a Google Places result (no DB record)
 *
 * At least one of (verifiedId, googlePlaceId) must be set.
 *
 * Why verifiedId/verifiedModel instead of businessId/destinationId?
 *   aiRoutes.js sets rec.verifiedId = matchedDb?._id and
 *   rec._verifiedModel = 'business' | 'destination' on every recommendation,
 *   regardless of whether it came from the Business or Destination collection.
 *   Mirroring that naming here keeps the frontend mapping trivial.
 */
const savedPlaceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // ── DB source (one of these two sets is populated) ────────────────────────
    verifiedId: {
        type: mongoose.Schema.Types.ObjectId,   // Business._id OR Destination._id
        default: null
    },
    verifiedModel: {
        type: String,
        enum: ['business', 'destination', null],
        default: null
    },

    // ── Google Places source ─────────────────────────────────────────────────
    googlePlaceId: {
        type: String,       // e.g. "ChIJ..."
        default: null
    },

    // ── Card snapshot at save-time ────────────────────────────────────────────
    // Stored so the Saved Places panel can render without extra DB/API lookups.
    snapshot: {
        name:        { type: String, required: true },
        category:    String,   // "Restaurant", "Hotel", "Hidden Gem", etc.
        type:        String,   // raw rec.type field
        description: String,
        image:       String,   // image URL or /api/ai/place-image/… path
        address:     String,
        location:    String,   // city/region fallback
        distance:    String,
        rating:      Number,
        // ── Coordinates — captured at save-time (newer saves) ─────────────────
        // Lets the itinerary "From saved" chooser use the place directly;
        // legacy saves without them are resolved through the PlaceCache-first
        // pipeline on read (GET /api/itinerary/:id/saved-candidates).
        latitude:    Number,
        longitude:   Number,
        website:     String,
        partnerTier: String,   // 'verified' | 'spotlight' | 'signature' | null

        // ── Event-specific (events only; null/absent otherwise) ───────────────
        // Captured at save-time so the Saved Places panel can show the event
        // date/time row without re-fetching the business. The GET /api/saves
        // route re-hydrates these from the live Business for verified events,
        // so this is effectively a fallback for Google-sourced events and for
        // the brief window before the first re-hydrated read.
        eventSchedule: {
            startDate:   Date,
            endDate:     Date,
            isRecurring: Boolean,
            // Venue IANA timezone — startDate / endDate are absolute UTC
            // instants and only mean a wall-clock time when paired with this.
            timezone:    String
        },
        // true when a non-recurring event has already ended
        _isExpired:  { type: Boolean, default: false }
    },

    savedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// ── Compound indexes — fast "is this already saved?" look-up ─────────────────
savedPlaceSchema.index({ userId: 1, verifiedId: 1 },    { sparse: true });
savedPlaceSchema.index({ userId: 1, googlePlaceId: 1 }, { sparse: true });

// ── Validation: at least one source reference must be present ─────────────────
savedPlaceSchema.pre('validate', function (next) {
    if (!this.verifiedId && !this.googlePlaceId) {
        return next(new Error('SavedPlace must have either verifiedId or googlePlaceId'));
    }
    next();
});

module.exports = mongoose.model('SavedPlace', savedPlaceSchema);