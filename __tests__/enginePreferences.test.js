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
    const User = (calls) => ({ updateOne: async (q, u) => { calls.push({ q, u }); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } });

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

// that for you", which was false. Then: "it should simply set and save, same

// Arsen 2026-08-24: "the jinni can have access to discovery and nearby modes
// also their radiuses, in clever situations can ask or get command to change,
// also can set budget in preferences with budget style, if user he wants budget
// places then should give budget also min and max" — plus, crucially, "user may
// manually toggle off gps location".
describe('search radii and what Jinni admits to seeing', () => {
    const { validateProposal, applyProposal, PREF_PATHS } = require('../engine/preferences/proposal');
    const { selfBlock } = require('../engine/narrator/prompts/grounded');

    // Arsen 2026-08-26: "we can remove the radius touch by ai ... for radius it
    // can say user to do from settings manually". The radius stopped being
    // WRITABLE; it did not stop being READ — v2's search now honours whatever
    // the Preferences slider holds, which it never did while chat could set it.
    test('no radius proposal is ever accepted, whatever the value', () => {
        for (const value of [8, 75, 40, 5, 'wide', 200, null]) {
            expect(validateProposal({ field: 'nearbyRadius', value })).toBeNull();
            expect(validateProposal({ field: 'discoveryRadius', value })).toBeNull();
        }
    });

    test('no radius path is writable', () => {
        expect(PREF_PATHS.nearbyRadius).toBeUndefined();
        expect(PREF_PATHS.discoveryRadius).toBeUndefined();
        expect(Object.values(PREF_PATHS).some(x => x.startsWith('settings.searchRadius'))).toBe(false);
    });

    // The refusal has to be USEFUL. A bare field name told the traveler nothing;
    // this names the setting and the screen, and it is generated where the
    // decision is made rather than explained to the model in the prompt.
    test('a refused radius tells the traveler where to change it', () => {
        const { refusalReason } = require('../engine/preferences/proposal');
        for (const f of ['nearbyRadius', 'discoveryRadius']) {
            const why = refusalReason(f);
            expect(why).toMatch(/radius/i);
            expect(why).toMatch(/Preferences/);
            expect(why).toMatch(/you cannot do it for them/i);
        }
    });

    // The READ side — the half that was broken and is now the whole point.
    test('a saved radius reaches the search, clamped to the slider bounds', () => {
        const { radiusKmFor } = require('../engine/preferences/proposal');
        expect(radiusKmFor('nearby', { nearby: 12 })).toBe(12);
        expect(radiusKmFor('discovery', { discovery: 100 })).toBe(100);
        expect(radiusKmFor('nearby', { nearby: 999 })).toBe(20);      // schema max
        expect(radiusKmFor('discovery', { discovery: 2 })).toBe(10);  // schema min
        expect(radiusKmFor('nearby', { nearby: 'wide' })).toBe(5);    // junk -> default
        expect(radiusKmFor('discovery', {})).toBe(50);                // unset -> default
        expect(radiusKmFor('discovery', null)).toBe(50);
    });

    // The lie, live 2026-08-24: "are you sure that my location is Dubai?" →
    // "Yes, your location is Dubai right now — the app reported it this turn",
    // while the log read "User location: Yerevan, Yerevan, Armenia". Dubai was
    // the SAVED location. The prompt said it could see a position without ever
    // saying which one, so it reached for the only place name in front of it.
    test('the current position is NAMED, not merely asserted to exist', () => {
        const block = selfBlock(
            { _here: 'Yerevan, Armenia', _savedLocation: { city: 'Dubai', countryName: 'United Arab Emirates' } },
            { knowsLocation: true });
        expect(block).toMatch(/WHERE THEY ARE RIGHT NOW: Yerevan, Armenia/);
        expect(block).toMatch(/NOT the same thing as the location saved/);
    });

    test('the saved location is labelled as somewhere they plan to go', () => {
        const block = selfBlock({ _savedLocation: { city: 'Dubai', countryName: 'United Arab Emirates' } });
        expect(block).toMatch(/location saved in their settings \(where they plan to go, NOT where they are\): Dubai/);
    });

    test('knowing the flag but not the place counts as NOT knowing', () => {
        // Half-knowledge is what produced the invention, so it fails closed.
        const block = selfBlock({ travelStyle: 'luxury', _knowsLocation: true }, { knowsLocation: true });
        expect(block).toMatch(/do NOT know where the traveler is right now/);
    });

    test('with location switched off, it says so — and points at Settings', () => {
        const block = selfBlock({ travelStyle: 'luxury' }, { knowsLocation: false });
        expect(block).toMatch(/do NOT know where the traveler is right now/);
        expect(block).toMatch(/never infer it from their saved location/);
        expect(block).toMatch(/enable it in Settings/);
        expect(block).not.toMatch(/WHERE THEY ARE RIGHT NOW/);
    });

    test('budget style with no numbers is surfaced as a gap to ask about', () => {
        const block = selfBlock({ travelStyle: 'budget', budget: { min: 0, max: 0 } });
        expect(block).toMatch(/NO budget range is saved/);
    });

    test('budget style WITH numbers raises nothing', () => {
        const block = selfBlock({ travelStyle: 'budget', budget: { min: 20, max: 80, currency: 'USD' } });
        expect(block).not.toMatch(/NO budget range is saved/);
        expect(block).toMatch(/budget: 20–80 USD/);
    });

    test('the radii appear as rows it can quote', () => {
        const block = selfBlock({ _searchRadius: { nearby: 7, discovery: 60 } });
        expect(block).toMatch(/nearby radius: 7 km/);
        expect(block).toMatch(/discovery radius: 60 km/);
    });
});

