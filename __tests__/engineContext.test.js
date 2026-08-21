// Tests for the V2 engine's Context Engine — the 3 AM fix.
// Time is always injected; nothing here depends on the machine clock or zone.

const { buildTimeContext, isOpenAt, annotateOpenNow, shouldDropWhenClosed, _daypartOf } = require('../engine/context/contextEngine');

// 2026-08-21 is a FRIDAY. 23:00 UTC that day = 03:00 Saturday in Yerevan (UTC+4).
const NOW = new Date('2026-08-21T23:00:00Z');

describe('buildTimeContext', () => {
    test('client timezone wins: 23:00Z Friday = 03:00 Saturday in Asia/Yerevan', () => {
        const ctx = buildTimeContext({ timezone: 'Asia/Yerevan', lng: 44.5, now: NOW });
        expect(ctx.source).toBe('client-tz');
        expect(ctx.hour).toBe(3);
        expect(ctx.dayOfWeek).toBe(6);            // Saturday
        expect(ctx.isLateNight).toBe(true);
        expect(ctx.daypart).toBe('night');
        expect(ctx.localISO).toBe('2026-08-22T03:00');
    });
    test('missing timezone → longitude estimate genuinely runs (the round-42 lesson)', () => {
        const ctx = buildTimeContext({ timezone: null, lng: 44.5, now: NOW });
        expect(ctx.source).toBe('longitude-estimate');
        expect(ctx.hour).toBe(2);                 // +3h estimate (44.5/15 rounds to 3)
        expect(ctx.dayOfWeek).toBe(6);
        expect(ctx.isLateNight).toBe(true);
    });
    test('invalid timezone string falls through to the estimate instead of throwing', () => {
        const ctx = buildTimeContext({ timezone: 'Not/AZone', lng: 44.5, now: NOW });
        expect(ctx.source).toBe('longitude-estimate');
        expect(ctx.hour).toBe(2);
    });
    test('nothing at all → honest UTC', () => {
        const ctx = buildTimeContext({ now: NOW });
        expect(ctx.source).toBe('utc');
        expect(ctx.hour).toBe(23);
        expect(ctx.dayOfWeek).toBe(5);            // still Friday in UTC
        expect(ctx.timezone).toBe(null);
    });
    test('dayparts', () => {
        expect(_daypartOf(8)).toBe('morning');
        expect(_daypartOf(14)).toBe('afternoon');
        expect(_daypartOf(19)).toBe('evening');
        expect(_daypartOf(2)).toBe('night');
        expect(_daypartOf(23)).toBe('night');
    });
});

// isOpenAt reads only {dayOfWeek, hour, minute} — hand-built contexts below.
const at = (dayOfWeek, hour, minute = 0) => ({ dayOfWeek, hour, minute });

describe('isOpenAt (Google periods math)', () => {
    const monday9to17 = { periods: [{ open: { day: 1, time: '0900' }, close: { day: 1, time: '1700' } }] };
    test('ordinary same-day hours', () => {
        expect(isOpenAt(monday9to17, at(1, 12))).toBe(true);
        expect(isOpenAt(monday9to17, at(1, 8, 59))).toBe(false);
        expect(isOpenAt(monday9to17, at(1, 17))).toBe(false);     // close boundary exclusive
        expect(isOpenAt(monday9to17, at(2, 12))).toBe(false);     // different day
    });
    test('overnight span: Friday 20:00 → Saturday 02:00', () => {
        const h = { periods: [{ open: { day: 5, time: '2000' }, close: { day: 6, time: '0200' } }] };
        expect(isOpenAt(h, at(5, 21))).toBe(true);
        expect(isOpenAt(h, at(6, 1))).toBe(true);                 // after midnight, still open
        expect(isOpenAt(h, at(6, 3))).toBe(false);                // 3 AM — closed
    });
    test('week-wrap span: Saturday 22:00 → Sunday 01:00 (tests the +week frame)', () => {
        const h = { periods: [{ open: { day: 6, time: '2200' }, close: { day: 0, time: '0100' } }] };
        expect(isOpenAt(h, at(6, 23))).toBe(true);
        expect(isOpenAt(h, at(0, 0, 30))).toBe(true);
        expect(isOpenAt(h, at(0, 2))).toBe(false);
    });
    test('24/7 marker: single open {day:0,time:"0000"} with no close', () => {
        const h = { periods: [{ open: { day: 0, time: '0000' } }] };
        expect(isOpenAt(h, at(3, 3))).toBe(true);
        expect(isOpenAt(h, at(0, 0))).toBe(true);
    });
    test('THE 3 AM CASE: restaurant open daily 09:00–23:00 is CLOSED at 03:00', () => {
        const h = { periods: Array.from({ length: 7 }, (_, d) => ({
            open: { day: d, time: '0900' }, close: { day: d, time: '2300' } })) };
        expect(isOpenAt(h, at(6, 3))).toBe(false);
        expect(isOpenAt(h, at(6, 12))).toBe(true);
    });
    test('unknown stays unknown — never guessed closed', () => {
        expect(isOpenAt(undefined, at(1, 12))).toBe(null);
        expect(isOpenAt({}, at(1, 12))).toBe(null);
        expect(isOpenAt({ periods: [] }, at(1, 12))).toBe(null);
        expect(isOpenAt({ periods: [{ open: { day: 1 } }] }, at(1, 12))).toBe(null);   // malformed only
    });
});

describe('annotateOpenNow', () => {
    test('stamps _openNow per place; missing hours → null; alt key supported', () => {
        const ctx = at(1, 12);
        const places = [
            { name: 'Open',   opening_hours: { periods: [{ open: { day: 1, time: '0900' }, close: { day: 1, time: '1700' } }] } },
            { name: 'Closed', openingHours:  { periods: [{ open: { day: 2, time: '0900' }, close: { day: 2, time: '1700' } }] } },
            { name: 'Unknown' },
            null,
        ];
        annotateOpenNow(places, ctx);
        expect(places[0]._openNow).toBe(true);
        expect(places[1]._openNow).toBe(false);
        expect(places[2]._openNow).toBe(null);
    });
});

describe('shouldDropWhenClosed (policy table)', () => {
    test('dining/shopping/activities may drop; everything else never does', () => {
        expect(shouldDropWhenClosed('restaurants')).toBe(true);
        expect(shouldDropWhenClosed('shopping')).toBe(true);
        expect(shouldDropWhenClosed('activities')).toBe(true);
        for (const cat of ['hotels', 'events', 'photo_spots', 'historical', 'hidden_gems', 'general', null]) {
            expect(shouldDropWhenClosed(cat)).toBe(false);
        }
    });
});
