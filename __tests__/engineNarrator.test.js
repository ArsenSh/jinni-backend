// Tests for the V2 narrator v0: grounded prompt builders (pure) and the
// stream contract with an injected fake provider — no API keys, no network.

const { buildGroundedMessages, buildChitchatMessages, placeFactLine } = require('../engine/narrator/prompts/grounded');
const narrator = require('../engine/narrator');

describe('placeFactLine', () => {
    test('renders only the facts we actually hold', () => {
        const line = placeFactLine({
            name: 'Uzbechka', primaryType: 'restaurant', distanceKm: 1.234,
            rating: 4.4, _openNow: true, source: 'cache',
        });
        expect(line).toBe('- Uzbechka (restaurant, 1.2 km away, rated 4.4, open now)');
    });
    test('unknown open state is simply absent — never asserted', () => {
        expect(placeFactLine({ name: 'X', source: 'cache' })).toBe('- X');
    });
    test('validator/partner provenance is stated', () => {
        expect(placeFactLine({ name: 'Matenadaran', source: 'destination' })).toContain('verified by Jinni staff');
        expect(placeFactLine({ name: 'Tashir', source: 'business' })).toContain('Jinni partner');
    });
});

describe('buildGroundedMessages', () => {
    const msgs = buildGroundedMessages({
        query: 'uzbek restaurant',
        places: [{ name: 'Uzbechka', distanceKm: 1, rating: 4.4, source: 'cache' }],
        langName: 'Russian',
        timeNote: 'late night (03:00 local)',
    });
    test('system prompt carries the grounding rules and the reply language', () => {
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('ONLY from the list');
        expect(msgs[0].content).toContain('Reply in Russian');
        expect(msgs[0].content).toContain('say so honestly');
    });
    test('user message carries the query, the time note and the fact lines', () => {
        expect(msgs[1].content).toContain('uzbek restaurant');
        expect(msgs[1].content).toContain('late night (03:00 local)');
        expect(msgs[1].content).toContain('- Uzbechka');
    });
});

describe('buildChitchatMessages', () => {
    test('no place list; explicitly forbids naming venues', () => {
        const msgs = buildChitchatMessages({ message: 'Hi', langName: 'English' });
        expect(msgs[0].content).toContain('Do NOT recommend or name any specific real place');
        expect(msgs[1].content).toBe('Hi');
    });
});

describe('narrator.stream (contract, fake provider)', () => {
    test('pseudo-streams the text through onToken and returns real usage', async () => {
        const chunks = [];
        const fake = { complete: async () => ({ text: 'Hello traveler, welcome to Yerevan tonight.', usage: { in: 10, out: 8, cacheRead: 0, cacheWrite: 0 }, searches: [], searchCount: 0 }) };
        const out = await narrator.stream({ messages: [], onToken: (c) => chunks.push(c) }, { provider: fake });
        expect(chunks.join('')).toBe('Hello traveler, welcome to Yerevan tonight.');
        expect(out.usage).toEqual({ in: 10, out: 8, cacheRead: 0, cacheWrite: 0 });
    });
    test('tool-use is honestly unimplemented', async () => {
        await expect(narrator.stream({ messages: [], tools: [{}] })).rejects.toThrow(/tool-use loop not implemented/);
    });
});
