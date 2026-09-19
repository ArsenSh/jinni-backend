// ── DECK AGENT (founder 2026-09-18: "ai should have brain … what tools to
//    give to help it work in 100 percent situations correctly instead of
//    giving words like if user said this then do this") ──────────────────────
//
// One model, a handful of TOOLS, and a short loop. The model looks before it
// deals: it can ask the gazetteer where things are, run the engine's own
// retrieval (every honesty gate intact) up to a few times, read what came
// back, and only then deal cards or ask the traveler one question.
//
// What stays in CODE, whatever the model says:
//   · a card can only be a candidate that a search in THIS turn returned;
//   · at most SEARCH_BUDGET paid searches and MAX_STEPS model calls per turn;
//   · every tool result is data the engine already trusts (owned rows, the
//     gazetteer, cache, Google through canonicalStore) — no numbers from
//     memory reach the traveler through this path.
//
// Engine rules: no express, injectable deps, never throws — a failure of any
// kind returns { kind: 'fail' } and the route runs its classic pipeline.
const { haversineKm } = require('../utils/geo');

const SEARCH_BUDGET = 3;
const MAX_STEPS = 6;
const RESULT_CAP = 12;

const clip = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── Tools the model sees ─────────────────────────────────────────────────────
const LOOKUP_PLACE_TOOL = {
    type: 'function',
    function: {
        name: 'lookup_place',
        description: 'Where is a place, and what is it? Resolves a NAMED place (city, town, region, lake, landmark) from the owned gazetteer and the places already in this conversation. Returns coordinates, kind, population, whether it is a water body, and its distance from the traveler. Use it to understand geography before searching — e.g. to find the lake nearest the traveler, or to check that a name really is where you think. Costs nothing.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'The place name as the traveler or you would write it, e.g. "Sevan", "Lake Sevan", "Dilijan", "Batumi".' } },
            required: ['name'],
        },
    },
};

const SEARCH_PLACES_TOOL = {
    type: 'function',
    function: {
        name: 'search_places',
        description: `Find real places to show. Runs the engine's retrieval (owned places first, then the cache, then a paid index) around a centre and returns up to ${RESULT_CAP} candidates with facts: id, name, kind, distance, rating, price tier, tags, open-now, source. READ the results before dealing — search again with a different query, centre, radius or style when they do not fit the ask. Budget: ${SEARCH_BUDGET} searches per turn.`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Short search in English: what + qualifiers, e.g. "luxury lakefront hotel", "quiet cafe to read", "calm spa resort". Max ~8 words. Never the traveler\'s whole sentence.' },
                category: { type: 'string', description: 'One of: restaurants, hotels, historical, activities, hidden_gems, photo_spots, shopping, events, general.' },
                centre: { type: 'string', description: 'Where to search: a place name resolved with lookup_place (e.g. "Lake Sevan", "Dilijan") or "traveler" for where they are now. Default: traveler.' },
                radius_km: { type: 'number', description: 'How far around the centre. Town 5–15, a lake or region 30–50, a country 150. Omit to let the engine choose.' },
                style: { type: 'string', description: '"luxury" or "budget" when the ask or the saved style says so; omit for no price gate.' },
                open_now: { type: 'boolean', description: 'true only when the traveler wants somewhere open right now / tonight.' },
                count: { type: 'number', description: 'How many candidates to consider (3–12). Default 8.' },
            },
            required: ['query', 'category'],
        },
    },
};

const ASK_TRAVELER_TOOL = {
    type: 'function',
    function: {
        name: 'ask_traveler',
        description: 'End the turn with ONE short question, only when a fact that only the traveler has is missing and the conversation, state and your tools cannot supply it. Name real options when you can ("Sevan, an hour away — or somewhere abroad?").',
        parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    },
};

const DEAL_TOOL = {
    type: 'function',
    function: {
        name: 'deal',
        description: 'End the turn by showing cards. Only ids returned by search_places in THIS turn are allowed. Choose the ones that truly fit the ask (3 unless more are clearly wanted, max 6), best first; leave out anything that contradicts the ask. Keep it SHORT — every word you write here is time the traveler waits: intro = 1–2 sentences in the traveler\'s language that answer the ask and name 1–2 chosen places; blurb = ONE sentence, max 18 words, only facts you saw; question optional, one line.',
        parameters: {
            type: 'object',
            properties: {
                intro: { type: 'string' },
                cards: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, blurb: { type: 'string' }, kind: { type: 'string', description: 'What the place IS, one or two words in English (cafe, coworking space, lakeside hotel, park…) — read the name and facts, do not copy a raw type like "parking".' } }, required: ['id', 'blurb'] } },
                question: { type: 'string' },
            },
            required: ['intro', 'cards'],
        },
    },
};

