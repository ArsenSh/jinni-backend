const mongoose = require('mongoose');

// One document per calendar day — OpenRouteService (map road/route
// calculation) usage. ORS is free but hard-capped (~2,000 directions/day,
// 40/min), so the admin needs to SEE how close each day gets to the wall
// before users start hitting "routing is busy". Same pattern as
// GoogleApiStats: routingRoutes.js increments via upsert on every call.
const RoutingDailyStatsSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true, index: true },  // 'YYYY-MM-DD'
    directions:  { type: Number, default: 0 },  // successful route calculations (consume the ORS quota)
    rateLimited: { type: Number, default: 0 },  // ORS 403 (daily cap) / 429 (per-minute) responses
    failed:      { type: Number, default: 0 }   // other ORS errors (5xx, no route ≠ counted here)
}, { timestamps: true });

RoutingDailyStatsSchema.statics.track = async function (field, amount = 1) {
    const today = new Date().toISOString().slice(0, 10);
    await this.findOneAndUpdate(
        { date: today },
        { $inc: { [field]: amount } },
        { upsert: true, new: true }
    ).catch(() => {});   // stats must never break a routing request
};

module.exports = mongoose.model('RoutingDailyStats', RoutingDailyStatsSchema);
