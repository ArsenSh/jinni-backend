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
        // Deliberately NOT told to the model (decision 2026-08-22): the partner
        // relationship is disclosed by the card BADGE, never by narration —
        // "a Jinni partner" in prose reads as advertising and burns blurb words
        // that should sell the experience. Trust > tier flattery.
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
              + 'You DO see the recent conversation above — reference it naturally; never claim you cannot see or remember it.\n'
              + 'Do not invent or name any specific real venue in THIS reply (none are verified on this turn). '
              + 'If the traveler wants places, hotels or recommendations, warmly invite them to ask directly '
              + '(e.g. "ask me for cozy bars nearby") — you WILL fetch real verified places with photo cards then. '
              + 'Never describe yourself as unable to name places, and never point the traveler to external sites or searches.',
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

/**
 * Structured narration: ONE call returns intro prose + a short blurb per card +
 * an optional follow-up question (v1's habit, kept). Card blurbs are flavor
 * text in v1's spirit (hasAIDescription) — but hard facts stay forbidden:
 * no prices, hours, menus, phones, or ratings beyond the given ones.
 */
function buildNarrationJson({ query, places = [], langName = 'English', timeNote = null, history = [] }) {
    const facts = places.map((p, i) => `${i}. ${placeFactLine(p).slice(2)}`).join('\n');
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply ONLY with JSON — no prose outside it, no markdown fences.\n'
              + 'Schema: {"intro": string, "cards": [{"i": number, "blurb": string}], "question": string|null}\n'
              + 'Rules:\n'
              + `- intro: 1–3 warm sentences in ${langName} answering the ask, highlighting 1–2 listed places by exact name. NEVER mention a place not on the list — including ones from earlier in the conversation.\n`
              + `- cards: one entry per listed index, blurb of 1–2 sentences (max ~35 words) in ${langName} on why it suits THIS ask — vivid but factual. Never state prices, opening hours, menus, phone numbers, addresses, or ratings other than those given.\n`
              + `- question: one short follow-up in ${langName} to refine the search (or null).\n`
              + '- HONESTY: never attribute a cuisine, specialty, or feature to a place unless its facts line states it. If none of the listed places truly matches what the traveler asked for (e.g. a cuisine you cannot see in the facts), open the intro by saying so plainly and present them as closest alternatives — never dress a place up as what it is not.\n'
              + '- If nothing genuinely fits, say so honestly in intro and return "cards": [].',
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

/** Parse the structured reply; null on any malformed answer (caller falls back
 *  to plain grounded prose — a bad model turn must never blank the reply). */
function parseNarrationJson(text, count) {
    try {
        const m = String(text || '').match(/\{[\s\S]*\}/);
        if (!m) return null;
        const obj = JSON.parse(m[0]);
        if (typeof obj.intro !== 'string' || !obj.intro.trim()) return null;
        const blurbs = new Array(count).fill(null);
        for (const c of (Array.isArray(obj.cards) ? obj.cards : [])) {
            if (c && Number.isInteger(c.i) && c.i >= 0 && c.i < count
                && typeof c.blurb === 'string' && c.blurb.trim()) {
                blurbs[c.i] = c.blurb.trim().slice(0, 240);
            }
        }
        const question = (typeof obj.question === 'string' && obj.question.trim())
            ? obj.question.trim().slice(0, 200) : null;
        return { intro: obj.intro.trim(), blurbs, question };
    } catch { return null; }
}

/**
 * STREAMED narration format: prose FIRST (streams live to the user), then the
 * <<<CARDS>>> delimiter, then a private JSON tail with a blurb for EVERY card
 * plus the follow-up question. Same grounding rules as the JSON variant.
 */
function buildStreamedNarrationMessages({ query, places = [], langName = 'English', timeNote = null, history = [] }) {
    const facts = places.map((p, i) => `${i}. ${placeFactLine(p).slice(2)}`).join('\n');
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion.\n'
              + `FIRST write 1–3 warm sentences in ${langName} answering the ask, highlighting 1–2 listed places by exact name. `
              + 'NEVER mention a place not on the list — including ones from earlier in the conversation.\n'
              + 'THEN, on a new line, write exactly <<<CARDS>>> followed by JSON only:\n'
              + '{"cards": [{"i": 0, "blurb": "..."}, ...], "question": "..." | null}\n'
              + `- cards MUST contain EXACTLY one entry for EVERY listed index (0..${Math.max(places.length - 1, 0)}), blurb of 1–2 sentences (max ~35 words) in ${langName} on why it suits THIS ask — vivid but factual. `
              + 'Never state prices, opening hours, menus, phone numbers, addresses, or ratings other than those given.\n'
              + `- question: one short follow-up in ${langName} to refine the search (or null).\n`
              + '- HONESTY: never attribute a cuisine, specialty, or feature to a place unless its facts line states it. If none of the listed places truly matches what the traveler asked for (e.g. a cuisine you cannot see in the facts), open the prose by saying so plainly and present them as closest alternatives — never dress a place up as what it is not.\n'
              + '- If nothing genuinely fits, say so honestly in the prose and return "cards": [].',
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

/** Parse the post-delimiter tail: {blurbs, question} or null on junk. */
function parseCardsTail(tail, count) {
    try {
        const m = String(tail || '').match(/\{[\s\S]*\}/);
        if (!m) return null;
        const obj = JSON.parse(m[0]);
        const blurbs = new Array(count).fill(null);
        for (const c of (Array.isArray(obj.cards) ? obj.cards : [])) {
            if (c && Number.isInteger(c.i) && c.i >= 0 && c.i < count
                && typeof c.blurb === 'string' && c.blurb.trim()) {
                blurbs[c.i] = c.blurb.trim().slice(0, 240);
            }
        }
        const question = (typeof obj.question === 'string' && obj.question.trim())
            ? obj.question.trim().slice(0, 200) : null;
        return { blurbs, question };
    } catch { return null; }
}

/**
 * Tool-loop turns (detail questions about a specific known place). The model
 * decides which tools to call; the honesty rules are v1's round-61 lessons
 * made structural: null = "not listed", point inward (the card's More button),
 * never outward to Google.
 */
function buildToolAnswerMessages({ message, langName = 'English', history = [] }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + 'The traveler asks about a specific place. Use get_place_details to fetch its verified data, then answer from THAT data only.\n'
              + '- A null field means the detail is not listed: say so briefly and point to the place\'s card — tap More for website, phone, hours and directions.\n'
              + '- NEVER tell the traveler to look a place up on Google, Google Maps or any external site.\n'
              + '- Never guess or invent details. 1–3 sentences, natural prose.',
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

module.exports = { buildGroundedMessages, buildChitchatMessages, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail, buildToolAnswerMessages, placeFactLine, historyTurns };
