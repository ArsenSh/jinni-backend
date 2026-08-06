const axios = require('axios');

class BookingService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://api.booking.com';
    }

    async getPropertyDetails(propertyId) {
        try {
            const response = await axios.get(`${this.baseURL}/properties/${propertyId}`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.data;
        } catch (error) {
            throw new Error('Failed to fetch property details');
        }
    }

    async searchProperties(location, checkin, checkout) {
        try {
            const response = await axios.get(`${this.baseURL}/search`, {
                params: { location, checkin, checkout },
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.data.results;
        } catch (error) {
            throw new Error('Failed to search properties');
        }
    }
}

module.exports = BookingService;