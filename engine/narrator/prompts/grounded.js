// Jinni V2 Engine — grounded narration prompts (pure functions).
// THE v2 rule, stated structurally: the narrator may name ONLY the places the
// retrieval core returned. It narrates evidence; it never discovers. The tiny
// prompt is the point (ChatV2 §2/§3) — tools/retrieval replaced the v1 pleading.

/** One evidence line per place — the ONLY facts the model may assert. */
const { CATEGORY_VOCABULARY, normalizeCategory } = require('../cards');
// The vocabulary the Preferences screen offers, taken from the module that
// VALIDATES it rather than retyped here. Asked "what interest I can select",
// Jinni answered "family, adventure, food, culture, nature, shopping, or
// relaxation" — inventing shopping, missing romantic/history/art/nightlife, and
// naming two of them wrongly (live 2026-08-25). A second hardcoded copy of a
// category list is the repo's oldest recurring bug; there is one list, and this
// reads it.
const { PREF_VOCAB, settableSentence, readOnlySentence } = require('../../preferences/proposal');

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
        // WHY this place leads the deck (retrieval's demand seats): it was
        // fetched by a live search for the ask's own rare term. Without this
        // the narrator hedged against its own deck — "I can't confirm any of
        // these are Uzbek" over a deck holding Uzbechka (live 2026-08-29).
        p._demandTerm ? `found by a live search for "${p._demandTerm}"` : null,
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
  + 'START with the answer to the current message. Do not preface it with the traveler\'s preferences, '
  + 'with what you do or do not have, or with a recap of an earlier topic — asked "who made you", answer '
  + 'who made you and nothing else. '
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
    // It claimed "I don't have access to your device's location or any settings
    // panel" while the log read "User location: Yerevan, Armenia" — a blindfold
    // it put on itself (live 2026-08-24). Denying a capability you have is as
    // misleading as inventing one you lack.
    'You DO see the traveler\'s saved settings.',
    'You CAN change a saved setting when they ask you to — say it is done, in the past tense. Never say you have no access to their settings or location.',
    // Saying "I can change a setting" without saying WHICH is the same empty
    // capability that produced the invented current position above: the model
    // knows it may act but not on what, so it either refuses or promises
    // something the app cannot do.
    //
    // BOTH lists are GENERATED from proposal.js's registry, never typed here.
    // The typed version said "exactly these five" and went on saying it after
    // the set changed twice — a hand-written list is a promise that stops being
    // checked the moment it is written. Now removing a setting from the registry
    // rewrites this sentence on the next request, and the model cannot be told
    // about a field the validator would refuse.
    `The settings you can change are exactly these: ${settableSentence()} — and nothing else.`,
    // Each setting carries the screen it actually lives on — the radius is in
    // Settings, the saved location in Preferences. Naming the wrong one sends
    // the traveler hunting through a screen that has no such control.
    `NOT yours to change (the screen each one lives on is in brackets): ${readOnlySentence()}. `
    + 'If they ask you to set or update one, say plainly that they can do it themselves on that screen, '
    + 'naming it, and that you will not do it for them. '
    + 'This does NOT limit searching: a city named in their message is somewhere you look for places '
    + 'right now, and asking for "hotels in Dubai" needs no setting changed at all.',
    'Language, theme, password and account you also cannot change; for those, point to Settings.',
    // Naming the settings without naming their VALUES left the model to invent
    // the list when asked what it could pick from. These are the same ten the
    // Preferences screen shows, and the only ten a proposal will validate
    // against — anything else is silently dropped, so offering it is a promise
    // the app will not keep.
    'The interests they can choose are exactly these ten, and no others: '
    + PREF_VOCAB.interests.map(i => i.replace(/_/g, ' & ')).join(', ')
    + '. If asked which interests are available, list these — never improvise a category '
    + '(there is no "shopping" interest) and never rename one.',
    // "can you change my preferences?" names no value, so nothing is written and
    // "it is done" would be a lie — but a flat "I can't" is false too, and that
    // is what shipped (live 2026-08-24). A question about the CAPABILITY is
    // answered yes, then asks which one.
    'If they ask WHETHER you can change their preferences without naming what to change, the answer is '
    + 'YES — say so and ask which setting and which value they want. Only describe a change as done when '
    + 'this turn actually reports one.',
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
    // A zero budget is the untouched default, not a preference — it produced
    // "a budget of $0–0 USD" in a live reply (2026-08-24). No value, no row.
    if (p.budget && (p.budget.min > 0 || p.budget.max > 0)) {
        rows.push(`budget: ${[p.budget.min, p.budget.max].filter(v => v > 0).join('–')} ${p.budget.currency || 'USD'}`);
    }
    if (Array.isArray(p.accessibility) && p.accessibility.length) rows.push(`accessibility needs: ${p.accessibility.join(', ')}`);
    if (Array.isArray(p.languages) && p.languages.length) rows.push(`languages: ${p.languages.join(', ')}`);
    // settings.location is the field the Preferences screen shows and the one
    // Jinni writes; preferences.destination is the older twin kept in step.
    const d = p._savedLocation || p.destination || {};
    if (d.city || d.countryName) {
        rows.push(`location saved in their settings (where they plan to go, NOT where they are): `
            + `${[d.city, d.countryName].filter(Boolean).join(', ')}`);
    }
    // The search radii, so it can answer "how far do you look?" and notice when
    // one is the reason a deck came back thin (Arsen 2026-08-24).
    // 5 km and 50 km are what every account starts with, so they are present on
    // EVERY traveler and were recited in every "what are my preferences?" answer
    // as though the traveler had chosen them (Arsen 2026-08-25: "it is by
    // default when user joins jinni … not tell all time"). The rows stay — they
    // are how "how far do you look?" gets answered — but an untouched default is
    // labelled as one, so it is background rather than news.
    // Which of the two radii is actually in force. It arrives in the request
    // body on EVERY turn, so this costs nothing to know — yet it never reached
    // a prompt, and Jinni behaved differently per mode without being able to
    // say which one it was in. Asked outright, it guessed.
    if (p._searchMode) {
        rows.push(p._searchMode === 'nearby'
            ? 'search mode: NEARBY — you are searching tight around where they physically are right now'
            : 'search mode: DISCOVERY — you are searching wide around the place they are exploring, '
              + 'which is not necessarily where they are standing');
    }
    const r = p._searchRadius || {};
    const dflt = (isDefault) => isDefault
        ? ' — the DEFAULT every account starts with, not a choice they made: never volunteer it, '
          + 'state it only if this message asks about search distance'
        : '';
    if (r.nearby) rows.push(`nearby radius: ${r.nearby} km (they can change it, 1–20)${dflt(r.nearby === 5)}`);
    if (r.discovery) rows.push(`discovery radius: ${r.discovery} km (they can change it, 10–100)${dflt(r.discovery === 50)}`);
    // Budget style with no budget is a gap worth closing, and only the traveler
    // can close it. Arsen 2026-08-24: "if user he wants budget places then
    // should give budget also min and max".
    if (p.travelStyle === 'budget' && !(p.budget && (p.budget.min > 0 || p.budget.max > 0))) {
        rows.push('their style is budget but NO budget range is saved — ask for a min and max when it would help');
    }
    return rows;
}

