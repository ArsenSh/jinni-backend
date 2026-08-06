const TravelQuery = require('../models/TravelQuery');
const Business = require('../models/Business');
const openai = require('../config/openai');

const aiService = {
    generateItinerary: async (user, queryParams) => {
        if (!user.isPremium && user.analytics.totalQueries >= 5) {
            throw new Error('Free trial limit reached. Upgrade to premium');
        }
        if (process.env.USE_MOCK_DATA === "true") {
            return generateMockResponse(queryParams);
        }
        try {
            const prompt = `Create a personalized ${queryParams.duration}-day itinerary for Armenia focusing on ${queryParams.interests.join(', ')}. Budget: ${queryParams.budget} AMD. Travel style: ${queryParams.travelStyle}.`;
            const response = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
                max_tokens: 1000
            });
            const itinerary = response.choices[0].message.content;
            const partnerBusinesses = await Business.find({
                'partnership.isPartner': true
            }).limit(3);
            const travelQuery = new TravelQuery({
                userId: user._id,
                query: queryParams,
                response: {
                    itinerary,
                    recommendedBusinesses: partnerBusinesses.map(b => ({
                        businessId: b._id,
                        reason: "Featured partner",
                        priority: b.partnership.priorityScore
                    }))
                }
            });
            await travelQuery.save();
            return {
                itinerary,
                recommendedBusinesses: partnerBusinesses.map(b => ({
                    id: b._id,
                    name: b.name,
                    type: b.type,
                    description: b.description?.short || ''
                }))
            };
        } catch (error) {
            console.error('AI Error:', error.message);
            if (process.env.FALLBACK_TO_MOCK === "true") {
                console.warn("Using mock data due to API limits");
                return generateMockResponse(queryParams);
            }
            throw new Error('Failed to generate itinerary');
        }
    }
};

const generateMockResponse = (query) => {
    const { duration, budget, interests = [], travelStyle } = query;
    const days = {};
    const armenianCities = ["Yerevan", "Gyumri", "Dilijan", "Sevan", "Goris"];
    const activities = {
        cultural: ["Ancient Temple", "Museum Tour", "Art Gallery"],
        adventure: ["Hiking Trail", "Paragliding", "Rock Climbing"],
        luxury: ["Wine Tasting", "Spa Retreat", "Private Tour"]
    };
    for (let i = 1; i <= duration; i++) {
        const city = armenianCities[i % armenianCities.length];
        const styleActivities = activities[travelStyle] || activities.cultural;
        days[`day${i}`] = {
            morning: `${styleActivities[0]} in ${city}`,
            afternoon: `${interests[0] || styleActivities[1]} experience`,
            evening: `Dinner at ${city}'s best local restaurant`
        };
    }
    return {
        itinerary: days,
        estimatedCost: Math.floor(budget * 0.65),
        recommendedBusinesses: [{
            id: "mock-123",
            name: "Premium Armenian Tours",
            type: "tour_operator",
            reason: "Top-rated for " + (travelStyle || "cultural") + " experiences",
            mock: true
        }],
        _isMock: true, mockNotice: "DEMO DATA - Real AI recommendations will appear when enabled"
    };
};

module.exports = aiService;