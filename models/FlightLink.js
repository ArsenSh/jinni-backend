// models/FlightLink.js
//
// A short id → the real Aviasales booking URL for ONE fare. Live 2026-09-13:
// those URLs are ~400 characters of tracking keys full of underscores. Asked
// to copy four of them into a reply, the narrator ran out of tokens mid-URL,
// and the chat formatter turned the underscores into <em>, breaking the link.
// So the narrator is handed `${API_PUBLIC_URL}/go/f/<id>` — short, no
// underscores — and /go/f/:id redirects to the real thing. Rows expire after
// 60 days; a fare that old is not a fare any more.

const mongoose = require('mongoose');

const flightLinkSchema = new mongoose.Schema({
    _id: { type: String },                       // 8 base62 chars, e.g. "k3Zp9QaB"
    url: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 60 * 24 * 3600 } },
}, { versionKey: false });

module.exports = mongoose.models.FlightLink || mongoose.model('FlightLink', flightLinkSchema);
