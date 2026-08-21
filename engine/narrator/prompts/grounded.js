// Jinni V2 Engine — grounded narration prompts (pure functions).
// THE v2 rule, stated structurally: the narrator may name ONLY the places the
// retrieval core returned. It narrates evidence; it never discovers. The tiny
// prompt is the point (ChatV2 §2/§3) — tools/retrieval replaced the v1 pleading.

/** One evidence line per place — the ONLY facts the model may assert. */
function placeFactLine(p) {
    const bits = [
        p.primaryType || (Array.isArray(p.types) && p.types[0]) || null,
        p.distanceKm != null ? `${p.distanceKm.toFixed(1)} km away` : null,
        p.rating ? `rated ${p.rating}` : null,
        p._openNow === true ? 'open now' : (p._openNow === false ? 'closed right now' : null),
        p.source === 'destination' ? 'verified by Jinni staff' : null,
        p.source === 'business' ? 'Jinni partner' : null,
    ].filter(Boolean);
    return `- ${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** Session turns ({sender:'user'|'ai', text}) → provider messages, oldest first. */
function historyTurns(history) {
    return (history || [])
        .filter(t => t && t.text)
        .map(t => ({ role: t.sender === 'ai' ? 'assistant' : 'user', content: String(t.text).slice(0, 300) }));
}

/**
 * Place-query narration: retrieved facts in, warm prose out — nothing invented.
 * History rides along so follow-ups ("which one is closest?") read naturally,
 * but the ONLY nameable places are still the ones on THIS turn's list.
 * @param {object} opts {query, places, langName, timeNote, history}
 */
function buildGroundedMessages({ query, places = [], langName = 'English', timeNote = null, history = [] }) {
    const facts = places.map(placeFactLine).join('\n');
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + 'You are given a VERIFIED list of real places. Rules:\n'
              + '- Recommend ONLY from the list, by exact name. NEVER mention any place not on it — including places from earlier in the conversation.\n'
              + '- Only assert the facts given per place (distance, rating, open state). No prices, no hours, no dishes unless given.\n'
              + '- If nothing on the list genuinely fits the request, say so honestly and suggest broadening — do not force a bad match.\n'
              + '- 2–5 sentences. No lists, no headers — natural prose.',
        },
        ...historyTurns(history),
        {
            role: 'user',
            content:
                `Traveler asks: "${query}"\n`
              + (timeNote ? `Right now: ${timeNote}.\n` : '')
              + `Verified places:\n${facts}`,
        },
    ];
}

/** Non-place turns: just be Jinni — and never name specific venues (none are verified). */
function buildChitchatMessages({ message, langName = 'English', history = [] }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + 'This is a casual/meta message — answer naturally in 1–3 sentences.\n'
              + 'Do NOT recommend or name any specific real place, restaurant or venue in this reply '
              + '(none are verified on this turn); if asked for places, invite the traveler to ask for what they want.',
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

module.exports = { buildGroundedMessages, buildChitchatMessages, placeFactLine, historyTurns };
