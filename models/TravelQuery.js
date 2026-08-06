const mongoose = require('mongoose');

const travelQuerySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    query: {
        budget: Number,
        duration: Number,
        interests: [String],
        travelStyle: String,
        groupSize: Number,
        accommodation: String,
        transportation: String,
        seasonalPreferences: String
    },
    response: {
        itinerary: Object,
        recommendedBusinesses: [{
            businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
            reason: String,
            priority: Number
        }],
        estimatedCost: Number,
        aiConfidence: Number
    },
    feedback: {
        rating: Number,
        comments: String,
        wasHelpful: Boolean
    },
    analytics: {
        sessionDuration: Number,
        clickedBusinesses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Business' }],
        savedItinerary: Boolean
    }
}, { timestamps: true });

module.exports = mongoose.model('TravelQuery', travelQuerySchema);