// Free-tier laundering defense (founder 2026-09-01: "user use too much then
// deletes account and then registers one more time? and endlessly").
// When an account is deleted, its SAME-DAY usage survives as a tombstone
// keyed by a SALTED HASH of the email — no readable personal data, two
// numbers, gone after 48h (TTL). A re-registration with the same address
// (Google OAuth re-register is always the same Gmail) seeds the fresh
// UserAILimit with the dead account's spent usage instead of a zero meter,
// so delete-and-return resumes the same daily allowance. GDPR posture:
// minimal pseudonymized data, abuse-prevention legitimate interest, short
// retention.
const mongoose = require('mongoose');
const crypto = require('crypto');

const usageTombstoneSchema = new mongoose.Schema({
    emailHash: { type: String, required: true, index: true },
    tokensUsed: { type: Number, default: 0 },
    placesViewed: { type: Number, default: 0 },
    day: { type: String, required: true },                 // UTC YYYY-MM-DD the usage belongs to
    createdAt: { type: Date, default: Date.now, expires: 172800 },  // 48h TTL
});

usageTombstoneSchema.statics.hashEmail = (email) =>
    crypto.createHmac('sha256', process.env.JWT_SECRET || 'jinni-tombstone')
        .update(String(email || '').trim().toLowerCase()).digest('hex');

usageTombstoneSchema.statics.utcDay = () => new Date().toISOString().slice(0, 10);

module.exports = mongoose.model('UsageTombstone', usageTombstoneSchema);
