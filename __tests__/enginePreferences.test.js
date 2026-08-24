// Changing a saved preference, by asking first (Arsen 2026-08-24: "it can stop
// and notify then ask to change, if user says yes then changes").
//
// The model may PROPOSE. Only an explicit yes writes. Everything ambiguous
// leaves the traveler's settings exactly as they left them.

const { validateProposal, isAffirmative, isNegative, applyProposal, PREF_VOCAB } = require('../engine/preferences/proposal');

describe('validateProposal', () => {
    test('the three fields chat may touch', () => {
        expect(validateProposal({ field: 'travelStyle', value: 'Budget' }))
            .toEqual({ field: 'travelStyle', value: 'budget', label: 'travel style to budget' });
        expect(validateProposal({ field: 'interests', value: ['Family', 'food & drink'] }))
            .toEqual({ field: 'interests', value: ['family', 'food_drink'], label: 'interests to family, food_drink' });
        expect(validateProposal({ field: 'budget', value: { min: 50, max: 200, currency: 'usd' } }))
            .toEqual({ field: 'budget', value: { min: 50, max: 200, currency: 'USD' }, label: 'budget to 50–200 USD' });
    });

    test('a value outside the app\'s own vocabulary is dropped, never repaired', () => {
        expect(validateProposal({ field: 'travelStyle', value: 'mid-range' })).toBeNull();
        expect(validateProposal({ field: 'interests', value: ['skydiving'] })).toBeNull();
        expect(validateProposal({ field: 'budget', value: { min: 10, max: 20, currency: 'AMD' } })).toBeNull();
    });

    test('a field chat has no business touching is refused', () => {
        for (const f of ['email', 'isPremium', 'settings', 'password', '__proto__', '']) {
            expect(validateProposal({ field: f, value: 'x' })).toBeNull();
        }
    });

    test('nonsense budgets are refused rather than clamped', () => {
        const bad = [{ min: 200, max: 50 }, { min: -5, max: 100 }, { min: 0, max: 0 },
            { min: 1, max: 9e9 }, { min: 'a', max: 'b' }, {}];
        for (const value of bad) expect(validateProposal({ field: 'budget', value: { ...value, currency: 'USD' } })).toBeNull();
    });

    test('junk in, null out', () => {
        for (const raw of [null, undefined, 'travelStyle', 42, [], {}]) expect(validateProposal(raw)).toBeNull();
    });
});

describe('consent', () => {
    test('a clear yes, in the languages the app ships', () => {
        for (const m of ['yes', 'Yes please', 'ok', 'sure', 'do it', 'go ahead', 'да', 'давай', 'այո', 'oui', '好的']) {
            expect(isAffirmative(m)).toBe(true);
        }
    });

    test('a clear no is never a yes', () => {
        for (const m of ['no', 'nope', "don't", 'leave it', 'cancel', 'нет', 'ոչ', 'non']) {
            expect(isAffirmative(m)).toBe(false);
            expect(isNegative(m)).toBe(true);
        }
    });

    test('ambiguity is not consent — the safe default is to change nothing', () => {
        for (const m of ['', '   ', 'maybe', 'i think so', 'what are my preferences?',
            'yesterday I went to Garni', 'show me events', 'okay so what about hotels']) {
            expect(isAffirmative(m)).toBe(false);
        }
    });

    test('"yesterday" does not begin a yes', () => {
        expect(isAffirmative('yesterday was great')).toBe(false);
    });
});

describe('applyProposal', () => {
    const User = (calls) => ({ updateOne: async (q, u) => { calls.push({ q, u }); return { acknowledged: true }; } });

    test('writes ONE path, so no other setting can be lost', async () => {
        const calls = [];
        expect(await applyProposal('u1', { field: 'travelStyle', value: 'budget' }, { User: User(calls) })).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].u).toEqual({ $set: { 'preferences.travelStyle': 'budget' } });
    });

    test('an invalid proposal never reaches the database', async () => {
        const calls = [];
        expect(await applyProposal('u1', { field: 'isPremium', value: true }, { User: User(calls) })).toBe(false);
        expect(await applyProposal(null, { field: 'travelStyle', value: 'budget' }, { User: User(calls) })).toBe(false);
        expect(calls).toHaveLength(0);
    });

    test('a database failure is reported, not thrown', async () => {
        const boom = { updateOne: async () => { throw new Error('down'); } };
        expect(await applyProposal('u1', { field: 'travelStyle', value: 'budget' }, { User: boom })).toBe(false);
    });

    test('the vocabulary matches the app\'s own Preferences screen', () => {
        expect(PREF_VOCAB.travelStyle).toEqual(['luxury', 'budget']);
        expect(PREF_VOCAB.interests).toContain('food_drink');
        expect(PREF_VOCAB.currency).toEqual(['AED', 'USD', 'RUB', 'EUR', 'GBP']);
    });
});
