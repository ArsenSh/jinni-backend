// V3 conversation controller (V3 doc §12). Every assertion runs the shipped
// code; the model is injected, never called.
const { decide, buildControllerMessages, shapeDecision, shapeFlights, stateBlock, LANES } = require('../engine/controller/conversationController');
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
        expect(user).toContain("Traveler's date: Monday 2026-09-14");
        expect(user).toContain('Lane that answered the previous turn: transport');
        expect(user).toMatch(/Jinni's previous reply .*return date as well\?/);
        expect(user).toContain('Fares last fetched (REAL data): Yerevan → Moscow, 2026-09-14..2026-09-20; 1 fare(s): 2026-09-15 07:00 · FlyOne Armenia · 99 USD · direct');
        expect(user).toContain('Cards last shown, in order: 1. Diva; 2. Illusion');
        expect(user).toContain('Saved preferences: style=luxury · interests=nightlife');
        // and still the whole v2 intent schema, so the lanes get what they expect
        expect(user).toMatch(/"is_travel":<true or false>/);
        expect(user).toMatch(/"lane": one of flights \| transport/);
        expect(user).toMatch(/"stay 4 days" is a duration/);
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
    test('an intent that fails validation is no decision at all', () => {
        expect(shapeDecision({ lane: 'flights' }, 'x')).toBeNull();
    });
});

describe('decide — fail-open to the v2 classifier', () => {
    test('a working model gives a controller decision', async () => {
        const d = await decide({ message: 'I need to stay 4 days', state: STATE, dateNote: DATE }, {
            complete: async () => ({ text: '```json\n' + JSON.stringify(GOOD) + '\n```' }), model: 'test-model',
        });
        expect(d.source).toBe('controller');
        expect(d.lane).toBe('flights');
        expect(d.model).toBe('test-model');
        expect(d.error).toBeNull();
    });
    test('an API error, a timeout, or junk JSON falls back — v3 degrades to v2, never worse', async () => {
        const classify = async () => ({ source: 'llm', isTravel: false, actionType: 'general', placeNames: [], language: 'en' });
        const dead = await decide({ message: 'hi' }, { complete: async () => { throw new Error('boom'); }, classify });
        expect(dead.source).toBe('fallback'); expect(dead.lane).toBeNull(); expect(dead.error).toMatch(/boom/); expect(dead.intent.isTravel).toBe(false);
        const junk = await decide({ message: 'hi' }, { complete: async () => ({ text: 'not json' }), classify });
        expect(junk.source).toBe('fallback'); expect(junk.error).toMatch(/unusable/);
        const slow = await decide({ message: 'hi' }, { complete: () => new Promise(r => setTimeout(() => r({ text: '{}' }), 200)), timeoutMs: 20, classify });
        expect(slow.source).toBe('fallback'); expect(slow.error).toMatch(/timeout/);
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
