// models/GuidePick.js
//
// One place a guide recommends. Always a REAL place Jinni already knows (a
// PlaceCache placeId chosen from Jinni's own search) — never a name typed in
// free text, so a pick can never become a card for a place that isn't there
// (the "cards only from real places" rule).
//
// Categories are the guide's world only (founder 2026-10-02): restaurants,
// hidden gems, photo spots, activities. Hotels, flights and events are Jinni's
// partner bookings and never guide picks.
//
// reelUrl is the guide's OWN Instagram post/reel, stored as a link only and
// shown through Instagram's official embed — the video is never downloaded.
//
// video (founder 2026-10-05) is the clip the guide UPLOADS themselves, so Jinni
// can play it in its own clean player; reelUrl then becomes the small
// "on Instagram" link beside it. Files live in GridFS (guideVideoService).

const mongoose = require('mongoose');

const CATEGORIES = ['restaurant', 'hidden_gem', 'photo_spot', 'activity'];

const tourSchema = new mongoose.Schema({
    title: { type: String, trim: true, maxlength: 80 },
    durationHours: { type: Number, min: 0, max: 240, default: null },
    price: { type: Number, min: 0, default: null },
    currency: { type: String, uppercase: true, trim: true, maxlength: 3, default: null },
    languages: { type: [String], default: [] },
    contact: { type: String, trim: true, maxlength: 160 },   // how to book: WhatsApp / Telegram / phone / website
}, { _id: false });

const videoSchema = new mongoose.Schema({
    status: { type: String, enum: ['processing', 'ready', 'failed'], required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },           // GridFS 'guideVideos'
    posterId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sizeBytes: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    error: { type: String, default: null },
    uploadedAt: { type: Date, default: null },
}, { _id: false });

const guidePickSchema = new mongoose.Schema({
    guide: { type: mongoose.Schema.Types.ObjectId, ref: 'Guide', required: true, index: true },
    placeId: { type: String, required: true, index: true },
    placeName: { type: String, required: true, trim: true, maxlength: 160 },   // snapshot for the guide's own list
    category: { type: String, enum: CATEGORIES, required: true },
    note: { type: String, default: '', maxlength: 280 },                       // "why I love it", in the guide's words
    reelUrl: { type: String, default: null },
    tour: { type: tourSchema, default: null },                                 // only for category 'activity'
    video: { type: videoSchema, default: null },
}, { timestamps: true, versionKey: false });

guidePickSchema.index({ guide: 1, placeId: 1, category: 1 }, { unique: true });

const GuidePick = mongoose.models.GuidePick || mongoose.model('GuidePick', guidePickSchema);
GuidePick.CATEGORIES = CATEGORIES;
module.exports = GuidePick;
