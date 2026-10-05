const { _test } = require('../routes/publicRoutes');
const { FUNNEL_EVENTS } = require('../models/FunnelEvent');
const { sanitizeFunnel } = _test;

describe('sanitizeFunnel (anonymous sign-up funnel, 2026-09-30)', () => {
    test('accepts a text/plain JSON beacon and normalises the source', () => {
        expect(sanitizeFunnel('{"event":"wish_tap","sid":"abcd1234-xyz","source":"WWW.Instagram.com"}'))
            .toEqual({ event: 'wish_tap', sid: 'abcd1234-xyz', source: 'instagram.com' });
    });
    test('unknown events, bad sids and junk bodies are ignored', () => {
        expect(sanitizeFunnel({ event: 'buy_now', sid: 'abcdefghij' })).toBeNull();
        expect(sanitizeFunnel({ event: 'landing_view', sid: 'short' })).toBeNull();
        expect(sanitizeFunnel({ event: 'landing_view', sid: { $ne: 1 } })).toBeNull();
        expect(sanitizeFunnel('not json')).toBeNull();
        expect(sanitizeFunnel(null)).toBeNull();
    });
    test('missing or non-string source falls back to direct; long values are capped', () => {
        expect(sanitizeFunnel({ event: 'landing_view', sid: 'abcdefghijk', source: { $ne: 1 } }).source).toBe('direct');
        expect(sanitizeFunnel({ event: 'landing_view', sid: 'a'.repeat(100), source: 'x'.repeat(100) }))
            .toEqual({ event: 'landing_view', sid: 'a'.repeat(64), source: 'x'.repeat(60) });
    });
    test('every whitelisted event is accepted, in funnel order', () => {
        expect(FUNNEL_EVENTS).toEqual(['landing_view', 'wish_tap', 'auth_view', 'auth_switch_signup', 'signup_start', 'google_tap', 'signup_done']);
        for (const e of FUNNEL_EVENTS) expect(sanitizeFunnel({ event: e, sid: 'abcdefghij' })).not.toBeNull();
    });
});

describe('sanitizeVisit (anonymous public-page visits, 2026-10-06)', () => {
    const { sanitizeVisit } = _test;
    const { PAGE_KEYS } = require('../models/PageVisit');
    test('accepts a known page with the funnel sid/source rules', () => {
        expect(sanitizeVisit('{"page":"discover","sid":"abcd1234-xyz","source":"WWW.Instagram.com"}'))
            .toEqual({ page: 'discover', sid: 'abcd1234-xyz', source: 'instagram.com' });
        for (const p of PAGE_KEYS) expect(sanitizeVisit({ page: p, sid: 'abcdefghij' })).not.toBeNull();
    });
    test('unknown pages, bad sids and junk bodies are ignored', () => {
        expect(sanitizeVisit({ page: 'admin', sid: 'abcdefghij' })).toBeNull();
        expect(sanitizeVisit({ page: { $ne: 1 }, sid: 'abcdefghij' })).toBeNull();
        expect(sanitizeVisit({ page: 'guide', sid: 'short' })).toBeNull();
        expect(sanitizeVisit('not json')).toBeNull();
        expect(sanitizeVisit(null)).toBeNull();
    });
});
