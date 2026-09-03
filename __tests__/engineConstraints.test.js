// The constraint ledger — replaying ChatGPT QA §4's exact 5-turn chain
// (live failure 2026-09-04: turn 4 lost `cheaper` + the 2km walking cap,
// turn 5 degraded the query to "restaurant actually make").
const { parsePartySize, parseTargetTime, mergeConstraints, ledgerLine, fmtTargetTime }
    = require('../engine/session/constraints');

describe('the ChatGPT §4 chain, constraint by constraint', () => {
    test('every turn keeps what earlier turns set and changes only its own key', () => {
        // t1: "I'm hungry. Find me a good Armenian restaurant near Republic Square"
        let r = mergeConstraints(null, { lastQuery: 'armenian restaurant near republic square' },
            { category: 'restaurants' });
        expect(r.ledger.category).toBe('restaurants');

        // t2: "Something cheaper."
        r = mergeConstraints(r.ledger, { price: 'cheaper' }, { category: 'restaurants' });
        expect(r.changed).toEqual(['price']);

        // t3: "Walking distance."
        r = mergeConstraints(r.ledger, { radiusCapKm: 2 }, { category: 'restaurants' });
        expect(r.ledger).toMatchObject({ price: 'cheaper', radiusCapKm: 2 });

        // t4: "For 4 people tonight at 8."
        const t4time = parseTargetTime('For 4 people tonight at 8.', { nowMinutes: 13 * 60 });
        r = mergeConstraints(r.ledger,
            { partySize: parsePartySize('For 4 people tonight at 8.'), targetTime: t4time },
            { category: 'restaurants' });
        expect(r.ledger).toMatchObject({ price: 'cheaper', radiusCapKm: 2, partySize: 4, targetTime: 20 * 60 });

        // t5: "Actually make it 9." — ONE key changes, everything else survives
        const t5time = parseTargetTime('Actually make it 9.', { prevTargetMin: r.ledger.targetTime });
        r = mergeConstraints(r.ledger, { targetTime: t5time }, { category: 'restaurants' });
        expect(r.changed).toEqual(['targetTime']);
        expect(r.ledger).toMatchObject({ price: 'cheaper', radiusCapKm: 2, partySize: 4, targetTime: 21 * 60 });
        expect(r.ledger.lastQuery).toBe('armenian restaurant near republic square');
        expect(ledgerLine(r.ledger, r.changed)).toContain('cheaper');
    });
    test('a mission change WIPES the ledger — constraints never leak across topics (§10 trap)', () => {
        const { ledger } = mergeConstraints(null, { price: 'cheaper', radiusCapKm: 2 }, { category: 'restaurants' });
        const r = mergeConstraints(ledger, {}, { category: 'historical' });
        expect(r.reset).toBe(true);
        expect(r.ledger.price).toBeUndefined();
        expect(r.ledger.category).toBe('historical');
    });
    test('a new value REPLACES its opposite: fancier clears cheaper, 10km clears the walking cap', () => {
        let { ledger } = mergeConstraints(null, { price: 'cheaper', radiusCapKm: 2 }, { category: 'restaurants' });
        ({ ledger } = mergeConstraints(ledger, { price: 'fancier', radiusCapKm: 10 }, { category: 'restaurants' }));
        expect(ledger).toMatchObject({ price: 'fancier', radiusCapKm: 10 });
    });
});

describe('parseTargetTime — clock words become minutes, PM inferred honestly', () => {
    test('markers decide first', () => {
        expect(parseTargetTime('tonight at 8')).toBe(20 * 60);
        expect(parseTargetTime('at 8 pm')).toBe(20 * 60);
        expect(parseTargetTime('at 8 am')).toBe(8 * 60);
        expect(parseTargetTime('at 20:30')).toBe(20 * 60 + 30);
    });
    test('"make it 9" after a 20:00 target means 21:00, not breakfast', () => {
        expect(parseTargetTime('Actually make it 9.', { prevTargetMin: 20 * 60 })).toBe(21 * 60);
    });
    test('a small bare hour that already passed today means this evening', () => {
        expect(parseTargetTime('at 8', { nowMinutes: 13 * 60 })).toBe(20 * 60);
        expect(parseTargetTime('at 8', { nowMinutes: 7 * 60 })).toBe(8 * 60);
    });
    test('no time words → null (never a 12:00 placeholder — the honesty rule)', () => {
        expect(parseTargetTime('Something cheaper.')).toBeNull();
        expect(parseTargetTime('Walking distance.')).toBeNull();
    });
});

describe('parsePartySize', () => {
    test('digits and words, EN and RU', () => {
        expect(parsePartySize('For 4 people tonight at 8.')).toBe(4);
        expect(parsePartySize('table for two')).toBe(2);
        expect(parsePartySize('нас 6')).toBe(6);
        expect(parsePartySize('walking distance')).toBeNull();
    });
});

describe('fmtTargetTime', () => {
    test('renders minutes as HH:MM', () => {
        expect(fmtTargetTime(21 * 60)).toBe('21:00');
        expect(fmtTargetTime(null)).toBeNull();
    });
});
