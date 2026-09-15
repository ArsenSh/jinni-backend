// Per-request capture of the engine's console lines (founder 2026-09-16: the
// admin Sessions tab shows what the engine printed while deciding).
const { runWithLog, capture, MAX_LINES } = require('../engine/utils/requestLog');

describe('requestLog', () => {
    test('lines printed inside a request are captured, with a timestamp, and still printed', () => {
        const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const got = runWithLog(() => {
            console.log('[v3] controller controller lane=deck');
            console.warn('[narrator] slow');
            return capture();
        });
        spy.mockRestore();
        expect(got).toHaveLength(2);
        expect(got[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[v3\] controller controller lane=deck$/);
        expect(got[1]).toMatch(/\[narrator\] slow$/);
    });

    test('outside a request nothing is captured, and capture() is empty', () => {
        expect(capture()).toEqual([]);
    });

    test('async continuations stay inside the request buffer', async () => {
        const got = await runWithLog(async () => {
            await new Promise(r => setTimeout(r, 5));
            console.log('after await');
            return capture();
        });
        expect(got.map(l => l.slice(13))).toEqual(['after await']);
    });

    test('the buffer is capped so a runaway loop cannot grow a turn record without bound', () => {
        const got = runWithLog(() => {
            for (let i = 0; i < MAX_LINES + 50; i++) console.log('line', i);
            return capture();
        });
        expect(got).toHaveLength(MAX_LINES);
    });

    test('objects and errors are rendered, long lines are cut', () => {
        const got = runWithLog(() => {
            console.log('obj', { a: 1 });
            console.error(new Error('boom'));
            console.log('x'.repeat(2000));
            return capture();
        });
        expect(got[0]).toMatch(/obj \{"a":1\}$/);
        expect(got[1]).toMatch(/boom$/);
        expect(got[2].length).toBeLessThanOrEqual(13 + 500);
    });
});
