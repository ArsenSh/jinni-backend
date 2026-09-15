// V3 conversation controller (V3 doc §12). Every assertion runs the shipped
// code; the model is injected, never called.
const { decide, buildControllerMessages, shapeDecision, shapeFlights, stateBlock, LANES, CONTROLLER_PROVIDER } = require('../engine/controller/conversationController');
const { resolveLaneFlags } = require('../engine/controller/laneOverride');

const STATE = {
    lastLane: 'transport',
    lastReply: 'Here are the fares I have… Want me to check a return date as well?',
    lastFlights: { args: { origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-20' },
        result: { offers: [{ label: '2026-09-15 07:00 · FlyOne Armenia · 99 USD · direct' }] } },
    lastDeck: ['Diva', 'Illusion'],
    preferences: { travelStyle: 'luxury', interests: ['nightlife'] },
};
const DATE = 'Monday 2026-09-14, 00:23 local time (Asia/Yerevan). "today" = 2026-09-14, "tomorrow" = 2026-09-15, "this week" = 2026-09-14 to 2026-09-20';

const GOOD = {
    language: 'en', translated: '', is_travel: true, action_type: 'general', place_names: [], place_search_query: '',
    when: 'unspecified', period: '', refill: false, count: 0, price_direction: '', wants_search: false, info_ask: 'transport',
    out_of_town: false, correction: false, browse: false, stated_at: '', anchor_reference: false, destination_scope: false,
    exclude: [], needs_weather: false, itinerary_details: null, settings_change: [],
    lane: 'flights', answers_pending_question: true, topic_changed: false,
    flights: { origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-20', return_from: '2026-09-18', return_to: '2026-09-24', stay_days: 4 },
    clarify_question: '', reply_language: 'en',
};

describe('the prompt carries the engine state and the date', () => {
    test('state lines: lane, the question asked, the fares as data, the deck, preferences', () => {
        const { system, user } = buildControllerMessages({ message: 'I need to stay 4 days', recentTurns: [], state: STATE, dateNote: DATE });
        expect(system).toMatch(/conversation controller/);
        // the STATIC schema and rules sit in the cached system prompt; the
        // conversation, date, state and message are the only per-call text
        expect(system).toMatch(/"is_travel":<true or false>/);
        expect(system).toMatch(/"lane": one of flights \| transport/);
        expect(system).toMatch(/"stay 4 days" is a duration/);
        expect(user).not.toMatch(/"is_travel":<true or false>/);
        expect(user).toContain('Current user message: """I need to stay 4 days"""');
        expect(user).toContain("Traveler's date: Monday 2026-09-14");
        expect(user).toContain('Lane that answered the previous turn: transport');
        expect(user).toMatch(/Jinni's previous reply .*return date as well\?/);
        expect(user).toContain('Fares last fetched (REAL data): Yerevan → Moscow, 2026-09-14..2026-09-20; 1 fare(s): 2026-09-15 07:00 · FlyOne Armenia · 99 USD · direct');
        expect(user).toContain('Cards last shown, in order: 1. Diva; 2. Illusion');
        expect(user).toContain('Saved preferences: style=luxury · interests=nightlife');
    });
    test('an empty state says so instead of inventing lines', () => {
        expect(stateBlock({}, null)).toBe('(nothing yet — first turn)');
    });
});

describe('shapeDecision — the deterministic brake on the model\'s JSON', () => {
    test('a good decision keeps the v2 intent AND the controller keys', () => {
        const d = shapeDecision(GOOD, 'I need to stay 4 days');
        expect(d.intent.source).toBe('controller');
        expect(d.intent.isTravel).toBe(true);
        expect(d.intent.infoAsk).toBe('transport');
        expect(d.lane).toBe('flights');
        expect(d.answersPendingQuestion).toBe(true);
        expect(d.flights).toEqual({ origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-20', return_from: '2026-09-18', return_to: '2026-09-24', stay_days: 4 });
    });
    test('an unknown lane is no lane; a clarify without a question is no decision; bad dates are dropped', () => {
        expect(shapeDecision({ ...GOOD, lane: 'teleport' }, 'x').lane).toBeNull();
        expect(shapeDecision({ ...GOOD, lane: 'clarify', clarify_question: '' }, 'x').lane).toBeNull();
        const c = shapeDecision({ ...GOOD, lane: 'clarify', clarify_question: 'Which day would you fly back?' }, 'x');
        expect(c.lane).toBe('clarify'); expect(c.clarifyQuestion).toBe('Which day would you fly back?'); expect(c.flights).toBeNull();
        const f = shapeFlights({ origin: 'Yerevan', destination: 'Moscow', depart_from: 'next week', depart_date: '2026-10', stay_days: '4' });
        expect(f).toEqual({ origin: 'Yerevan', destination: 'Moscow', depart_date: '2026-10', stay_days: 4 });
        expect(shapeFlights({ origin: 'Yerevan' })).toBeNull();
    });
    test('the language brake still applies: a Latin message is never answered in Cyrillic', () => {
        expect(shapeDecision({ ...GOOD, reply_language: 'ru' }, 'yes').intent.language).toBe('en');
        expect(shapeDecision({ ...GOOD, reply_language: 'ru' }, 'да').intent.language).toBe('ru');
    });
    test('"deck" with nothing to search for is a closing, not a deck (live 2026-09-14: "ok thanks" dealt six cards)', () => {
        const thanks = { ...GOOD, lane: 'deck', answers_pending_question: true, info_ask: '', place_search_query: '', browse: false, refill: false, count: 0, action_type: 'general', flights: null };
        const d = shapeDecision(thanks, 'ok thanks');
        expect(d.lane).toBe('chitchat');
        expect(d.intent.isTravel).toBe(false);
        // but a real deck ask with a query, a refill, a count or a category stays a deck
        expect(shapeDecision({ ...thanks, place_search_query: 'rooftop bars' }, 'rooftop bars').lane).toBe('deck');
        expect(shapeDecision({ ...thanks, refill: true }, 'other ones').lane).toBe('deck');
        expect(shapeDecision({ ...thanks, action_type: 'restaurants' }, 'restaurants?').lane).toBe('deck');
    });
    test('the prompt names closings and asks for compact output', () => {
        const { system } = buildControllerMessages({ message: 'ok thanks', state: STATE, dateNote: DATE });
        expect(system).toMatch(/a thank-you is not a yes/);
        expect(system).toMatch(/OUTPUT COMPACTLY/);
    });
    test('an intent that fails validation is no decision at all', () => {
        expect(shapeDecision({ lane: 'flights' }, 'x')).toBeNull();
    });
});

describe('decide — fail-open to the v2 classifier', () => {
    test('DeepSeek decides by default; Claude only when CONTROLLER_PROVIDER=claude (founder 2026-09-15)', () => {
        expect(CONTROLLER_PROVIDER).toBe('deepseek');
    });
    test('the DeepSeek path sends the system prompt as a leading system turn', async () => {
        let seen = null;
        const fakeDeepseek = require('../engine/narrator/providers/deepseek');
        const spy = jest.spyOn(fakeDeepseek, 'complete').mockImplementation(async (args) => { seen = args; return { text: JSON.stringify(GOOD) }; });
        const d = await decide({ message: 'I need to stay 4 days', state: STATE, dateNote: DATE }, { provider: 'deepseek', classify: async () => ({ source: 'llm', isTravel: true }) });
        spy.mockRestore();
        expect(d.source).toBe('controller'); expect(d.provider).toBe('deepseek');
        expect(seen.messages[0].role).toBe('system'); expect(seen.messages[0].content).toMatch(/conversation controller/);
        expect(seen.messages[1].role).toBe('user'); expect(seen.temperature).toBe(0);
    });
    test('a working model gives a controller decision', async () => {
        let hedged = 0;
        const d = await decide({ message: 'I need to stay 4 days', state: STATE, dateNote: DATE }, {
            complete: async () => ({ text: '```json\n' + JSON.stringify(GOOD) + '\n```' }), model: 'test-model',
            classify: async () => { hedged++; return { source: 'llm', isTravel: true }; },
        });
        expect(hedged).toBe(1);   // the hedge ran in parallel, and was simply not needed
        expect(d.source).toBe('controller');
        expect(d.lane).toBe('flights');
        expect(d.model).toBe('test-model');
        expect(d.error).toBeNull();
    });
    test('an API error, a timeout, or junk JSON falls back to the PARALLEL v2 answer — v3 degrades to v2, never worse', async () => {
        let calls = 0;
        const classify = async () => { calls++; return { source: 'llm', isTravel: false, actionType: 'general', placeNames: [], language: 'en' }; };
        const dead = await decide({ message: 'hi' }, { complete: async () => { throw new Error('boom'); }, classify });
        expect(dead.source).toBe('fallback'); expect(dead.lane).toBeNull(); expect(dead.error).toMatch(/boom/); expect(dead.intent.isTravel).toBe(false);
        const junk = await decide({ message: 'hi' }, { complete: async () => ({ text: 'not json' }), classify });
        expect(junk.source).toBe('fallback'); expect(junk.error).toMatch(/unusable/);
        const slow = await decide({ message: 'hi' }, { complete: () => new Promise(r => setTimeout(() => r({ text: '{}' }), 200)), timeoutMs: 20, classify });
        expect(slow.source).toBe('fallback'); expect(slow.error).toMatch(/timeout/);
        expect(calls).toBe(3);   // one hedge per decision, never a second sequential call
    });
});

describe('resolveLaneFlags — the lane lands on v2\'s own flags', () => {
    const base = { transportAsk: false, placeQuestion: false, deckAsk: true, namedCard: { name: 'X' }, referentClarify: true, contextualQ: true, isTravel: false, infoAsk: null, actionType: 'general', destinationScope: false };
    test('flights and transport open the getting-around branch and close the others', () => {
        for (const lane of ['flights', 'transport']) {
            const f = resolveLaneFlags(lane, base);
            expect(f).toMatchObject({ transportAsk: true, placeQuestion: false, referentClarify: false, contextualQ: false, isTravel: true, infoAsk: 'transport' });
            expect(f.namedCard).toEqual({ name: 'X' });     // a named card still gets its route map
        }
    });
    test('place_question → tool loop; deck → the deck path with no stale pointer; chitchat → prose', () => {
        expect(resolveLaneFlags('place_question', base)).toMatchObject({ placeQuestion: true, transportAsk: false, isTravel: true, infoAsk: 'place' });
        expect(resolveLaneFlags('deck', base)).toMatchObject({ transportAsk: false, placeQuestion: false, namedCard: null, isTravel: true, infoAsk: null, destinationScope: false });
        expect(resolveLaneFlags('destinations', base)).toMatchObject({ destinationScope: true, isTravel: true });
        expect(resolveLaneFlags('itinerary', base)).toMatchObject({ actionType: 'itinerary', isTravel: true });
        expect(resolveLaneFlags('chitchat', base)).toMatchObject({ isTravel: false, transportAsk: false, placeQuestion: false, namedCard: null });
    });
    test('lanes the route detects itself, and no lane, leave every flag alone', () => {
        for (const lane of ['settings', 'currency', 'clarify', null, undefined, 'nonsense']) expect(resolveLaneFlags(lane, base)).toEqual(base);
    });
    test('every lane the controller may name is handled or deliberately left alone', () => {
        for (const lane of LANES) expect(() => resolveLaneFlags(lane, base)).not.toThrow();
    });
});

describe('vague places asks are asked about, not guessed at (founder 2026-09-16)', () => {
    // The judgement is the model's; these replay tonight's conversation through
    // the shipped decision pipeline with the model's answer injected, so the
    // RULES (prompt) and the SHAPE CHECKS (code) are both exercised.
    const base = { ...GOOD, lane: 'deck', answers_pending_question: false, info_ask: '', flights: null, place_search_query: '', action_type: 'general', browse: false, refill: false, count: 0 };
    const at2am = 'Monday 2026-09-16, 02:05 local time (Asia/Yerevan). "today" = 2026-09-16, "tomorrow" = 2026-09-17';

    test('the instructions carry the rule, its shape, and its exceptions', () => {
        const { system } = buildControllerMessages({ message: 'what is open right now?', state: { travelerLocation: 'Yerevan, Armenia' }, dateNote: at2am });
        expect(system).toMatch(/A VAGUE PLACES ASK is a clarify/);
        expect(system).toMatch(/THREE concrete choices that fit the hour/);
        expect(system).toMatch(/bars discussed two turns ago and now "what's open\?" is a deck for bars/);
        expect(system).toMatch(/A refill \("what else", "other ones"\) continues the previous deck and is never vague/);
        expect(system).toMatch(/When the traveler ANSWERS a clarify question/);
    });

    test('"what is open right now" from a fresh chat at 2 am → one question with three choices', async () => {
        const d = await decide({ message: 'what is open right now?', state: { travelerLocation: 'Yerevan, Armenia' }, dateNote: at2am }, {
            complete: async () => ({ text: JSON.stringify({ ...base, lane: 'clarify', clarify_question: 'It\'s 2 am — are you after food, a drink, or somewhere to walk?' }) }),
            classify: async () => ({ source: 'llm', isTravel: true }),
        });
        expect(d.lane).toBe('clarify');
        expect(d.clarifyQuestion).toBe('It\'s 2 am — are you after food, a drink, or somewhere to walk?');
        expect(d.flights).toBeNull();
    });

    test('"food" as the answer → a food deck, marked as answering the question', async () => {
        const d = await decide({
            message: 'food',
            recentTurns: [{ sender: 'user', text: 'what is open right now?' }, { sender: 'ai', text: 'It\'s 2 am — are you after food, a drink, or somewhere to walk?' }],
            state: { travelerLocation: 'Yerevan, Armenia', lastLane: 'clarify', lastReply: 'It\'s 2 am — are you after food, a drink, or somewhere to walk?' }, dateNote: at2am,
        }, {
            complete: async () => ({ text: JSON.stringify({ ...base, lane: 'deck', action_type: 'restaurants', place_search_query: 'late-night food Yerevan', browse: true, answers_pending_question: true }) }),
            classify: async () => ({ source: 'llm', isTravel: true }),
        });
        expect(d.lane).toBe('deck');
        expect(d.answersPendingQuestion).toBe(true);
        expect(d.intent.actionType).toBe('restaurants');
        expect(d.intent.searchQuery).toBe('late-night food Yerevan');
    });

    test('a deck decision with nothing to search for is still not a deck — the shape check, not a meaning rule', () => {
        const d = shapeDecision({ ...base }, 'what is open right now?');
        expect(d.lane).not.toBe('deck');
    });

    test('a clarify with an empty question is no decision — falls to the v2 answer', async () => {
        const d = await decide({ message: 'what is open right now?', dateNote: at2am }, {
            complete: async () => ({ text: JSON.stringify({ ...base, lane: 'clarify', clarify_question: '' }) }),
            classify: async () => ({ source: 'llm', isTravel: true }),
        });
        expect(d.lane).toBeNull();
        expect(d.clarifyQuestion).toBeNull();
    });
});
