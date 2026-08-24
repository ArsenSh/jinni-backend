// Rendering is an ESCALATION, never a starting point: fetch, read, and only
// reach for a browser when the plain HTML carried nothing. It is also entirely
// optional — with playwright absent every path must behave exactly as before.

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
            renderPage: async () => { rendered++; return RENDERED; },
        }));
        expect(rendered).toBe(1);
        expect(out.map(e => e.name)).toContain('Desert Rhythms');
    });

    test('HTML that already carries dates is never rendered — cost without benefit', async () => {
        let rendered = 0;
        await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => RENDERED,
            renderPage: async () => { rendered++; return RENDERED; },
        }));
        expect(rendered).toBe(0);
    });

    test('with rendering unavailable the hunt behaves exactly as before', async () => {
        let rendered = 0;
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            renderAvailable: () => false,
            fetchHtml: async () => SHELL,
            renderPage: async () => { rendered++; return RENDERED; },
        }));
        expect(rendered).toBe(0);
        expect(out).toEqual([]);
    });

    test('a render that fails costs the page, not the hunt', async () => {
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPage: async () => null,
        }));
        expect(out).toEqual([]);
    });

    test('a render that still carries no dates is not adopted', async () => {
        const out = await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, base({
            fetchHtml: async () => SHELL,
            renderPage: async () => SHELL,
        }));
        expect(out).toEqual([]);
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
