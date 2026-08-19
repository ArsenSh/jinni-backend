// models/UserGoogleUsage.js
//
// Per-user-per-month rollup of billed Google API calls, written fire-and-forget
// from googleService.trackApiCall via the request context (see
// services/requestContext.js). Exists to answer "what does the average user in
// <country> cost me in Google calls?" — the global counters can't, because
// they don't know who triggered a call. Counting starts at deploy; there is no
// history to backfill (old calls were never attributed).
//
// Cache-warming subtlety: a call triggered by user A fills the cache that
// serves users B..Z for free — so per-user numbers are honest for "who
// triggers spend", not "who benefits". Read them as trigger-attribution.

const mongoose = require('mongoose');

const userGoogleUsageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month:  { type: String, required: true },   // 'YYYY-MM' (UTC)
    findPlaces:      { type: Number, default: 0 },   // Text Search $0.032
    prefetchSearch:  { type: Number, default: 0 },   // Text Search $0.032
    getPlaceDetails: { type: Number, default: 0 },   // Place Details $0.020
    imageDownload:   { type: Number, default: 0 },   // Place Photos $0.007
    reverseGeocode:  { type: Number, default: 0 },   // Geocoding $0.005
}, { timestamps: true });

userGoogleUsageSchema.index({ userId: 1, month: 1 }, { unique: true });
userGoogleUsageSchema.index({ month: 1 });

const TRACKED = new Set(['findPlaces', 'prefetchSearch', 'getPlaceDetails', 'imageDownload', 'reverseGeocode']);

// Fire-and-forget increment. Unknown kinds and missing userIds are ignored —
// attribution must never break or slow a Google call.
userGoogleUsageSchema.statics.track = function (userId, kind) {
    if (!userId || !TRACKED.has(kind)) return;
    const month = new Date().toISOString().slice(0, 7);
    this.updateOne({ userId, month }, { $inc: { [kind]: 1 } }, { upsert: true })
        .catch(err => console.warn('[UserGoogleUsage] track failed:', err.message));
};

module.exports = mongoose.model('UserGoogleUsage', userGoogleUsageSchema);
