const Business = require('../models/Business');

const businessController = {
    createBusiness: async (req, res) => {
        try {
            const newBusiness = new Business(req.body);
            await newBusiness.save();
            res.status(201).json(newBusiness);
        } catch (error) {res.status(400).json({ error: 'Failed to create business' })}
    },
    getBusiness: async (req, res) => {
        try {
            const business = await Business.findById(req.params.id);
            if (!business) return res.status(404).json({ error: 'Business not found' });
            res.json(business);
        } catch (error) {res.status(500).json({ error: 'Server error' })}
    },
    updateBusiness: async (req, res) => {
        try {
            const updatedBusiness = await Business.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
            if (!updatedBusiness) return res.status(404).json({ error: 'Business not found' });
            res.json(updatedBusiness);
        } catch (error) {res.status(400).json({ error: 'Update failed' })}
    }
};

module.exports = businessController;