/**
 * Price-tier bucket semantics — locked to the founder's 2026-09-05 decision:
 * "expensive and very expensive for Luxury, inexpensive and moderate for
 * budget, free can be for both of them."
 */
const { priceTier, tierMismatch, tierFit } = require('../services/priceTier');

const tierOf = (lvl) => priceTier([], null, lvl).tier;

describe('priceTier buckets', () => {
    test('FREE has no price tier — neutral for both styles', () => {
        expect(tierOf('PRICE_LEVEL_FREE')).toBe(null);
        expect(tierMismatch(tierOf('PRICE_LEVEL_FREE'), 'luxury')).toBe(false);
        expect(tierMismatch(tierOf('PRICE_LEVEL_FREE'), 'budget')).toBe(false);
        expect(tierFit(tierOf('PRICE_LEVEL_FREE'), 'luxury')).toBe(0);
    });

    test('luxury keeps EXPENSIVE + VERY_EXPENSIVE, drops INEXPENSIVE + MODERATE', () => {
        expect(tierMismatch(tierOf('PRICE_LEVEL_EXPENSIVE'), 'luxury')).toBe(false);
        expect(tierMismatch(tierOf('PRICE_LEVEL_VERY_EXPENSIVE'), 'luxury')).toBe(false);
        expect(tierMismatch(tierOf('PRICE_LEVEL_INEXPENSIVE'), 'luxury')).toBe(true);
        expect(tierMismatch(tierOf('PRICE_LEVEL_MODERATE'), 'luxury')).toBe(true);
    });

    test('budget keeps INEXPENSIVE + MODERATE, drops EXPENSIVE + VERY_EXPENSIVE', () => {
        expect(tierMismatch(tierOf('PRICE_LEVEL_INEXPENSIVE'), 'budget')).toBe(false);
        expect(tierMismatch(tierOf('PRICE_LEVEL_MODERATE'), 'budget')).toBe(false);
        expect(tierMismatch(tierOf('PRICE_LEVEL_EXPENSIVE'), 'budget')).toBe(true);
        expect(tierMismatch(tierOf('PRICE_LEVEL_VERY_EXPENSIVE'), 'budget')).toBe(true);
    });

    test('unknown tier and unset style are always neutral', () => {
        expect(tierMismatch(null, 'luxury')).toBe(false);
        expect(tierMismatch(null, 'budget')).toBe(false);
        expect(tierMismatch(3, '')).toBe(false);
        expect(tierMismatch(3, 'mid-range')).toBe(false);
    });

    test('lodging fallback still prices hotels with no priceLevel', () => {
        expect(priceTier(['hostel'], null, null).tier).toBe(1);
        expect(priceTier(['resort_hotel'], null, null).tier).toBe(4);
    });
});
