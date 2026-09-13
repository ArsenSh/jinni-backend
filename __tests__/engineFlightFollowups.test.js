// A flight conversation that fell apart, live 2026-09-06:
//   1. "Find flight to Mykonos for upcoming week"  → no fares on that route (true)
//   2. Jinni: "Would you like me to look up Yerevan to Athens instead?"
//   3. "Yes"                     → fast path said travel=false → generic
//                                  "I can't book flights", offer lost
//   4. "At dec 7 where is the stop" → denied fares it had just listed, because
//                                  prose is not data and numbers may never come
//                                  from memory
//   5. "can you find flights for October?" → no place, no topic the classifier
//                                  could see → 50 km place search → six Yerevan
//                                  restaurants under a flights question
const { answersAPendingQuestion } = require('../services/intentService');
const { recentTurnsFromMessages, withServerReply, sameCitiesAsLastFlights } = require('../engine/context/session');
const { buildGettingAroundMessages, clipTurn, historyTurns } = require('../engine/narrator/prompts/grounded');

describe('an answer to Jinni’s own question is not small talk', () => {
    const asked = (text) => [{ sender: 'user', text: 'find flights' }, { sender: 'ai', text }];

    test('a question mark in the assistant’s last turn blocks the fast path', () => {
        expect(answersAPendingQuestion(asked('Would you like me to look up Yerevan to Athens instead?'))).toBe(true);
    });

    test('it reads the LAST assistant turn, not any older one', () => {
        expect(answersAPendingQuestion([
            { sender: 'ai', text: 'Shall I look for flights?' },
            { sender: 'user', text: 'yes' },
            { sender: 'ai', text: 'Here are the cheapest fares from Yerevan to Dubai.' },
        ])).toBe(false);
    });

    test('every script the app speaks', () => {
        expect(answersAPendingQuestion(asked('Хотите посмотреть?'))).toBe(true);
        expect(answersAPendingQuestion(asked('Ուզու՞մ ես'))).toBe(true);       // mark sits mid-word
        expect(answersAPendingQuestion(asked('هل تريد ذلك؟'))).toBe(true);
        expect(answersAPendingQuestion(asked('要看看吗？'))).toBe(true);
    });

    test('a closing bracket or quote after the mark still counts', () => {
        expect(answersAPendingQuestion(asked('Want me to check Athens (or Santorini)?'))).toBe(true);
        expect(answersAPendingQuestion(asked('He asked "shall we?"'))).toBe(true);
    });

    test('a statement does not block the fast path — "thanks" stays $0', () => {
        expect(answersAPendingQuestion(asked('Here are the cheapest fares from Yerevan to Dubai.'))).toBe(false);
        expect(answersAPendingQuestion([])).toBe(false);
        expect(answersAPendingQuestion()).toBe(false);
    });
});

describe('fares already fetched are handed back as DATA', () => {
    const fares = {
        args: { origin: 'EVN', destination: 'DXB' },
        result: { fares: [{ date: '2026-12-07', airline: 'Wizz Air', price: 131, stops: 1, via: 'BUD' }] },
    };
    const text = (opts) => buildGettingAroundMessages({ message: 'At dec 7 where is the stop', ...opts })[0].content;

    test('the follow-up can answer from the real API result', () => {
        const t = text({ priorFlights: fares });
        expect(t).toMatch(/FARES ALREADY FETCHED/);
        expect(t).toMatch(/Wizz Air/);
        expect(t).toMatch(/BUD/);
    });

    test('it is labelled as fetched data, never as recall', () => {
        expect(text({ priorFlights: fares })).toMatch(/real API results, not memory/);
    });

    test('a question the data does not cover must be admitted, not filled in', () => {
        expect(text({ priorFlights: fares })).toMatch(/say when the question asks about something it does not contain/);
    });

    test('nothing fetched means no block at all — no empty scaffolding to fill', () => {
        expect(text({})).not.toMatch(/FARES ALREADY FETCHED/);
        expect(text({ priorFlights: null })).not.toMatch(/FARES ALREADY FETCHED/);
    });

    test('a huge fare set is truncated rather than blowing the prompt', () => {
        const many = { args: {}, result: { fares: Array.from({ length: 400 }, (_, i) => ({ airline: `Carrier ${i}`, price: i })) } };
        const t = text({ priorFlights: many });
        expect(t).toMatch(/FARES ALREADY FETCHED/);
        expect(t.length).toBeLessThan(9000);
    });
});

