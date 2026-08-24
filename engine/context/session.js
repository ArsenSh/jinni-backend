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

/**
 * The last question that actually PRODUCED a deck — i.e. the ask a follow-up
 * like "other ones please" is really about.
 *
 * Live 2026-08-24: "other interesting events please, which you think will be
 * better to go with girlfriend" ran the query "then if you see what are my
 * preferences", because the refill path reused the literal previous message —
 * which was chit-chat. WHETHER a turn is a follow-up is a judgement, and the
 * intent model makes it. WHICH ask it follows is not: it is a lookup in
 * session state, and a turn that returned no cards cannot be the answer.
 *
 * Returns null when no carded ask sits in the visible window — the caller then
 * treats the turn as a fresh ask, which is honest. Guessing was the bug.
 */
function lastCardAsk(messages) {
    const list = messages || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.sender !== 'ai' || !(m.recommendations || []).length) continue;
        // The user turn immediately preceding that deck is the ask that made it.
        for (let j = i - 1; j >= 0; j--) {
            if (list[j]?.sender === 'user' && list[j].text) return String(list[j].text).slice(0, 300);
        }
        return null;
    }
    return null;
}

module.exports = { recentTurnsFromMessages, shownFromMessages, shownPlaces, lastCardAsk };
