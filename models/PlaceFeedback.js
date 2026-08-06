const mongoose = require('mongoose');

/**
 * PlaceFeedback — a per-user record of the CURRENT vote on a place.
 *
 * Supersedes the earlier PlaceDislike model. It does two jobs:
 *
 *   1. Dislike-hide (per-action): rows with vote==='dislike' are read by the
 *      backfill to skip a place for THIS user under THIS action. Scoping the hide
 *      by action matters — a museum disliked as an 'event' must still surface under
 *      'historical' where it belongs. (Same behaviour the old PlaceDislike had.)
 *
 *   2. Cross-chat highlight (per-place): when a place reappears in a brand-new
 *      chat, its card should show the user's prior like/dislike. The display query
 *      collapses these rows to ONE vote per placeId (latest wins), so a place the
 *      user liked anywhere shows as liked everywhere, regardless of action.
 *
 * Why a dedicated per-user store (not the shared PlaceCache.likes/dislikes):
 *   those are COMMUNITY increment counters — they can't tell us *who* voted or what
 *   their *current* vote is (a like→dislike toggle just nets to zero there). To
 *   render "did THIS user like this place", we need the current per-user vote,
 *   which is exactly this collection.
 *
 * Keyed by (userId, placeId, action). placeId is the Google place id for cache
 * places, or the stringified Business/Destination _id for verified places —
 * whichever the feedback carried.
 */
const placeFeedbackSchema = new mongoose.Schema({
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Google place id (cache) OR stringified verified _id (business/destination).
    placeId: { type: String, required: true, index: true },
    // The quick-action category the place was shown under when voted.
    action:  { type: String, required: true },
    // The user's current vote for this place+action.
    vote:    { type: String, enum: ['like', 'dislike'], required: true },
    // Denormalized for debugging / future "your liked places" UI. Not authoritative.
    name:    { type: String, default: '' }
}, { timestamps: true });

// One row per (user, place, action): a place can be disliked for 'events' yet
// liked for 'historical'. Toggles update vote in place; clearing removes the row.
placeFeedbackSchema.index({ userId: 1, placeId: 1, action: 1 }, { unique: true });

// Supports the cross-chat highlight lookup: "all of this user's votes for these
// placeIds" → collapse to per-place in app code.
placeFeedbackSchema.index({ userId: 1, placeId: 1 });

module.exports = mongoose.model('PlaceFeedback', placeFeedbackSchema);