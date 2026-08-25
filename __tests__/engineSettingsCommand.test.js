// A settings command is CARRIED OUT, not answered with places.
//
// Arsen 2026-08-24: "this kind of commands why it triggers to show locations???
// … it only updated interest to family but it recommended locations, it couldnt
// set to dubai, and have not asked budget to set style."
//
// Three symptoms, one cause: a change was parsed out of the CARD narration, so
// the turn had to retrieve places to carry one, the prose was written from
// preferences read BEFORE the write, and a field the narrator simply omitted
// was never written while the reply still said "done".

const { buildSettingsMessages } = require('../engine/narrator/prompts/grounded');

describe('reporting a settings change', () => {
    test('the reply is built from what was WRITTEN, not from what was asked', () => {
        const m = buildSettingsMessages({
            message: 'set style to budget', langName: 'English',
            done: ['travel style to budget'], failed: [],
        });
        expect(m[1].content).toContain('CHANGED, and already saved: travel style to budget.');
        expect(m[0].content).toMatch(/past tense/);
        expect(m[0].content).toMatch(/Do not claim anything was changed that is not on the CHANGED line/);
    });

    test('a refusal is reported as a refusal, not glossed over', () => {
        const m = buildSettingsMessages({
            message: 'set location to Atlantis', langName: 'English',
            done: [], failed: ['location'],
        });
        expect(m[1].content).toContain('NOT changed — you could not do this: location.');
    });

    test('it is told not to offer places on a command turn', () => {
        const m = buildSettingsMessages({ message: 'set style to budget', langName: 'English', done: ['x'] });
        expect(m[0].content).toMatch(/Do not offer places/);
        expect(m[0].content).toMatch(/do not ask what they want to see next/);
    });

    test('budget style with no figures asks for them, and never invents them', () => {
        const m = buildSettingsMessages({
            message: 'set style to budget', langName: 'English',
            done: ['travel style to budget'], needsBudget: true,
        });
        expect(m[0].content).toMatch(/minimum and maximum budget/);
        expect(m[0].content).toMatch(/Never invent the figures/);
    });

    test('budget style WITH figures does not nag', () => {
        const m = buildSettingsMessages({
            message: 'set style to budget', langName: 'English',
            done: ['travel style to budget'], needsBudget: false,
        });
        expect(m[0].content).not.toMatch(/minimum and maximum budget/);
    });

    test('it answers in the traveler\'s language', () => {
        const m = buildSettingsMessages({ message: 'поставь бюджетный стиль', langName: 'Russian', done: ['x'] });
        expect(m[0].content).toMatch(/Reply in Russian/);
    });
});

describe('intent reports the command', () => {
    const intentService = require('../services/intentService');

    test('the prompt names every settable field and its allowed values', () => {
        const src = require('fs').readFileSync(require.resolve('../services/intentService.js'), 'utf8');
        for (const f of ['location', 'travelStyle', 'interests', 'budget', 'nearbyRadius', 'discoveryRadius']) {
            expect(src).toContain(f);
        }
        // A one-off want must not be read as a lasting change.
        expect(src).toMatch(/Wanting something once is NOT a setting change/);
        // Coordinates and place names never come from the model.
        expect(src).toMatch(/never a place name or coordinates here/);
    });

    test('malformed entries are dropped rather than repaired', () => {
        expect(typeof intentService.classify).toBe('function');
        const src = require('fs').readFileSync(require.resolve('../services/intentService.js'), 'utf8');
        expect(src).toMatch(/settingsChange: Array\.isArray\(raw\.settings_change\)/);
        expect(src).toMatch(/\.filter\(c => c && typeof c === 'object' && typeof c\.field === 'string'\)/);
    });
});

// ── RECOGNITION (added 2026-08-25) ────────────────────────────────────────────
//
// Everything above tests the REPLY — what is said once a command has been
// recognised. Nothing tested the recognition itself, and that is where the
// chain actually broke:
//
//   "can you set to current location, gps one?"  → six Dubai cards
//   "can you change my preferences?"             → "I can't change your preferences"
//
// Both are one cause. Every example in the rule was an imperative (set, change,
// make, search) under the verb "TELLS you to change", preceded by the hard
// prior "[] on almost every message" — so a polite interrogative read as a
// question about places and fell through to retrieval. The write machinery was
// never reached; it worked the whole time.
//
// The decision itself is an LLM call, so these assert the RULE the model reads.
// They fail if the wording is ever trimmed back to imperatives only.
describe('recognising a settings command', () => {
    const { buildUserPrompt } = require('../services/intentService');
    const prompt = () => buildUserPrompt('can you set my location to Dubai?', []);

    test('a polite question is stated to be a command, with examples', () => {
        const p = prompt();
        expect(p).toMatch(/POLITE QUESTION IS STILL A COMMAND/i);
        expect(p).toContain('can you set my location to Dubai?');
        expect(p).toContain('could you change my style to budget?');
    });

    test('the rule is non-Latin too — the phrasing trap is not English-only', () => {
        expect(prompt()).toMatch(/можешь поставить бюджетный стиль/);
    });

    test('grammar is explicitly NOT the test — naming a value is', () => {
        expect(prompt()).toMatch(/NAMES A SETTING AND THE VALUE/i);
    });

    test('a question naming no value is NOT a change', () => {
        // "can you change my preferences?" must leave settings_change empty:
        // nothing was named, so nothing can be written and "done" would lie.
        // The capability answer belongs to the prompt in grounded.js instead.
        const p = prompt();
        expect(p).toContain('can you change my preferences?');
        expect(p).toMatch(/names NO value is not a change/i);
    });
});

// The other half of the same failure: the narrator must know the capability
// exists, WHICH settings it covers, and what to say when asked whether it can
// change preferences without being told which.
describe('what Jinni says it can change', () => {
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
    const sys = () => buildChitchatMessages({ message: 'can you change my preferences?', langName: 'English' })[0].content;

    test('the five settable fields are named, so nothing wider is promised', () => {
        const s = sys();
        for (const field of ['travel style', 'interests', 'budget', 'saved location', 'search radius']) {
            expect(s).toContain(field);
        }
        expect(s).toMatch(/language, theme, password, account — you cannot change/i);
    });

    test('asked whether it CAN, the answer is yes-then-which, never a refusal', () => {
        const s = sys();
        expect(s).toMatch(/the answer is YES/);
        expect(s).toMatch(/ask which setting and which value/i);
        expect(s).toMatch(/Only describe a change as done when this turn actually reports one/i);
    });
});
