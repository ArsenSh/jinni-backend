// Jinni V2 Engine — session context helpers (pure).
// v1's lesson, kept: the frontend persists chat messages (PATCH
// /chat-sessions/:id), so the engine only READS session state — recent turns
// for intent/narration, and already-shown places so follow-ups ("more
// hotels") surface new ones instead of repeats.

/** Last few conversational turns, trimmed — same shape v1 feeds intentService. */
function recentTurnsFromMessages(messages, limit = 4) {
    return (messages || [])
        .filter(m => m && m.text)
        .slice(-limit)
        .map(m => ({ sender: m.sender, text: String(m.text).slice(0, 300) }));
}

/** Places already shown in this session → retrieval excludes. */
function shownFromMessages(messages) {
    const placeIds = [], names = [];
    for (const m of messages || []) {
        for (const r of m?.recommendations || []) {
            if (!r) continue;
            if (r.placeId) placeIds.push(r.placeId);
            if (r.name) names.push(r.name);
        }
    }
    return { placeIds: [...new Set(placeIds)], names: [...new Set(names)] };
}

/** Name→placeId pairs for every place shown in this session (first win per
 *  name) — the tool loop uses these so "the phone of Nairi" resolves to the
 *  EXACT card the traveler saw, never a same-named place elsewhere. */
function shownPlaces(messages) {
    const seen = new Map();
    for (const m of messages || []) {
        for (const r of m?.recommendations || []) {
            if (r?.name && !seen.has(r.name)) {
                seen.set(r.name, { name: r.name, placeId: r.placeId || null });
            }
        }
    }
    return [...seen.values()];
}

module.exports = { recentTurnsFromMessages, shownFromMessages, shownPlaces };
