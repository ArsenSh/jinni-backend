// Budget clause currency conversion (found 2026-08-30): stored pricing is in
// the owner's currency, the budget band is USD — the clause must convert.
const { budgetMatchClause, effectivePrice } = require('../services/proximityService');

describe('budgetMatchClause currency conversion', () => {
    const RATES = { USD: 1, AMD: 364.33, AED: 3.6725 };
    test('with rates: the band compares a USD-converted price ($divide by per-currency $switch)', () => {
        const clause = budgetMatchClause({ min: 10, max: 60 }, RATES);
        const s = JSON.stringify(clause);
        expect(s).toContain('"$divide"');
        expect(s).toContain('"$pricing.currency"');
        expect(s).toContain('364.33');       // AMD branch present
        expect(s).toContain('3.6725');       // AED branch present
        expect(s).not.toContain('"USD"');    // USD is the default divisor 1, never a branch
    });
    test('without rates: divisor defaults to 1 — the historical all-USD behavior', () => {
        const s = JSON.stringify(budgetMatchClause({ min: 10, max: 60 }));
        expect(s).toContain('"$divide"');
        expect(s).toContain('"default":1');
        expect(s).toContain('"branches":[],"default":1');   // currency divisor has NO branches
    });
    test('free and unpriced listings still bypass the band', () => {
        const s = JSON.stringify(budgetMatchClause({ min: 30, max: 60 }, RATES));
        expect(s).toContain('"$eq":["$$eff",0]');
        expect(s).toContain('"$eq":["$$eff",null]');
    });
});

describe('effectivePrice derivation (unchanged)', () => {
    test('priority: free → average → midpoint → min → max → null', () => {
        expect(effectivePrice({ isFree: true, min: 5 })).toBe(0);
        expect(effectivePrice({ average: 20, min: 5, max: 50 })).toBe(20);
        expect(effectivePrice({ min: 10, max: 30 })).toBe(20);
        expect(effectivePrice({ min: 12 })).toBe(12);
        expect(effectivePrice({ max: 40 })).toBe(40);
        expect(effectivePrice({})).toBe(null);
    });
});
