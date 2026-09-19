// Deck agent (founder 2026-09-18): a fake model exercises the loop — the
// invariants live in code, whatever the model says.
const { runDeckAgent, SEARCH_BUDGET } = require('../engine/agent/deckAgent');

const call = (name, args, id = 'c1') => ({ id, function: { name, arguments: JSON.stringify(args) } });
const fakeProvider = (script) => {
    let i = 0;
    return { completeWithTools: async () => ({ message: { content: null, tool_calls: script[i++] || [] }, usage: { in: 10, out: 5 } }) };
};
const SEVAN = { name: 'Lake Sevan', lat: 40.35, lng: 45.2, kind: 'landmark', waterBody: true, population: 0, countryName: 'Armenia' };
const HOTEL = (name, km) => ({ placeId: `g_${name}`, name, source: 'cache', distanceKm: km, rating: 4.5, types: ['hotel'], interests: ['nature'] });

describe('deck agent', () => {
    test('an events search reports how the listings were obtained', async () => {
        const call = (name, args, id = 'c1') => ({ id, function: { name, arguments: JSON.stringify(args) } });
        let i = 0; const script = [[call('search_places', { query: 'concerts', category: 'events' })], [call('ask_traveler', { question: 'Which night?' }, 'c2')]];
        const provider = { completeWithTools: async () => ({ message: { content: null, tool_calls: script[i++] || [] }, usage: {} }) };
        const out = await runDeckAgent({ message: 'events?', traveler: { lat: 40.2, lng: 44.5 } }, {
            provider, lookup: async () => null,
            retrieve: async (args) => { args.eventsHunt.onStats({ mode: 'web_search', pages_read: 3, found: 0, budget_cut: true }); return { places: [] }; },
        });
        expect(out.toolCalls[0].result.events_listings).toMatchObject({ mode: 'web_search', pages_read: 3, budget_cut: true });
        expect(out.toolCalls[0].result.events_note).toMatch(/web search/);
    });
    test('summary tells events from venues', () => {
        const { summarize } = require('../engine/agent/deckAgent');
        expect(summarize({ name: 'Opera', eventSchedule: { startDate: '2026-09-24T15:00:00.000Z' } })).toMatchObject({ is_dated_event: true, event_start: '2026-09-24 15:00 UTC' });
        expect(summarize({ name: 'Tashir Arena', types: ['event_venue'] })).toMatchObject({ is_dated_event: false, event_start: null });
    });
    test('looks up the lake, searches its shore, deals only returned ids', async () => {
        const searches = [];
        const out = await runDeckAgent({ message: 'I want to stay near a lake for several days', traveler: { lat: 40.2, lng: 44.5, label: 'Yerevan' }, findArgsBase: { preferences: { travelStyle: 'luxury' } } }, {
            provider: fakeProvider([
                [call('lookup_place', { name: 'Lake Sevan' })],
                [call('search_places', { query: 'luxury lakefront hotel', category: 'hotels', centre: 'Lake Sevan', radius_km: 40 })],
                [call('deal', { intro: 'Two lakeside stays on Sevan.', cards: [{ id: 'p2', blurb: 'On the shore.' }, { id: 'p1', blurb: 'Near the town.' }, { id: 'ghost', blurb: 'invented' }], question: 'Spa or beach?' })],
            ]),
            retrieve: async (args) => { searches.push(args); return { places: [HOTEL('Noy Land', 4), HOTEL('Black Diamond', 6)], provenance: {} }; },
            lookup: async () => SEVAN,
        });
        expect(out.kind).toBe('deal');
        expect(out.places.map(p => p.name)).toEqual(['Black Diamond', 'Noy Land']);   // model's order, ghost dropped
        expect(out.blurbs).toEqual(['On the shore.', 'Near the town.']);
        expect(out.question).toBe('Spa or beach?');
        expect(searches[0].center).toEqual({ lat: 40.35, lng: 45.2 });
        expect(searches[0].radiusKm).toBe(40);
        expect(searches[0].preferences.travelStyle).toBe('luxury');
        expect(out.toolCalls.map(c => c.name)).toEqual(['lookup_place', 'search_places', 'deal']);
    });
    test('a deal with no valid ids is refused; the model can still ask', async () => {
        const out = await runDeckAgent({ message: 'x', traveler: { lat: 40.2, lng: 44.5 } }, {
            provider: fakeProvider([
                [call('deal', { intro: 'made up', cards: [{ id: 'nope', blurb: 'x' }] })],
                [call('ask_traveler', { question: 'Which lake?' })],
            ]),
            retrieve: async () => ({ places: [] }), lookup: async () => null,
        });
        expect(out.kind).toBe('ask');
        expect(out.question).toBe('Which lake?');
        expect(out.toolCalls[0].result.error).toBe('no_valid_cards');
    });
    test('the search budget is enforced in code', async () => {
        const script = [];
        for (let i = 0; i < SEARCH_BUDGET + 1; i++) script.push([call('search_places', { query: 'q', category: 'hotels' }, `s${i}`)]);
        script.push([call('ask_traveler', { question: 'q?' })]);
        const out = await runDeckAgent({ message: 'x', traveler: { lat: 40.2, lng: 44.5 } }, {
            provider: fakeProvider(script), retrieve: async () => ({ places: [HOTEL('A', 1)] }), lookup: async () => null,
        });
        const errs = out.toolCalls.filter(c => c.result && c.result.error === 'search_budget_exhausted');
        expect(errs).toHaveLength(1);
        expect(out.searches).toBe(SEARCH_BUDGET);
    });
    test('never throws: a provider failure is a fail result, not an exception', async () => {
        const out = await runDeckAgent({ message: 'x' }, { provider: { completeWithTools: async () => { throw new Error('down'); } }, retrieve: async () => ({ places: [] }) });
        expect(out.kind).toBe('fail');
    });
});
