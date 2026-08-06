const axios = require('axios');

module.exports = {
    getLocationImages: async (locationName) => {
        try {
            const googleResponse = await axios.get(
                `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`,
                {
                    params: {
                        input: `${locationName} Armenia`,
                        inputtype: 'textquery',
                        fields: 'photos',
                        key: process.env.GOOGLE_API_KEY,
                        locationbias: 'point:40.1772,44.50349'
                    }
                }
            );
            if (googleResponse.data.candidates?.[0]?.photos) {
                return googleResponse.data.candidates[0].photos.map(photo =>
                    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${photo.photo_reference}&key=${process.env.GOOGLE_API_KEY}`
                );
            }
            return [];
        } catch (error) {
            console.error('Image service error:', error);
            return [];
        }
    }
}