// The bug this exists to prevent, live 2026-08-24: "change my location, choose
// Dubai" → "Your location is now set to Dubai — done." while the log read
// "[prefs] location to Yerevan, Armenia — set on request". The vocabulary
// only had 'current', so a named city was silently turned into the GPS. The

// "it reads, it says correctly but it is not editing in user settings, it is
// editing in his mind only" (Arsen 2026-08-24). Two causes, one here:
// `acknowledged` is true even when the write matched nothing, so a silent no-op
// logged "approved by the traveler". (The other was the frontend never
// reloading its copy of the user — fixed in JinniChat.vue.)
describe('a write only counts when it matched a document', () => {
    const { applyProposal } = require('../engine/preferences/proposal');
    const res = (r) => ({ User: { updateOne: async () => r } });

    test('matched and modified is a success', async () => {
        expect(await applyProposal('u', { field: 'travelStyle', value: 'budget' },
            res({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }))).toBe(true);
    });

    test('matched but unmodified is also fine — the value was already that', async () => {
        expect(await applyProposal('u', { field: 'travelStyle', value: 'budget' },
            res({ acknowledged: true, matchedCount: 1, modifiedCount: 0 }))).toBe(true);
    });

    test('acknowledged with nothing matched is a FAILURE, not a success', async () => {
        expect(await applyProposal('u', { field: 'travelStyle', value: 'budget' },
            res({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }))).toBe(false);
    });

    test('the legacy driver shape still reads correctly', async () => {
        expect(await applyProposal('u', { field: 'travelStyle', value: 'budget' },
            res({ n: 1, nModified: 1 }))).toBe(true);
        expect(await applyProposal('u', { field: 'travelStyle', value: 'budget' },
            res({ n: 0, nModified: 0 }))).toBe(false);
    });
});

// OnboardingPage.vue's save payload is the contract a chat-driven change has to
// match, because both write the SAME user and the Preferences screen reads what
// onboarding wrote:
//
//   preferences: { travelStyle, interests, budget, useGPS, destination }
//   settings:    { location, privacy: { autoDetectLocation, locationPermissionGranted } }
//
// applyProposal wrote destination, settings.location and autoDetectLocation —
// but not useGPS, which is the field the screen's GPS toggle actually renders
// (handleGPSToggle + the locationMode computed both read preferences.useGPS).
// So the toggle kept showing the previous choice after Jinni moved the
// location: the same two-fields-one-fact drift that once had chat reading