/** Identity rows + traveler rows + the no-invention rule, as one prompt block. */
/**
 * @param {object} preferences the traveler's saved rows
 * @param {{knowsLocation?: boolean}} opts whether the app actually reported a
 *   position this turn. Arsen 2026-08-24: "user may manually toggle off gps
 *   location" — so this is not a constant. Claiming to see a location that was
 *   switched off is the same failure as denying one that was on.
 */
function selfBlock(preferences, { knowsLocation = false } = {}) {
    const rows = travelerRows(preferences);
    // NAME the place. Saying only "you can see where they are" told it that it
    // knew something without telling it what, so it filled the gap with the
    // saved destination and answered "Yes, your location is Dubai right now —
    // the app reported it this turn" while the log read Yerevan (live
    // 2026-08-24). A capability with no value behind it is worse than no
    // capability: it produces confident invention.
    const here = preferences?._here || null;
    const locationRow = (knowsLocation && here)
        ? `WHERE THEY ARE RIGHT NOW: ${here} — the app reported this position on this turn. `
          + 'This is their PHYSICAL position and it is NOT the same thing as the location saved in their '
          + 'settings, which is where they plan to go. If those two differ, say so plainly rather than '
          + 'picking one. Never state a current position other than the one on this line.'
        : 'You do NOT know where the traveler is right now: no position was reported this turn '
          + '(they may have location switched off in Settings). Do not guess it, never infer it from their '
          + 'saved location, and if they ask you to use their current location, say plainly that you have '
          + 'none and that they can enable it in Settings.';
    return SELF_KNOWLEDGE_RULE
        + 'ROWS ABOUT YOU:\n' + [...IDENTITY_ROWS, locationRow].map(r => `- ${r}`).join('\n') + '\n'
        + (rows.length
            ? 'ROWS ABOUT THIS TRAVELER (from their saved Preferences — you DO see these):\n'
              + rows.map(r => `- ${r}`).join('\n')
              + '\nThese are BACKGROUND. Let them quietly shape WHAT you suggest — never announce them. '
              + 'State them back only if the CURRENT message asks what you know about the traveler. '
              + 'Nothing else about them is known to you.\n'
            : 'ROWS ABOUT THIS TRAVELER: none — they have saved no preferences. If they ask what their '
              + 'preferences are, say plainly that none are saved yet and that they can set them in Preferences. '
              + 'Do NOT describe any taste, style or budget for them.\n');
}

