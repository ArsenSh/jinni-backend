const UserActivity = require('../models/UserActivity');
const User = require('../models/User');
const Analytics = require('../models/Analytics');

/* Mirrors JinniChat.vue's quick-action list (same map as the admin
 * quick-action-stats panel — keep the two in sync). */
const ACTION_LABELS = {
    restaurants: 'Restaurants', hotels: 'Hotels', hidden_gems: 'Hidden Gems',
    historical: 'Historical', events: 'Local Events', photo_spots: 'Photo Spots',
    shopping: 'Shopping', itinerary: 'Itinerary'
};

/* Builds the retention report served to the admin dashboard and the
 * token-guarded marketing page. Everything is computed from the
 * UserActivity day-rollup (cheap, LLM-free, no Google) + a User count.
 *
 * The report answers the marketing question directly: "after people try
 * the app (e.g. from an ad), do they come back?" — via new-vs-returning
 * daily series, D1/D7/D30 return rates, and weekly cohort curves.
 *
 * All aggregates only — no per-user data leaves this module, so the
 * marketing endpoint can safely be shared outside the team.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStr(d) { return new Date(d).toISOString().slice(0, 10); }
function addDays(day, n) { return dayStr(new Date(new Date(day + 'T00:00:00Z').getTime() + n * DAY_MS)); }
/* ISO week start (Monday) for a 'YYYY-MM-DD' day */
function weekStart(day) {
    const d = new Date(day + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
    return dayStr(new Date(d.getTime() - dow * DAY_MS));
}

async function buildRetentionReport({ windowDays = 30 } = {}) {
    const today = dayStr(new Date());
    const windowStart = addDays(today, -(windowDays - 1));

    /* Per-user lifetime shape: first/last active day + every active day.
     * Fine at current scale (hundreds–thousands of users); revisit with a
     * windowed variant past ~50k users. */
    const perUser = await UserActivity.aggregate([
        { $sort: { day: 1 } },
        { $group: {
            _id: '$userId',
            firstDay: { $first: '$day' },
            lastDay: { $last: '$day' },
            days: { $push: '$day' },
            country: { $last: '$country' },
            language: { $last: '$language' }
        } }
    ]);

    const activeByDay = new Map();      // day → Set(userIdStr)
    for (const u of perUser) {
        for (const d of u.days) {
            if (d < windowStart || d > today) continue;
            if (!activeByDay.has(d)) activeByDay.set(d, new Set());
            activeByDay.get(d).add(String(u._id));
        }
    }

    const firstDayByUser = new Map(perUser.map(u => [String(u._id), u.firstDay]));

    /* Daily series: active / new / returning */
    const daily = [];
    for (let i = 0; i < windowDays; i++) {
        const d = addDays(windowStart, i);
        if (d > today) break;
        const ids = activeByDay.get(d) || new Set();
        let newUsers = 0;
        for (const id of ids) if (firstDayByUser.get(id) === d) newUsers++;
        daily.push({ day: d, active: ids.size, newUsers, returning: ids.size - newUsers });
    }

    /* DAU / WAU / MAU */
    const activeSince = (fromDay) => {
        const s = new Set();
        for (const u of perUser) for (const d of u.days) if (d >= fromDay && d <= today) { s.add(String(u._id)); break; }
        return s.size;
    };
    const dau = (activeByDay.get(today) || new Set()).size;
    const wau = activeSince(addDays(today, -6));
    const mau = activeSince(addDays(today, -29));

    /* Return rates. dN = "of users whose first day is ≥N days old, % active
     * on any day within N days AFTER their first day". comeback = "% ever
     * active again after their first day" (the founder's core question). */
    const rate = (n) => {
        let eligible = 0, returned = 0;
        for (const u of perUser) {
            if (u.firstDay > addDays(today, -n)) continue;   // too recent to judge
            eligible++;
            const cutoff = addDays(u.firstDay, n);
            if (u.days.some(d => d > u.firstDay && d <= cutoff)) returned++;
        }
        return { eligible, returned, pct: eligible ? Math.round(1000 * returned / eligible) / 10 : null };
    };
    let cbEligible = 0, cbReturned = 0;
    for (const u of perUser) {
        if (u.firstDay > addDays(today, -7)) continue;       // give a week before judging
        cbEligible++;
        if (u.days.length > 1) cbReturned++;
    }
    const returnRates = {
        d1: rate(1), d7: rate(7), d30: rate(30),
        comeback: { eligible: cbEligible, returned: cbReturned, pct: cbEligible ? Math.round(1000 * cbReturned / cbEligible) / 10 : null }
    };

    /* Weekly cohorts: users grouped by the week they FIRST showed up;
     * for each later week, % of them active. Reads as the classic
     * retention curve marketing expects after a campaign. */
    const cohortMap = new Map();        // cohortWeek → [userIds]
    for (const u of perUser) {
        const w = weekStart(u.firstDay);
        if (!cohortMap.has(w)) cohortMap.set(w, []);
        cohortMap.get(w).push(u);
    }
    const thisWeek = weekStart(today);
    const cohortWeeks = [...cohortMap.keys()].sort().slice(-8);
    const cohorts = cohortWeeks.map(w => {
        const members = cohortMap.get(w);
        const weeks = [];
        for (let k = 0; ; k++) {
            const ws = addDays(w, k * 7);
            if (ws > thisWeek) break;
            const we = addDays(ws, 6);
            const active = members.filter(u => u.days.some(d => d >= ws && d <= we)).length;
            weeks.push(Math.round(1000 * active / members.length) / 10);
        }
        return { week: w, size: members.length, weeks };
    });

    /* Country / language split (locals vs visitors approximation) */
    const countBy = (field) => {
        const m = new Map();
        for (const u of perUser) {
            const v = u[field] || 'unknown';
            m.set(v, (m.get(v) || 0) + 1);
        }
        return [...m.entries()].map(([k, n]) => ({ key: k, users: n }))
            .sort((a, b) => b.users - a.users).slice(0, 8);
    };

    /* Surface usage within the window */
    const surfAgg = await UserActivity.aggregate([
        { $match: { day: { $gte: windowStart, $lte: today } } },
        { $group: {
            _id: null,
            chat: { $sum: '$surfaces.chat' }, quickAction: { $sum: '$surfaces.quickAction' },
            explore: { $sum: '$surfaces.explore' }, itinerary: { $sum: '$surfaces.itinerary' },
            saves: { $sum: '$surfaces.saves' }, other: { $sum: '$surfaces.other' }
        } }
    ]);
    const surfaces = surfAgg[0] || {};
    delete surfaces._id;

    const totalUsers = await User.countDocuments({ role: 'user', isActive: { $ne: false } });
    const newUsers7 = await User.countDocuments({ role: 'user', 'analytics.registrationDate': { $gte: new Date(Date.now() - 7 * DAY_MS) } });
    const newUsers30 = await User.countDocuments({ role: 'user', 'analytics.registrationDate': { $gte: new Date(Date.now() - 30 * DAY_MS) } });

    /* What people ask for — quick-action categories + free chat (windowed).
     * Same Analytics events the admin quick-action-stats panel reads. */
    const windowStartDate = new Date(windowStart + 'T00:00:00Z');
    const [qaAgg, chatAgg] = await Promise.all([
        Analytics.aggregate([
            { $match: { type: 'quick_action_used', createdAt: { $gte: windowStartDate } } },
            { $group: { _id: '$metadata.action', n: { $sum: 1 } } }
        ]),
        Analytics.aggregate([
            { $match: { type: 'ai_chat_interaction', 'metadata.actionType': 'stream_chat', createdAt: { $gte: windowStartDate } } },
            { $count: 'n' }
        ])
    ]);
    const quickActions = qaAgg
        .filter(r => r._id)
        .map(r => ({ key: r._id, label: ACTION_LABELS[r._id] || r._id, n: r.n }));
    const chatN = chatAgg[0]?.n || 0;
    if (chatN) quickActions.push({ key: 'chat', label: 'Chat (free-form)', n: chatN });
    quickActions.sort((a, b) => b.n - a.n);

    /* Aggregate onboarding preferences — same source as the admin
     * preference-stats panel (current saved preferences, travelers only). */
    const [travelStylesAgg, interestsAgg] = await Promise.all([
        User.aggregate([
            { $match: { role: 'user', onboardingCompleted: true, 'preferences.travelStyle': { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$preferences.travelStyle', n: { $sum: 1 } } },
            { $sort: { n: -1 } }
        ]),
        User.aggregate([
            { $match: { role: 'user', onboardingCompleted: true, 'preferences.interests.0': { $exists: true } } },
            { $unwind: '$preferences.interests' },
            { $group: { _id: '$preferences.interests', n: { $sum: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 10 }
        ])
    ]);
    const preferences = {
        travelStyles: travelStylesAgg.map(r => ({ key: r._id, users: r.n })),
        interests: interestsAgg.map(r => ({ key: r._id, users: r.n }))
    };

    /* Where users are + where they plan to travel — same aggregations as the
     * admin users page (settings.location = home, preferences.destination =
     * chosen trip), aggregate counts only. */
    const locMatch = { role: 'user', isActive: { $ne: false } };
    const [locCountry, locCity, destCountry, destCity] = await Promise.all([
        User.aggregate([
            { $match: { ...locMatch, 'settings.location.countryName': { $nin: ['', 'Select a country', null] } } },
            { $group: { _id: '$settings.location.countryName', n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...locMatch, 'settings.location.city': { $nin: ['', 'Select a city', null] } } },
            { $group: { _id: '$settings.location.city', country: { $first: '$settings.location.countryName' }, n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...locMatch, 'preferences.destination.countryName': { $nin: ['', null] } } },
            { $group: { _id: '$preferences.destination.countryName', n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...locMatch, 'preferences.destination.city': { $nin: ['', null] } } },
            { $group: { _id: '$preferences.destination.city', country: { $first: '$preferences.destination.countryName' }, n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ])
    ]);
    const asRows = a => a.map(r => ({ key: r._id, country: r.country || '', users: r.n }));
    const locations = {
        byCountry: asRows(locCountry),
        byCity: asRows(locCity),
        destinations: { byCountry: asRows(destCountry), byCity: asRows(destCity) }
    };

    return {
        generatedAt: new Date().toISOString(),
        windowDays,
        totals: { totalUsers, newUsers7, newUsers30, dau, wau, mau, trackedUsers: perUser.length },
        daily,
        returnRates,
        cohorts,
        languages: countBy('language'),
        surfaces,
        quickActions,
        preferences,
        locations
    };
}

/* 10-minute in-process cache so marketers refreshing the page cost ~nothing. */
let _cache = null, _cacheAt = 0;
async function buildRetentionReportCached(opts) {
    const now = Date.now();
    if (_cache && now - _cacheAt < 10 * 60 * 1000) return _cache;
    _cache = await buildRetentionReport(opts);
    _cacheAt = now;
    return _cache;
}

module.exports = { buildRetentionReport, buildRetentionReportCached };
