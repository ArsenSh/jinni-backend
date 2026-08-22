// Nightly curated-source sweep — reads every enabled EventSource with patient
// timeouts and fills AiFoundEvent while nobody is waiting, so the events
// shelf is warm BEFORE users ask and in-chat hunts become rare. Web search is
// hard-disabled here (searchWeb stub): the cron reads only what validators
// registered — it can never spend a paid search.

const { huntEvents } = require('./hunt');
const { parseEventWindow } = require('../places/eventStore');

const SWEEP_TIMEOUT_MS = 30000;   // patient: slow hosts don't matter overnight

async function sweepEventSources(deps = {}) {
    const EventSource = deps.EventSource || require('../../models/EventSource');
    const hunt = deps.huntEvents || huntEvents;
    let groups = [];
    try {
        // One hunt per distinct location; country-wide sources (city null)
        // group under their country's name so the hunt query stays a city-ish
        // string and stored rows carry the right region.
        groups = await EventSource.aggregate([
            { $match: { enabled: true } },
            { $group: { _id: { city: '$city', country: '$country' }, n: { $sum: 1 } } },
        ]);
    } catch (err) {
        console.warn(`[source-sweep] registry unavailable: ${err.message}`);
        return { locations: 0, events: 0 };
    }
    if (!groups.length) return { locations: 0, events: 0 };

    const win = parseEventWindow('', Date.now());      // default horizon (14d)
    let events = 0;
    for (const g of groups) {
        const city = g._id.city || g._id.country;
        if (!city) continue;
        try {
            const out = await hunt(
                { city, country: g._id.country || null, center: null, window: win },
                { ...deps, timeoutMs: SWEEP_TIMEOUT_MS, searchWeb: async () => [] },
            );
            events += out.length;
        } catch (err) {
            console.warn(`[source-sweep] ${city}: ${err.message}`);
        }
    }
    console.log(`[source-sweep] ${groups.length} location(s) swept → ${events} event(s) on the shelf`);
    return { locations: groups.length, events };
}

module.exports = { sweepEventSources, SWEEP_TIMEOUT_MS };
