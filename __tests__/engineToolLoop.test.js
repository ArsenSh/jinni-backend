// Tests for the V2 agentic tool loop: the capped loop mechanics, the
// get_place_details executor (session-first identity, honest nulls), and the
// tool-answer prompt rules. Fake provider + fake lookup — fully offline.

const { runToolLoop, MAX_ITERATIONS } = require('../engine/narrator/toolLoop');
const { PLACE_DETAILS_TOOL, makeExecutors } = require('../engine/narrator/tools');
const { buildToolAnswerMessages } = require('../engine/narrator/prompts/grounded');
const { shownPlaces } = require('../engine/context/session');

const toolCallMsg = (name, args, id = 'c1') => ({
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});

describe('runToolLoop', () => {
    test('call → result → final answer; usage summed; conversation carries the tool result', async () => {
        const seenConvos = [];
        const provider = {
            completeWithTools: async ({ messages }) => {
                seenConvos.push(messages.length);
                if (seenConvos.length === 1) {
                    return { message: toolCallMsg('get_place_details', { name: 'Nairi' }), usage: { in: 10, out: 5 } };
                }
                return { message: { content: 'Nairi\'s phone is +374...' }, usage: { in: 20, out: 8 } };
            },
        };
        const out = await runToolLoop({
            messages: [{ role: 'user', content: 'phone of Nairi?' }],
            tools: [PLACE_DETAILS_TOOL],
            execute: { get_place_details: async ({ name }) => ({ name, phone: '+374...' }) },
        }, { provider });
        expect(out.text).toContain('+374');
        expect(out.toolCalls).toHaveLength(1);
        expect(out.toolCalls[0].result.phone).toBe('+374...');
        expect(out.usage).toEqual({ in: 30, out: 13, cacheRead: 0, cacheWrite: 0 });
        expect(out.iterations).toBe(2);
        expect(seenConvos[1]).toBe(3);   // user + assistant(tool_calls) + tool result
    });

    test('iteration cap: the final round runs WITHOUT tools, forcing an answer', async () => {
        const toolsSeen = [];
        const provider = {
            completeWithTools: async ({ tools }) => {
                toolsSeen.push(!!tools);
                if (tools) return { message: toolCallMsg('get_place_details', { name: 'X' }, `c${toolsSeen.length}`), usage: {} };
                return { message: { content: 'best I can say' }, usage: {} };
            },
        };
        const out = await runToolLoop({
            messages: [], tools: [PLACE_DETAILS_TOOL],
            execute: { get_place_details: async () => ({ ok: 1 }) },
        }, { provider });
        expect(out.iterations).toBe(MAX_ITERATIONS);
        expect(toolsSeen[MAX_ITERATIONS - 1]).toBe(false);   // last round tool-less
        expect(out.text).toBe('best I can say');
    });

    test('unknown tool and throwing executors become error results, never crashes', async () => {
        let round = 0;
        const provider = {
            completeWithTools: async () => {
                round++;
                if (round === 1) return { message: { tool_calls: [
                    { id: 'a', function: { name: 'nope', arguments: '{}' } },
                    { id: 'b', function: { name: 'get_place_details', arguments: 'not json' } },
                ] }, usage: {} };
                return { message: { content: 'done' }, usage: {} };
            },
        };
        const out = await runToolLoop({
            messages: [], tools: [PLACE_DETAILS_TOOL],
            execute: { get_place_details: async () => { throw new Error('boom'); } },
        }, { provider });
        expect(out.toolCalls[0].result.error).toMatch(/unknown_tool/);
        expect(out.toolCalls[1].result.error).toMatch(/tool_failed: boom/);
        expect(out.text).toBe('done');
    });

    test('provider without completeWithTools is rejected loudly', async () => {
        await expect(runToolLoop({ messages: [] }, { provider: {} })).rejects.toThrow(/completeWithTools is required/);
    });
});

