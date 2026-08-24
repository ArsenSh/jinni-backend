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

// Arsen 2026-08-24: "can you set to current location, gps one?" → "I can't set
// that for you", which was false. Then: "it should simply set and save, same
// things user can do from onboarding page."
describe('setting the destination to where you are', () => {
    const { validateProposal, isExplicit, applyProposal } = require('../engine/preferences/proposal');
    const HERE = { city: 'Yerevan', country: 'Armenia', countryCode: 'AM', lat: 40.18, lng: 44.51 };

    test('code fills in every field from the reported position', () => {
        const p = validateProposal({ field: 'destination', value: 'current' }, { currentPlace: HERE });
        expect(p.value).toEqual({
            country: 'AM', countryName: 'Armenia', city: 'Yerevan',
            coordinates: { lat: 40.18, lng: 44.51 },
        });
        expect(p.label).toBe('destination to Yerevan, Armenia');
    });

    test('a city NAME is refused — a guessed coordinate is not saveable', () => {
        expect(validateProposal({ field: 'destination', value: 'Paris' }, { currentPlace: HERE })).toBeNull();
        expect(validateProposal({ field: 'destination', value: { lat: 1, lng: 2 } }, { currentPlace: HERE })).toBeNull();
    });

    test('no position means no write, rather than 0,0', () => {
        expect(validateProposal({ field: 'destination', value: 'current' }, {})).toBeNull();
        expect(validateProposal({ field: 'destination', value: 'current' },
            { currentPlace: { city: 'X', lat: 0, lng: 0 } })).toBeNull();
    });

    test('an ISO country code is only stored when the region gave one', () => {
        // resolveRegion returns {city, country} with no code, so this field stays
        // empty rather than being guessed from the country name.
        const p = validateProposal({ field: 'destination', value: 'current' },
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

    test('an asked-for change writes exactly one path', async () => {
        const sets = [];
        const User = { updateOne: async (q, u) => { sets.push(u); return { acknowledged: true }; } };
        const p = validateProposal({ field: 'destination', value: 'current' }, { currentPlace: HERE });
        expect(await applyProposal('u1', p, { User })).toBe(true);
        expect(Object.keys(sets[0].$set)).toEqual(['preferences.destination']);
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
        const User = { updateOne: async (q, u) => { sets.push(Object.keys(u.$set)[0]); return { acknowledged: true }; } };
        await applyProposal('u1', { field: 'nearbyRadius', value: 6 }, { User });
        await applyProposal('u1', { field: 'travelStyle', value: 'budget' }, { User });
        expect(sets).toEqual(['settings.searchRadius.nearby', 'preferences.travelStyle']);
        expect(PREF_PATHS.discoveryRadius).toBe('settings.searchRadius.discovery');
    });

    test('with location reported, it says it sees where they are', () => {
        const block = selfBlock({ travelStyle: 'luxury', _knowsLocation: true }, { knowsLocation: true });
        expect(block).toMatch(/DO see where the traveler is right now/);
    });

    test('with location switched off, it says it does NOT — and points at Settings', () => {
        const block = selfBlock({ travelStyle: 'luxury' }, { knowsLocation: false });
        expect(block).toMatch(/do NOT see where the traveler is right now/);
        expect(block).toMatch(/enable it in Settings/);
        expect(block).not.toMatch(/DO see where the traveler is right now/);
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
// "[prefs] destination to Yerevan, Armenia — set on request". The vocabulary
// only had 'current', so a named city was silently turned into the GPS. The
// prose and the database disagreed, which is worse than refusing outright.
describe('a named destination is saved as the city that was named', () => {
    const { validateProposal } = require('../engine/preferences/proposal');
    const GPS = { city: 'Yerevan', country: 'Armenia', lat: 40.18, lng: 44.51 };
    const NAMED = { city: 'Dubai', country: 'United Arab Emirates', lat: 25.205, lng: 55.271 };

    test('"named" saves the named city, not where they are standing', () => {
        const p = validateProposal({ field: 'destination', value: 'named' },
            { currentPlace: GPS, namedPlace: NAMED });
        expect(p.value.city).toBe('Dubai');
        expect(p.value.coordinates).toEqual({ lat: 25.205, lng: 55.271 });
        expect(p.label).toBe('destination to Dubai, United Arab Emirates');
    });

    test('"current" still saves where they are', () => {
        const p = validateProposal({ field: 'destination', value: 'current' },
            { currentPlace: GPS, namedPlace: NAMED });
        expect(p.value.city).toBe('Yerevan');
    });

    test('"named" with no city named writes NOTHING — it does not fall back to GPS', () => {
        // Falling back is how Yerevan got saved when Dubai was asked for.
        expect(validateProposal({ field: 'destination', value: 'named' }, { currentPlace: GPS })).toBeNull();
    });

    test('a place name or coordinates from the model are still refused', () => {
        expect(validateProposal({ field: 'destination', value: 'Dubai' },
            { currentPlace: GPS, namedPlace: NAMED })).toBeNull();
        expect(validateProposal({ field: 'destination', value: { lat: 25, lng: 55 } },
            { currentPlace: GPS, namedPlace: NAMED })).toBeNull();
    });
});