// ── System prompt: goals and invariants, not situations ─────────────────────
function systemPrompt({ langName, dateNote, traveler, preferences, lastDeck, lastQuestion, activeDestination }) {
    const prefs = preferences || {};
    const lines = [
        `You are Jinni, a travel companion with tools. Your job this turn: understand what the traveler wants, look at the world with your tools, and either deal the right cards or ask one question. Reply language: ${langName}.`,
        '',
        'HOW TO THINK',
        '- Understand first: what kind of place, where, when, for how long, in what mood or budget. Use the conversation and the traveler\'s profile below before asking anything.',
        '- A place described by kind ("near a lake", "by the sea", "in the mountains") is geography: use lookup_place to see what real places of that kind are within reach, and how far. Decide from distances and facts, never from assumptions about their country — they may want somewhere abroad.',
        '- Look before you deal: read search results. If they contradict the ask (city hotels for a lakeside stay, a VR arena for calm), search again with a better query, centre, radius or style. You have a small search budget; make each search count.',
        '- Prefer places marked source "owned" (verified by local staff) when they fit; they are the most trustworthy.',
        '- Ask only when a fact that only the traveler has is missing. Never ask what you could find out with a tool.',
        '',
        'HONESTY (absolute)',
        '- Say only what the facts you saw support. Never state a price, hours, or a quality ("luxury", "quiet", "on the lake") that no fact carries. When nothing fits, say so plainly in the intro and offer the closest real options or a question.',
        '- Deal only ids that search_places returned this turn. Never invent a place.',
        '',
        'CONTEXT',
        `- Date: ${dateNote || 'unknown'}`,
        `- Traveler is at: ${traveler?.label || 'unknown'}${traveler?.lat != null ? ` (${traveler.lat.toFixed(3)}, ${traveler.lng.toFixed(3)})` : ''}`,
        `- Saved travel style: ${prefs.travelStyle || 'none'} · interests: ${(prefs.interests || []).join(', ') || 'none'}`,
        activeDestination ? `- Destination in play from earlier turns: ${clip(activeDestination, 80)}` : null,
        lastDeck && lastDeck.length ? `- Cards already on screen (do not repeat unless asked): ${lastDeck.slice(0, 8).join(', ')}` : null,
        lastQuestion ? `- Your previous reply ended with the question: "${clip(lastQuestion, 160)}" — a short answer to it continues that thread.` : null,
        '',
        'Finish EVERY turn with exactly one of: deal(...) or ask_traveler(...). Do not answer in plain text.',
    ];
    return lines.filter(l => l !== null).join('\n');
}

function summarize(c) {
    const kind = c._kind || c.primaryType || (Array.isArray(c.types) && c.types[0]) || null;
    return {
        id: c._agentId,
        name: c.name,
        kind,
        // From the SEARCH CENTRE, not the traveler — live 2026-09-18 the model
        // wrote "12 km from you" for a hotel 12 km from Lake Sevan's centre.
        distance_from_search_centre_km: Number.isFinite(c.distanceKm) ? Math.round(c.distanceKm * 10) / 10 : null,
        rating: c.rating ?? null,
        price_tier: c.priceLevel || c._styleTier || null,
        // The owner's listed price when the place is ours — a real number the
        // model may quote ("from 150 USD"), unlike price_tier which is a band.
        price: c.ownedPrice ? (c.ownedPrice.min != null ? `from ${c.ownedPrice.min}${c.ownedPrice.max != null ? ` to ${c.ownedPrice.max}` : ''} ${c.ownedPrice.currency}` : `about ${c.ownedPrice.average} ${c.ownedPrice.currency}`) + ' (owner\'s listing, per night)' : null,
        tags: (c.interests || []).slice(0, 5),
        open_now: c._openNow === true ? true : (c._openNow === false ? false : null),
        // Events are not places: a dated event carries its start; a venue or an
        // attraction in an events search carries none — deal it as an event
        // and the traveler gets "check its schedule" padding (live 2026-09-19).
        is_dated_event: !!(c.eventSchedule && c.eventSchedule.startDate),
        event_start: c.eventSchedule?.startDate ? new Date(c.eventSchedule.startDate).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null,
        source: c.source === 'destination' || c.source === 'business' ? 'owned' : (c.source || null),
        area: c._town?.city || c.city || null,
        address: clip(c.address, 80) || null,
    };
}

/**
 * @returns {Promise<{kind:'deal'|'ask'|'fail', places?, intro?, blurbs?, question?, toolCalls, usage, steps, searches}>}
 */