describe('get_place_details executor', () => {
    const CARDS = [{ name: 'Nairi Restaurant', placeId: 'gp-nairi' }];

    test('session-first identity: the shown card\'s placeId reaches the lookup', async () => {
        let seen = null;
        const ex = makeExecutors({ sessionPlaces: CARDS }, {
            lookup: async (name, knownPlaceId) => { seen = knownPlaceId; return { name: 'Nairi Restaurant', formatted_phone_number: '+374 10' }; },
        });
        const r = await ex.get_place_details({ name: 'Nairi' });
        expect(seen).toBe('gp-nairi');
        expect(r.phone).toBe('+374 10');
    });
    test('honest nulls for missing fields; hours from weekday_text', async () => {
        const ex = makeExecutors({}, { lookup: async () => ({
            name: 'X', website: null, rating: 4.5,
            opening_hours: { weekday_text: ['Mon: 9–17'] },
        }) });
        const r = await ex.get_place_details({ name: 'X' });
        expect(r.phone).toBe(null);
        expect(r.website).toBe(null);
        expect(r.rating).toBe(4.5);
        expect(r.hours).toEqual(['Mon: 9–17']);
    });
    test('not found / failure / missing name are explicit errors', async () => {
        const notFound = makeExecutors({}, { lookup: async () => null });
        expect((await notFound.get_place_details({ name: 'Ghost' })).error).toBe('not_found');
        const failing = makeExecutors({}, { lookup: async () => { throw new Error('db'); } });
        expect((await failing.get_place_details({ name: 'X' })).error).toMatch(/lookup_failed/);
        expect((await notFound.get_place_details({})).error).toBe('name_required');
    });
});

describe('buildToolAnswerMessages + shownPlaces', () => {
    test('prompt keeps the round-61 honesty rules: inward to More, never Google', () => {
        const msgs = buildToolAnswerMessages({ message: 'phone of Nairi?', langName: 'Russian' });
        expect(msgs[0].content).toContain('NEVER tell the traveler to look a place up on Google');
        expect(msgs[0].content).toContain('tap More');
        expect(msgs[0].content).toContain('Reply in Russian');
    });
    test('shownPlaces: name→placeId pairs, first occurrence wins', () => {
        const pairs = shownPlaces([
            { recommendations: [{ name: 'Nairi Restaurant', placeId: 'gp1' }] },
            { recommendations: [{ name: 'Nairi Restaurant', placeId: 'gp-other' }, { name: 'Sherep', placeId: null }] },
        ]);
        expect(pairs).toEqual([
            { name: 'Nairi Restaurant', placeId: 'gp1' },
            { name: 'Sherep', placeId: null },
        ]);
    });
});

