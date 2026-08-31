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
    // Refill chains must not eat their own memory (live 2026-08-31: each
    // filler refill became the NEXT refill's "ask" — "hotels in Dilijan"
    // degraded to "another ones please", and that junk became the retrieval
    // query and reached the paid search). A refill/count-only message is a
    // POINTER at an earlier ask, not an ask — walk past it to the deck it
    // continued. The newest filler is kept only as a last resort when the
    // visible window holds nothing substantive (safe: the paid boundary
    // independently refuses non-substantive queries).
    let fallbackAsk = null;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.sender !== 'ai' || !(m.recommendations || []).length) continue;
        // The user turn immediately preceding that deck is the ask that made it.
        let ask = null;
        for (let j = i - 1; j >= 0; j--) {
            if (list[j]?.sender === 'user' && list[j].text) { ask = String(list[j].text).slice(0, 300); break; }
        }
        if (!ask) continue;
        let substantive = true;
        try { substantive = require('../places/canonicalStore').isSubstantiveAsk(ask); }
        catch { /* test-lite env without the store — old behavior */ }
        if (substantive) return ask;
        if (!fallbackAsk) fallbackAsk = ask;
    }
    return fallbackAsk;
}

/** Display labels ('Hotel', 'Restaurant'…) of the deck on screen — the
 *  refill's category memory. "Give me 10 examples" continued the ASK's words
 *  but ran cat=free and served horseriding for a hotels deck (live
 *  2026-08-30); the cards themselves say what the deck was. */
function lastDeckLabels(messages) {
    const list = messages || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m && m.sender === 'ai' && (m.recommendations || []).length) {
            return m.recommendations.map(r => r?.category).filter(Boolean);
        }
    }
    return [];
}

/**
 * Subtype-narrowing detector (live 2026-08-31: "villas please" after a mixed
 * deck got "found nothing" while two SHOWN cards were villas — excluded as
 * already-seen). A message token that names something already ON SCREEN is the
 * traveler organizing what they saw, not asking for novelty — the caller may
 * re-serve the matching shown subset instead of the exhausted reply.
 *
 * Deterministic by construction: token ≥4 chars, not a vibe/function word
 * (canonicalStore's ONE stoplist), not an excluded token (city names, the
 * deck's own category noun — "more hotels" must never read as narrowing),
 * singular-folded ("villas"→"villa"), contained in a shown card's name.
 * Returns the matched tokens; empty = not a narrowing ask.
 */
function narrowingMatches(message, shownNames = [], { excludeTokens = [] } = {}) {
    let vibe;
    // Lazy require: session.js stays light for its own tests; no cycle
    // (canonicalStore never imports session.js).
    try { vibe = require('../places/canonicalStore').VIBE_TOKENS; } catch { vibe = new Set(); }
    const fold = (t) => String(t || '').toLowerCase().replace(/s$/, '');
    const excluded = new Set((excludeTokens || []).filter(Boolean).map(fold));
    const names = (shownNames || []).map(n => String(n || '').toLowerCase());
    if (!names.length) return [];
    const toks = String(message || '').toLowerCase().split(/[^a-z0-9Ѐ-ӿ԰-֏]+/u)
        .filter(t => t.length >= 4 && !vibe.has(t))
        .map(fold)
        .filter(t => t.length >= 3 && !excluded.has(t));
    return [...new Set(toks.filter(t => names.some(n => n.includes(t))))];
}

module.exports = { recentTurnsFromMessages, shownFromMessages, shownPlaces, lastCardAsk, lastDeckLabels, narrowingMatches };
