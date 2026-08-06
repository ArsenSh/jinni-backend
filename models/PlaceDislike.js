const mongoose = require('mongoose');

/**
 * PlaceDislike — a per-user "don't show me this again" record.
 *
 * Why this exists, and why it is separate from PlaceCache.likes/dislikes:
 *   PlaceCache is a SHARED document. Its likes/dislikes are COMMUNITY totals and
 *   drive community-ranked backfill. They must not be used to decide what to hide
 *   from one specific person — one user disliking a place should not erase it for
 *   everyone, and the community total can't tell us *who* disliked it.
 *
 *   This collection answers the per-user question instead: "has THIS user
 *   disliked THIS place?" If so, we exclude it from that user's backfill (both the
 *   DB and the PlaceCache top-up). The place itself is never deleted and can still
 *   be surfaced as a direct AI suggestion — we only suppress it from the
 *   automatic fill-to-target backfill for the person who disliked it.
 *
 * Keyed by (userId, placeId, action). placeId is the Google place id for cache
 * places, or the stringified Business/Destination _id for verified places —
 * whichever the feedback carried. ACTION is the quick-action category the place
 * was shown under when disliked ('events', 'historical', 'restaurants', …).
 *
 * Why action is part of the key: the same place can legitimately appear under
 * several actions (a museum shows up under both 'events' and 'historical'). A
 * dislike means "don't show me THIS place for THIS kind of request" — e.g. a
 * museum wrongly surfaced as an 'event' — and must NOT suppress that same place
 * when the user later asks for 'historical', where it genuinely belongs. Scoping
 * the hide per-action keeps the dislike precise instead of blanket-banning a good
 * place from every category.
 */
const placeDislikeSchema = new mongoose.Schema({
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Google place id (cache) OR stringified verified _id (business/destination).
    placeId: { type: String, required: true },
    // The quick-action category the place was shown under when disliked.
    action:  { type: String, required: true },
    // Denormalized for debugging / future "your hidden places" UI. Not authoritative.
    name:    { type: String, default: '' }
}, { timestamps: true });

// One row per (user, place, action): a place can be hidden for 'events' yet still
// shown for 'historical'. Upserts are idempotent and toggles can't duplicate.
placeDislikeSchema.index({ userId: 1, placeId: 1, action: 1 }, { unique: true });

module.exports = mongoose.model('PlaceDislike', placeDislikeSchema);