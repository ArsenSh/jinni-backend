// models/PlaceView.js
//
// Per-user memory of which places a user has SEEN, so recommendations can
// surface fresh spots first (their "locations to dig into") without ever
// hiding anything — the penalty is a soft ranking nudge, not a filter, so a
// small market never runs dry.
//
// Two states, promoted by engagement:
//   • 'shown'   — the card appeared in a served list (weak signal). Written
//                 server-side at serve time.
//   • 'watched' — the user deliberately engaged: opened "More info", tapped
//                 "Ask AI" or "view images", or acted inside the detail modal
//                 (directions/website/…). The real "I looked at this" signal.
//                 Promoted from the trackInteraction handler.
//
// Never downgrades watched→shown. TTL (`expireAt`, refreshed on each show)
// lets a long-unseen place resurface — "seen in March" shouldn't hide it in
// June. Covers every source uniformly: the placeId is whatever identity the
// served card carried (Google placeId, dest_<id>, verified id).

const mongoose = require('mongoose');

const placeViewSchema = new mongoose.Schema({
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    placeId: { type: String, required: true },
    // Category the place was shown/engaged under (restaurants, historical, …).
    action:  { type: String, default: null },

    status:  { type: String, enum: ['shown', 'watched'], default: 'shown', index: true },
    shownCount:  { type: Number, default: 1 },
    engageCount: { type: Number, default: 0 },

    firstSeenAt: { type: Date, default: Date.now },
    lastShownAt: { type: Date, default: Date.now },
    watchedAt:   { type: Date, default: null },

    // Rolling 90-day window — refreshed on each show; lets old views expire so
    // places resurface. Mongo deletes the doc once expireAt passes.
    expireAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

placeViewSchema.index({ userId: 1, placeId: 1 }, { unique: true });

module.exports = mongoose.model('PlaceView', placeViewSchema);
