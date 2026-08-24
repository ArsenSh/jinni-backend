// Rendering is an ESCALATION, never a starting point: fetch, read, and only
// reach for a browser when the plain HTML carried nothing. It is also entirely
// optional — with playwright absent every path must behave exactly as before.
//
// A render now returns the page AND the JSON the page fetched for itself, so
// the fixtures inject renderPageFull.

const { renderAvailable } = require('../engine/utils/render');
const { huntEvents } = require('../engine/events/hunt');

const WINDOW = { start: '2026-09-01T00:00:00Z', end: '2026-09-07T00:00:00Z', label: 'w' };
const SHELL = `<html><body><div id="app"></div>${'x'.repeat(600)}</body></html>`;
const RENDERED = `<html><script type="application/ld+json">${JSON.stringify(
    { '@type': 'Event', name: 'Desert Rhythms', startDate: '2026-09-03T19:00:00Z' })}</script></html>`;

const base = (over = {}) => ({
    EventSource: { find: () => ({ select: () => ({ lean: async () => [] }) }), bulkWrite: async () => {} },
    AiFoundEvent: { bulkWrite: async () => {} },
    discoverEventSources: async () => ({ feeds: [{ label: 'js.example', url: 'https://js.example/dubai' }] }),
    searchWeb: async () => [],
    findPlaces: async () => [],
    renderAvailable: () => true,
    ...over,
});

describe('render escalation', () => {
    test('a JS shell is rendered, and its events are found', async () => {
        let rendered = 0;
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPageFull: async () => { rendered++; return { html: RENDERED, api: [] }; },
        }));
        expect(rendered).toBe(1);
        expect(out.map(e => e.name)).toContain('Desert Rhythms');
    });

    test('HTML that already carries dates is never rendered — cost without benefit', async () => {
        let rendered = 0;
        await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => RENDERED,
            renderPageFull: async () => { rendered++; return { html: RENDERED, api: [] }; },
        }));
        expect(rendered).toBe(0);
    });

    test('with rendering unavailable the hunt behaves exactly as before', async () => {
        let rendered = 0;
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            renderAvailable: () => false,
            fetchHtml: async () => SHELL,
            renderPageFull: async () => { rendered++; return { html: RENDERED, api: [] }; },
        }));
        expect(rendered).toBe(0);
        expect(out).toEqual([]);
    });

    test('a render that fails costs the page, not the hunt', async () => {
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPageFull: async () => null,
        }));
        expect(out).toEqual([]);
    });

    test('a render that still carries no dates is not adopted', async () => {
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPageFull: async () => ({ html: SHELL, api: [] }),
        }));
        expect(out).toEqual([]);
    });
});

// Arsen 2026-08-24: "lets build the network capture tier". A shell whose events
// arrive as JSON must produce cards, with no markup on the page at all.
describe('the network-capture tier', () => {
    test('events come from the JSON the page fetched for itself', async () => {
        const api = [{ url: 'https://js.example/api/events', data: { events: [
            { title: 'Desert Rhythms', start_date: '2026-09-03T19:00:00Z',
              venue: { name: 'Coca-Cola Arena' }, url: '/e/1', price: { amount: 250, currency: 'AED' } },
        ] } }];
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,                       // no markup, ever
            renderPageFull: async () => ({ html: SHELL, api }),  // the shell, plus its API
        }));
        const ev = out.find(e => e.name === 'Desert Rhythms');
        expect(ev).toBeTruthy();
        expect(ev.venueName).toBe('Coca-Cola Arena');
        expect(ev.price).toBe('250 AED');
    });

    test('an API with nothing dated in it falls through to the other tiers', async () => {
        const api = [{ url: 'https://js.example/api/config', data: { theme: 'dark' } }];
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPageFull: async () => ({ html: RENDERED, api }),   // markup still wins
        }));
        expect(out.map(e => e.name)).toContain('Desert Rhythms');
    });
});

describe('renderAvailable', () => {
    test('is honest about whether the browser exists, and never throws', () => {
        expect(typeof renderAvailable()).toBe('boolean');
    });

    test('the RENDER_JS=off switch wins even where playwright is installed', () => {
        const prev = process.env.RENDER_JS;
        process.env.RENDER_JS = 'off';
        expect(renderAvailable()).toBe(false);
        if (prev === undefined) delete process.env.RENDER_JS; else process.env.RENDER_JS = prev;
    });
});
