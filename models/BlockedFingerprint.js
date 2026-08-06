// models/BlockedFingerprint.js
//
// Abuse / repeat-offender registry, separate from the Business collection so
// fingerprints outlive any single rejected listing.
//
// Two severities:
//   • 'watch' — application is still allowed through, but staff sees a banner
//               in the validation queue ("matches 3 prior rejected listings").
//   • 'block' — /apply hard-rejects before staff ever sees it. Reserved for
//               cases an admin has explicitly confirmed as abuse.
//
// Five fingerprint types covered. Pick the ones that survive the abuser's
// easiest evasion moves:
//   • 'email'     — owner-provided, easy to rotate but cheap to catch
//   • 'phone'     — owner-provided, normalized to last-8 digits
//   • 'name+city' — alphanumeric-lowercase name + lowercase city
//   • 'ip'        — submission IP (req.ip); evasion = VPN, raises the cost
//   • 'userId'    — the owner's User._id; survives email/phone changes
//
// IMPORTANT: when /apply hits a 'block', the response to the user must NOT
// reveal which field matched — that would be an evasion roadmap. The internal
// record knows; the client gets a generic "contact support" message.

const mongoose = require('mongoose');

const blockedFingerprintSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['email', 'phone', 'name+city', 'ip', 'userId'],
        required: true,
        index: true
    },
    // Normalized value. Normalization is the caller's responsibility — see
    // services/blocklistService.normalize* helpers. We store post-normalization
    // so lookups are pure equality checks (no per-row regex).
    value: {
        type: String,
        required: true,
        index: true
    },
    severity: {
        type: String,
        enum: ['watch', 'block'],
        default: 'watch',
        index: true
    },
    // Free-text reason from the admin or auto-flag system. Surfaced to staff
    // in the validation queue, never shown to the applicant.
    reason: { type: String, default: '' },

    // Links to the rejected listings that produced this fingerprint, for audit
    // and to let admins justify a 'block' promotion.
    evidence: [{
        businessId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
        rejectedAt:      { type: Date },
        rejectionReason: { type: String, default: '' }
    }],

    // Who created the entry. null = system-generated (auto-promote from
    // repeat rejections).
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Optional auto-expiry. Lets you, say, watchlist an IP for 30 days after
    // an abuse spike without making it permanent. null = never expires.
    expiresAt: { type: Date, default: null },

    // Telemetry — bumped every time /apply matches this fingerprint, even if
    // severity is 'watch'. High hitCount + 'watch' is the cue for an admin to
    // promote to 'block'.
    hitCount:  { type: Number, default: 0 },
    lastHitAt: { type: Date,   default: null }
}, { timestamps: true });

// Unique on (type, value) — one entry per fingerprint. New hits update the
// existing row's counters/evidence instead of creating duplicates.
blockedFingerprintSchema.index({ type: 1, value: 1 }, { unique: true });

module.exports = mongoose.model('BlockedFingerprint', blockedFingerprintSchema);