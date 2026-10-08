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
