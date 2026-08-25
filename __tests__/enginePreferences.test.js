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

// Arsen 2026-08-24: "can you set to current location, gps one?" → "I can't set
// that for you", which was false. Then: "it should simply set and save, same
// things user can do from onboarding page."
describe('setting the destination to where you are', () => {
    const { validateProposal, isExplicit, applyProposal } = require('../engine/preferences/proposal');
    const HERE = { city: 'Yerevan', country: 'Armenia', countryCode: 'AM', lat: 40.18, lng: 44.51 };

    test('code fills in every field from the reported position', () => {
        const p = validateProposal({ field: 'location', value: 'current' }, { currentPlace: HERE });
        expect(p.value).toMatchObject({
            country: 'AM', countryName: 'Armenia', city: 'Yerevan',
            coordinates: { lat: 40.18, lng: 44.51 },
        });
        // settings.location carries a timestamp; preferences.destination does
        // not, and applyProposal strips it for that path.
        expect(p.value.lastUpdated).toBeInstanceOf(Date);
        expect(p.label).toBe('location to Yerevan, Armenia');
    });

    test('a city NAME is refused — a guessed coordinate is not saveable', () => {
        expect(validateProposal({ field: 'location', value: 'Paris' }, { currentPlace: HERE })).toBeNull();
        expect(validateProposal({ field: 'location', value: { lat: 1, lng: 2 } }, { currentPlace: HERE })).toBeNull();
    });

    test('no position means no write, rather than 0,0', () => {
        expect(validateProposal({ field: 'location', value: 'current' }, {})).toBeNull();
        expect(validateProposal({ field: 'location', value: 'current' },
            { currentPlace: { city: 'X', lat: 0, lng: 0 } })).toBeNull();
    });

    test('an ISO country code is only stored when the region gave one', () => {
        // resolveRegion returns {city, country} with no code, so this field stays
        // empty rather than being guessed from the country name.
        const p = validateProposal({ field: 'location', value: 'current' },
            { currentPlace: { city: 'Dubai', country: 'United Arab Emirates', lat: 25.2, lng: 55.27 } });
        expect(p.value.country).toBe('');
        expect(p.value.countryName).toBe('United Arab Emirates');
    });

    test('only a real boolean true skips the confirmation', () => {
        expect(isExplicit({ explicit: true })).toBe(true);
        expect(isExplicit({ explicit: 'maybe' })).toBe(false);
        expect(isExplicit({})).toBe(false);
        expect(isExplicit(null)).toBe(false);
    });

    // Arsen 2026-08-24: "onboarding page works with user modal … then ai should
    // do the same." OnboardingPage.vue PATCHes /api/auth/onboarding with BOTH
    // preferences.destination and settings.location, plus the GPS flag. Writing
    // only one leaves chat and the Preferences screen disagreeing, which is what
    // made the change look imaginary.
    test('a location change writes exactly what onboarding writes', async () => {
        const sets = [];
        const User = { updateOne: async (q, u) => { sets.push(u); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } };
        const p = validateProposal({ field: 'location', value: 'current' }, { currentPlace: HERE });
        expect(await applyProposal('u1', p, { User })).toBe(true);
        // 2026-08-25: this list was SHORT of the payload the test is named
        // after. OnboardingPage.vue also sends preferences.useGPS and
        // settings.privacy.locationPermissionGranted, and useGPS is the field
        // the Preferences screen's GPS toggle actually reads — so the toggle
        // kept showing the old choice after Jinni moved the location. The
        // assertion encoded the gap instead of catching it.
        expect(Object.keys(sets[0].$set).sort()).toEqual([
            'preferences.destination', 'preferences.useGPS', 'settings.location',
            'settings.privacy.autoDetectLocation', 'settings.privacy.locationPermissionGranted',
        ]);
        expect(sets[0].$set['settings.location'].city).toBe('Yerevan');
        expect(sets[0].$set['preferences.destination'].city).toBe('Yerevan');
        // The schema has no lastUpdated under preferences.destination.
        expect(sets[0].$set['preferences.destination'].lastUpdated).toBeUndefined();
        expect(sets[0].$set['settings.location'].lastUpdated).toBeInstanceOf(Date);
    });

    test('choosing a named city switches GPS autodetect off, as onboarding does', async () => {
        const sets = [];
        const User = { updateOne: async (q, u) => { sets.push(u); return { matchedCount: 1 }; } };
        const named = { city: 'Dubai', country: 'United Arab Emirates', lat: 25.205, lng: 55.271 };
        await applyProposal('u1', validateProposal({ field: 'location', value: 'named' }, { namedPlace: named }), { User });
        expect(sets[0].$set['settings.privacy.autoDetectLocation']).toBe(false);
        await applyProposal('u1', validateProposal({ field: 'location', value: 'current' }, { currentPlace: HERE }), { User });
        expect(sets[1].$set['settings.privacy.autoDetectLocation']).toBe(true);
    });
});