async function runDeckAgent({
    message, recentTurns = [], langName = 'English', dateNote = null,
    traveler = null, preferences = null, lastDeck = [], lastQuestion = null, activeDestination = null,
    findArgsBase = {}, sessionCards = [],
} = {}, deps = {}) {
    const provider = deps.provider;
    const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {};
    const retrieve = deps.retrieve;           // (args) => retrieval.findPlaces(args, { loadCandidates })
    const lookup = deps.lookup;               // (name, { near }) => gazetteer hit | null
    const extraTools = deps.extraTools || []; // e.g. place_details / get_route schemas
    const extraExec = deps.extraExec || {};
    if (!provider || typeof provider.completeWithTools !== 'function' || typeof retrieve !== 'function') return { kind: 'fail', reason: 'deps' };

    const near = traveler && Number.isFinite(traveler.lat) ? { lat: traveler.lat, lng: traveler.lng } : null;
    const known = new Map();      // id → candidate
    const resolved = new Map();   // lower-cased name → { lat, lng, name, ... }
    const toolCalls = [];
    const usage = { in: 0, out: 0 };
    let searches = 0, terminal = null, idSeq = 0;

    const exec = {
        lookup_place: async ({ name } = {}) => {
            const n = String(name || '').trim();
            if (!n) return { error: 'name_required' };
            // Session cards first (free), then the gazetteer.
            const sc = sessionCards.find(c => c?.name && c.name.toLowerCase() === n.toLowerCase());
            let hit = null;
            if (sc && Number.isFinite(sc.latitude ?? sc.lat)) hit = { name: sc.name, lat: sc.latitude ?? sc.lat, lng: sc.longitude ?? sc.lng, kind: 'venue', source: 'session' };
            if (!hit && lookup) { try { hit = await lookup(n, { near }); } catch { hit = null; } }
            if (!hit) return { found: false, hint: 'unknown to the gazetteer — it may be a venue, a misspelling, or somewhere not seeded' };
            resolved.set(hit.name.toLowerCase(), hit); resolved.set(n.toLowerCase(), hit);
            return {
                found: true, name: hit.name, kind: hit.waterBody ? 'water body' : (hit.kind || hit.scale || 'place'),
                country: hit.countryName || null, population: hit.population || 0,
                distance_from_traveler_km: near ? Math.round(haversineKm(near.lat, near.lng, hit.lat, hit.lng)) : null,
                lat: hit.lat, lng: hit.lng,
            };
        },
        search_places: async (a = {}) => {
            if (searches >= SEARCH_BUDGET) return { error: 'search_budget_exhausted', hint: 'deal from what you have, or ask the traveler' };
            searches++;
            const query = clip(a.query, 80);
            if (!query) return { error: 'query_required' };
            const category = ['restaurants', 'hotels', 'historical', 'activities', 'hidden_gems', 'photo_spots', 'shopping', 'events', 'general'].includes(a.category) ? a.category : 'general';
            let center = near, centreName = 'traveler';
            if (a.centre && String(a.centre).toLowerCase() !== 'traveler') {
                const key = String(a.centre).toLowerCase();
                let hit = resolved.get(key);
                if (!hit && lookup) { try { hit = await lookup(String(a.centre), { near }); } catch { hit = null; } }
                if (!hit) return { error: 'unknown_centre', hint: 'resolve it with lookup_place first, or use "traveler"' };
                center = { lat: hit.lat, lng: hit.lng }; centreName = hit.name;
                resolved.set(key, hit);
            }
            if (!center) return { error: 'no_centre', hint: 'the traveler has no location; name a centre' };
            const radiusKm = Number.isFinite(a.radius_km) ? Math.min(Math.max(a.radius_km, 1), 150) : undefined;
            const count = Number.isFinite(a.count) ? Math.min(Math.max(Math.round(a.count), 3), RESULT_CAP) : 8;
            const style = a.style === 'luxury' || a.style === 'budget' ? a.style : null;
            const args = {
                ...findArgsBase,
                query, category: category === 'general' ? null : category, center,
                ...(radiusKm ? { radiusKm } : {}),
                count,
                enforceOpenNow: a.open_now === true,
                preferences: { ...(findArgsBase.preferences || {}), ...(style ? { travelStyle: style } : {}) },
            };
            // Events: let the brain see HOW the listings were obtained (or why not).
            let huntStats = null;
            if (category === 'events') args.eventsHunt = { ...(findArgsBase.eventsHunt || {}), onStats: (st) => { huntStats = st; } };
            let out;
            try { out = await retrieve(args); } catch (err) { return { error: `search_failed: ${err.message}` }; }
            const places = Array.isArray(out?.places) ? out.places.slice(0, count) : [];
            for (const p of places) { if (!p._agentId) p._agentId = `p${++idSeq}`; known.set(p._agentId, p); }
            return {
                centre: centreName, note: `distances below are from the search centre "${centreName}", not from the traveler`,
                radius_km: radiusKm || out?.provenance?.radiusKm || null, category, query,
                result_count: places.length, reason: places.length ? null : (out?.reason || 'nothing_found'),
                results: places.map(summarize),
                searches_left: SEARCH_BUDGET - searches,
                ...(huntStats ? { events_listings: huntStats, events_note: huntStats.mode === 'shelf' ? 'served from listings already read' : (huntStats.mode === 'shelf_fresh' ? 'all registered listings were read minutes ago — the shelf is current' : (huntStats.mode === 'web_search' ? 'no registered listing for this city — a web search found the pages read' : `read ${huntStats.pages_read ?? 0} listing page(s)`)) } : {}),
            };
        },
        ask_traveler: async ({ question } = {}) => {
            const q = clip(question, 300);
            if (!q) return { error: 'question_required' };
            terminal = { kind: 'ask', question: q };
            return { ok: true };
        },
        deal: async ({ intro, cards, question } = {}) => {
            const chosen = [];
            const blurbs = [];
            for (const c of (Array.isArray(cards) ? cards : []).slice(0, 6)) {
                const p = c && known.get(String(c.id));
                if (!p || chosen.includes(p)) continue;          // only what a search returned, once
                if (typeof c.kind === 'string' && c.kind.trim()) p._agentKind = clip(c.kind, 40);
                chosen.push(p); blurbs.push(clip(c.blurb, 240) || null);
            }
            if (!chosen.length) return { error: 'no_valid_cards', hint: 'use ids from search_places results, or ask_traveler' };
            terminal = { kind: 'deal', places: chosen, blurbs, intro: clip(intro, 900), question: clip(question, 200) || null };
            return { ok: true, dealt: chosen.length };
        },
        ...extraExec,
    };
    const tools = [LOOKUP_PLACE_TOOL, SEARCH_PLACES_TOOL, ...extraTools, ASK_TRAVELER_TOOL, DEAL_TOOL];

    const convo = [
        { role: 'system', content: systemPrompt({ langName, dateNote, traveler, preferences, lastDeck, lastQuestion, activeDestination }) },
        ...recentTurns.map(t => ({ role: t.role === 'assistant' || t.sender === 'ai' ? 'assistant' : 'user', content: clip(t.content || t.text, 600) })),
        { role: 'user', content: String(message || '') },
    ];
    let steps = 0;
    try {
        while (steps < MAX_STEPS && !terminal) {
            steps++;
            const last = steps === MAX_STEPS;
            const res = await provider.completeWithTools({
                messages: convo,
                tools: last ? [ASK_TRAVELER_TOOL, DEAL_TOOL] : tools,
                maxTokens: 700, temperature: 0.3,
            });
            usage.in += res.usage?.in || 0; usage.out += res.usage?.out || 0;
            const msg = res.message || {};
            const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!calls.length) {
                // Plain text instead of a terminal tool: nudge once, then give up.
                convo.push({ role: 'assistant', content: msg.content || '' });
                convo.push({ role: 'user', content: 'Finish with deal(...) or ask_traveler(...) — no plain text.' });
                continue;
            }
            convo.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
            for (const call of calls) {
                const name = call.function?.name;
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* junk → {} */ }
                let result;
                const fn = exec[name];
                try { onEvent({ tool: name, args }); } catch { /* progress is best-effort */ }
                if (!fn) result = { error: `unknown_tool: ${name}` };
                else { try { result = await fn(args, { known: [...known.values()] }); } catch (err) { result = { error: `tool_failed: ${err.message}` }; } }
                toolCalls.push({ name, args, result: name === 'search_places' ? { ...result, results: undefined, result_count: result.result_count } : result });
                convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
                if (terminal) break;
            }
        }
    } catch (err) {
        return { kind: 'fail', reason: err.message, toolCalls, usage, steps, searches };
    }
    if (!terminal) return { kind: 'fail', reason: 'no_terminal', toolCalls, usage, steps, searches };
    return { ...terminal, toolCalls, usage, steps, searches };
}

module.exports = { runDeckAgent, systemPrompt, summarize, SEARCH_BUDGET, MAX_STEPS, _tools: { LOOKUP_PLACE_TOOL, SEARCH_PLACES_TOOL, ASK_TRAVELER_TOOL, DEAL_TOOL } };
