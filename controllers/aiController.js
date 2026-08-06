const aiService = require('../services/aiService');
const Analytics = require('../models/Analytics');

const aiController = {
    generateItinerary: async (req, res) => {
        try {
            const { budget, duration, interests, travelStyle } = req.body;
            const analytics = new Analytics({type: 'query_submitted', userId: req.user.id, metadata: { query: req.body }});
            await analytics.save();
            const result = await aiService.generateItinerary(req.user, {budget, duration, interests, travelStyle});
            res.json({ success: true, data: result });
        } catch (error) {res.status(500).json({ error: error.message || 'Failed to generate itinerary' })}
    },
    saveItinerary: async (req, res) => {
        try {
            const user = await User.findById(req.user.id);
            user.analytics.totalQueries += 1;
            await user.save();
            const analytics = new Analytics({type: 'itinerary_saved', userId: req.user.id});
            await analytics.save();
            res.json({ success: true, message: 'Itinerary saved successfully' });
        } catch (error) {res.status(500).json({ error: 'Failed to save itinerary' })}
    }
};

module.exports = aiController;