// A path that is not in the schema is not a place to store anything.
//
// The applyProposal tests above stub User.updateOne, so they assert the $set we
// BUILD — not what Mongoose agrees to write. preferences.useGPS was added to
// that $set on 2026-08-25 and silently discarded in production, because it was
// missing from the schema and strict mode drops unknown paths without a word.
// The stub can never see that; this reads the schema itself.
describe('every path applyProposal writes actually exists in the User schema', () => {
    const User = require('../models/User');
    const { PREF_PATHS } = require('../engine/preferences/proposal');

    const PATHS = [
        ...Object.values(PREF_PATHS),
        // No longer written by chat, so no longer in PREF_PATHS — but the schema
        // paths must still exist, because the search READS them every turn.
        'settings.searchRadius.nearby',
        'settings.searchRadius.discovery',
        'preferences.useGPS',
        'settings.privacy.autoDetectLocation',
        'settings.privacy.locationPermissionGranted',
        'preferences.destination.city',
        'settings.location.city',
    ];

    test.each(PATHS)('%s is declared', (path) => {
        // Nested objects register as their leaves, so accept either a declared
        // path or a declared child — what matters is that strict mode will
        // not drop the write.
        const declared = User.schema.path(path)
            || Object.keys(User.schema.paths).some(p => p.startsWith(path + '.'));
        expect(declared).toBeTruthy();
    });
});

// Budget figures belong to the budget style — they are not a standalone setting.
//
// OnboardingPage.vue's selectStyle() clears min/max/currency for any style other
// than 'budget', and the inputs only render while 'budget' is chosen (Arsen
// 2026-08-25: "when user selects luxury and if he had budget in before, app
// drops budget min max numbers"). Chat wrote travelStyle alone, so a traveler
// who switched to luxury kept their old band — and that band GATES RETRIEVAL,
// so they went on being filtered to budget places by a number the Preferences
// screen no longer showed them.
describe('switching travel style keeps budget in step with the screen', () => {
    const { applyProposal } = require('../engine/preferences/proposal');
    const User = (calls) => ({ updateOne: async (q, u) => { calls.push({ q, u }); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } });

    test('luxury clears the figures, exactly as selectStyle does', async () => {
        const calls = [];
        expect(await applyProposal('u1', { field: 'travelStyle', value: 'luxury' }, { User: User(calls) })).toBe(true);
        expect(calls[0].u.$set).toEqual({
            'preferences.travelStyle': 'luxury',
            'preferences.budget': { min: 0, max: 0, currency: 'USD' },
        });
    });

    test('budget style leaves the figures alone — they are about to be asked for', async () => {
        const calls = [];
        expect(await applyProposal('u1', { field: 'travelStyle', value: 'budget' }, { User: User(calls) })).toBe(true);
        expect(calls[0].u.$set).toEqual({ 'preferences.travelStyle': 'budget' });
    });

    test('setting a budget on its own never touches the style', async () => {
        const calls = [];
        await applyProposal('u1', { field: 'budget', value: { min: 10, max: 200, currency: 'USD' } }, { User: User(calls) });
        expect(Object.keys(calls[0].u.$set)).toEqual(['preferences.budget']);
    });
});

// Onboarding will not let the traveler finish on budget style without figures
// (isBudgetValid: min > 0, max > 0, min <= max). Chat cannot block a turn the
// way a form blocks a save, so it asks instead — and must never invent them.
describe('budget style without figures is asked about, never filled in', () => {
    const { buildSettingsMessages } = require('../engine/narrator/prompts/grounded');

    test('the ask happens, and no numbers are supplied', () => {
        const m = buildSettingsMessages({
            message: 'change style to budget', langName: 'English',
            done: ['travel style to budget'], needsBudget: true,
        });
        const s = m.map(x => x.content).join('\n');
        expect(s).toMatch(/budget/i);
        expect(s).not.toMatch(/\$\s?\d/);
    });
});

