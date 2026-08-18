const UserActivity = require('../models/UserActivity');

/* Records "this user was active now, on this surface" — called from the
 * auth middleware on every authenticated request, fire-and-forget.
 *
 * Throttle: one DB write per user+surface per THROTTLE_MS. Retention
 * cares about day-level PRESENCE, not exact request counts, so skipping
 * rapid-fire repeats (SSE + image + settings calls of a single
 * interaction) keeps Atlas Flex ops low without losing the signal.
 * The in-memory map resets on redeploy — worst case an extra write, never
 * a lost day.
 */

const THROTTLE_MS = 60 * 1000;
const lastWrite = new Map();   // `${userId}:${day}:${surface}` → epoch ms
const MAP_CAP = 5000;          // hard cap; cleared wholesale if ever exceeded

function surfaceFor(url) {
    if (!url) return 'other';
    if (url.includes('/chat-stream')) return 'chat';
    if (url.includes('/quick-action')) return 'quickAction';
    if (url.includes('/explore')) return 'explore';
    if (url.startsWith('/api/itinerary')) return 'itinerary';
    if (url.startsWith('/api/saves')) return 'saves';
    if (url.startsWith('/api/routing')) return 'map';
    return 'other';
}

function recordActivity(user, originalUrl, body) {
    try {
        // Admin/staff/business sessions would poison the retention read —
        // only real travelers count.
        if (!user || (user.role && user.role !== 'user')) return;

        const now = new Date();
        const day = now.toISOString().slice(0, 10);   // UTC YYYY-MM-DD
        const surface = surfaceFor(originalUrl);
        const key = `${user._id}:${day}:${surface}`;

        const last = lastWrite.get(key);
        if (last && now.getTime() - last < THROTTLE_MS) return;
        if (lastWrite.size > MAP_CAP) lastWrite.clear();
        lastWrite.set(key, now.getTime());

        const inc = { requests: 1, [`surfaces.${surface}`]: 1 };
        // Search-mode split: only chat/quick-action bodies carry nearbyMode.
        if (body && typeof body.nearbyMode === 'boolean' && (surface === 'chat' || surface === 'quickAction')) {
            inc[body.nearbyMode ? 'modes.nearby' : 'modes.discovery'] = 1;
        }
        UserActivity.updateOne(
            { userId: user._id, day },
            {
                $setOnInsert: { firstAt: now },
                $set: {
                    lastAt: now,
                    country: user.settings?.location?.country || '',
                    language: user.settings?.language || ''
                },
                $inc: inc
            },
            { upsert: true }
        ).catch(err => {
            // Duplicate-key can race on the very first two writes of a day;
            // the second one retries as a plain update.
            if (err && err.code === 11000) {
                UserActivity.updateOne(
                    { userId: user._id, day },
                    { $set: { lastAt: now }, $inc: { requests: 1, [`surfaces.${surface}`]: 1 } }
                ).catch(() => {});
            } else {
                console.log('⚠️ userActivity write failed:', err.message);
            }
        });
    } catch (e) {
        // Analytics must never break a request.
        console.log('⚠️ recordActivity error:', e.message);
    }
}

module.exports = { recordActivity, surfaceFor };
