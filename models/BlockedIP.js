const mongoose = require('mongoose');

const blockedIPSchema = new mongoose.Schema({
    ip: {
        type: String,
        required: true,
        index: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 }
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('BlockedIP', blockedIPSchema);