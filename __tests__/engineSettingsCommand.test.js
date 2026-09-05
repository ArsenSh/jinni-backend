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
        expect(m[0].content).toContain('CHANGED, and already saved: travel style to budget.');
        expect(m[0].content).toMatch(/past tense/);
        expect(m[0].content).toMatch(/do not claim anything was changed that is not on the CHANGED line/i);
    });

    test('a refusal is reported as a refusal, not glossed over', () => {
        const m = buildSettingsMessages({
            message: 'set location to Atlantis', langName: 'English',
            done: [], failed: ['location'],
        });
        expect(m[0].content).toContain('NOT changed — you could not do this: location.');
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
        expect(m[0].content).toMatch(/Never invent their figures/);
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

// Live 2026-08-26. A turn that changed ONLY the budget replied "Your travel
// style is now budget" while the saved style was still luxury. Nothing in the
// engine had gone wrong: the prompt carried a worked example — «second person,
// e.g. "your travel style is now budget"» — and the model copied the sample
// instead of the line it was handed. A report must have no pre-written sentence
// lying beside it to reach for.
describe('the settings prompt offers no sentence to copy', () => {
    const { buildSettingsMessages } = require('../engine/narrator/prompts/grounded');

    test('a budget-only change never puts the words "travel style" in the prompt', () => {
        const sys = buildSettingsMessages({
            message: 'set 10 - 100', langName: 'English',
            done: ['budget to 10–100 USD'], failed: [],
        })[0].content;
        expect(sys).toContain('budget to 10–100 USD');
        expect(sys).not.toMatch(/travel style/i);
    });

    test('no settable VALUE appears unless this turn actually changed it', () => {
        const { PREF_VOCAB } = require('../engine/preferences/proposal');
        const sys = buildSettingsMessages({
            message: 'make my interests family', langName: 'English',
            done: ['interests to family'], failed: [],
        })[0].content;
        // 'luxury', 'nearby', 'discovery' — none of them were touched, so none
        // of them may be sitting in the prompt for the model to pick up.
        for (const v of [...PREF_VOCAB.travelStyle, ...PREF_VOCAB.searchMode]) {
            expect(sys.toLowerCase()).not.toContain(v);
        }
    });
});

describe('intent reports the command', () => {
    const intentService = require('../services/intentService');

    test('the prompt names every settable field and its allowed values', () => {
        const src = require('fs').readFileSync(require.resolve('../services/intentService.js'), 'utf8');
        // 'location' is deliberately absent since 2026-08-26 — see the
        // "saved location is not Jinni's to change" suite below.
        // The radii stay in the INTENT prompt on purpose: the model should keep
        // reporting a radius ask so code can refuse it with the line that tells
        // the traveler where to do it himself. Reporting is not writing.
        for (const f of ['travelStyle', 'interests', 'budget', 'searchMode', 'nearbyRadius', 'discoveryRadius']) {
            expect(src).toContain(f);
        }
        // A one-off want must not be read as a lasting change.
        expect(src).toMatch(/Wanting something once is NOT a setting change/);
        // A city in the message is somewhere to look, never a setting to write.
        expect(src).toMatch(/There is NO location field/);
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
        expect(p).toContain('could you change my style to budget?');
        expect(p).toContain('can you make my interests family?');
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
        for (const field of ['travel style', 'interests', 'budget', 'search MODE', 'search radius']) {
            expect(s).toContain(field);
        }
        expect(s).toMatch(/Language, theme, password and account you also cannot change/i);
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
        // Assert the DERIVATION, not the wording. The old test pinned the
        // literal phrase "exactly these five" and went on passing after the
        // settable set changed twice — which is how the prompt came to promise
        // fields the validator refuses. Now the sentence is generated, so the
        // test checks it against the same registry the validator uses.
        const { settableSentence } = require('../engine/preferences/proposal');
        expect(s).toContain(settableSentence());
        expect(s).toMatch(/search MODE \(nearby or discovery\)/);
    });
});

// Naming an amount is a budget change and nothing else (Arsen 2026-08-25: "if
// i say consider this x amount of money that will not set style automatically
// to budget … it will set the amount but the style will remain luxury").
//
// The rule tells the classifier that several changes at once are fine, so an
// amount was one plausible inference away from dragging travelStyle along with
// it — and a luxury traveler stating a number would have been demoted by their
// own sentence.
describe('an amount does not imply a style', () => {
    const { buildUserPrompt } = require('../services/intentService');

    test('the rule says so, with the examples that would have triggered it', () => {
        const p = buildUserPrompt('consider 500 usd', []);
        expect(p).toMatch(/NAMING AN AMOUNT IS A BUDGET CHANGE AND NOTHING ELSE/);
        expect(p).toContain('consider 500 usd');
        expect(p).toMatch(/a luxury traveler stating a number stays luxury/);
        expect(p).toMatch(/Only add a\s+travelStyle entry when they actually say the STYLE should change/);
    });
});

// Location came OUT of the settable set (Arsen 2026-08-26: "it can say open
// preferences and change … but not do by himself"). One edit there moves the
// search centre, the GPS/destination mode and every surface reading them; the
// Preferences screen already does it properly. Searching a named city is
// untouched — that was never a setting change.
describe('the saved location is not Jinni\'s to change', () => {
    const { validateProposal, PREF_VOCAB, PREF_PATHS } = require('../engine/preferences/proposal');
    const { buildUserPrompt } = require('../services/intentService');
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');

    test('no vocabulary, no path, no proposal survives', () => {
        expect(PREF_VOCAB.location).toBeUndefined();
        expect(PREF_PATHS.location).toBeUndefined();
        for (const v of ['current', 'named', 'Dubai']) {
            expect(validateProposal({ field: 'location', value: v })).toBeNull();
            expect(validateProposal({ field: 'destination', value: v })).toBeNull();
        }
    });

    test('the classifier is not offered the field at all', () => {
        const p = buildUserPrompt('set my location to Dubai', []);
        expect(p).not.toMatch(/"field":"<location\|/);
        expect(p).toMatch(/There is NO location field/);
        expect(p).toMatch(/a city named in the message is a place to SEARCH/);
    });

    test('asked to change it, Jinni points at Preferences instead', () => {
        const s = buildChitchatMessages({ message: 'set my location to Dubai', langName: 'English' })[0].content;
        const { readOnlySentence } = require('../engine/preferences/proposal');
        expect(s).toContain(readOnlySentence());
        expect(s).toMatch(/do it themselves on that screen/);
        expect(s).toMatch(/saved location/i);
        // and it must not read as "I can't help with Dubai at all"
        expect(s).toMatch(/hotels in Dubai" needs no setting changed/);
    });

    // Arsen 2026-08-26: "we can let only discovery and nearby context to toggle,
    // for radius it can say user to do from settings manually."
    test('the MODE is settable; the radii are not', () => {
        expect(PREF_PATHS.searchMode).toBe('settings.nearbyMode');
        expect(validateProposal({ field: 'searchMode', value: 'nearby' }).value).toBe('nearby');
        expect(validateProposal({ field: 'nearbyRadius', value: 10 })).toBeNull();
        expect(validateProposal({ field: 'discoveryRadius', value: 40 })).toBeNull();
    });

    // The registry is the ONLY list. A field it does not own cannot be written,
    // and cannot be advertised to the model either — the prompt sentence below
    // is generated from the same object.
    test('what the prompt promises is exactly what the validator accepts', () => {
        const { SETTINGS, settableSentence, readOnlySentence } = require('../engine/preferences/proposal');
        expect(Object.keys(SETTINGS).sort()).toEqual(['budget', 'interests', 'searchMode', 'travelStyle']);
        for (const f of Object.keys(SETTINGS)) expect(settableSentence()).toContain(f === 'searchMode' ? 'search MODE' : (f === 'travelStyle' ? 'travel style' : f));
        for (const f of ['radius', 'location']) expect(readOnlySentence()).toContain(f);
        expect(settableSentence()).not.toMatch(/radius|location/i);
    });
});


// Chit-chat can never claim a settings change (live 2026-08-29: "now set to
// AMD" was abstained by intent, landed in chit-chat, and the reply said the
// currency was set while nothing was written).
describe('chit-chat never claims settings changes', () => {
    const { buildChitchatMessages } = require('../engine/narrator/prompts/grounded');
    test('the system prompt forbids claiming a setting was set/changed/saved', () => {
        const m = buildChitchatMessages({ message: 'now set to AMD', langName: 'English' });
        expect(m[0].content).toMatch(/NEVER say one was set/);
        expect(m[0].content).toMatch(/could not apply it/);
    });
});

describe('itinerary details ride the intent (founder 2026-09-05: hotel/breakfast prefill)', () => {
    const { validateIntent } = require('../services/intentService');
    const base = { is_travel: true, action_type: 'itinerary', language: 'en' };

    test('stated days + hotel + breakfast survive validation in shape', () => {
        const r = validateIntent({ ...base, itinerary_details: { days: 3, hotel: 'Grand Hotel Yerevan', breakfast: true } }, 'my hotel is Grand Hotel Yerevan with breakfast, plan 3 days');
        expect(r.itineraryDetails).toEqual({ days: 3, hotel: 'Grand Hotel Yerevan', breakfast: true, timeBound: false });
    });

    test('absent facts stay null — never invented', () => {
        const r = validateIntent({ ...base, itinerary_details: { days: 0, hotel: '', breakfast: null } }, 'plan me an itinerary');
        expect(r.itineraryDetails).toBe(null);
    });

    test('a non-itinerary turn never carries details (hallucination fence)', () => {
        const r = validateIntent({ ...base, action_type: 'restaurants', itinerary_details: { days: 3, hotel: 'X Hotel', breakfast: true } }, 'show me restaurants');
        expect(r.itineraryDetails).toBe(null);
    });

    test('junk shapes are dropped, not repaired', () => {
        const r = validateIntent({ ...base, itinerary_details: { days: 99, hotel: 'A', breakfast: 'yes' } }, 'plan 99 days');
        expect(r.itineraryDetails).toBe(null); // 99>30, 1-char hotel, string breakfast — all rejected
    });
});

describe('count=1 and time_bound survive intent validation (ChatGPT battery 2026-09-05)', () => {
    const { validateIntent } = require('../services/intentService');
    test('"only one" is expressible', () => {
        const r = validateIntent({ is_travel: true, action_type: 'restaurants', count: 1 }, 'say me only one restaurant');
        expect(r.count).toBe(1);
    });
    test('time-bound itinerary ask carries the feasibility flag', () => {
        const r = validateIntent({ is_travel: true, action_type: 'itinerary', itinerary_details: { days: 0, hotel: '', breakfast: null, time_bound: true } }, 'visit Tatev and return by 20:00');
        expect(r.itineraryDetails.timeBound).toBe(true);
    });
});

describe('anchor_reference: the LLM decides what is a reference, never a phrase list (founder 2026-09-05)', () => {
    const { validateIntent } = require('../services/intentService');
    test('the flag survives validation as a strict boolean', () => {
        expect(validateIntent({ is_travel: true, action_type: 'restaurants', anchor_reference: true }, 'close to the glamping I saved?').anchorReference).toBe(true);
        expect(validateIntent({ is_travel: true, action_type: 'restaurants', anchor_reference: 'yes' }, 'x').anchorReference).toBe(false);
        expect(validateIntent({ is_travel: true, action_type: 'restaurants' }, 'near Khor Virap').anchorReference).toBe(false);
    });
    test('the route guards on the flag; the phrase list is gone', () => {
        const src = require('fs').readFileSync(require.resolve('../routes/aiChatV2.js'), 'utf8');
        expect(src).toMatch(/_refPhrase = intent\.anchorReference === true/);
        expect(src).not.toMatch(/isReferencePhrase/);
        const tsrc = require('fs').readFileSync(require.resolve('../engine/retrieval/tuning.js'), 'utf8');
        expect(tsrc).not.toMatch(/isReferencePhrase/);
    });
});

describe('Class-3 migration: correction / browse / stated_at are LLM judgements (founder 2026-09-06)', () => {
    const { validateIntent } = require('../services/intentService');
    const base = { is_travel: true, action_type: 'general' };

    test('strict booleans — junk shapes collapse to false', () => {
        expect(validateIntent({ ...base, correction: true }, 'no, it is on Monte Melkonyan').correction).toBe(true);
        expect(validateIntent({ ...base, correction: 'yes' }, 'x').correction).toBe(false);
        expect(validateIntent({ ...base, browse: true }, 'show me bars').browse).toBe(true);
        expect(validateIntent({ ...base, browse: 1 }, 'x').browse).toBe(false);
    });

    test('stated_at is a bounded name, and yields to anchor_reference', () => {
        expect(validateIntent({ ...base, stated_at: 'Khor Virap' }, 'I am at Khor Virap').statedAt).toBe('Khor Virap');
        expect(validateIntent({ ...base, stated_at: 'X' }, 'x').statedAt).toBe(null);
        expect(validateIntent({ ...base, stated_at: 'a'.repeat(90) }, 'x').statedAt).toBe(null);
        // A conversational reference is NOT a stated name — the flags are exclusive.
        expect(validateIntent({ ...base, anchor_reference: true, stated_at: 'my hotel' }, 'near the hotel I saved').statedAt).toBe(null);
    });

    test('the route uses the LLM first, the regexes only as backstops', () => {
        const src = require('fs').readFileSync(require.resolve('../routes/aiChatV2.js'), 'utf8');
        expect(src).toMatch(/intent\.statedAt \|\| parseAtLocation\(message\)/);
        expect(src).toMatch(/intent\.correction === true \|\| isCorrectionLead\(message\)/);
        expect(src).toMatch(/intent\.browse === true \|\| isBrowseAsk\(message\)/);
    });
});

describe('retry-after-self-change is not a settings command (live 2026-09-06: "radius is now greater, try again" got a refusal, no cards)', () => {
    const { validateIntent } = require('../services/intentService');
    test('out_of_town survives as a strict boolean', () => {
        expect(validateIntent({ is_travel: true, action_type: 'general', out_of_town: true }, 'somewhere outside the city').outOfTown).toBe(true);
        expect(validateIntent({ is_travel: true, action_type: 'general' }, 'bars nearby').outOfTown).toBe(false);
    });
    test('the settings arm yields to refill/browse when it only has refusals', () => {
        const src = require('fs').readFileSync(require.resolve('../routes/aiChatV2.js'), 'utf8');
        expect(src).toMatch(/settingsRefused\.length && !\(intent\.refill === true \|\| intent\.browse === true\)/);
    });
    test('the intent prompt marks self-reports as refills, not commands', () => {
        const src = require('fs').readFileSync(require.resolve('../services/intentService.js'), 'utf8');
        expect(src).toMatch(/REPORTING the user already changed a setting THEMSELVES/);
    });
});
