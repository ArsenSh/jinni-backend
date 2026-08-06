const mongoose = require('mongoose');

// One document per calendar day.
// Each API call in googleService.js increments the relevant counter via upsert.
// This gives the admin dashboard accurate, real-time tracking of every billed call —
// including Geocoding and findPlaces which are invisible to the PlaceCache approach.
const GoogleApiStatsSchema = new mongoose.Schema({
    date: {
        type: String,   // 'YYYY-MM-DD' — one doc per day, easy to query by range
        required: true,
        unique: true,
        index: true
    },
    findPlaces:     { type: Number, default: 0 },   // $0.032/call · Text Search Pro (5K free/mo) — fieldMask: places.id,places.location
    getPlaceDetails:{ type: Number, default: 0 },   // $0.020/call · Place Details Enterprise (1K free/mo) — rating + phone fields push to Enterprise tier
    reverseGeocode: { type: Number, default: 0 },   // $0.005/call · Geocoding Essentials (10K free/mo)
    imageDownload:  { type: Number, default: 0 },   // $0.007/call · Place Photos Enterprise (1K free/mo)
    calculateDistances: { type: Number, default: 0 } // free — Haversine, no API call
}, { timestamps: true });

// Convenience: total billed calls for a document
GoogleApiStatsSchema.virtual('totalBilled').get(function () {
    return this.findPlaces + this.getPlaceDetails + this.reverseGeocode + this.imageDownload;
});

/**
 * Atomically increment one counter for today.
 * Called from googleService.js on every API call.
 *
 * @param {'findPlaces'|'getPlaceDetails'|'reverseGeocode'|'imageDownload'|'calculateDistances'} apiName
 * @param {number} [amount=1]
 */
GoogleApiStatsSchema.statics.track = async function (apiName, amount = 1) {
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const inc = { [apiName]: amount };
    await this.findOneAndUpdate(
        { date: today },
        { $inc: inc },
        { upsert: true, new: true }
    );
};

module.exports = mongoose.model('GoogleApiStats', GoogleApiStatsSchema);