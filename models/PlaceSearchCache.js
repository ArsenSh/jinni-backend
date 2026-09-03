// models/PlaceSearchCache.js
//
// Caches the RESULT SET of a Google Text Search (the ~12 candidates returned
// for "restaurants near <area>"), as opposed to PlaceCache which caches a
// single resolved place (geometry + photos + contact).
//
// Why a separate collection?  The quick-action prefetch fires ONE Text Search
// per request to hand the model a shortlist of real places. Text Search is the
// pricier Places SKU, so without this the prefetch would bill a search on every
// quick action — including ones that would otherwise be 100% cache hits. This
// memoises the shortlist by (action, sub-type, rounded area, radius bucket) so
// repeated searches over the same neighbourhood reuse one call.
//
// Expiry is per-document via `expireAt` + a TTL index with expireAfterSeconds:0
// (Mongo deletes the doc once `expireAt` is in the past). Using a per-doc date
// rather than a fixed-interval TTL lets the admin change the TTL from AppConfig
// and have new writes honour it immediately, without dropping/rebuilding an
// index.

const mongoose = require('mongoose');

const candidateSchema = new mongoose.Schema({
    placeId: { type: String, required: true },
    name:    { type: String, required: true },
    lat:     { type: Number, default: null },
    lng:     { type: Number, default: null },
    types:   { type: [String], default: [] },
    primaryType: { type: String, default: null },
    rating:  { type: Number, default: null },
}, { _id: false });

const placeSearchCacheSchema = new mongoose.Schema({
    // `${action}:${subType||''}:${roundedLat}:${roundedLng}:${radiusBucketKm}`
    key:        { type: String, required: true, unique: true, index: true },
    action:     { type: String, default: null },
    subType:    { type: String, default: null },
    candidates: { type: [candidateSchema], default: [] },
    // TTL: Mongo removes the doc once now > expireAt.
    expireAt:   { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

module.exports = mongoose.model('PlaceSearchCache', placeSearchCacheSchema);