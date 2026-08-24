// Tests for V2 session context: recent turns, already-shown excludes, and
// history threading into the narration prompts.

const { recentTurnsFromMessages, shownFromMessages } = require('../engine/context/session');
const { buildGroundedMessages, buildChitchatMessages, historyTurns } = require('../engine/narrator/prompts/grounded');

const MSGS = [
    { sender: 'user', text: 'can you suggest hotels?' },
    { sender: 'ai', text: 'You have a few good hotel options nearby…',
      recommendations: [{ placeId: 'gp1', name: 'Tufenkian Heritage Hotels' },
                        { placeId: 'gp2', name: 'Seven Visions Hotels' }] },
    { sender: 'user', text: 'any cheaper ones?' },
];

describe('recentTurnsFromMessages', () => {
    test('keeps sender, trims text to 300 chars, respects the limit', () => {
        const turns = recentTurnsFromMessages([...MSGS, { sender: 'ai', text: 'x'.repeat(500) }], 2);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toEqual({ sender: 'user', text: 'any cheaper ones?' });
        expect(turns[1].text).toHaveLength(300);
    });
    test('textless messages are skipped; empty/null safe', () => {
        expect(recentTurnsFromMessages([{ sender: 'ai' }, null])).toEqual([]);
        expect(recentTurnsFromMessages(null)).toEqual([]);
    });
});

describe('shownFromMessages', () => {
    test('collects placeIds and names from session recs, deduped', () => {
        const shown = shownFromMessages([...MSGS, { sender: 'ai',
            recommendations: [{ placeId: 'gp1', name: 'Tufenkian Heritage Hotels' }] }]);
        expect(shown.placeIds).toEqual(['gp1', 'gp2']);
        expect(shown.names).toEqual(['Tufenkian Heritage Hotels', 'Seven Visions Hotels']);
    });
    test('no recs → empty excludes', () => {
        expect(shownFromMessages([{ sender: 'user', text: 'hi' }])).toEqual({ placeIds: [], names: [] });
    });
});

describe('history in prompts', () => {
    test('historyTurns maps ai→assistant, user→user, oldest first', () => {
        expect(historyTurns(recentTurnsFromMessages(MSGS))).toEqual([
            { role: 'user', content: 'can you suggest hotels?' },
            { role: 'assistant', content: 'You have a few good hotel options nearby…' },
            { role: 'user', content: 'any cheaper ones?' },
        ]);
    });
    test('grounded messages: system, then history, then the fact-bearing user turn', () => {
        const msgs = buildGroundedMessages({
            query: 'cheaper hotels', places: [{ name: 'Ibis Yerevan Center' }],
            history: recentTurnsFromMessages(MSGS),
        });
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('including places from earlier in the conversation');
        expect(msgs.slice(1, 4).map(m => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(msgs[msgs.length - 1].content).toContain('Ibis Yerevan Center');
    });
    test('chit-chat carries history too; empty history degrades to the old shape', () => {
        const withHistory = buildChitchatMessages({ message: 'thanks!', history: recentTurnsFromMessages(MSGS) });
        expect(withHistory).toHaveLength(5);
        expect(buildChitchatMessages({ message: 'hi' })).toHaveLength(2);
    });
});

// ── Which ask a follow-up continues (Arsen 2026-08-24) ───────────────────────
// "other interesting events please, which you think will be better to go with
// girlfriend" searched for "then if you see what are my preferences" — the
// refill path reused the literal previous message, and the message in between
// was chit-chat. A follow-up is about the deck on screen, so only a turn that
// produced cards can be the ask it continues.
describe('lastCardAsk', () => {
    const { lastCardAsk } = require('../engine/context/session');
    const ask = (text) => ({ sender: 'user', text });
    const deck = (...names) => ({ sender: 'ai', text: 'here you go', recommendations: names.map(n => ({ name: n, placeId: `p-${n}` })) });
    const said = (text) => ({ sender: 'ai', text });

    test('the live failure: chit-chat between the deck and the follow-up', () => {
        expect(lastCardAsk([
            ask('events next week'),
            deck('Coca-Cola Fest', 'Symphonic Hayko'),
            ask('do you see my preferences?'),
            said('I can see your saved preferences.'),
            ask('then if you see what are my preferences?'),
            said('You like cozy, low-key spots.'),
        ])).toBe('events next week');
    });

    test('the most recent deck wins when several asks produced one', () => {
        expect(lastCardAsk([
            ask('events next week'), deck('Coca-Cola Fest'),
            ask('cozy bars nearby'), deck('Bohem'),
        ])).toBe('cozy bars nearby');
    });

    test('an AI turn with an empty deck is not an answer', () => {
        expect(lastCardAsk([
            ask('events next week'), deck('Coca-Cola Fest'),
            ask('what AI works under you'), { sender: 'ai', text: 'I am Jinni.', recommendations: [] },
        ])).toBe('events next week');
    });

    test('no carded ask in the window → null, so the turn stays a fresh ask', () => {
        expect(lastCardAsk([ask('hello'), said('hi!'), ask('what can you do')])).toBeNull();
        expect(lastCardAsk([])).toBeNull();
        expect(lastCardAsk(null)).toBeNull();
        expect(lastCardAsk(undefined)).toBeNull();
    });

    test('a deck with no user turn before it yields null rather than a wrong ask', () => {
        expect(lastCardAsk([deck('Some Place')])).toBeNull();
    });

    test('malformed rows are skipped, not thrown on', () => {
        expect(lastCardAsk([null, ask('events next week'), undefined, deck('X'), {}])).toBe('events next week');
    });
});
