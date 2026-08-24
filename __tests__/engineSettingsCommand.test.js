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
