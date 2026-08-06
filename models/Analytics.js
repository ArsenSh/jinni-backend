const mongoose = require('mongoose');

const analyticsSchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    type: {
        type: String,
        enum: [
            'user_registration', 'query_submitted', 'ai_chat_interaction',
            'quick_action_used', 'business_clicked', 'itinerary_saved', 'business_conversion',
            'onboarding_completed', 'place_interaction',
            'message_feedback',         // like / dislike on an AI message bubble
            'recommendation_feedback',  // like / dislike on a location / rec card
            'place_share',              // share button clicked on a rec card or message
            'place_unsaved',            // user removed a saved place
            'view_more_clicked'         // user clicked View More on a quick-action result set
        ],
        required: true
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    queryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TravelQuery' },
    // Open schema — accepts any subfields (action, actionType, count, hasLocation, etc.)
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

// Indexes for fast aggregation on admin chart queries
analyticsSchema.index({ type: 1, 'metadata.action': 1 });
analyticsSchema.index({ type: 1, 'metadata.actionType': 1 });
analyticsSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('Analytics', analyticsSchema);