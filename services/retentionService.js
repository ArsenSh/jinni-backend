const UserActivity = require('../models/UserActivity');
const User = require('../models/User');
const Analytics = require('../models/Analytics');
const UserAILimit = require('../models/UserAILimit');
const PlaceView = require('../models/PlaceView');
const ChatSession = require('../models/ChatSession');

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

async function buildRetentionReport({ windowDays = 30, country = '', city = '' } = {}) {
    const today = dayStr(new Date());
    const windowStart = addDays(today, -(windowDays - 1));

    /* $nin, not role:'user' — legacy accounts registered before the role
     * field existed carry NO role in the DB, and a positive match would
     * exclude all of them. */
    const TRAVELER_ROLE = { $nin: ['staff', 'admin'] };

    /* Optional country/city filter (marketing page dropdowns). The filter is
     * the users' CURRENT profile location (settings.location) — same source
     * as the "Users by country/city" cards, so the numbers stay consistent. */
    const locFilter = {};
    if (country) locFilter['settings.location.countryName'] = country;
    if (city) locFilter['settings.location.city'] = city;
    const filtering = !!(country || city);
    let filterSet = null, filterIds = null;
    if (filtering) {
        const ids = await User.find({ role: TRAVELER_ROLE, ...locFilter }).select('_id').lean();
        filterIds = ids.map(d => d._id);
        filterSet = new Set(filterIds.map(String));
    }

    /* Per-user lifetime shape: first/last active day + every active day.
     * Fine at current scale (hundreds–thousands of users); revisit with a
     * windowed variant past ~50k users. */
    let perUser = await UserActivity.aggregate([
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
    if (filterSet) perUser = perUser.filter(u => filterSet.has(String(u._id)));

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

    /* Language split — over ALL travelers (was: only users with activity
     * records, which showed "en · 1" while 22 users existed). App language
     * defaults to 'en', so missing values count as English. */
    const langAgg = await User.aggregate([
        { $match: { role: TRAVELER_ROLE, isActive: { $ne: false }, ...locFilter } },
        { $group: { _id: { $ifNull: ['$settings.language', 'en'] }, n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 8 }
    ]);
    const languages = langAgg.map(r => ({ key: r._id || 'en', users: r.n }));

    /* Surface usage + search-mode split within the window, plus how many
     * distinct users touched the map (route/distance calculations). */
    const actScope = filterIds ? { userId: { $in: filterIds } } : {};
    const [surfAgg, mapUsersAgg] = await Promise.all([
        UserActivity.aggregate([
            { $match: { day: { $gte: windowStart, $lte: today }, ...actScope } },
            { $group: {
                _id: null,
                chat: { $sum: '$surfaces.chat' }, quickAction: { $sum: '$surfaces.quickAction' },
                explore: { $sum: '$surfaces.explore' }, itinerary: { $sum: '$surfaces.itinerary' },
                saves: { $sum: '$surfaces.saves' }, map: { $sum: '$surfaces.map' }, other: { $sum: '$surfaces.other' },
                nearby: { $sum: '$modes.nearby' }, discovery: { $sum: '$modes.discovery' }
            } }
        ]),
        UserActivity.aggregate([
            { $match: { day: { $gte: windowStart, $lte: today }, 'surfaces.map': { $gt: 0 }, ...actScope } },
            { $group: { _id: '$userId' } },
            { $count: 'n' }
        ])
    ]);
    const surfaces = surfAgg[0] || {};
    delete surfaces._id;
    const searchModes = { nearby: surfaces.nearby || 0, discovery: surfaces.discovery || 0 };
    delete surfaces.nearby; delete surfaces.discovery;
    const mapUsers = mapUsersAgg[0]?.n || 0;

    const totalUsers = await User.countDocuments({ role: TRAVELER_ROLE, isActive: { $ne: false }, ...locFilter });
    const newUsers7 = await User.countDocuments({ role: TRAVELER_ROLE, 'analytics.registrationDate': { $gte: new Date(Date.now() - 7 * DAY_MS) }, ...locFilter });
    const newUsers30 = await User.countDocuments({ role: TRAVELER_ROLE, 'analytics.registrationDate': { $gte: new Date(Date.now() - 30 * DAY_MS) }, ...locFilter });

    /* What people ask for — quick-action categories + free chat (windowed).
     * Same Analytics events the admin quick-action-stats panel reads. */
    const windowStartDate = new Date(windowStart + 'T00:00:00Z');
    const userScope = filterIds ? { userId: { $in: filterIds } } : {};
    const [qaAgg, chatAgg] = await Promise.all([
        Analytics.aggregate([
            { $match: { type: 'quick_action_used', createdAt: { $gte: windowStartDate }, ...userScope } },
            { $group: { _id: '$metadata.action', n: { $sum: 1 } } }
        ]),
        Analytics.aggregate([
            { $match: { type: 'ai_chat_interaction', 'metadata.actionType': 'stream_chat', createdAt: { $gte: windowStartDate }, ...userScope } },
            { $count: 'n' }
        ])
    ]);
    const quickActions = qaAgg
        .filter(r => r._id)
        .map(r => ({ key: r._id, label: ACTION_LABELS[r._id] || r._id, n: r.n }));
    const chatN = chatAgg[0]?.n || 0;
    if (chatN) quickActions.push({ key: 'chat', label: 'Chat (free-form)', n: chatN });
    quickActions.sort((a, b) => b.n - a.n);

    /* Usage & limits: cooldowns right now, today's metered AI usage, and
     * card views over the window (PlaceView shown/engaged counters).
     * Honest caveat: the per-user meter has a known undercount bug (the
     * profile modal "0 requests" issue) — treat these as lower bounds. */
    const startTodayDate = new Date(today + 'T00:00:00Z');
    const [cooldownCount, meterAgg, pvAgg] = await Promise.all([
        UserAILimit.countDocuments({ cooldownUntil: { $gt: new Date() }, ...(filterIds ? { userId: { $in: filterIds } } : {}) }),
        UserAILimit.aggregate([
            { $match: { 'dailyUsage.lastResetDate': { $gte: startTodayDate }, ...(filterIds ? { userId: { $in: filterIds } } : {}) } },
            { $group: {
                _id: null,
                tokens: { $sum: '$dailyUsage.tokensUsed' },
                places: { $sum: '$dailyUsage.placesViewed' },
                meteredUsers: { $sum: { $cond: [{ $gt: [{ $add: ['$dailyUsage.tokensUsed', '$dailyUsage.placesViewed'] }, 0] }, 1, 0] } }
            } }
        ]),
        PlaceView.aggregate([
            { $match: { lastShownAt: { $gte: windowStartDate }, ...(filterIds ? { userId: { $in: filterIds } } : {}) } },
            { $group: { _id: null, shown: { $sum: '$shownCount' }, engaged: { $sum: '$engageCount' }, viewers: { $addToSet: '$userId' } } },
            { $project: { shown: 1, engaged: 1, viewers: { $size: '$viewers' } } }
        ])
    ]);
    const usage = {
        usersOnCooldown: cooldownCount,
        todayTokens: meterAgg[0]?.tokens || 0,
        todayPlaces: meterAgg[0]?.places || 0,
        todayMeteredUsers: meterAgg[0]?.meteredUsers || 0,
        cardViews: pvAgg[0]?.shown || 0,
        cardEngagements: pvAgg[0]?.engaged || 0,
        cardViewers: pvAgg[0]?.viewers || 0
    };

    /* Engagement actions over the window — chat sessions started, places
     * saved/shared, likes/dislikes, View More, and the card buttons (map/
     * directions, Ask AI, more info, more images — those four are logged
     * globally only since the track-interaction log shipped, so they count
     * from that deploy onward). */
    const [engAgg, chatSessions] = await Promise.all([
        Analytics.aggregate([
            { $match: {
                createdAt: { $gte: windowStartDate },
                type: { $in: ['place_interaction', 'place_share', 'recommendation_feedback', 'message_feedback', 'view_more_clicked', 'place_unsaved'] },
                ...userScope
            } },
            { $group: { _id: { t: '$type', a: '$metadata.action' }, n: { $sum: 1 } } }
        ]),
        ChatSession.countDocuments({ createdAt: { $gte: windowStartDate }, ...(filterIds ? { userId: { $in: filterIds } } : {}) })
    ]);
    const engCounts = {};
    for (const r of engAgg) {
        const key = r._id.t === 'place_interaction' ? (r._id.a || 'other') : r._id.t;
        engCounts[key] = (engCounts[key] || 0) + r.n;
    }
    const engagement = {
        chatSessions,
        saved: engCounts.place_saved || 0,
        unsaved: engCounts.place_unsaved || 0,
        shares: (engCounts.place_share || 0),
        cardFeedback: engCounts.recommendation_feedback || 0,
        messageFeedback: engCounts.message_feedback || 0,
        viewMore: engCounts.view_more_clicked || 0,
        mapOpens: engCounts.map_open || 0,
        askAi: engCounts.ai_ask || 0,
        moreInfo: engCounts.info_open || 0,
        moreImages: engCounts.more_images || 0
    };

    /* Aggregate onboarding preferences — same source as the admin
     * preference-stats panel (current saved preferences, travelers only). */
    const [travelStylesAgg, interestsAgg] = await Promise.all([
        User.aggregate([
            // Whitelist: the app's only styles are luxury and budget — legacy
            // docs carry stray values ('family' etc.) from an old onboarding.
            { $match: { role: TRAVELER_ROLE, onboardingCompleted: true, 'preferences.travelStyle': { $in: ['luxury', 'budget'] }, ...locFilter } },
            { $group: { _id: '$preferences.travelStyle', n: { $sum: 1 } } },
            { $sort: { n: -1 } }
        ]),
        User.aggregate([
            { $match: { role: TRAVELER_ROLE, onboardingCompleted: true, 'preferences.interests.0': { $exists: true }, ...locFilter } },
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
    /* Mode-based, like the admin users page: onboarding writes the same
     * object to settings.location AND preferences.destination, so the old
     * "destinations" read was a duplicate of "users". autoDetectLocation
     * (true/missing = GPS, false = destination mode) is the real signal;
     * settings.location is the field each mode actually maintains. */
    const locMatch = { role: TRAVELER_ROLE, isActive: { $ne: false }, ...locFilter };
    const gpsMatch = { ...locMatch, 'settings.privacy.autoDetectLocation': { $ne: false } };
    const destMatch = { ...locMatch, 'settings.privacy.autoDetectLocation': false };
    const [locCountry, locCity, destCountry, destCity] = await Promise.all([
        User.aggregate([
            { $match: { ...gpsMatch, 'settings.location.countryName': { $nin: ['', 'Select a country', null] } } },
            { $group: { _id: '$settings.location.countryName', n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...gpsMatch, 'settings.location.city': { $nin: ['', 'Select a city', null] } } },
            { $group: { _id: '$settings.location.city', country: { $first: '$settings.location.countryName' }, n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...destMatch, 'settings.location.countryName': { $nin: ['', 'Select a country', null] } } },
            { $group: { _id: '$settings.location.countryName', n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ]),
        User.aggregate([
            { $match: { ...destMatch, 'settings.location.city': { $nin: ['', 'Select a city', null] } } },
            { $group: { _id: '$settings.location.city', country: { $first: '$settings.location.countryName' }, n: { $sum: 1 } } },
            { $sort: { n: -1 } }, { $limit: 10 }
        ])
    ]);
    const asRows = a => a.map(r => ({ key: r._id, country: r.country || '', users: r.n }));
    const locations = {
        byCountry: asRows(locCountry),
        byCity: asRows(locCity),
        destinations: { byCountry: asRows(destCountry), byCity: asRows(destCity) }
    };

    /* Dropdown options for the report's own filters — always the FULL list
     * of countries (so a filtered view can still switch away), plus the
     * cities of the currently selected country. */
    const [optCountries, optCities] = await Promise.all([
        User.aggregate([
            { $match: { role: TRAVELER_ROLE, isActive: { $ne: false }, 'settings.location.countryName': { $nin: ['', 'Select a country', null] } } },
            { $group: { _id: '$settings.location.countryName' } },
            { $sort: { _id: 1 } }
        ]),
        country ? User.aggregate([
            { $match: { role: TRAVELER_ROLE, isActive: { $ne: false }, 'settings.location.countryName': country, 'settings.location.city': { $nin: ['', 'Select a city', null] } } },
            { $group: { _id: '$settings.location.city' } },
            { $sort: { _id: 1 } }
        ]) : Promise.resolve([])
    ]);

    return {
        generatedAt: new Date().toISOString(),
        windowDays,
        filters: { country: country || '', city: city || '' },
        filterOptions: { countries: optCountries.map(c => c._id), cities: optCities.map(c => c._id) },
        totals: { totalUsers, newUsers7, newUsers30, dau, wau, mau, trackedUsers: perUser.length },
        daily,
        returnRates,
        cohorts,
        languages,
        surfaces,
        searchModes,
        mapUsers,
        usage,
        engagement,
        quickActions,
        preferences,
        locations
    };
}

/* 10-minute in-process cache (keyed by window + filters) so marketers
 * refreshing or switching filters back and forth cost ~nothing. */
const _cache = new Map();   // key → { at, report }
async function buildRetentionReportCached(opts = {}) {
    const key = `${opts.windowDays || 30}|${opts.country || ''}|${opts.city || ''}`;
    const now = Date.now();
    const hit = _cache.get(key);
    if (hit && now - hit.at < 10 * 60 * 1000) return hit.report;
    const report = await buildRetentionReport(opts);
    if (_cache.size > 50) _cache.clear();
    _cache.set(key, { at: now, report });
    return report;
}

module.exports = { buildRetentionReport, buildRetentionReportCached };
