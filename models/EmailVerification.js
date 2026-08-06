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
        password: String
    }
}, {
    timestamps: true
});
emailVerificationSchema.index({ email: 1, code: 1 });
emailVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });
module.exports = mongoose.model('EmailVerification', emailVerificationSchema);