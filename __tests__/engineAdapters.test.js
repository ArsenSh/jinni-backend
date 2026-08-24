// Per-site adapters (Arsen 2026-08-24: "several codes for each type of
// websites"). The generic ladder stays the default; an adapter is written
// against a REAL page it got wrong, and must never be able to delete an answer.

const { pickAdapter, runAdapter, listAdapters } = require('../engine/events/adapters');
const allevents = require('../engine/events/adapters/allevents');

// A trimmed copy of the real allevents.in/yerevan/all markup, fetched
// 2026-08-24. Two cards, so "does a title borrow its neighbour's link" is
// actually testable — that is the bug this adapter exists for.
const B64 = Buffer.from('https://cdn-az.allevents.in/events2/banners/full-size.jpg').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const LISTING = `<ul class="event-card-parent">
  <li class="event-card event-card-link" data-eid="1" data-link="https://allevents.in/yerevan/armenia-expo-2026/1" data-name="ARMENIA EXPO 2026">
    <div class="banner-cont" style="background:url(https://cdn-ip.allevents.in/s/rs:fill:500:250/${B64}.avif);background-size:cover;"></div>
    <div class="meta"><div class="date"> Fri, 04 Sep, 2026 - 11:00 AM </div></div>
  </li>
  <li class="event-card event-card-link" data-eid="2" data-link="https://allevents.in/yerevan/dandagh/2" data-name="Դանդաղ արտասահմանյան vol. 25">
    <div class="banner-cont" style="background:url(https://cdn-ip.allevents.in/s/rs:fill:500:250/OTHER.avif);"></div>
    <div class="meta"><div class="date"> Fri, 04 Sep, 2026 - 9:00 PM </div></div>
  </li>
</ul>`;

describe('allevents adapter', () => {
    const rows = allevents.extract(LISTING, { url: 'https://allevents.in/yerevan/all' });

    test('each event keeps its OWN link, poster and start time', () => {
        expect(rows).toHaveLength(2);
        expect(rows[0].name).toBe('ARMENIA EXPO 2026');
        expect(rows[0].url).toBe('https://allevents.in/yerevan/armenia-expo-2026/1');
        expect(rows[0].startDate.toISOString()).toBe('2026-09-04T11:00:00.000Z');
        expect(rows[1].name).toBe('Դանդաղ արտասահմանյան vol. 25');
        expect(rows[1].url).toBe('https://allevents.in/yerevan/dandagh/2');
        // The live failure: this one wore its neighbour's 21:00 AND its link.
        expect(rows[1].startDate.toISOString()).toBe('2026-09-04T21:00:00.000Z');
        expect(rows[1].url).not.toBe(rows[0].url);
        expect(rows[1].image).not.toBe(rows[0].image);
    });

    test('the full-resolution poster is recovered from the proxy path', () => {
        expect(rows[0].image).toBe('https://cdn-az.allevents.in/events2/banners/full-size.jpg');
    });

    test('an undecodable proxy path still yields the proxy url, not nothing', () => {
        expect(rows[1].image).toContain('cdn-ip.allevents.in');
    });

    test('dates: 12-hour, 24-hour, date-only, and junk', () => {
        expect(allevents._parseCardDate('Sat, 05 Sep, 2026 - 9:00 PM').toISOString()).toBe('2026-09-05T21:00:00.000Z');
        expect(allevents._parseCardDate('Mon, 24 Aug, 2026 - 19:30').toISOString()).toBe('2026-08-24T19:30:00.000Z');
        expect(allevents._parseCardDate('Mon, 24 Aug, 2026').toISOString()).toBe('2026-08-24T00:00:00.000Z');
        expect(allevents._parseCardDate('whenever')).toBeNull();
    });

    test('an undated card is skipped — unverifiable is not an answer', () => {
        const undated = '<ul><li class="event-card" data-link="https://allevents.in/x/1" data-name="No Date"></li></ul>';
        expect(allevents.extract(undated)).toHaveLength(0);
    });
});

describe('the registry', () => {
    test('a source gets an adapter by host without anyone configuring it', () => {
        expect(pickAdapter('https://allevents.in/yerevan/all').name).toBe('allevents');
        expect(pickAdapter('https://www.allevents.in/dubai/all').name).toBe('allevents');
    });

    test('a source may also name one explicitly', () => {
        expect(pickAdapter('https://mirror.example/list', 'allevents').name).toBe('allevents');
    });

    test('an unknown host gets the generic reader', () => {
        expect(pickAdapter('https://tomsarkgh.am/en')).toBeNull();
        expect(pickAdapter('not a url')).toBeNull();
        expect(pickAdapter('https://x.example/y', 'no-such-adapter')).toBeNull();
    });

    test('an adapter that throws returns nothing, so the generic path still runs', () => {
        const boom = { name: 'boom', extract: () => { throw new Error('site redesigned'); } };
        expect(runAdapter(boom, '<html>', {})).toEqual([]);
    });

    test('rows without a usable date never leave the adapter', () => {
        const sloppy = { name: 'sloppy', extract: () => [{ name: 'A' }, { name: 'B', startDate: new Date('nope') }, null] };
        expect(runAdapter(sloppy, '<html>', {})).toEqual([]);
    });

    test('the staff picker can list what exists', () => {
        expect(listAdapters()).toEqual(expect.arrayContaining([{ name: 'allevents', hosts: ['allevents.in'] }]));
    });
});