// ── Flights (Travelpayouts): built ready for the token, Arsen 2026-08-23 ──
describe('find_flights: real fares or none, never remembered prices', () => {
    const { searchFlights, resolveIata, flightsEnabled, _bookUrl } = require('../engine/travel/flights');
    const { makeExecutors } = require('../engine/narrator/tools');
    const ENV = { TRAVELPAYOUTS_TOKEN: 'tok', TRAVELPAYOUTS_MARKER: '12345' };
    const API = {
        success: true,
        data: [{
            origin: 'DXB', destination: 'EVN', price: 210, airline: 'FZ', flight_number: '1751',
            departure_at: '2026-09-04T07:15:00+04:00', transfers: 0, duration: 195,
            link: '/search/DXB0409EVN1?t=abc',
        }],
    };
    const fetchOk = async (url) => ({
        ok: true,
        json: async () => (url.includes('autocomplete')
            ? [{ code: url.includes('Dubai') ? 'DXB' : 'EVN', name: 'City', type: 'city' }]
            : API),
    });

    test('off without a token — the feature simply is not offered', async () => {
        expect(flightsEnabled({})).toBe(false);
        expect(await searchFlights({ origin: 'Dubai', destination: 'Yerevan' }, { env: {}, fetch: fetchOk })).toBeNull();
    });

    test('city names resolve to IATA; offers normalize with an affiliate link', async () => {
        const r = await searchFlights({ origin: 'Dubai', destination: 'Yerevan', departDate: '2026-09' },
            { env: ENV, fetch: fetchOk });
        expect(r.origin).toBe('DXB');
        expect(r.destination).toBe('EVN');
        expect(r.offers[0]).toMatchObject({ price: 210, airline: 'FZ', transfers: 0, flightNumber: 'FZ1751' });
        expect(r.offers[0].bookUrl).toBe('https://www.aviasales.com/search/DXB0409EVN1?t=abc&marker=12345');
        expect(await resolveIata('evn', { env: ENV, fetch: fetchOk })).toBe('EVN');   // already a code
    });

    test('API failure returns null, and the executor forbids quoting a price', async () => {
        const dead = async () => ({ ok: false });
        expect(await searchFlights({ origin: 'Dubai', destination: 'Yerevan' }, { env: ENV, fetch: dead })).toBeNull();
        const exec = makeExecutors({}, { searchFlights: async () => null });
        const out = await exec.find_flights({ origin: 'Dubai', destination: 'Yerevan' });
        expect(out.offers).toEqual([]);
        expect(out.note).toMatch(/do not state any price/);
        expect((await exec.find_flights({ origin: 'Dubai' })).error).toBe('origin_and_destination_required');
    });

    test('no marker configured → plain booking link, still a real one', () => {
        expect(_bookUrl('/search/x', {})).toBe('https://www.aviasales.com/search/x');
    });
});

describe('get_place_details session-card selection (the Dilijan Park Resort conflation, 2026-08-30)', () => {
    const { makeExecutors } = require('../engine/narrator/tools');
    const cards = [
        { name: 'Black Diamond Sevan', placeId: 'dest_black' },
        { name: 'Tufenkian Old Dilijan Complex', placeId: 'pid_tufenkian' },
        { name: 'Dilijan Park Resort & Villas', placeId: 'pid_resort' },
    ];
    const spyLookup = () => {
        const calls = [];
        return { calls, lookup: async (nameOrId, knownPlaceId) => { calls.push(knownPlaceId); return { name: nameOrId, place_id: knownPlaceId }; } };
    };
    test('the asked card wins over an earlier card sharing only the city token', async () => {
        const { calls, lookup } = spyLookup();
        const ex = makeExecutors({ sessionPlaces: cards }, { lookup });
        await ex.get_place_details({ name: 'Dilijan Park Resort & Villas' });
        expect(calls[0]).toBe('pid_resort');          // was pid_tufenkian before the fix
    });
    test('a distinctive-name ask still resolves to its own card', async () => {
        const { calls, lookup } = spyLookup();
        const ex = makeExecutors({ sessionPlaces: cards }, { lookup });
        await ex.get_place_details({ name: 'tell me about Tufenkian Old Dilijan Complex' });
        expect(calls[0]).toBe('pid_tufenkian');
    });
    test('an unknown name passes no session placeId (fresh resolve)', async () => {
        const { calls, lookup } = spyLookup();
        const ex = makeExecutors({ sessionPlaces: cards }, { lookup });
        await ex.get_place_details({ name: 'Some Totally Other Hotel' });
        expect(calls[0]).toBe(null);
    });
});

