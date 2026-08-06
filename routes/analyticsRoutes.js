const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const auth = require('../middleware/auth');

router.get('/dashboard', auth, analyticsController.getDashboardData);
router.get('/business/:id', auth, analyticsController.getBusinessAnalytics);

module.exports = router;