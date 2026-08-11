const mongoose = require('mongoose');

const emailVerificationSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        index: true
    },
    code: {
        type: String,
        required: true
    },
    ipAddress: String,
    attempts: {
        type: Number,
        default: 0,
        max: 3
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 }
    },
    userData: {
        name: String,
        password: String,
        // UI language the visitor had selected when they started signing up
        // (chosen on the landing page). Parked here because signup is a
        // two-step flow — the account is not created until the emailed code
        // comes back — and without carrying it across the gap the new user
        // would be created with the schema's default 'en' and land in an
        // English app despite having browsed the site in their own language.
        language: String
    }
}, {
    timestamps: true
});
emailVerificationSchema.index({ email: 1, code: 1 });
emailVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });
module.exports = mongoose.model('EmailVerification', emailVerificationSchema);