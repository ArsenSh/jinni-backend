// Polish batch 2026-08-31: deterministic greeting-strip (mid-chat "Привет!"
// opener bleed), honest-max phrasing when a stated count outruns the deck,
// and the tool-answer trailing-sentence ban.

const { stripLeadingGreeting, makeGreetingGate, messageGreets } = require('../engine/narrator/greetingStrip');
const g = require('../engine/narrator/prompts/grounded');

describe('stripLeadingGreeting', () => {
    test('strips a standalone Russian greeting opener with emoji', () => {
        expect(stripLeadingGreeting('Привет! 😊 Вот отличные рестораны в Дилижане.'))
            .toBe('Вот отличные рестораны в Дилижане.');
    });
    test('strips "Hi there!" openers', () => {
        expect(stripLeadingGreeting('Hi there! Here are three cozy cafes.'))
            .toBe('Here are three cozy cafes.');
    });
    test('strips stacked greetings', () => {
        expect(stripLeadingGreeting('Привет! Здравствуйте! Вот кафе.')).toBe('Вот кафе.');
    });
    test('strips an Armenian greeting with Armenian punctuation', () => {
        expect(stripLeadingGreeting('Բարև ձեզ։ Ահա հյուրանոցները.')).toBe('Ահա հյուրանոցները.');
    });
    test('leaves a place name that CONTAINS a greeting word intact', () => {
        const s = 'Hello Kitty Café is a lovely spot for families.';
        expect(stripLeadingGreeting(s)).toBe(s);
    });
    test('leaves flowing prose after a comma intact (no terminator)', () => {
        const s = 'Привет, вот рестораны рядом с вами.';
        expect(stripLeadingGreeting(s)).toBe(s);
    });
    test('never blanks a greeting-only reply', () => {
        expect(stripLeadingGreeting('Привет! 😊')).toBe('Привет! 😊');
    });
    test('handles empty/null input', () => {
        expect(stripLeadingGreeting('')).toBe('');
        expect(stripLeadingGreeting(null)).toBe('');
    });
});

describe('makeGreetingGate (streaming)', () => {
    const run = (chunks, opts) => {
        const out = [];
        const gate = makeGreetingGate((t) => out.push(t), opts);
        for (const c of chunks) gate.feed(c);
        gate.finalize();
        return out.join('');
    };
    test('catches a greeting split across deltas', () => {
        expect(run(['Прив', 'ет! ', 'Вот отличные рестораны в Дилижане для вас.']))
            .toBe('Вот отличные рестораны в Дилижане для вас.');
    });
    test('passes text through untouched after the hold window opens', () => {
        const body = 'Here are ten hotels in Dilijan worth your evening, each one open and rated well. More follows.';
        expect(run([body.slice(0, 70), body.slice(70)])).toBe(body);
    });
    test('short reply held in the buffer still flushes on finalize', () => {
        expect(run(['Sure — done.'])).toBe('Sure — done.');
    });
    test('disabled gate is a pass-through', () => {
        expect(run(['Привет! ', 'Вот кафе.'], { enabled: false })).toBe('Привет! Вот кафе.');
    });
});

describe('messageGreets', () => {
    test('greeting messages turn the gate off (echo is natural)', () => {
        expect(messageGreets('привет')).toBe(true);
        expect(messageGreets('Hi, how are you?')).toBe(true);
        expect(messageGreets('Բարև ձեզ')).toBe(true);
    });
    test('ordinary asks do not read as greetings', () => {
        expect(messageGreets('hotels in Dilijan')).toBe(false);
        expect(messageGreets('покажи рестораны')).toBe(false);
    });
});

describe('honest-max phrasing (askedCount)', () => {
    const places = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    test('streamed builder states the ceiling when the deck falls short', () => {
        const sys = g.buildStreamedNarrationMessages({ query: 'hotels', places, askedCount: 10 })[0].content;
        expect(sys).toContain('They asked for 10');
        expect(sys).toContain('EVERYTHING you could find');
    });
    test('one-shot JSON builder carries the same rule', () => {
        const sys = g.buildNarrationJson({ query: 'hotels', places, askedCount: 10 })[0].content;
        expect(sys).toContain('They asked for 10');
    });
    test('silent when the count was met or no count was asked', () => {
        expect(g.buildStreamedNarrationMessages({ query: 'hotels', places, askedCount: 3 })[0].content)
            .not.toContain('They asked for');
        expect(g.buildStreamedNarrationMessages({ query: 'hotels', places })[0].content)
            .not.toContain('They asked for');
    });
    test('silent on an empty deck (the empty-deck branch owns that reply)', () => {
        expect(g.buildStreamedNarrationMessages({ query: 'hotels', places: [], askedCount: 10 })[0].content)
            .not.toContain('They asked for');
    });
});

describe('tool-answer trailing-sentence ban', () => {
    test('system forbids closing remarks about earlier asks; user tail restates it', () => {
        const msgs = g.buildToolAnswerMessages({ message: 'is Tufenkian open tonight?', langName: 'English' });
        expect(msgs[0].content).toContain('Never append a sentence about an earlier');
        expect(msgs[msgs.length - 1].content).toContain('no closing remark about earlier requests');
    });
});
