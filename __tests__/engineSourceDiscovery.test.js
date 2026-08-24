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

// ── Pinning events to their venue (Arsen 2026-08-24) ─────────────────────────
// "the map that appears in buttom of recommendation cards is not showing
// location from jinnievents" — hunted rows stored lat/lng null, so the map had
// nothing to plot. Get Directions still worked, because it opens the address as
// text: the address was known, only the coordinates were missing.
describe('hunt: venue pinning', () => {
    const YEREVAN = { lat: 40.18, lng: 44.51 };
    const twoNights = `<html><script type="application/ld+json">${JSON.stringify([
        { '@type': 'Event', name: 'Night One', startDate: '2026-09-02T19:00:00Z', location: { name: 'Bohem theatre' } },
        { '@type': 'Event', name: 'Night Two', startDate: '2026-09-03T19:00:00Z', location: { name: 'Bohem theatre' } },
    ])}</script></html>`;

    const run = async (findPlaces) => {
        const stored = [];
        const d = {
            EventSource: { find: () => ({ select: () => ({ lean: async () => [] }) }), bulkWrite: async () => {} },
            AiFoundEvent: { bulkWrite: async (ops) => { stored.push(...ops); } },
            discoverEventSources: async () => ({ feeds: [{ label: 'src.am', url: 'https://src.am/e' }] }),
            searchWeb: async () => [],
            fetchHtml: async () => twoNights,
            findPlaces,
        };
        await huntEvents({ city: 'Yerevan', country: 'Armenia', center: YEREVAN, window: WINDOW }, d);
        return stored.map(o => o.updateOne.update.$setOnInsert);
    };

    test('one lookup pins every night at the same venue', async () => {
        let calls = 0;
        const rows = await run(async () => { calls++; return [{ place_id: 'venue1', geometry: { location: { lat: 40.19, lng: 44.52 } } }]; });
        expect(calls).toBe(1);
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(r.lat).toBe(40.19);
            expect(r.lng).toBe(44.52);
            expect(r.placeId).toBe('venue1');
        }
    });

    test('a venue resolved on the wrong continent is left unpinned', async () => {
        const rows = await run(async () => [{ place_id: 'far', geometry: { location: { lat: 48.85, lng: 2.35 } } }]);
        for (const r of rows) { expect(r.lat).toBeNull(); expect(r.placeId).toBeNull(); }
    });

    test('a geocoder failure costs the pin, not the events', async () => {
        const rows = await run(async () => { throw new Error('quota'); });
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r.lat).toBeNull();
    });
});

// ── A city with no events must still be huntable (Arsen 2026-08-24) ──────────
// "why i have not received events for dubai?" — the hunt took its city from the
// events it already held, so a city with none had no name to hunt with and
// huntEvents returned on its first line, silently. The only source of the name
// was the thing we could not have yet.
describe('huntCity', () => {
    const { huntCity } = require('../engine/places/canonicalStore');

    test('the reverse-geocoded region wins, so an eventless city is huntable', () => {
        expect(huntCity({ regionCity: 'Dubai' }, [])).toBe('Dubai');
    });

    test('the old path still works where events exist', () => {
        expect(huntCity({}, [{ city: 'Yerevan' }])).toBe('Yerevan');
    });

    test('the region outranks a stale city on the events', () => {
        expect(huntCity({ regionCity: 'Dubai' }, [{ city: 'Yerevan' }])).toBe('Dubai');
    });

    test('address fragments are still refused', () => {
        expect(huntCity({ regionCity: '10/9' }, [])).toBeNull();
        expect(huntCity({ regionCity: '0002' }, [{ city: '6/2 Hyusisayin' }])).toBeNull();
    });

    test('nothing known at all is null, not a guess', () => {
        expect(huntCity({}, [])).toBeNull();
        expect(huntCity()).toBeNull();
        expect(huntCity({ regionCity: null }, [{ city: null }, null])).toBeNull();
    });
});
