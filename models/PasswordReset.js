const mongoose = require('mongoose');
const passwordResetSchema = new mongoose.Schema({
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
    isUsed: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 }
    }
}, {
    timestamps: true
});
passwordResetSchema.index({ email: 1, code: 1 });
passwordResetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });
module.exports = mongoose.model('PasswordReset', passwordResetSchema);