const mongoose = require('mongoose');
const pendingPlaceSchema = new mongoose.Schema({
    name: { type: String, required: true },
    userHash: String,
    ipHash: String,
    enrichedData: { type: Object, required: true },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    detectedAt: { type: Date, default: Date.now },
    reviewedAt: Date,
    reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
module.exports = mongoose.model('PendingPlace', pendingPlaceSchema);