// The Discovery/Nearby toggle, reachable by Jinni at last.
//
// It sits in the chat input container beside the preference chips, but it was
// the only control there that lived in localStorage instead of the database —
// so Jinni could change every setting around it and not that one, and it did
// not survive a change of device. Arsen 2026-08-25: "user will see how it
// sets" — the visible button flipping is the confirmation.
describe('switching search mode', () => {
    const { validateProposal, applyProposal, PREF_VOCAB } = require('../engine/preferences/proposal');
    const User = (calls) => ({ updateOne: async (q, u) => { calls.push({ q, u }); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } });

    test('the vocabulary is the two words on the toggle', () => {
        expect(PREF_VOCAB.searchMode).toEqual(['nearby', 'discovery']);
    });

    test('the WORD survives validation — a boolean would not round-trip', () => {
        // applyProposal re-validates whatever comes back out of the database, so
        // a proposal has to validate twice. 'true' is not in any vocabulary.
        const p = validateProposal({ field: 'searchMode', value: 'Nearby' });
        expect(p).toEqual({ field: 'searchMode', value: 'nearby', label: 'search mode to nearby' });
        expect(validateProposal(p)).toEqual(p);
    });

    test('anything that is not one of the two words is dropped', () => {
        for (const v of ['near', 'explore', true, 1, '', null]) {
            expect(validateProposal({ field: 'searchMode', value: v })).toBeNull();
        }
    });

    test('the word becomes the boolean exactly once, at the write', async () => {
        const near = []; const disc = [];
        await applyProposal('u1', { field: 'searchMode', value: 'nearby' }, { User: User(near) });
        await applyProposal('u1', { field: 'searchMode', value: 'discovery' }, { User: User(disc) });
        expect(near[0].u.$set).toEqual({ 'settings.nearbyMode': true });
        expect(disc[0].u.$set).toEqual({ 'settings.nearbyMode': false });
    });

    test('the path it writes exists in the schema', () => {
        expect(require('../models/User').schema.path('settings.nearbyMode')).toBeTruthy();
    });
});

// "from 10 to 10" is not a range, and storing it looked like agreement while
// quietly gating retrieval to a single price point (Arsen 2026-08-25: "it will
// set like that instead of notifing you are giving incorrect, minimum should be
// little than maximum").
describe('a flat budget range is refused, with a reason', () => {
    const { validateProposal, budgetRefusalReason } = require('../engine/preferences/proposal');
    const b = (min, max, currency = 'USD') => ({ field: 'budget', value: { min, max, currency } });

    test('min === max is refused', () => {
        expect(validateProposal(b(10, 10))).toBeNull();
        expect(validateProposal(b(200, 200))).toBeNull();
    });

    test('a genuine range still passes', () => {
        expect(validateProposal(b(10, 11)).value).toEqual({ min: 10, max: 11, currency: 'USD' });
        expect(validateProposal(b(10, 200)).value).toEqual({ min: 10, max: 200, currency: 'USD' });
    });

    test('the reason names what to change, rather than just refusing', () => {
        expect(budgetRefusalReason({ min: 10, max: 10, currency: 'USD' }))
            .toMatch(/minimum has to be LOWER than the maximum/);
        expect(budgetRefusalReason({ min: 200, max: 50, currency: 'USD' }))
            .toMatch(/minimum was higher than the maximum/);
        expect(budgetRefusalReason({ min: 10, max: 200, currency: 'AMD' }))
            .toMatch(/currency must be one of/);
        expect(budgetRefusalReason({ min: 'a', max: 'b' }))
            .toMatch(/both a minimum and a maximum/);
    });

    test('a valid budget has no reason to give', () => {
        expect(budgetRefusalReason({ min: 10, max: 200, currency: 'USD' })).toBeNull();
    });
});
