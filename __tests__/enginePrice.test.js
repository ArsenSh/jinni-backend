// A printed price stays printed; the traveler's currency rides alongside it.
// Arsen 2026-08-24: "it will show what it found and how much it will be."

const { parsePrice, approxIn } = require('../engine/money/price');

// AMD ≈ 363.76 to the dollar (the rate in the live log), USD passthrough.
const rates = {
    isCurrencySupported: (c) => ['USD', 'AMD', 'EUR', 'RUB', 'AED', 'GBP'].includes(c),
    convertToUSD: (n, c) => (c === 'AMD' ? n / 363.76 : c === 'EUR' ? n / 0.856 : n),
    convertFromUSD: (n, c) => (c === 'AMD' ? n * 363.76 : c === 'EUR' ? n * 0.856 : n),
};
const approx = (t, to = 'USD') => approxIn(t, to, { currencyService: rates });

describe('parsePrice', () => {
    test('reads the forms our own sources actually print', () => {
        expect(parsePrice('3000 AMD')).toMatchObject({ min: 3000, max: 3000, currency: 'AMD' });
        expect(parsePrice('3000-10000 դրամ')).toMatchObject({ min: 3000, max: 10000, currency: 'AMD' });
        expect(parsePrice('9,000 դր')).toMatchObject({ min: 9000, max: 9000, currency: 'AMD' });
        expect(parsePrice('12,000–16,000 драм')).toMatchObject({ min: 12000, max: 16000, currency: 'AMD' });
        expect(parsePrice('AED 50')).toMatchObject({ min: 50, currency: 'AED' });
        expect(parsePrice('$25')).toMatchObject({ min: 25, currency: 'USD' });
    });
    test('a label in front of the number does not confuse it', () => {
        expect(parsePrice('General - 9,000 դր')).toMatchObject({ min: 9000, max: 9000, currency: 'AMD' });
    });
    test('free is a price, and it is zero', () => {
        for (const t of ['Free entry', 'անվճար', 'бесплатно']) expect(parsePrice(t)).toMatchObject({ free: true });
    });
    test('an unlabelled number is not a price — it could be anything', () => {
        for (const t of ['25', '3000-10000', '', null, undefined, '   ']) expect(parsePrice(t)).toBeNull();
    });
});

describe('approxIn', () => {
    test('converts, rounds like a human, and marks itself approximate', () => {
        expect(approx('3000 AMD')).toBe('≈ $8.2');
        expect(approx('9,000 դր')).toBe('≈ $25');
    });
    test('a range carries the unit once', () => {
        expect(approx('3000-10000 դրամ')).toBe('≈ $8.2–27');
        expect(approx('12,000–16,000 драм')).toBe('≈ $33–44');
    });
    test('says nothing when it would be noise or a guess', () => {
        expect(approx('3000 AMD', 'AMD')).toBeNull();      // already their money
        expect(approx('Free entry')).toBeNull();           // nothing to convert
        expect(approx('25')).toBeNull();                   // unreadable
        expect(approx('3000 AMD', '')).toBeNull();         // no target
        expect(approx('3000 ZWL')).toBeNull();             // currency we have no rate for
    });
    test('a rate service that throws produces no claim at all', () => {
        expect(approxIn('3000 AMD', 'USD', { currencyService: {
            isCurrencySupported: () => true,
            convertToUSD: () => { throw new Error('rates down'); },
            convertFromUSD: () => 1,
        } })).toBeNull();
    });
    test('non-symbol currencies name themselves', () => {
        expect(approxIn('$10', 'AMD', { currencyService: rates })).toBe('≈ 3,640 AMD');
    });
});
