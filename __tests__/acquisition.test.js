const { sanitizeAcquisition, acquisitionLabel } = require('../services/acquisition');

describe('sanitizeAcquisition (sign-up source, 2026-09-18)', () => {
    test('keeps known utm fields, trims, caps and lowercases the source', () => {
        const a = sanitizeAcquisition({ source: ' Google ', medium: 'CPC', campaign: 'yerevan-restaurants', term: 'x'.repeat(500), junk: 'no', landing: '/discover/yerevan' });
        expect(a.source).toBe('google');
        expect(a.medium).toBe('cpc');
        expect(a.campaign).toBe('yerevan-restaurants');
        expect(a.term).toHaveLength(160);
        expect(a.junk).toBeUndefined();
        expect(a.landing).toBe('/discover/yerevan');
    });
    test('a referrer without utm becomes its hostname as the source', () => {
        expect(sanitizeAcquisition({ referrer: 'https://www.instagram.com/p/abc' }).source).toBe('instagram.com');
    });
    test('nothing usable → null; non-strings ignored', () => {
        expect(sanitizeAcquisition({})).toBeNull();
        expect(sanitizeAcquisition({ source: 42 })).toBeNull();
        expect(sanitizeAcquisition('x')).toBeNull();
    });
    test('label groups by source and campaign', () => {
        expect(acquisitionLabel(null)).toBe('direct');
        expect(acquisitionLabel({ source: 'google' })).toBe('google');
        expect(acquisitionLabel({ source: 'google', campaign: 'c1' })).toBe('google / c1');
    });
});
