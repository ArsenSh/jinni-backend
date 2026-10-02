// models/Guide.js
//
// A travel guide / local creator with a public Jinni page at /@handle
// (founder 2026-10-02: guides cover restaurants, hidden gems, photo spots,
// activities and itineraries; hotels, flights and events stay Jinni's own).
//
// Mirrors the Business application flow (apply → staff approve/reject), with
// one deliberate difference: a guide applies while SIGNED IN, so the profile
// is always tied to a real account (`user`). No new User role — like business
// owners (User.businessId), a guide is recognised by having a Guide row.
//
// Instagram ownership is proved by a short code the applicant puts in their
// Instagram bio; staff check it by eye in the Guides tab of the staff queue.
// Nothing here ever fetches Instagram (scraping it breaks their terms).

const mongoose = require('mongoose');

const historySchema = new mongoose.Schema({
    action: { type: String, enum: ['applied', 'approved', 'rejected', 'suspended', 'reinstated', 'pick_removed'], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
    at: { type: Date, default: Date.now },
}, { _id: false });

const guideSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // The page address: jinni.travel/@<handle>. Lowercase letters, digits, dot,
    // underscore — Instagram's own alphabet, so most guides keep their handle.
    handle: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    instagram: { type: String, required: true, lowercase: true, trim: true, maxlength: 30 },
    bio: { type: String, default: '', maxlength: 400 },
    region: { type: String, required: true, trim: true, maxlength: 80 },     // where they guide, e.g. "Yerevan", "Dilijan"
    languages: { type: [String], default: [] },
    guideType: { type: String, enum: ['licensed', 'creator', 'local'], default: 'local' },
    status: { type: String, enum: ['pending', 'active', 'rejected', 'suspended'], default: 'pending', index: true },
    verification: {
        code: { type: String, required: true },          // e.g. "jinni-7K3P", shown to the applicant
        staffNotes: { type: String, default: '' },        // also carries the rejection reason
        verifiedAt: { type: Date, default: null },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        verifiedAction: { type: String, enum: ['approved', 'rejected', null], default: null },
        history: { type: [historySchema], default: [] },
    },
    termsAcceptedAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.Guide || mongoose.model('Guide', guideSchema);
