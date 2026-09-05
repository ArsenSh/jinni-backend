// ─────────────────────────────────────────────────────────────────────────────
//  ShotSpot.js — "Jinni Shot Spots" (Stage 1, founder-approved 2026-09-06)
//
//  A Shot Spot is NOT a place — it is a PHOTOGRAPH with coordinates:
//  where to STAND (camera), what to POINT AT (subject/heading), and how to
//  GET THERE (access point + human instructions instead of a postal address,
//  so caves, forests and viewpoints work as well as street corners).
//
//  Deliberately its own model + collection, NOT a Destination subdocument:
//  the feature is experimental and must be deletable by removing files
//  (founder: "build in other file, so if it will not work we can delete it
//  easily"). Nothing else in the codebase references this model.
//
//  Data honesty (same invariant family as LocalFact/events):
//  - every sensor value is RECORDED at capture, never invented; a sensor the
//    device didn't provide stays null and the UI degrades honestly
//    (no heading → cardinal text, weak GPS → softer guidance).
//  - the hero photo is staff-captured on site (source 'jinni_staff') — the
//    Wikimedia experiment taught us third-party photos are garbage-prone.
//
//  Photo bytes live in the document (Buffer). Client compresses to ≤1600px
//  JPEG (~300-600KB), far under both Mongo's 16MB doc cap and the 10mb JSON
//  body limit. Every list/detail query MUST exclude photo.data (routes do);
//  bytes are served only by GET /api/shotspots/:id/photo with long caching.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const shotSpotSchema = new mongoose.Schema({
    title:   { type: String, required: true, trim: true, maxlength: 120 },
    // draft = staff-only (capture page); active = visible to travelers.
    status:  { type: String, enum: ['draft', 'active'], default: 'draft', index: true },

    city:    { type: String, required: true, trim: true, index: true },
    country: { type: String, trim: true, default: '' },

    // WHERE TO STAND — recorded by the phone at the shutter instant.
    camera: {
        lat: { type: Number, required: true, min: -90,  max: 90 },
        lng: { type: Number, required: true, min: -180, max: 180 },
        // GPS accuracy (meters) AT CAPTURE. Drives guidance softness on the
        // traveler side: a forest capture with ±40m must not promise ±5m.
        accuracyMeters: { type: Number, default: null },
        // Compass bearing the camera faced, 0-360 or null (sensor absent).
        heading: { type: Number, min: 0, max: 360, default: null },
        // Device tilt in degrees relative to level (0 = level, + = up).
        pitch:   { type: Number, min: -90, max: 90, default: null },
        orientation: { type: String, enum: ['portrait', 'landscape'], default: 'portrait' },
    },

    // WHAT THE PHOTO IS OF — a name, optionally its own coordinate (lets a
    // future UI draw stand-here→look-there on a map).
    subject: {
        name: { type: String, trim: true, default: '' },
        lat:  { type: Number, min: -90,  max: 90,  default: null },
        lng:  { type: Number, min: -180, max: 180, default: null },
    },

    // HOW TO GET THERE — replaces the postal address. `point` is where
    // navigation should aim FIRST (trailhead, cave entrance, gate); the
    // instructions walk the human the rest of the way.
    access: {
        nearestPlace: { type: String, trim: true, default: '' }, // "Cascade Complex"
        point: {
            lat: { type: Number, min: -90,  max: 90,  default: null },
            lng: { type: Number, min: -180, max: 180, default: null },
        },
        instructions: { type: String, trim: true, maxlength: 600, default: '' },
        walkMinutes:  { type: Number, min: 0, max: 600, default: null },
    },

    // Enum key, not free text, so the traveler UI can localize it.
    shooting: {
        bestTime: { type: String, enum: ['sunrise', 'morning', 'midday', 'afternoon', 'sunset', 'blue_hour', 'night', 'any'], default: 'any' },
        season:   { type: String, trim: true, maxlength: 120, default: '' },  // free text, staff-worded
        notes:    { type: String, trim: true, maxlength: 600, default: '' },
    },

    // Hero photo (see header). data is NEVER selected by list/detail queries.
    photo: {
        data:        { type: Buffer, select: false },
        contentType: { type: String, default: 'image/jpeg' },
        width:       { type: Number, default: null },
        height:      { type: Number, default: null },
        capturedAt:  { type: Date, default: null },
        source:      { type: String, enum: ['jinni_staff'], default: 'jinni_staff' },
    },

    // Stage 3 (admin-only miner) parking space — evidence never becomes the
    // face of a spot, only a lead for staff. Unused in Stage 1.
    evidence: [{ kind: String, url: String, note: String }],
    // Stage 2 ("I got the shot") parking space. Unused in Stage 1.
    recreations: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        lat: Number, lng: Number, heading: Number, accuracyMeters: Number,
        capturedAt: Date,
    }],

    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
}, { timestamps: true });

shotSpotSchema.index({ status: 1, city: 1 });

module.exports = mongoose.model('ShotSpot', shotSpotSchema);
