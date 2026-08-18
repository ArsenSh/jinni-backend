const mongoose = require('mongoose');

/* One document per user per UTC day. This is the retention backbone:
 * "was this user active on this day" is a single indexed doc, so
 * DAU/WAU/MAU, comeback rates and cohort tables are cheap aggregations
 * instead of scans over the raw Analytics event log.
 *
 * Written fire-and-forget from the auth middleware (every authenticated
 * request), throttled in-process so repeat requests within the same
 * minute don't burn Atlas ops. Backfilled from Analytics events by
 * scripts/backfillUserActivity.js.
 *
 * `day` is the UTC calendar day — same convention as the daily limit
 * resets (midnight UTC). country/language are snapshots of the user's
 * settings at the time of activity, so locals-vs-visitors splits need
 * no join against User.
 */
const userActivitySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },          // 'YYYY-MM-DD' (UTC)
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    requests: { type: Number, default: 0 },
    surfaces: {
        chat:        { type: Number, default: 0 },
        quickAction: { type: Number, default: 0 },
        explore:     { type: Number, default: 0 },
        itinerary:   { type: Number, default: 0 },
        saves:       { type: Number, default: 0 },
        map:         { type: Number, default: 0 },   // /api/routing — map route/distance calculations
        other:       { type: Number, default: 0 }
    },
    // Search mode per request, when the request body carries the nearbyMode
    // flag (chat + quick-action). nearby = around the user's GPS position;
    // discovery = browsing a destination. Requests without the flag count in
    // neither — this is a mode split of SEARCHES, not of all traffic.
    modes: {
        nearby:    { type: Number, default: 0 },
        discovery: { type: Number, default: 0 }
    },
    country:  { type: String, default: '' },        // user's settings.location.country at activity time
    language: { type: String, default: '' },        // user's settings.language at activity time
    // true when this doc was reconstructed from the Analytics event log
    // rather than recorded live (request counts are approximate there)
    backfilled: { type: Boolean, default: false }
}, { timestamps: true });

userActivitySchema.index({ userId: 1, day: 1 }, { unique: true });
userActivitySchema.index({ day: 1 });

module.exports = mongoose.model('UserActivity', userActivitySchema);
