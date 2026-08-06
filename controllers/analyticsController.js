const Analytics = require('../models/Analytics');
const User = require('../models/User');
const Business = require('../models/Business');

const analyticsController = {
    getDashboardData: async (req, res) => {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);
            const [userRegistrations, queriesSubmitted, businessConversions] = await Promise.all([
                Analytics.countDocuments({type: 'user_registration', createdAt: { $gte: startDate }}),
                Analytics.countDocuments({type: 'query_submitted', createdAt: { $gte: startDate }}),
                Analytics.countDocuments({type: 'business_conversion', createdAt: { $gte: startDate }})
            ]);
            const popularDestinations = await Analytics.aggregate([
                { $match: { type: 'itinerary_saved', createdAt: { $gte: startDate } } },
                { $group: { _id: "$metadata.destination", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 }
            ]);
            res.json({success: true, data: {userRegistrations, queriesSubmitted, businessConversions, popularDestinations}});
        } catch (error) {res.status(500).json({ error: 'Failed to fetch analytics' })}
    },
    getBusinessAnalytics: async (req, res) => {
        try {
            const businessId = req.params.id;
            const [views, clicks, conversions] = await Promise.all([
                Analytics.countDocuments({ businessId, type: 'business_viewed' }),
                Analytics.countDocuments({ businessId, type: 'business_clicked' }),
                Analytics.countDocuments({ businessId, type: 'business_conversion' })
            ]);
            const conversionRate = views > 0 ? (conversions / views * 100).toFixed(2) : 0;
            res.json({success: true, data: {views, clicks, conversions, conversionRate}});
        } catch (error) {res.status(500).json({ error: 'Failed to fetch business analytics' })}
    }
};

module.exports = analyticsController;