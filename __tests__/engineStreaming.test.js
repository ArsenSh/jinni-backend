// Tests for V2 true streaming: the delimiter splitter (prose live, tail
// private), the SSE delta parser (v1's chunk-boundary lesson), the streamed
// narration prompt/tail, and the narrator realStream contract.

const { DelimitedSplitter, CARDS_DELIMITER } = require('../engine/narrator/streamSplit');
const { _sseDeltas } = require('../engine/narrator/providers/deepseek');
const { buildStreamedNarrationMessages, parseCardsTail } = require('../engine/narrator/prompts/grounded');
const narrator = require('../engine/narrator');

describe('DelimitedSplitter', () => {
    const run = (chunks) => {
        const out = [];
        const s = new DelimitedSplitter((t) => out.push(t));
        for (const c of chunks) s.feed(c);
        const tail = s.finalize();
        return { emitted: out.join(''), tail, prose: s.prose };
    };

    test('prose streams; tail after the delimiter stays private', () => {
        const { emitted, tail } = run(['Nairi is lovely. ', '<<<CARDS>>>{"cards":[]}']);
        expect(emitted).toBe('Nairi is lovely. ');
        expect(tail).toBe('{"cards":[]}');
    });
    test('delimiter split ACROSS chunks never leaks to the user', () => {
        const { emitted, tail } = run(['Great spot! <<<CA', 'RDS>>>{"x":1}']);
        expect(emitted).toBe('Great spot! ');
        expect(tail).toBe('{"x":1}');
    });
    test('angle brackets that are NOT the delimiter flush as prose on finalize', () => {
        const { emitted, tail } = run(['temperature is <<<']);
        expect(emitted).toBe('temperature is <<<');
        expect(tail).toBe(null);
    });
    test('no delimiter at all → everything is prose, tail null', () => {
        const { emitted, tail, prose } = run(['Just a plain ', 'answer.']);
        expect(emitted).toBe('Just a plain answer.');
        expect(prose).toBe('Just a plain answer.');
        expect(tail).toBe(null);
    });
    test('tail spread over many chunks accumulates', () => {
        const { tail } = run(['ok<<<CARDS>>>{"cards":[{"i"', ':0,"blurb":"x"}]}']);
        expect(JSON.parse(tail).cards[0].blurb).toBe('x');
    });
});

describe('_sseDeltas (chunk-boundary safe SSE parsing)', () => {
    test('a JSON line split mid-chunk is buffered, not dropped (v1 lesson)', () => {
        const first = _sseDeltas('data: {"choices":[{"delta":{"content":"Hel');
        expect(first.deltas).toEqual([]);
        expect(first.rest).toContain('"Hel');
        const second = _sseDeltas(first.rest + 'lo"}}]}\n');
        expect(second.deltas).toEqual(['Hello']);
        expect(second.rest).toBe('');
    });
    test('[DONE] flags completion; malformed lines never throw', () => {
        const r = _sseDeltas('data: not-json\ndata: {"choices":[{"delta":{"content":"A"}}]}\ndata: [DONE]\n');
        expect(r.deltas).toEqual(['A']);
        expect(r.done).toBe(true);
    });
});

describe('streamed narration prompt + tail', () => {
    test('prompt demands prose first, then the delimiter, and a blurb for EVERY index', () => {
        const msgs = buildStreamedNarrationMessages({ query: 'dinner', places: [{ name: 'A' }, { name: 'B' }] });
        expect(msgs[0].content).toContain('FIRST write');
        expect(msgs[0].content).toContain(CARDS_DELIMITER);
        expect(msgs[0].content).toContain('EVERY listed index (0..1)');
    });
    test('parseCardsTail: valid tail; junk → null', () => {
        const parsed = parseCardsTail('{"cards":[{"i":0,"blurb":"Cozy."},{"i":1,"blurb":"Lively."}],"question":"Vibe?"}', 2);
        expect(parsed.blurbs).toEqual(['Cozy.', 'Lively.']);
        expect(parsed.question).toBe('Vibe?');
        expect(parseCardsTail('garbage', 2)).toBe(null);
    });
});

describe('narrator realStream', () => {
    test('routes to provider.streamText and forwards deltas', async () => {
        const seen = [];
        const fake = {
            streamText: async ({ onDelta }) => {
                onDelta('Hel'); onDelta('lo');
                return { text: 'Hello', usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0, estimated: true }, searches: [], searchCount: 0 };
            },
            complete: async () => { throw new Error('must not be called'); },
        };
        const out = await narrator.stream({ messages: [], realStream: true, onToken: (d) => seen.push(d) }, { provider: fake });
        expect(seen.join('')).toBe('Hello');
        expect(out.usage.estimated).toBe(true);
    });
    test('providers without streamText fall back to pseudo-stream', async () => {
        const seen = [];
        const fake = { complete: async () => ({ text: 'Plain answer here.', usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, searches: [], searchCount: 0 }) };
        const out = await narrator.stream({ messages: [], realStream: true, onToken: (d) => seen.push(d) }, { provider: fake });
        expect(seen.join('')).toBe('Plain answer here.');
        expect(out.text).toBe('Plain answer here.');
    });
});
