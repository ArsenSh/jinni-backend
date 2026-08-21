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
