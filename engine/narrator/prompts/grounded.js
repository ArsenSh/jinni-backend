// Jinni V2 Engine — grounded narration prompts (pure functions).
// THE v2 rule, stated structurally: the narrator may name ONLY the places the
// retrieval core returned. It narrates evidence; it never discovers. The tiny
// prompt is the point (ChatV2 §2/§3) — tools/retrieval replaced the v1 pleading.

/** One evidence line per place — the ONLY facts the model may assert. */
const { CATEGORY_VOCABULARY, normalizeCategory } = require('../cards');

function placeFactLine(p) {
    const bits = [
        // Up to three raw Google types, not one. The model is asked to NAME
        // what this place is (see the card schema), and one coarse type is not
        // enough to tell a rental agency from an apartment block — the live
        // 2026-08-24 deck where a mall, an opera house and a real-estate office
        // all came out "Attraction".
        [p.primaryType, ...(Array.isArray(p.types) ? p.types : [])]
            .filter(Boolean).filter((t, i, a) => a.indexOf(t) === i)
            .filter(t => !/^(point_of_interest|establishment)$/.test(t))
            .slice(0, 3).join('/') || null,
        p.distanceKm != null ? `${p.distanceKm.toFixed(1)} km away` : null,
        p.rating ? `rated ${p.rating}` : null,
        p._openNow === true ? 'open now' : (p._openNow === false ? 'closed right now' : null),
        p.source === 'destination' ? 'verified by Jinni staff' : null,
        // Event date — the ONE fact that makes an event an event. English
        // weekday/month; the narrator renders it in the reply language.
        p.eventSchedule?.startDate ? `event on ${new Date(p.eventSchedule.startDate).toUTCString().slice(0, 16)}` : null,
        // Ticket price VERBATIM from the source page. It is here so the blurb
        // may quote it — and because it is here, the model never has to invent
        // one. Absent ⇒ the page printed no price ⇒ the blurb says nothing.
        p.price ? `ticket price ${p.price}` : null,
        // Personal-taste facts (personalization/taste.js annotations): honest,
        // user-visible memory — "you saved this one" is delight, not ads.
        // One line max: an explicit like outranks the bookmark mention.
        p._tasteLiked ? 'the traveler liked this place before'
            : (p._tasteSaved ? 'the traveler has saved this place' : null),
        // Deliberately NOT told to the model (decision 2026-08-22): the partner
        // relationship is disclosed by the card BADGE, never by narration —
        // "a Jinni partner" in prose reads as advertising and burns blurb words
        // that should sell the experience. Trust > tier flattery.
    ].filter(Boolean);
    return `- ${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** Session turns ({sender:'user'|'ai', text}) → provider messages, oldest first. */
// Every prose path shares this. Live 2026-08-24: asked "where can I buy a SIM
// card", Jinni answered Russian events + visas + which AI it runs on + SIMs, in
// four bold sections. The history is there for CONTEXT, not as a to-do list —
// earlier questions already got their own replies.
const ANSWER_ONLY_CURRENT =
    'Answer ONLY the traveler\'s CURRENT message. Earlier questions in this conversation have already '
  + 'been answered — never answer them again, never summarise them, and never open with a correction or '
  + 'apology about an earlier turn unless the current message asks about it. '
  + 'Plain sentences only: no headers, no bullet lists, no bold section titles.\n';

// ── SELF-KNOWLEDGE AS EVIDENCE ───────────────────────────────────────────────
//
// Live 2026-08-24. Asked "what are my preferences?" three times, Jinni said
// "cozy, low-key spots, local food, avoiding touristy crowds" — while the
// stored travelStyle was 'luxury' — then two turns later denied having any
// access at all. It also announced it was "made by Withlocals", a company with
// no connection to this app.
//
// Neither was a reasoning failure. The preferences were loaded the whole time
// (they steer ranking; `style=luxury` is in every retrieval log line) and were
// simply never shown to the narrator. Withholding real data does not make a
// model safer — it makes it guess, and a guess is the thing we are trying to
// prevent. So the traveler's saved settings and Jinni's own identity become
// ROWS, and a claim with no row behind it is forbidden.
//
// Only what is verifiable belongs here. Which model answers a turn varies per
// request, and the company behind the app is not this file's to assert — so
// neither is listed, and "I don't know" is the required answer for both.
const IDENTITY_ROWS = [
    'You are Jinni, the travel companion inside the Jinni app (jinni.travel).',
    'You find real, verified places and events near the traveler, and answer practical travel questions from sourced notes.',
    'You DO see the current conversation. You do NOT carry memory between separate chats.',
];

const SELF_KNOWLEDGE_RULE =
    'ABOUT YOURSELF AND THE TRAVELER you may state ONLY what the rows below say. '
  + 'Anything absent from them you genuinely do not know — which AI model answers you, which company '
  + 'built or owns the app, the traveler\'s tastes, budget, home city or past trips. Say you don\'t know '
  + 'in one short sentence and move on. Never name a company or a model, never describe a preference '
  + 'that is not listed, and never claim to see settings that are not listed.\n';

/** The traveler's SAVED settings, one row per field that actually holds a value.
 *  Absent fields stay absent on purpose: a missing row means "unknown", which
 *  the rule above turns into an honest "I don't know" instead of an invention. */
function travelerRows(preferences) {
    const p = preferences || {};
    const rows = [];
    if (p.travelStyle) rows.push(`travel style: ${p.travelStyle}`);
    if (Array.isArray(p.interests) && p.interests.length) rows.push(`interests: ${p.interests.join(', ')}`);
    if (p.budget && (p.budget.min != null || p.budget.max != null)) {
        rows.push(`budget: ${[p.budget.min, p.budget.max].filter(v => v != null).join('–')} ${p.budget.currency || 'USD'}`);
    }
    if (Array.isArray(p.accessibility) && p.accessibility.length) rows.push(`accessibility needs: ${p.accessibility.join(', ')}`);
    if (Array.isArray(p.languages) && p.languages.length) rows.push(`languages: ${p.languages.join(', ')}`);
    const d = p.destination || {};
    if (d.city || d.countryName) rows.push(`destination they saved: ${[d.city, d.countryName].filter(Boolean).join(', ')}`);
    return rows;
}

/** Identity rows + traveler rows + the no-invention rule, as one prompt block. */
function selfBlock(preferences) {
    const rows = travelerRows(preferences);
    return SELF_KNOWLEDGE_RULE
        + 'ROWS ABOUT YOU:\n' + IDENTITY_ROWS.map(r => `- ${r}`).join('\n') + '\n'
        + (rows.length
            ? 'ROWS ABOUT THIS TRAVELER (from their saved Preferences — you DO see these):\n'
              + rows.map(r => `- ${r}`).join('\n')
              + '\nQuote these when asked, and let them shape what you suggest. Nothing else about them is known to you.\n'
            : 'ROWS ABOUT THIS TRAVELER: none — they have saved no preferences. If they ask what their '
              + 'preferences are, say plainly that none are saved yet and that they can set them in Preferences. '
              + 'Do NOT describe any taste, style or budget for them.\n');
}

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
              + ANSWER_ONLY_CURRENT
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
function buildChitchatMessages({ message, langName = 'English', history = [], localFacts = [], preferences = null }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences)
              + (localFacts.length
                  ? 'The traveler asked a practical question and you HAVE verified notes for it below — '
                  + 'answer from them, attribute the source, and never contradict them from memory. '
                  + 'For entry rules and safety, tell them to confirm with the official authority.\n'
                  : '')
              + 'This is a casual/meta message — answer naturally in 1–3 sentences.\n'
              + 'You DO see the recent conversation above — reference it naturally; never claim you cannot see or remember it.\n'
              + 'Do not invent or name any specific real venue in THIS reply (none are verified on this turn). '
              + 'If the traveler wants places, hotels or recommendations, warmly invite them to ask directly '
              + '(e.g. "ask me for cozy bars nearby") — you WILL fetch real verified places with photo cards then. '
              + 'Never describe yourself as unable to name places, and never point the traveler to external sites or searches.'
              + localFactsBlock(localFacts),
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

/**
 * "How do I get around / get there" turns (Arsen 2026-08-23, after his brother
 * asked "I want to book a taxi. How can I do it" and got six sightseeing
 * cards). Transport is the traveler's second question after "where do I eat",
 * and it is answered in PROSE — no cards, no retrieval, no Google spend.
 * Ride-hailing apps and metro lines are services, not venues, so naming them
 * breaks no honesty rule; invented fares and phone numbers would, and are
 * forbidden.
 */
/** Owned, sourced knowledge → prompt block. Facts outrank model memory, and
 *  the source is named so the answer can attribute it (a licence duty for
 *  Wikivoyage's CC BY-SA and the FCDO's Open Government Licence alike). */
function localFactsBlock(facts = [], maxChars = 4000) {
    if (!Array.isArray(facts) || !facts.length) return '';
    return '\nVERIFIED LOCAL NOTES — prefer these over your own knowledge, and name the source in your reply:\n'
        + facts.map(f => {
            const age = f.reviewedAt ? ` (source reviewed ${new Date(f.reviewedAt).toISOString().slice(0, 10)})` : '';
            return `[${f.sourceName}${age}] ${f.title || ''}\n${String(f.body || '').slice(0, maxChars)}`
                + (f.caveat ? `\nCAVEAT you must pass on: ${f.caveat}` : '');
        }).join('\n\n') + '\n';
}

function buildGettingAroundMessages({ message, langName = 'English', cityLabel = null, timeNote = null, history = [], canQuoteFares = false, localFacts = [], preferences = null }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences)
              + 'The traveler is asking how to GET AROUND or reach somewhere'
              + (cityLabel ? ` in ${cityLabel}` : '') + '. Answer it directly in 2–4 sentences.\n'
              + (timeNote ? `Right now: ${timeNote} — factor it in (heat, late hour) when it matters.\n` : '')
              + 'Answer the MODE they actually asked about — walking, taxi or ride-hailing, metro or bus, '
              + 'driving or renting, ferry, or flying between cities — and name what a local would name: '
              + 'the apps that genuinely operate there, the official taxi, the line or route that serves the trip. '
              + 'If they only asked "how do I get there", say which mode you would take and why.\n'
              + 'NEVER invent fares, phone numbers, timetables, journey times, or app names you are not sure '
              + 'operate in that city — say "roughly" or leave the number out instead.\n'
              + (canQuoteFares
                  ? 'For flights between cities you have a find_flights tool: call it and quote ONLY the fares it '
                  + 'returns, with its booking link. If it returns nothing, say you have no fares for that route.\n'
                  : '')
              + 'Do not name specific venues (none are verified on this turn). '
              + 'If knowing their destination would let you answer better, end by asking where they are heading.'
              + localFactsBlock(localFacts),
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

/**
 * The RELEVANCE BRAKE's voice: the traveler asked for something specific and
 * NOTHING in the pool matches it. Padding the deck with whatever is nearby is
 * how "book a taxi" became six museums — so we say so instead, in prose, with
 * no cards attached.
 */
function buildNoMatchMessages({ message, langName = 'English', unmatched = [], cityLabel = null, history = [], preferences = null }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences)
              + 'You searched your verified data' + (cityLabel ? ` for ${cityLabel}` : '')
              + ' and found NOTHING matching what the traveler asked'
              + (unmatched.length ? ` (nothing for: ${unmatched.slice(0, 4).join(', ')})` : '') + '.\n'
              + 'Say that plainly in 1–2 sentences — no apology spiral — then be useful: '
              + 'if the question has a real-world answer you are confident about, give it briefly; '
              + 'otherwise offer the nearest thing you COULD look up and invite them to ask for it.\n'
              + 'Never name a specific venue, address or business in this reply — none are verified on this turn. '
              + 'Never suggest external websites or search engines.',
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
function buildStreamedNarrationMessages({ query, places = [], langName = 'English', timeNote = null, history = [], localFacts = [], preferences = null }) {
    const facts = places.map((p, i) => `${i}. ${placeFactLine(p).slice(2)}`).join('\n');
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion.\n'
              + selfBlock(preferences)
              + `FIRST write 1–3 warm sentences in ${langName} answering the ask, highlighting 1–2 listed places by exact name. `
              + 'NEVER mention a place not on the list — including ones from earlier in the conversation.\n'
              + 'THEN, on a new line, write exactly <<<CARDS>>> followed by JSON only:\n'
              + '{"cards": [{"i": 0, "kind": "...", "blurb": "..."}, ...], "question": "..." | null}\n'
              + `- cards MUST contain EXACTLY one entry for EVERY listed index (0..${Math.max(places.length - 1, 0)}), blurb of 1–2 sentences (max ~35 words) in ${langName} on why it suits THIS ask — vivid but factual. `
              // The card's category. Google's raw types are on each facts line
              // and they are coarse — a rental agency, an apartment block and a
              // mall can all arrive as one vague type. The model reads the NAME
              // too, so it can tell them apart; code then checks the answer is
              // a vocabulary word and ignores anything else.
              + '\n- kind: what this place IS, chosen from this list EXACTLY as spelled, in English (never translated):\n'
              + `  ${CATEGORY_VOCABULARY.join(', ')}.\n`
              + '  Judge from the name AND the raw types shown. Pick the most specific one that is TRUE; '
              + 'use "Place" only when nothing else honestly fits. Never invent a word outside the list.\n'
              + 'Never state prices, opening hours, menus, phone numbers, addresses, or ratings other than those given.\n'
              + `- question: one short follow-up in ${langName} to refine the search (or null).\n`
              + '- HONESTY: never attribute a cuisine, specialty, or feature to a place unless its facts line states it. If none of the listed places truly matches what the traveler asked for (e.g. a cuisine you cannot see in the facts), open the prose by saying so plainly and present them as closest alternatives — never dress a place up as what it is not.\n'
              // Owned notes on a PLACES turn (Arsen 2026-08-24, after "where can
              // I buy a SIM card" returned phone-repair shops and a blurb
              // claimed one sold tourist SIMs). The notes say what a local
              // knows; the cards stay whatever search found.
              + (localFacts.length
                  ? '- You also hold VERIFIED LOCAL NOTES below. Open the prose with what they say when it answers the ask better than the cards do (which operators/companies actually serve travellers, what documents are needed), then present the cards as where to go. Never contradict the notes from memory, and never claim a listed place offers something no fact states.\n'
                  : '')
              + '- The card deck is already FIXED by search — your tail only LABELS it. So ALWAYS emit the <<<CARDS>>> line with one blurb per index: when the places fit poorly, when the traveler seems to have changed subject, and even when you want to ask something first. Put the caveat in the prose, the question in "question", and still describe every card. Omitting the tail, or returning an empty "cards" array, leaves the traveler staring at unlabelled cards (live 2026-08-23: five event cards each read only "Event").',
        },
        ...historyTurns(history),
        {
            role: 'user',
            content:
                `Traveler asks: "${query}"\n`
              + (timeNote ? `Right now: ${timeNote}.\n` : '')
              // Capped hard: a places turn must not pay full-length notes.
              + localFactsBlock(localFacts, 1200)
              + `Verified places:\n${facts}`,
        },
    ];
}

/** Parse the post-delimiter tail: {blurbs, kinds, question} or null on junk.
 *  `kinds` are the model's category names, already checked against the
 *  vocabulary — an unrecognised word is dropped, never rewritten, and that
 *  slot falls back to the deterministic table in cards.js. */
function parseCardsTail(tail, count) {
    const text = String(tail || '');
    const blurbs = new Array(count).fill(null);
    const kinds = new Array(count).fill(null);
    let question = null;

    // Pass 1 — parse the JSON, tolerating the model's most common slip
    // (trailing commas before } or ]).
    let obj = null;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
        for (const candidate of [m[0], m[0].replace(/,\s*([}\]])/g, '$1')]) {
            try { obj = JSON.parse(candidate); break; } catch { /* next repair */ }
        }
    }
    if (obj) {
        for (const c of (Array.isArray(obj.cards) ? obj.cards : [])) {
            if (!c || !Number.isInteger(c.i) || c.i < 0 || c.i >= count) continue;
            if (typeof c.blurb === 'string' && c.blurb.trim()) blurbs[c.i] = c.blurb.trim().slice(0, 240);
            const kind = normalizeCategory(c.kind);
            if (kind) kinds[c.i] = kind;
        }
        if (typeof obj.question === 'string' && obj.question.trim()) {
            question = obj.question.trim().slice(0, 200);
        }
        // A parse that yielded NOTHING (valid JSON, wrong shape) still gets
        // the salvage pass below — don't return an empty win.
        if (blurbs.some(Boolean) || kinds.some(Boolean) || question) return { blurbs, kinds, question };
    }

    // Pass 2 — salvage (battery row 7, 2026-08-22): a truncated or malformed
    // tail still usually contains well-formed {"i":N,"blurb":"…"} fragments;
    // recover them individually so most cards keep their written blurbs
    // instead of ALL falling back to fact-lines.
    const cardRe = /"i"\s*:\s*(\d+)\s*(?:,\s*"kind"\s*:\s*"([^"]*)")?\s*,\s*"blurb"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let hit, salvaged = false;
    while ((hit = cardRe.exec(text))) {
        const i = Number(hit[1]);
        if (i >= 0 && i < count) {
            const kind = normalizeCategory(hit[2]);
            if (kind) kinds[i] = kind;
            try { blurbs[i] = JSON.parse(`"${hit[3]}"`).trim().slice(0, 240); salvaged = true; }
            catch { /* bad escapes — skip this fragment */ }
        }
    }
    const qm = text.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (qm) {
        try { question = JSON.parse(`"${qm[1]}"`).trim().slice(0, 200); } catch { /* skip */ }
    }
    return (salvaged || question) ? { blurbs, kinds, question } : null;
}

/**
 * Tool-loop turns (detail questions about a specific known place). The model
 * decides which tools to call; the honesty rules are v1's round-61 lessons
 * made structural: null = "not listed", point inward (the card's More button),
 * never outward to Google.
 */
function buildToolAnswerMessages({ message, langName = 'English', history = [], preferences = null }) {
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences)
              + 'The traveler asks about a specific place. Use get_place_details to fetch its verified data, then answer from THAT data only.\n'
              + '- A null field means the detail is not listed: say so briefly and point to the place\'s card — tap More for website, phone, hours and directions.\n'
              + '- NEVER tell the traveler to look a place up on Google, Google Maps or any external site.\n'
              + '- Never guess or invent details. 1–3 sentences, natural prose.',
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

module.exports = { buildGroundedMessages, buildChitchatMessages, buildGettingAroundMessages, buildNoMatchMessages, localFactsBlock, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail, buildToolAnswerMessages, placeFactLine, historyTurns, selfBlock };