// Live 2026-08-24, asked for Dubai events with an Armenian deck on screen:
// Jinni said it had no Dubai cards — then recited "the Dubai International
// Humanitarian Aid & Development Conference … August 24 to 26" and "Dubai
// Summer Surprises through August 30" from memory. Nothing fetched those. An
// honest preamble in front of remembered facts makes them MORE dangerous, not
// less, because it buys them credibility. Naming an event is naming a date.
const NO_REMEMBERED_EVENTS =
    'Never name an event, festival, exhibition, concert, fair or conference that is not in the evidence '
  + 'above — not even one you are confident is real, and not as an aside or an example. EVIDENCE means '
  + 'the listed items in this prompt and nothing else: not your memory, and not anything you find by '
  + 'searching, which has been checked by nobody. A named event is a named DATE, and a date nobody '
  + 'verified is a guess a traveler can act on. If you hold nothing for the place or period asked, say '
  + 'that plainly and stop there; do not soften it by listing something anyway.\n';

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
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
              // This branch cannot write settings — reaching it means no
              // settings command was recognised this turn. Live 2026-08-29:
              // "now set to AMD" landed here and the reply claimed the
              // currency was set while nothing was written anywhere.
              + 'Nothing in this reply changes any saved setting or preference — NEVER say one was set, '
              + 'changed or saved. If they asked for a settings change, say you could not apply it from '
              + 'that message and invite them to rephrase (e.g. "set my currency to USD") or use the '
              + 'Preferences screen.\n'
              + (localFacts.length
                  ? 'The traveler asked a practical question and you HAVE verified notes for it below — '
                  + 'answer from them, attribute the source, and never contradict them from memory. '
                  + 'For entry rules and safety, tell them to confirm with the official authority.\n'
                  : '')
              + 'This is a casual/meta message — answer naturally in 1–3 sentences.\n'
              + 'You DO see the recent conversation above — never claim you cannot. Draw on it only where THIS '
              + 'message needs it; do not summarise or revisit it otherwise.\n'
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
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
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
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
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
 * Empty deck, localized (Dilijan lesson 2026-08-30: these replies were
 * hardcoded English — an Armenian ask got an English brush-off — and
 * 'all_filtered' lumped "everything is closed right now" in with "you've
 * seen everything", which was false twice over). The MEANING per cause is
 * fixed HERE; the model only renders it in the traveler's language. It may
 * never add venues — nothing is verified on an empty turn.
 */
function buildEmptyDeckMessages({ message, langName = 'English', cause = 'empty', isEvents = false, cityLabel = null, history = [], preferences = null }) {
    const where = cityLabel ? ` in ${cityLabel}` : ' in this area';
    const meaning = cause === 'no_web'
        ? 'They explicitly asked you to search the internet. You CANNOT browse the web here — say that plainly and warmly in one sentence, then offer what you CAN do: recommend from your own verified places and events. No apology spiral.'
        : cause === 'all_closed'
        ? `Every matching place you have${where} is CLOSED at this hour (it is late). Say that plainly and warmly, then offer: if they want, they can ask for the list "for tomorrow" and you will show it for planning ahead.`
        : cause === 'all_filtered'
            ? (isEvents
                ? `They have already been shown every upcoming event you have${where} — there are no new ones left right now. Suggest asking for places instead, or checking back in a day or two.`
                : `They have already been shown everything you have for this exact ask${where}. Suggest shifting the ask a little for a fresh angle.`)
            : (isEvents
                ? `You have no verified event listings${where} yet. Say you will go looking for that city's sources — they can try again shortly, or ask for places instead.`
                : `You searched all your sources and found nothing for this ask${where}. Suggest broadening it, or trying a different area.`);
    return [
        {
            role: 'system',
            content:
                'You are Jinni, a warm, concise travel companion. Reply in ' + langName + '.\n'
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
              + 'Your ENTIRE reply is 1–2 short sentences carrying EXACTLY this meaning, in '
              + langName + ' (no apology spiral, no extra offers):\n' + meaning + '\n'
              + 'Never name a specific venue, address or business — none are verified on this turn. '
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
              // The card path had no such rule, and it is where "I apologize for
              // the confusion in my earlier message. You're right — I DO have
              // verified events…" came from (live 2026-08-24). A deck turn can
              // re-litigate an earlier turn just as easily as a prose one.
              + ANSWER_ONLY_CURRENT
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
              + `FIRST write 1–3 warm sentences in ${langName} answering the ask, highlighting 1–2 listed places by exact name. `
              + 'NEVER mention a place not on the list — including ones from earlier in the conversation.\n'
              // The demand-seat annotation's other half: the fact line says WHY
              // a place is in the deck; this says what to DO with that. Judge
              // from each name and its types which genuinely answer the ask,
              // LEAD with those, and call the rest what they are.
              + (places.some(p => p._demandTerm)
                  ? 'Places marked \'found by a live search for "…"\' were fetched specifically for that term. '
                  + 'Judge from each NAME and its types which genuinely match the ask — lead with those, and present '
                  + 'the others honestly as nearby alternatives. Never claim you cannot confirm a match that a '
                  + 'place\'s own name or types make plain.\n'
                  : '')
              + 'THEN, on a new line, write exactly <<<CARDS>>> followed by JSON only:\n'
              + '{"cards": [{"i": 0, "kind": "...", "blurb": "..."}, ...], "question": "..." | null, "prefUpdate": {...} | null}\n'
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
              // Noticing a contradiction is a judgement, so the model makes it.
              // Overwriting what a person set is not, so it only ever proposes,
              // and code needs an explicit yes before anything is written.
              + '- prefUpdate: null, unless this message ASKS to change a saved preference above, or shows a '
              + 'LASTING change to one (e.g. their style is luxury and they say they always travel cheap). One of '
              + '{"field":"travelStyle","value":"luxury|budget"}, {"field":"interests","value":["family","romantic"]}, '
              + '{"field":"budget","value":{"min":50,"max":200,"currency":"USD"}}, '
              // The two location options that used to sit here were removed on
              // 2026-08-26. They had already stopped working — proposal.js holds
              // no `location` path, so every one was silently dropped — and they
              // contradicted the identity row above, which tells the model the
              // saved location is not its to change. Offering a field code
              // refuses to write is how "I've set that for you" gets said about
              // nothing at all.
              + 'or {"field":"searchMode","value":"nearby|discovery"}. '
              // The two radius options were removed on 2026-08-26 along with the
              // location pair above. Same reason each time: the prompt was
              // offering a field the validator refuses. The rows above already
              // say the radius is theirs to set in Preferences, and those rows
              // are generated from the registry — so this list and that sentence
              // cannot drift apart again.
              + 'A one-off ask is NOT a change: wanting a cheap lunch on a luxury trip changes nothing.\n'
              // A style with no numbers behind it cannot be used for anything.
              + '- If you set their style to budget and no budget range is saved, ASK for a min and max in the '
              + 'same reply, in one short sentence. Never invent the figures — only they know what their budget is.\n'
              // An instruction is already consent. Treating "set my destination
              // to my GPS" as something to ask permission for produced "I can't
              // set that for you" (live 2026-08-24).
              + '- Add "explicit": true when they TOLD you to change it ("set my destination to here", "make me '
              + 'budget from now on") — that is done immediately and you say so plainly, in the past tense. '
              + 'Add "explicit": false when you merely INFERRED it from something they said — then ask in one '
              + 'short sentence and wait, and never say it is done.\n'
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
    let question = null, prefUpdate = null;

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
        if (obj.prefUpdate && typeof obj.prefUpdate === 'object') prefUpdate = obj.prefUpdate;
        if (blurbs.some(Boolean) || kinds.some(Boolean) || question) return { blurbs, kinds, question, prefUpdate };
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
    return (salvaged || question) ? { blurbs, kinds, question, prefUpdate } : null;
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
              + selfBlock(preferences, { knowsLocation: !!preferences?._knowsLocation })
              + NO_REMEMBERED_EVENTS
              + 'The traveler asks about a specific place. Use get_place_details to fetch its verified data, then answer from THAT data only.\n'
              + '- A null field means the detail is not listed: say so briefly and point to the place\'s card — tap More for website, phone, hours and directions.\n'
              + '- NEVER tell the traveler to look a place up on Google, Google Maps or any external site.\n'
              + '- Never guess or invent details. 1–3 sentences, natural prose.',
        },
        ...historyTurns(history),
        { role: 'user', content: String(message || '') },
    ];
}

/**
 * Reporting a settings change that CODE HAS ALREADY MADE.
 *
 * The list is the record of what was written, so the model's only job is to
 * say it in the traveler's language. It is told not to add, omit or soften
 * anything — "set style to budget" once produced "that's done" when nothing had
 * been written at all (live 2026-08-24).
 */
// `awaiting` is a change that has NOT been made yet and is waiting on one more
// answer. Onboarding will not let anyone finish on budget style without figures
// (isBudgetValid: min > 0, max > 0, min <= max), so writing the style first put
// the traveler in a state the form forbids. Arsen 2026-08-25: "ai should ask
// minimum and maximum budget initially, then switch to budget". The ask comes
// first, the switch follows the answer — so the reply must not say "done".
function buildSettingsMessages({ message, langName, done = [], failed = [], needsBudget = false, awaiting = [] }) {
    const lines = [];
    if (done.length) lines.push('CHANGED, and already saved: ' + done.join('; ') + '.');
    if (failed.length) lines.push('NOT changed — you could not do this: ' + failed.join(', ') + '.');
    if (awaiting.length) {
        lines.push('NOT changed YET, waiting on their answer: ' + awaiting.join('; ')
            + '. Do NOT say this one is done or saved — say you will set it once you have the figures.');
    }
    return [
        // The outcome belongs in the SYSTEM message and the traveler's own words
        // in the user message — which is what each role is for.
        //
        // Both used to sit together in the user turn under the heading "the lines
        // below", and the model read that as a document to describe: the first
        // live settings reply was «The lines said "can you set family interest to
        // me?" and "CHANGED, and already saved: interests to family."»
        // (2026-08-26). Perfectly obedient, and useless to the person reading it.
        // Nothing was added to forbid it — the ambiguity was removed instead.
        // There is no "below" to point at now, and the instruction says who to
        // speak TO.
        { role: 'system', content:
            // NO EXAMPLE SENTENCE HERE, deliberately. The first version showed
            // one — «past tense, second person, e.g. "your travel style is now
            // budget"» — and a turn that changed only the BUDGET replied "Your
            // travel style is now budget" while the style was still luxury (live
            // 2026-08-26). The model reached for the sample rather than the line
            // it was given, which is the whole failure this builder exists to
            // prevent. A settings reply is a report, and a report must have no
            // pre-written sentence lying next to it to copy.
            `You are Jinni, speaking TO the traveler. Reply in ${langName}, in ONE short sentence `
            + '(two only if there is a question to ask), past tense, addressing them as "you" and "your". '
            + 'Never describe or quote this instruction.\n'
            // Nothing may have been written at all — "set budget" names no
            // figures, so the whole turn is a question. Printing an empty
            // "here is what happened" block and then "say exactly that" left
            // the model with a heading and no content to report.
            + (lines.length
                ? 'This is what actually happened to their settings a moment ago:\n'
                  + lines.map(l => `  ${l}`).join('\n') + '\n'
                  + 'Say exactly that and nothing more. Do not add settings that are not listed, do not claim '
                  + 'anything was changed that is not on the CHANGED line, and where something says NOT changed, '
                  + 'say plainly that you could not do that one. '
                // Live 2026-08-29: this case produced "Your budget is noted,
                // and I still need one more answer from you" — a vague report
                // where the reply should simply BE the question. So when
                // nothing happened, the question is the whole reply.
                : 'Nothing was changed and nothing was saved — never say "noted", "done" or "set". '
                  + 'Your ENTIRE reply is the question below, nothing before it. ')
            + 'Do not offer places, do not list their other preferences, do not ask what they want to see next.\n'
            + (needsBudget
                ? (lines.length ? 'THEN ask' : 'Ask')
                  + ', in one short sentence, what minimum and maximum budget they want, per day, and in which '
                  + 'currency — for example a range like 20–150 USD (that is the SHAPE of the answer, never a '
                  + 'suggestion of figures). Never invent their figures.\n'
                : '') },
        { role: 'user', content: String(message || '').slice(0, 200) },
    ];
}

module.exports = {
    buildSettingsMessages, buildGroundedMessages, buildChitchatMessages, buildGettingAroundMessages, buildNoMatchMessages, buildEmptyDeckMessages, localFactsBlock, buildNarrationJson, parseNarrationJson, buildStreamedNarrationMessages, parseCardsTail, buildToolAnswerMessages, placeFactLine, historyTurns, selfBlock };
