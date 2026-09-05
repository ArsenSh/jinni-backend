// ─────────────────────────────────────────────────────────────────────────────
//  ShotRecreation.js — Stage 2 of Jinni Shot Spots ("I got the shot 📸").
//  Part of the deletable Shot Spots file set.
//
//  A recreation is a traveler's GPS-verified confirmation that they stood at
//  a spot and took the shot. Own collection (not a ShotSpot subdocument) so
//  popular spots never bloat toward Mongo's 16MB doc cap and photo bytes are
//  loaded only when staff asks for exactly one.
//
//  Privacy/moderation model (founder-approved hero hierarchy 2026-09-06):
//  traveler photos are NEVER public by themselves — the public sees only the
//  count ("N travelers got this shot"). A photo becomes the spot's face only
//  when staff explicitly PROMOTES it (photo.source: 'traveler'), which is the
//  "trusted contributor with GPS" tier with a human moderator in the loop.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const shotRecreationSchema = new mongoose.Schema({
    spotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShotSpot', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Recorded at the traveler's shutter/confirm instant — same honesty rules
    // as the spot itself: absent sensors stay null.
    lat: { type: Number, required: true, min: -90,  max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, default: null },
    heading: { type: Number, min: 0, max: 360, default: null },
    pitch:   { type: Number, min: -90, max: 90, default: null },
    // Distance to the spot's camera point at confirm time, computed and
    // verified SERVER-side (the client is never trusted about presence).
    distanceM: { type: Number, default: null },

    photo: {
        data:        { type: Buffer, select: false },
        contentType: { type: String, default: 'image/jpeg' },
        width:       { type: Number, default: null },
        height:      { type: Number, default: null },
    },
    hasPhoto: { type: Boolean, default: false },

    promotedAt: { type: Date, default: null }, // set when staff makes it the hero
}, { timestamps: true });

// One confirmation per traveler per spot — re-confirming updates in place, so
// the public count is countDocuments truth and can never be inflated.
shotRecreationSchema.index({ spotId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ShotRecreation', shotRecreationSchema);
