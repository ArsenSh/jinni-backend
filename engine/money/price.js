// Jinni V2 Engine — reading a printed price, and saying what it means in the
// traveler's own currency.
//
// Arsen 2026-08-24: "can it shows with the price user has in settings? with usd
// too for instance — it will show what it found and how much it will be."
//
// The order of those two halves is the whole design. What the listing PRINTED
// is the fact and never changes: "3000 դրամ" stays "3000 դրամ". The conversion
// is a derived number, so it is additive, visibly rounded, and marked with ≈.
// If the string cannot be read with confidence, nothing is added at all — a
// wrong conversion is worse than none, because it looks like research.

// Currency words as listings actually print them, including the Armenian and
// Russian forms our own sources use. Longest form first within each entry, so
// 'դրամ' is tested before 'դր' and 'рубл' before 'руб'.
const CURRENCY_WORDS = [
    ['AMD', ['դրամ', 'դր.', 'դր', '֏', 'amd', 'dram', 'драм']],
    ['RUB', ['рубл', 'руб', '₽', 'rub']],
    ['AED', ['dirham', 'aed', 'dhs', 'د.إ']],
    ['EUR', ['euro', 'eur', '€']],
    ['GBP', ['gbp', '£']],
    ['USD', ['usd', 'dollar', '$']],
];

// "free" in the languages our sources publish in. A free event HAS a price and
// it is zero — worth saying, never worth converting.
const FREE_WORDS = /\b(free|free entry|no charge)\b|անվճար|бесплатн|مجان/i;

/**
 * A printed price → { min, max, currency, free } or null when unreadable.
 * Handles ranges ("3000-10000", "12,000–16,000"), thousands separators
 * (comma, space, non-breaking space) and either word order ("AED 50", "50 AED").
 */
function parsePrice(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (FREE_WORDS.test(raw)) return { min: 0, max: 0, currency: null, free: true };

    const lower = raw.toLowerCase();
    let currency = null;
    for (const [code, words] of CURRENCY_WORDS) {
        if (words.some(w => lower.includes(w))) { currency = code; break; }
    }
    if (!currency) return null;                 // an unlabelled number could be anything

    // Strip separators only BETWEEN digits, so "9,000" is one number while
    // "3000, 5000" stays two.
    const numbers = (raw.replace(/(\d)[\s ,](?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) || [])
        .map(Number).filter(n => Number.isFinite(n) && n >= 0);
    if (!numbers.length) return null;

    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return { min, max, currency, free: min === 0 && max === 0 };
}

/** Round to something a human would say: exact under 10, whole under 100,
 *  nearest 5 above. "$27.43" pretends to a precision the exchange rate on a
 *  theatre ticket does not have. */
function _round(n) {
    if (n < 10) return Math.round(n * 10) / 10;
    if (n < 100) return Math.round(n);
    return Math.round(n / 5) * 5;
}

function _fmt(n, code) {
    const symbol = { USD: '$', EUR: '€', GBP: '£' }[code];
    const shown = _round(n).toLocaleString('en-US');
    return symbol ? `${symbol}${shown}` : `${shown} ${code}`;
}

/**
 * The approximate line that sits BESIDE the printed price, or null.
 * Null whenever it would be noise or a guess: unreadable string, same currency,
 * free entry, an unsupported currency, or a rate lookup that failed.
 * @returns {string|null} e.g. "≈ $8" or "≈ $33–44"
 */
function approxIn(printed, toCurrency, deps = {}) {
    const to = String(toCurrency || '').toUpperCase();
    if (!to) return null;
    const parsed = parsePrice(printed);
    if (!parsed || parsed.free || !parsed.currency) return null;
    if (parsed.currency === to) return null;               // already in their money

    const svc = deps.currencyService || require('../../services/currencyService');
    try {
        if (svc.isCurrencySupported && (!svc.isCurrencySupported(parsed.currency) || !svc.isCurrencySupported(to))) return null;
        const conv = (n) => svc.convertFromUSD(svc.convertToUSD(n, parsed.currency), to);
        const lo = conv(parsed.min);
        const hi = conv(parsed.max);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
        if (_round(lo) === _round(hi)) return `≈ ${_fmt(lo, to)}`;
        // A range carries the unit once: "$8–27", not "$8–$27".
        const symbol = { USD: '$', EUR: '€', GBP: '£' }[to];
        return symbol
            ? `≈ ${_fmt(lo, to)}–${_round(hi).toLocaleString('en-US')}`
            : `≈ ${_round(lo).toLocaleString('en-US')}–${_fmt(hi, to)}`;
    } catch {
        return null;                                       // no rate, no claim
    }
}

module.exports = { parsePrice, approxIn };
