const { joinSpelled, sttPrompt } = require('../routes/voiceRoutes')._test;

describe('voice speech-to-text helpers (2026-10-09)', () => {
    test('letters spoken one by one become one word', () => {
        expect(joinSpelled('I mean A, M, A, R restaurant')).toBe('I mean Amar restaurant');
        expect(joinSpelled('a-m-a-r')).toBe('Amar');
        expect(joinSpelled('a m a r and cafe')).toBe('Amar and cafe');
    });
    test('ordinary sentences are left alone', () => {
        expect(joinSpelled('I am at a bar')).toBe('I am at a bar');
        expect(joinSpelled('Room B is ok')).toBe('Room B is ok');
        expect(joinSpelled('')).toBe('');
    });
    test('the prompt lists hints first, without duplicates, and stays short', () => {
        const p = sttPrompt(['Amar Restaurant and Cafe', 'Mohana at Epos'], ['Cascade Complex', 'amar restaurant and cafe']);
        expect(p).toBe('Jinni is a travel app; the user may say place names such as: Amar Restaurant and Cafe, Mohana at Epos, Cascade Complex.');
        const long = sttPrompt(Array.from({ length: 200 }, (_, i) => 'Place number ' + i), []);
        expect(long.length).toBeLessThanOrEqual(905);
    });
});

describe('ElevenLabs keyterms (2026-10-09)', () => {
    const { keyterms, sttProvider } = require('../routes/voiceRoutes')._test;
    test('Jinni first, no duplicates, at most 5 words and under 50 characters each, at most 90', () => {
        const t = keyterms(['Amar Restaurant and Cafe', 'The Pool by Seven Visions Resort and Places, The Dvin'], ['amar restaurant and cafe', 'Cascade Complex']);
        expect(t).toEqual(['Jinni', 'Amar Restaurant and Cafe', 'The Pool by Seven Visions', 'Cascade Complex']);
        expect(keyterms(Array.from({ length: 300 }, (_, i) => 'Place ' + i), []).length).toBe(90);
        expect(keyterms(['x'.repeat(80)], [])[1].length).toBeLessThan(50);
    });
    test('provider: ElevenLabs when its key is set, OpenAI when only that one is, none otherwise', () => {
        const env = { ...process.env };
        delete process.env.STT_PROVIDER; delete process.env.WHISPER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_BASE_URL;
        process.env.ELEVENLABS_API_KEY = 'el'; expect(sttProvider()).toBe('elevenlabs');
        delete process.env.ELEVENLABS_API_KEY; process.env.OPENAI_API_KEY = 'oa'; expect(sttProvider()).toBe('openai');
        delete process.env.OPENAI_API_KEY; expect(sttProvider()).toBe(null);
        process.env = env;
    });
});
