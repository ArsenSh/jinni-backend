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

// What Jinni offers must be what the Preferences grid offers.
//
// Asked "what interest I can select" it answered "family, adventure, food,
// culture, nature, shopping, or relaxation" (live 2026-08-25) — it invented
// shopping, dropped romantic/history/art/nightlife, and renamed two. It was
// improvising, because the prompt named the SETTINGS but never their VALUES.
describe('the interests Jinni offers', () => {
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
    const { PREF_VOCAB } = require('../engine/preferences/proposal');
    // frontend/src/locales/en.json → onboarding.interests. Hardcoded rather than
    // read from disk: the backend deploys on its own and that file is not in the
    // container. If the grid ever gains an interest, this fails until the
    // validator vocabulary gains it too — which is the point.
    const UI_KEYS = ['family', 'romantic', 'nature', 'adventure', 'cultural',
        'history', 'art', 'food_drink', 'nightlife', 'relaxation'];

    test('the validator vocabulary IS the onboarding grid', () => {
        expect(PREF_VOCAB.interests).toEqual(UI_KEYS);
    });

    test('all ten reach the prompt, and the invented one does not', () => {
        const s = buildChitchatMessages({ message: 'what interests can I select?', langName: 'English' })[0].content;
        for (const key of UI_KEYS) expect(s).toContain(key.replace(/_/g, ' & '));
        expect(s).toMatch(/there is no "shopping" interest/i);
    });
});

// 5 km and 50 km ship with every account, so they appeared in every "what are
// my preferences?" answer as though they had been chosen (Arsen 2026-08-25:
// "it is by default when user joins jinni … not tell all time").
describe('default search radii are background, not news', () => {
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
    const sys = (searchRadius) => buildChitchatMessages({
        message: 'what are my preferences?', langName: 'English',
        preferences: { travelStyle: 'luxury', _searchRadius: searchRadius },
    })[0].content;

    test('untouched defaults are labelled as defaults and not to be volunteered', () => {
        const s = sys({ nearby: 5, discovery: 50 });
        expect(s).toMatch(/nearby radius: 5 km.*never volunteer it/s);
        expect(s).toMatch(/discovery radius: 50 km.*never volunteer it/s);
    });

    test('a radius the traveler actually changed is NOT marked default', () => {
        const s = sys({ nearby: 12, discovery: 80 });
        expect(s).toContain('nearby radius: 12 km');
        expect(s).toContain('discovery radius: 80 km');
        expect(s).not.toMatch(/never volunteer it/);
    });
});

// Ask first, switch second (Arsen 2026-08-25: "ai should ask minimum and
// maximum budget initially, then swithc to budget"). Onboarding refuses to
// finish on budget style without figures, so announcing the switch before
// having them puts the traveler in a state the form forbids.
describe('a budget-style switch that is still waiting on figures', () => {
    const { buildSettingsMessages } = require('../engine/narrator/prompts/grounded');

    test('it is reported as NOT done yet, and the figures are asked for', () => {
        const s = buildSettingsMessages({
            message: 'change style to budget', langName: 'English',
            done: [], awaiting: ['travel style to budget'], needsBudget: true,
        }).map(x => x.content).join('\n');
        expect(s).toMatch(/NOT changed YET/);
        expect(s).toMatch(/Do NOT say this one is done or saved/);
        expect(s).toMatch(/minimum and maximum budget/i);
        expect(s).not.toMatch(/CHANGED, and already saved/);
    });

    test('once the figures land, both are reported as done together', () => {
        const s = buildSettingsMessages({
            message: '10 and 200 usd', langName: 'English',
            done: ['travel style to budget', 'budget to 10–200 USD'], needsBudget: false,
        }).map(x => x.content).join('\n');
        expect(s).toMatch(/CHANGED, and already saved: travel style to budget; budget to 10–200 USD/);
        expect(s).not.toMatch(/NOT changed YET/);
    });
});

// The mode arrives in the request body on every single turn, so knowing it
// costs nothing — yet it reached radius, ranking weights and retrieval without
// ever reaching a prompt. Jinni behaved differently per mode and could not say
// which one it was in; asked outright, it guessed.
describe('Jinni knows which search mode it is in', () => {
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
    const sys = (mode) => buildChitchatMessages({
        message: 'am I in nearby mode?', langName: 'English',
        preferences: { travelStyle: 'luxury', _searchMode: mode },
    })[0].content;

    test('nearby is described as tight around where they physically are', () => {
        expect(sys('nearby')).toMatch(/search mode: NEARBY/);
        expect(sys('nearby')).not.toMatch(/search mode: DISCOVERY/);
    });

    test('discovery says plainly it is not necessarily where they are standing', () => {
        const s = sys('discovery');
        expect(s).toMatch(/search mode: DISCOVERY/);
        expect(s).toMatch(/not necessarily where they are standing/);
    });

    test('no mode supplied means no row invented', () => {
        expect(sys(null)).not.toMatch(/search mode:/);
    });

    test('the capability list counts the mode among what it can change', () => {
        const s = sys('nearby');
        expect(s).toMatch(/exactly these six/);
        expect(s).toMatch(/search MODE \(nearby or discovery\)/);
    });
});
