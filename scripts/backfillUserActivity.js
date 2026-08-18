/**
 * backfillUserActivity.js — reconstruct per-user-per-day activity history
 * from the Analytics event log, so retention numbers exist from the app's
 * first days instead of starting the day UserActivity shipped.
 *
 * WHY THIS EXISTS
 * ---------------
 * Live day-level tracking (models/UserActivity.js, written from the auth
 * middleware) only starts collecting when it deploys. But the Analytics
 * collection has been logging chat / quick-action / saves / itinerary events
 * WITH userId + createdAt since early on — enough to answer "which users were
 * active on which days" for the past. This script rolls those events up into
 * UserActivity docs marked `backfilled: true`.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   • INSERTS UserActivity docs for user+day pairs that have none.
 *   • NEVER overwrites an existing (live-recorded) user+day doc.
 *   • Skips events with no userId, and users whose role !== 'user'
 *     (admin/staff testing would poison the retention read).
 *   • Request counts per surface are approximate (events ≠ requests);
 *     day-level presence — what retention needs — is exact.
 *
 * USAGE
 *   node scripts/backfillUserActivity.js            # dry run (default)
 *   node scripts/backfillUserActivity.js --apply    # write the rollups
 *
 * Run from backend/ so .env resolves (needs MONGODB_URI).
 * Safe to re-run any time — it only fills gaps.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Analytics = require('../models/Analytics');
const UserActivity = require('../models/UserActivity');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');

/* Analytics type → UserActivity surface bucket */
const TYPE_TO_SURFACE = {
    ai_chat_interaction: 'chat',
    query_submitted: 'chat',
    message_feedback: 'chat',
    quick_action_used: 'quickAction',
    view_more_clicked: 'quickAction',
    itinerary_saved: 'itinerary',
    place_interaction: 'explore',
    recommendation_feedback: 'other',
    place_share: 'other',
    place_unsaved: 'saves',
    business_clicked: 'other',
    onboarding_completed: 'other',
    user_registration: 'other'
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

    // Only real travelers
    const travelers = await User.find({ role: 'user' }).select('_id settings.location.country settings.language').lean();
    const travelerSet = new Map(travelers.map(u => [String(u._id), u]));
    console.log(`Travelers (role=user): ${travelers.length}`);

    // Roll Analytics events up to user+day in the DB, not in memory
    const rollup = await Analytics.aggregate([
        { $match: { userId: { $ne: null } } },
        { $group: {
            _id: {
                u: '$userId',
                d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                t: '$type'
            },
            n: { $sum: 1 },
            firstAt: { $min: '$createdAt' },
            lastAt: { $max: '$createdAt' }
        } }
    ]);
    console.log(`Analytics rollup rows (user+day+type): ${rollup.length}`);

    // Merge types into one record per user+day
    const byUserDay = new Map();
    for (const r of rollup) {
        const uid = String(r._id.u);
        if (!travelerSet.has(uid)) continue;
        const key = `${uid}|${r._id.d}`;
        let rec = byUserDay.get(key);
        if (!rec) {
            rec = { userId: r._id.u, day: r._id.d, firstAt: r.firstAt, lastAt: r.lastAt, requests: 0,
                    surfaces: { chat: 0, quickAction: 0, explore: 0, itinerary: 0, saves: 0, other: 0 } };
            byUserDay.set(key, rec);
        }
        const surface = TYPE_TO_SURFACE[r._id.t] || 'other';
        rec.surfaces[surface] += r.n;
        rec.requests += r.n;
        if (r.firstAt < rec.firstAt) rec.firstAt = r.firstAt;
        if (r.lastAt > rec.lastAt) rec.lastAt = r.lastAt;
    }
    console.log(`Distinct traveler user-days in Analytics: ${byUserDay.size}`);

    // Which user+days already exist (live-recorded or previous backfill)?
    const existing = await UserActivity.find({}).select('userId day').lean();
    const existingSet = new Set(existing.map(e => `${e.userId}|${e.day}`));
    const toInsert = [...byUserDay.values()].filter(r => !existingSet.has(`${r.userId}|${r.day}`));
    console.log(`Already present: ${existingSet.size} · To insert: ${toInsert.length}`);

    if (!APPLY) {
        const days = [...new Set(toInsert.map(r => r.day))].sort();
        console.log(`Date range to backfill: ${days[0] || '—'} → ${days[days.length - 1] || '—'}`);
        const sample = toInsert.slice(0, 5).map(r => `${r.day} user=${String(r.userId).slice(-6)} req≈${r.requests}`);
        console.log('Sample:', sample);
        console.log('\nDry run only. Re-run with --apply to write.');
    } else {
        let inserted = 0;
        for (const r of toInsert) {
            const u = travelerSet.get(String(r.userId));
            try {
                await UserActivity.updateOne(
                    { userId: r.userId, day: r.day },
                    { $setOnInsert: {
                        firstAt: r.firstAt, lastAt: r.lastAt, requests: r.requests, surfaces: r.surfaces,
                        country: u?.settings?.location?.country || '',
                        language: u?.settings?.language || '',
                        backfilled: true
                    } },
                    { upsert: true }
                );
                inserted++;
            } catch (e) {
                if (e.code !== 11000) console.error(`Failed ${r.day}/${r.userId}:`, e.message);
            }
        }
        console.log(`Inserted ${inserted} user-day rollups (backfilled: true).`);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