describe('"yes please" to Jinni’s own offer (live 2026-09-13: it re-listed the fares)', () => {
    const longReply = 'Here are the fares I have for Yerevan–Moscow this week, all direct: [FLYONE Armenia](https://api.jinni.travel/go/f/IAYtyZmG) on 15 September at 07:00 for 99 USD; '
        + '[FLYONE Armenia](https://api.jinni.travel/go/f/7bGwHOVE) on 16 September at 23:20 for 100 USD; [FLYONE Armenia](https://api.jinni.travel/go/f/R7mmwDVY) on 17 September at 22:40 for 100 USD; '
        + 'and [Utair](https://api.jinni.travel/go/f/DskrOuEV) on 18 September at 02:45 for 105 USD. Nothing showed for today or the weekend in what I have. Want me to check a specific return date too?';

    test('a long earlier turn keeps its ENDING — the question Jinni asked survives the clip', () => {
        expect(longReply.length).toBeGreaterThan(300);
        const clipped = clipTurn(longReply);
        expect(clipped.length).toBeLessThanOrEqual(305);
        expect(clipped).toMatch(/Want me to check a specific return date too\?$/);
        expect(clipped).toMatch(/^Here are the fares I have/);
        expect(clipped).toContain(' … ');
    });

    test('short turns are untouched', () => {
        expect(clipTurn('yes please')).toBe('yes please');
        expect(historyTurns([{ sender: 'user', text: 'hi' }, { sender: 'ai', text: 'hello' }])).toEqual([
            { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
        ]);
    });

    test('the prompt sees the offer, and is told to act on a yes by asking for the missing detail', () => {
        const msgs = buildGettingAroundMessages({
            message: 'yes please', canQuoteFares: true,
            history: [{ sender: 'user', text: 'Find tickets to Moscow in this week' }, { sender: 'ai', text: longReply }],
        });
        const assistantTurn = msgs.find(m => m.role === 'assistant');
        expect(assistantTurn.content).toMatch(/return date too\?$/);
        expect(msgs[0].content).toMatch(/answers YES/);
        expect(msgs[0].content).toMatch(/never repeat fares already shown/);
        expect(msgs[0].content).toMatch(/Which day would you fly back\?/);
    });
});

describe('a bare "yes" after a LONG offer (live 2026-09-13: filed as small talk)', () => {
    const longReply = 'Here are the fares I have for Yerevan–Moscow this week, all direct:\n\n'
        + '[FLYONE Armenia](https://api.jinni.travel/go/f/X74GsbY0) — departs 2026-09-15 at 07:00, 99 USD.\n'
        + '[FLYONE Armenia](https://api.jinni.travel/go/f/FamkdJo0) — departs 2026-09-17 at 06:10, 102 USD.\n'
        + '[FLYONE Armenia](https://api.jinni.travel/go/f/tyQlIJEf) — departs 2026-09-16 at 23:20, 105 USD.\n'
        + '[Utair](https://api.jinni.travel/go/f/lRZgrqWC) — departs 2026-09-18 at 02:45, 106 USD.\n\n'
        + 'Want me to check a return date as well?';

    test('the recent turns handed to the classifier keep the closing question', () => {
        expect(longReply.length).toBeGreaterThan(300);
        const turns = recentTurnsFromMessages([{ sender: 'user', text: 'Find tickets to Moscow in this week' }, { sender: 'ai', text: longReply }]);
        expect(turns[1].text).toMatch(/return date as well\?$/);
        expect(turns[1].text.length).toBeLessThanOrEqual(300);
    });

    test('so the pending-question guard fires and "yes" never reaches the small-talk fast path', () => {
        const turns = recentTurnsFromMessages([{ sender: 'user', text: 'Find tickets to Moscow in this week' }, { sender: 'ai', text: longReply }]);
        expect(answersAPendingQuestion(turns)).toBe(true);
    });
});

describe('the server remembers its own last reply (live 2026-09-13: "yes" arrived before the frontend saved it)', () => {
    const offer = 'Here are the fares I have… Want me to check a return date too?';

    test('with nothing persisted yet, the reply is folded in and the guard fires', () => {
        const turns = withServerReply(recentTurnsFromMessages([{ sender: 'user', text: 'Find tickets to Moscow in this week' }]), { text: offer, at: new Date() });
        expect(turns[turns.length - 1]).toEqual({ sender: 'ai', text: offer });
        expect(answersAPendingQuestion(turns)).toBe(true);
    });

    test('once the frontend HAS persisted it, nothing is duplicated', () => {
        const turns = withServerReply(recentTurnsFromMessages([
            { sender: 'user', text: 'Find tickets to Moscow in this week' }, { sender: 'ai', text: offer },
        ]), { text: offer, at: new Date() });
        expect(turns).toHaveLength(2);
    });

    test('no server reply, or an empty one, changes nothing', () => {
        const base = recentTurnsFromMessages([{ sender: 'user', text: 'hi' }]);
        expect(withServerReply(base, null)).toEqual(base);
        expect(withServerReply(base, { text: '   ' })).toEqual(base);
        expect(withServerReply(null, { text: 'x' })).toEqual([{ sender: 'ai', text: 'x' }]);
    });
});

describe('naming the same two cities again stays in the flights lane (live 2026-09-13: a road-trip search instead)', () => {
    const last = { origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-20' };
    test('"Yerevan to Moscow and not vice versa" — both cities, either order', () => {
        expect(sameCitiesAsLastFlights(['Moscow', 'Yerevan'], last)).toBe(true);
        expect(sameCitiesAsLastFlights(['yerevan', 'MOSCOW'], last)).toBe(true);
    });
    test('one city, a third city, or no fares before → not the same conversation', () => {
        expect(sameCitiesAsLastFlights(['Moscow'], last)).toBe(false);
        expect(sameCitiesAsLastFlights(['Moscow', 'Tbilisi'], last)).toBe(false);
        expect(sameCitiesAsLastFlights(['Moscow', 'Yerevan'], null)).toBe(false);
        expect(sameCitiesAsLastFlights([], last)).toBe(false);
    });
});

describe('"I need to stay 4 days" is a duration, not a hotel ask (live 2026-09-13: became a nightlife deck)', () => {
    const { namesVenueType } = require('../engine/retrieval/tuning');
    test('stay + a number of days/nights does not name a venue type', () => {
        expect(namesVenueType('I need to stay 4 days have not planned which day specifically to travel')).toBe(false);
        expect(namesVenueType('staying for two nights')).toBe(false);
        expect(namesVenueType('we stay a few days')).toBe(false);
    });
    test('lodging asks still do', () => {
        expect(namesVenueType('where can I stay in Moscow')).toBe(true);
        expect(namesVenueType('a hotel to stay 4 nights')).toBe(true);
        expect(namesVenueType('good bars near the hotel')).toBe(true);
    });
    test('the prompt tells the narrator what to do with a stay length', () => {
        const msgs = buildGettingAroundMessages({ message: 'I need to stay 4 days', canQuoteFares: true });
        expect(msgs[0].content).toMatch(/LENGTH of stay/);
        expect(msgs[0].content).toMatch(/never ask again for a date they said they have not chosen/);
    });
});
