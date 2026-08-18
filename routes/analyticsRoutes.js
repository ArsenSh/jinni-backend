const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const auth = require('../middleware/auth');

router.get('/dashboard', auth, analyticsController.getDashboardData);
router.get('/business/:id', auth, analyticsController.getBusinessAnalytics);

/* ── Marketing retention report (token-guarded, no login) ────────────────
 * Shared with external marketing partners as a standing link:
 *   https://jinni.travel/marketing/<token>  →  this endpoint.
 * The token lives in the MARKETING_REPORT_TOKEN env var (Coolify):
 *   - unset  → endpoint disabled (404), safe default
 *   - rotate → old links die instantly, no code change
 * Serves ONLY aggregate numbers (no emails, names or per-user rows) —
 * see services/retentionService.js. Cached 10 min in-process. */
/* Authed variant — for marketing staff accounts (created from the admin
 * staff page with the "Marketing report" permission) and admins. Same
 * aggregate report as the token link. */
router.get('/marketing-report', auth, async (req, res) => {
    try {
        const u = req.user;
        const allowed = u?.role === 'admin' || u?.isAdmin === true ||
            (u?.role === 'staff' && u?.staffAssignment?.permissions?.viewMarketing === true);
        if (!allowed) return res.status(403).json({ error: 'Not allowed' });
        const report = await require('../services/retentionService').buildRetentionReportCached({ windowDays: 30 });
        res.json({ success: true, data: report });
    } catch (error) {
        console.error('Marketing report (authed) error:', error);
        res.status(500).json({ error: 'Failed to build report' });
    }
});

router.get('/marketing-report/:token', async (req, res) => {
    try {
        const expected = process.env.MARKETING_REPORT_TOKEN;
        if (!expected) return res.status(404).json({ error: 'Not found' });
        if (req.params.token !== expected) return res.status(403).json({ error: 'Invalid link' });
        const report = await require('../services/retentionService').buildRetentionReportCached({ windowDays: 30 });
        res.json({ success: true, data: report });
    } catch (error) {
        console.error('Marketing report error:', error);
        res.status(500).json({ error: 'Failed to build report' });
    }
});

module.exports = router;