describe('makeExecutors: onPlace side-channel (first-mention card)', () => {
    test('the full doc reaches ctx.onPlace; the model still gets the slim projection', async () => {
        const doc = { name: 'Kamancha', place_id: 'pid1', rating: 4.2,
            formatted_address: '23 Tumanyan St', geometry: { location: { lat: 40.18, lng: 44.51 } } };
        const seen = [];
        const ex = makeExecutors({ sessionPlaces: [], onPlace: (d) => seen.push(d) }, { lookup: async () => doc });
        const out = await ex.get_place_details({ name: 'Kamancha' });
        expect(seen).toHaveLength(1);
        expect(seen[0].geometry.location.lat).toBe(40.18);
        expect(out.rating).toBe(4.2);
        expect(out.geometry).toBeUndefined();
    });
    test('a throwing onPlace never breaks the tool', async () => {
        const ex = makeExecutors({ onPlace: () => { throw new Error('x'); } },
            { lookup: async () => ({ name: 'A', place_id: 'p' }) });
        const out = await ex.get_place_details({ name: 'A' });
        expect(out.name).toBe('A');
    });
});

describe('get_place_details: OWNED rows answer before PlaceCache/Google', () => {
    test('a Destination hit short-circuits the cache/google lookup', async () => {
        let googleCalled = false;
        const owned = { name: 'Kamancha', place_id: 'dest_abc', rating: 4.2,
            formatted_address: '23 Tumanyan St', formatted_phone_number: '095 711700',
            website: 'kamancharest.com', _weekdayText: ['Monday: 10:00 – 00:00'],
            geometry: { location: { lat: 40.18, lng: 44.51 } }, image: '/api/ai/place-image/dest_abc/0', _owned: 'destination' };
        const seen = [];
        const ex = makeExecutors({ onPlace: (d) => seen.push(d) }, {
            ownedLookup: async () => owned,
            lookup: async () => { googleCalled = true; return { name: 'x' }; },
        });
        const out = await ex.get_place_details({ name: 'Kamancha' });
        expect(googleCalled).toBe(false);
        expect(out.placeId).toBe('dest_abc');
        expect(out.hours).toEqual(['Monday: 10:00 – 00:00']);
        expect(seen[0].image).toBe('/api/ai/place-image/dest_abc/0');
    });
    test('no owned row -> falls through to the normal lookup', async () => {
        const ex = makeExecutors({}, {
            ownedLookup: async () => null,
            lookup: async () => ({ name: 'Cachey', place_id: 'p2', rating: 4.0 }),
        });
        const out = await ex.get_place_details({ name: 'Cachey' });
        expect(out.name).toBe('Cachey');
        expect(out.placeId).toBe('p2');
    });
});

describe('ownedLookup shorthand tier (via injected deps it is bypassed; test the tool with a partial-name owned hit)', () => {
    test('owned row still answers when deps.ownedLookup resolves a shorthand', async () => {
        const owned = { name: "Yasaman Tsaghkadzor's Restaurant", place_id: 'dest_y1', rating: 4.7,
            geometry: { location: { lat: 40.53, lng: 44.72 } }, _owned: 'destination' };
        const ex = makeExecutors({}, { ownedLookup: async (nm) => /yasaman/i.test(nm) ? owned : null,
            lookup: async () => { throw new Error('must not reach google'); } });
        const out = await ex.get_place_details({ name: 'Yasaman Tsaghkadzor' });
        expect(out.name).toBe("Yasaman Tsaghkadzor's Restaurant");
    });
});

describe('cross-script + qualifier fixes (live 2026-09-05)', () => {
    test('implausible cache resolution is an honest miss, not an answer', async () => {
        const ex = makeExecutors({}, {
            ownedLookup: async () => null,
            lookup: async () => ({ name: 'Matenadaran', place_id: 'pM', rating: 4.7 }),
        });
        const out = await ex.get_place_details({ name: 'Ясаман' });
        expect(out.error).toBe('not_found');
    });
    test('cross-script match to the RIGHT place still passes', async () => {
        const ex = makeExecutors({}, {
            ownedLookup: async () => null,
            lookup: async () => ({ name: "Yasaman Yerevan's Restaurant", place_id: 'pY', rating: 4.7 }),
        });
        const out = await ex.get_place_details({ name: 'Ясаман' });
        expect(out.name).toBe("Yasaman Yerevan's Restaurant");
    });
});
