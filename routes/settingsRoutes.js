const express = require('express');
const router = express.Router();
const User = require('../models/User');
const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const user = await User.findById(userId);
        if (!user) { 
            console.log('❌ USER NOT FOUND!');
            return res.status(404).json({ error: 'User not found' }) 
        }
        const settings = {
            language: user.settings?.language || 'en',
            theme: user.settings?.theme || 'auto',
            fontStyle: user.settings?.fontStyle || 'standard',
            textSize: user.settings?.textSize || 'normal',
            location: {
                country: user.settings?.location?.country || 'AM',
                countryName: user.settings?.location?.countryName || 'Armenia',
                city: user.settings?.location?.city || 'Yerevan',
                coordinates: {
                    lat: user.settings?.location?.coordinates?.lat || 40.1792,
                    lng: user.settings?.location?.coordinates?.lng || 44.4991
                },
                lastUpdated: user.settings?.location?.lastUpdated || new Date()
            },
            searchRadius: {
                nearby: user.settings?.searchRadius?.nearby || 5,
                discovery: user.settings?.searchRadius?.discovery || 50
            },
            privacy: {
                autoDetectLocation: user.settings?.privacy?.autoDetectLocation !== false,
                showDistances: user.settings?.privacy?.showDistances !== false,
                locationPermissionGranted: user.settings?.privacy?.locationPermissionGranted || false
            }
        };
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

router.patch('/', authenticateToken, async (req, res) => {
    try {
        const { language, theme, location, searchRadius, privacy, fontStyle, textSize } = req.body;
        const updateData = {};
        if (language && ['en', 'ru', 'zh', 'hy', 'fr', 'ar'].includes(language)) { updateData['settings.language'] = language }
        if (theme && ['auto', 'light', 'dark'].includes(theme)) { updateData['settings.theme'] = theme }
        if (fontStyle && ['standard', 'classic', 'elegant', 'rounded'].includes(fontStyle)) { updateData['settings.fontStyle'] = fontStyle }
        if (textSize && ['small', 'normal', 'big'].includes(textSize)) { updateData['settings.textSize'] = textSize }
        if (location) {
            if (location.country) { updateData['settings.location.country'] = location.country }
            if (location.countryName) { updateData['settings.location.countryName'] = location.countryName }
            if (location.city) { updateData['settings.location.city'] = location.city }
            if (location.coordinates) {
                const lat = parseFloat(location.coordinates.lat);
                const lng = parseFloat(location.coordinates.lng);
                if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    updateData['settings.location.coordinates.lat'] = lat;
                    updateData['settings.location.coordinates.lng'] = lng;
                    updateData['settings.location.lastUpdated'] = new Date();
                }
            }
        }
        if (searchRadius) {
            if (searchRadius.nearby >= 1 && searchRadius.nearby <= 20) { updateData['settings.searchRadius.nearby'] = searchRadius.nearby }
            if (searchRadius.discovery >= 10 && searchRadius.discovery <= 100) { updateData['settings.searchRadius.discovery'] = searchRadius.discovery }
        }
        if (privacy) {
            if (typeof privacy.autoDetectLocation === 'boolean') { updateData['settings.privacy.autoDetectLocation'] = privacy.autoDetectLocation }
            if (typeof privacy.showDistances === 'boolean') { updateData['settings.privacy.showDistances'] = privacy.showDistances }
            if (typeof privacy.locationPermissionGranted === 'boolean') { updateData['settings.privacy.locationPermissionGranted'] = privacy.locationPermissionGranted }
        }        
        const userId = req.user._id; 
        const user = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true, runValidators: true, upsert: false }).select('settings');
        if (!user) { 
            console.log('❌ User not found with ID:', userId);
            return res.status(404).json({ error: 'User not found' }) 
        }
        res.json({ success: true, message: 'Settings updated successfully', settings: user.settings });
    } catch (error) {
        console.error('❌ Error updating settings:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ error: 'Failed to update settings', details: error.message });
    }
});

router.put('/reset', authenticateToken, async (req, res) => {
    try {
        console.log('🔄 PUT /api/settings/reset - req.user._id:', req.user._id);
        const defaultSettings = {
            'settings.language': 'en',
            'settings.theme': 'auto',
            'settings.fontStyle': 'standard',
            'settings.textSize': 'normal',
            'settings.location.country': 'AM',
            'settings.location.countryName': 'Armenia',
            'settings.location.city': 'Yerevan',
            'settings.location.coordinates.lat': 40.1792,
            'settings.location.coordinates.lng': 44.4991,
            'settings.location.lastUpdated': new Date(),
            'settings.searchRadius.nearby': 5,
            'settings.searchRadius.discovery': 50,
            'settings.privacy.autoDetectLocation': true,
            'settings.privacy.showDistances': true
        };
        const user = await User.findByIdAndUpdate(req.user._id, { $set: defaultSettings }, { new: true }).select('settings');
        res.json({ success: true, message: 'Settings reset to defaults', settings: user.settings });
    } catch (error) {
        console.error('Error resetting settings:', error);
        res.status(500).json({ error: 'Failed to reset settings' });
    }
});

// POST geocode city (helper endpoint for city selection)
router.post('/geocode', authenticateToken, async (req, res) => {
    try {
        const { city, country } = req.body;
        if (!city) { return res.status(400).json({ error: 'City name required' }) }
        const geocodeResult = { city, country: country || 'Unknown', coordinates: { lat: 40.1792, lng: 44.4991 } };
        res.json({ success: true, data: geocodeResult });
    } catch (error) {
        console.error('Error geocoding:', error);
        res.status(500).json({ error: 'Failed to geocode location' });
    }
});

module.exports = router;