// Arsen 2026-08-24: "the jinni can have access to discovery and nearby modes
// also their radiuses, in clever situations can ask or get command to change,
// also can set budget in preferences with budget style, if user he wants budget
// places then should give budget also min and max" — plus, crucially, "user may
// manually toggle off gps location".
describe('search radii and what Jinni admits to seeing', () => {
    const { validateProposal, applyProposal, PREF_PATHS } = require('../engine/preferences/proposal');
    const { selfBlock } = require('../engine/narrator/prompts/grounded');

    test('a radius is accepted only inside the slider\'s own range', () => {
        expect(validateProposal({ field: 'nearbyRadius', value: 8 }).value).toBe(8);
        expect(validateProposal({ field: 'discoveryRadius', value: 75 }).value).toBe(75);
        expect(validateProposal({ field: 'nearbyRadius', value: 40 })).toBeNull();       // max 20
        expect(validateProposal({ field: 'discoveryRadius', value: 5 })).toBeNull();     // min 10
        expect(validateProposal({ field: 'nearbyRadius', value: 'wide' })).toBeNull();
    });

    test('out of range is dropped, never quietly clamped', () => {
        // Storing 20 after someone asked for 200 would make Jinni's "done" a lie.
        expect(validateProposal({ field: 'nearbyRadius', value: 200 })).toBeNull();
    });

    test('radii write under settings, not preferences', async () => {
        const sets = [];
        const User = { updateOne: async (q, u) => { sets.push(Object.keys(u.$set)[0]); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } };
        await applyProposal('u1', { field: 'nearbyRadius', value: 6 }, { User });
        await applyProposal('u1', { field: 'travelStyle', value: 'budget' }, { User });
        expect(sets).toEqual(['settings.searchRadius.nearby', 'preferences.travelStyle']);
        expect(PREF_PATHS.discoveryRadius).toBe('settings.searchRadius.discovery');
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
// prose and the database disagreed, which is worse than refusing outright.
describe('a named destination is saved as the city that was named', () => {
    const { validateProposal } = require('../engine/preferences/proposal');
    const GPS = { city: 'Yerevan', country: 'Armenia', lat: 40.18, lng: 44.51 };
    const NAMED = { city: 'Dubai', country: 'United Arab Emirates', lat: 25.205, lng: 55.271 };

    test('"named" saves the named city, not where they are standing', () => {
        const p = validateProposal({ field: 'location', value: 'named' },
            { currentPlace: GPS, namedPlace: NAMED });
        expect(p.value.city).toBe('Dubai');
        expect(p.value.coordinates).toEqual({ lat: 25.205, lng: 55.271 });
        expect(p.label).toBe('location to Dubai, United Arab Emirates');
    });

    test('"current" still saves where they are', () => {
        const p = validateProposal({ field: 'location', value: 'current' },
            { currentPlace: GPS, namedPlace: NAMED });
        expect(p.value.city).toBe('Yerevan');
    });

    test('"named" with no city named writes NOTHING — it does not fall back to GPS', () => {
        // Falling back is how Yerevan got saved when Dubai was asked for.
        expect(validateProposal({ field: 'location', value: 'named' }, { currentPlace: GPS })).toBeNull();
    });

    test('a place name or coordinates from the model are still refused', () => {
        expect(validateProposal({ field: 'location', value: 'Dubai' },
            { currentPlace: GPS, namedPlace: NAMED })).toBeNull();
        expect(validateProposal({ field: 'location', value: { lat: 25, lng: 55 } },
            { currentPlace: GPS, namedPlace: NAMED })).toBeNull();
    });
});

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

// ── The onboarding contract, field for field (added 2026-08-25) ──────────────
//
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
// preferences.destination while the screen showed settings.location.
describe('a location change writes what onboarding writes', () => {
    const { validateProposal, applyProposal } = require('../engine/preferences/proposal');
    const HERE = { city: 'Yerevan', country: 'Armenia', countryCode: 'AM', lat: 40.18, lng: 44.51 };
    const THERE = { city: 'Dubai', country: 'United Arab Emirates', countryCode: 'AE', lat: 25.07, lng: 55.14 };
    const User = (calls) => ({ updateOne: async (q, u) => { calls.push({ q, u }); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; } });

    test('"use where I am now" sets BOTH gps flags, and grants the permission', async () => {
        const calls = [];
        const p = validateProposal({ field: 'location', value: 'current' }, { currentPlace: HERE });
        expect(await applyProposal('u1', p, { User: User(calls) })).toBe(true);
        const $set = calls[0].u.$set;
        expect($set['preferences.useGPS']).toBe(true);
        expect($set['settings.privacy.autoDetectLocation']).toBe(true);
        // Onboarding: `useGPS ? true : existingPermission`.
        expect($set['settings.privacy.locationPermissionGranted']).toBe(true);
        expect($set['preferences.destination']).toMatchObject({ city: 'Yerevan', countryName: 'Armenia' });
        expect($set['settings.location'].coordinates).toEqual({ lat: 40.18, lng: 44.51 });
    });

    test('a NAMED city unticks gps in both places — and never revokes the permission', async () => {
        const calls = [];
        const p = validateProposal({ field: 'location', value: 'named' }, { namedPlace: THERE });
        expect(await applyProposal('u1', p, { User: User(calls) })).toBe(true);
        const $set = calls[0].u.$set;
        expect($set['preferences.useGPS']).toBe(false);
        expect($set['settings.privacy.autoDetectLocation']).toBe(false);
        // Onboarding PRESERVES the existing permission when GPS is off, so
        // writing false here would withdraw something nobody withdrew.
        expect($set).not.toHaveProperty('settings.privacy.locationPermissionGranted');
    });

    test('an unknown source leaves every gps flag alone rather than guessing', async () => {
        const calls = [];
        // A proposal parked in the database before `source` existed: the place
        // still applies, but nothing may be inferred about the GPS choice.
        const parked = {
            field: 'location',
            value: { country: 'AE', countryName: 'United Arab Emirates', city: 'Dubai',
                coordinates: { lat: 25.07, lng: 55.14 }, lastUpdated: new Date() },
        };
        expect(await applyProposal('u1', parked, { User: User(calls) })).toBe(true);
        const $set = calls[0].u.$set;
        expect($set).not.toHaveProperty('preferences.useGPS');
        expect($set).not.toHaveProperty('settings.privacy.autoDetectLocation');
        expect($set).not.toHaveProperty('settings.privacy.locationPermissionGranted');
        expect($set['preferences.destination']).toMatchObject({ city: 'Dubai' });
    });
});

// A path that is not in the schema is not a place to store anything.
//
// The applyProposal tests above stub User.updateOne, so they assert the $set we
// BUILD — not what Mongoose agrees to write. preferences.useGPS was added to
// that $set on 2026-08-25 and silently discarded in production, because it was
// missing from the schema and strict mode drops unknown paths without a word.
// The stub can never see that; this reads the schema itself.
describe('every path applyProposal writes actually exists in the User schema', () => {
    const User = require('../models/User');
    const { PREF_PATHS, RADIUS_LIMITS } = require('../engine/preferences/proposal');

    const PATHS = [
        ...Object.values(PREF_PATHS),
        ...Object.values(RADIUS_LIMITS).map(r => r.path),
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
