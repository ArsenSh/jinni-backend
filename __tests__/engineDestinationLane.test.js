// The DESTINATION lane — "where in the world should I go", as opposed to
// "what is near me". Live 2026-09-06 (founder: "it is very bad"):
//   · "which countries would you recommend for one week based on my
//     preferences" ran as q="countries visit week based preferences" at
//     r=50km and dealt six Yerevan venues;
//   · "No please not in armenia" became q="armenia", lex=3, and dealt a
//     grocery, three bars and a helicopter tour.
// So an exclusion must be a CONSTRAINT that survives the conversation, never a
// search keyword, and a destination-scale ask must never reach the deck.
const { mergeConstraints, ledgerLine } = require('../engine/session/constraints');
const { buildDestinationMessages } = require('../engine/narrator/prompts/grounded');

describe('exclusions are constraints, not keywords', () => {
    test('a ruled-out country enters the ledger and is carried to later turns', () => {
        const first = mergeConstraints(null, { excluded: ['Armenia'] }, { category: null });
        expect(first.ledger.excluded).toEqual(['Armenia']);
        expect(first.changed).toContain('excluded');

        const silent = mergeConstraints(first.ledger, {}, { category: null });
        expect(silent.ledger.excluded).toEqual(['Armenia']);   // still ruled out
        expect(silent.changed).not.toContain('excluded');
    });

    test('exclusions ACCUMULATE — "not Armenia" then "not Italy" rules out both', () => {
        const a = mergeConstraints(null, { excluded: ['Armenia'] }, { category: null });
        const b = mergeConstraints(a.ledger, { excluded: ['Italy'] }, { category: null });
        expect(b.ledger.excluded).toEqual(['Armenia', 'Italy']);
    });

    test('the same country said twice, cased differently, is not stored twice', () => {
        const a = mergeConstraints(null, { excluded: ['Armenia'] }, { category: null });
        const b = mergeConstraints(a.ledger, { excluded: ['armenia', 'ARMENIA'] }, { category: null });
        expect(b.ledger.excluded).toEqual(['Armenia']);
        expect(b.changed).not.toContain('excluded');
    });

    test('a mission change clears them with the rest of the ledger', () => {
        const a = mergeConstraints(null, { excluded: ['Armenia'] }, { category: 'hotels' });
        const b = mergeConstraints(a.ledger, {}, { category: 'events' });
        expect(b.reset).toBe(true);
        expect(b.ledger.excluded).toBeUndefined();
    });

    test('the ledger line says what was ruled out', () => {
        const a = mergeConstraints(null, { excluded: ['Armenia', 'Italy'] }, { category: null });
        expect(ledgerLine(a.ledger, a.changed)).toMatch(/not: Armenia\/Italy/);
    });
});

describe('the destination prompt', () => {
    const base = {
        message: 'which countries for one week?',
        preferences: { travelStyle: 'luxury', interests: ['romantic', 'nature'] },
    };
    const text = (opts) => buildDestinationMessages({ ...base, ...opts })[0].content;

    test('a ruled-out country is named as ruled out, and cannot return via coverage', () => {
        const t = text({ excluded: ['Armenia'], coverage: [{ name: 'Armenia', places: 873 }, { name: 'Italy', places: 58 }] });
        expect(t).toMatch(/RULED OUT[^\n]*Armenia/);
        expect(t).toMatch(/knows well, in order: Italy\b/);
        expect(t).not.toMatch(/knows well, in order: Armenia/);
    });

    test('the country they are standing in is not offered back to them', () => {
        expect(text({ here: 'Armenia' })).toMatch(/They are in Armenia right now[\s\S]*Do not offer Armenia itself/);
    });

    test('an unwarmed coverage count simply omits the line — nothing is invented', () => {
        const t = text({ coverage: [] });
        expect(t).not.toMatch(/knows well/);
        expect(t).toMatch(/HOW TO ANSWER/);
    });

    test('it forbids the quantities it has not looked up', () => {
        const t = text({});
        expect(t).toMatch(/NEVER state a price, a flight time, a temperature, a distance or an opening hour/);
    });

    test('it asks for destinations, not a deck of venues', () => {
        const t = text({});
        expect(t).toMatch(/Name three to five destinations/);
        expect(t).toMatch(/No lists of sights, no venue names/);
    });

    test('the traveler’s saved rows still reach it, and the message is last', () => {
        const msgs = buildDestinationMessages({ ...base, excluded: [], coverage: [] });
        expect(msgs[0].content).toMatch(/travel style: luxury/);
        expect(msgs[0].content).toMatch(/interests: romantic, nature/);
        expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: base.message });
    });

    test('it answers in the traveler’s language', () => {
        expect(text({ langName: 'Russian' })).toMatch(/Reply in Russian/);
    });
});

describe('what the intent call is allowed to hand back', () => {
    const { validateIntent } = require('../services/intentService');
    const raw = (over) => validateIntent({ is_travel: true, action_type: 'general', ...over }, 'test message');

    test('a destination-scale ask is carried through as a judgement', () => {
        expect(raw({ destination_scope: true }).destinationScope).toBe(true);
        expect(raw({}).destinationScope).toBe(false);
        expect(raw({ destination_scope: 'yes' }).destinationScope).toBe(false);   // only a real boolean
    });

    test('exclusions are trimmed, de-duplicated and capped', () => {
        const out = raw({ exclude: ['Armenia', ' Armenia ', 'Italy', 'Spain', 'France', 'Greece', 'Peru', 'Chile', 'Japan'] });
        expect(out.exclude.slice(0, 3)).toEqual(['Armenia', 'Italy', 'Spain']);
        expect(out.exclude.length).toBeLessThanOrEqual(6);
    });

    test('junk in the exclude list is dropped rather than passed on', () => {
        // These names are carried across turns and compared against places.
        const out = raw({ exclude: ['A', '', '   ', null, 42, { name: 'Italy' }, 'x'.repeat(200), 'Georgia'] });
        expect(out.exclude).toEqual(['Georgia']);
    });

    test('no exclude field at all is an empty list, never undefined', () => {
        expect(raw({}).exclude).toEqual([]);
        expect(raw({ exclude: 'Armenia' }).exclude).toEqual([]);   // not an array
    });
});
