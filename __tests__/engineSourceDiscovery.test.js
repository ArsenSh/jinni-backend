// A city nobody curated should teach itself (Arsen 2026-08-24, after asking
// for Dubai events and getting Armenian theatre): discover the listing sites,
// keep the ones that actually produce dated events, and never pay for that
// discovery twice.

const { huntEvents } = require('../engine/events/hunt');

const WINDOW = { start: '2026-09-01T00:00:00Z', end: '2026-09-07T00:00:00Z', label: 'next-week' };

const ldPage = (name, startDate) => `<html><script type="application/ld+json">
${JSON.stringify({ '@type': 'Event', name, startDate, location: { name: 'Coca-Cola Arena' } })}
</script></html>`;

/** Collects what the hunt would write to the registry. */
function fakeEventSource() {
    const writes = [];
    const disabled = new Set();
    return {
        writes, disabled,
        find: (q) => ({ select: () => ({ lean: async () => {
            if (q && q.enabled === false) return [...disabled].map(url => ({ url }));
            return [];                                    // nothing curated for this city
        } }) }),
        bulkWrite: async (ops) => { writes.push(...ops); },
    };
}

function deps({ feeds = [], pages = {}, source = fakeEventSource(), stored = [] } = {}) {
    return {
        EventSource: source,
        AiFoundEvent: { bulkWrite: async (ops) => { stored.push(...ops); } },
        discoverEventSources: async () => ({ domains: [], feeds }),
        searchWeb: async () => { throw new Error('web search must not run when discovery worked'); },
        fetchHtml: async (url) => pages[url] || null,
        _source: source, _stored: stored,
    };
}

describe('hunt: discovering sources for an uncurated city', () => {
    test('discovered feeds are read instead of a paid search, and registered', async () => {
        const d = deps({
            feeds: [{ label: 'platinumlist.net', url: 'https://platinumlist.net/dubai' }],
            pages: { 'https://platinumlist.net/dubai': ldPage('Desert Rhythms', '2026-09-03T19:00:00Z') },
        });
        const out = await huntEvents({ city: 'Dubai', country: 'United Arab Emirates', window: WINDOW }, d);
        expect(out.length).toBeGreaterThan(0);

        const upsert = d._source.writes.find(w => w.updateOne?.upsert);
        expect(upsert).toBeTruthy();
        expect(upsert.updateOne.filter).toEqual({ url: 'https://platinumlist.net/dubai', city: 'Dubai' });
        expect(upsert.updateOne.update.$setOnInsert).toMatchObject({ city: 'Dubai', enabled: true });
        expect(upsert.updateOne.update.$setOnInsert.discoveredAt).toBeInstanceOf(Date);
        expect(upsert.updateOne.update.$setOnInsert.name).toContain('platinumlist.net');
    });

    test('enabled and discoveredAt are insert-only, so a staff decision survives', async () => {
        const d = deps({
            feeds: [{ label: 'x.com', url: 'https://x.com/dubai' }],
            pages: { 'https://x.com/dubai': ldPage('Show', '2026-09-03T19:00:00Z') },
        });
        await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, d);
        const set = d._source.writes[0].updateOne.update.$set;
        expect(set).not.toHaveProperty('enabled');
        expect(set).not.toHaveProperty('discoveredAt');
        expect(set).toHaveProperty('lastFoundCount');
    });

    test('a page that yields nothing is not registered — proposing is not earning', async () => {
        const d = deps({
            feeds: [{ label: 'empty.com', url: 'https://empty.com/dubai' }],
            pages: { 'https://empty.com/dubai': '<html>no structured events here</html>' },
        });
        await huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, d);
        expect(d._source.writes).toHaveLength(0);
    });

    test('a source a validator disabled is not re-read', async () => {
        const source = fakeEventSource();
        source.disabled.add('https://banned.com/dubai');
        const d = deps({
            source,
            feeds: [{ label: 'banned.com', url: 'https://banned.com/dubai' }],
            pages: { 'https://banned.com/dubai': ldPage('Should never appear', '2026-09-03T19:00:00Z') },
        });
        // No feeds survive the disabled filter, so the hunt falls through to
        // search — which must never see the banned page's events.
        let searched = false;
        d.searchWeb = async () => { searched = true; return []; };
        await expect(huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, d)).resolves.toEqual([]);
        expect(searched).toBe(true);
        expect(source.writes).toHaveLength(0);
    });

    test('no country means no discovery call at all', async () => {
        let asked = false;
        const d = deps({ feeds: [] });
        d.discoverEventSources = async () => { asked = true; return { feeds: [] }; };
        d.searchWeb = async () => [];
        await huntEvents({ city: 'Dubai', window: WINDOW }, d);
        expect(asked).toBe(false);
    });

    test('discovery failure falls back to search rather than losing the turn', async () => {
        const d = deps({ feeds: [] });
        d.discoverEventSources = async () => { throw new Error('model down'); };
        let searched = false;
        d.searchWeb = async () => { searched = true; return []; };
        await expect(huntEvents({ city: 'Dubai', country: 'UAE', window: WINDOW }, d)).resolves.toEqual([]);
        expect(searched).toBe(true);
    });
});
