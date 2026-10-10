// Founder 2026-10-10: "it always says 400 m away — it cannot see my MacBook's GPS". A city centre is never "the traveler".
const { systemPrompt } = require('../engine/agent/deckAgent');
const { toRecommendation, factDescription } = require('../engine/narrator/cards');

describe('distance honesty', () => {
    const base = { langName: 'English', dateNote: 'Friday', preferences: {}, lastDeck: [], lastQuestion: null, activeDestination: null };
    test('a city centre is presented as the search centre, never as where the traveler is', () => {
        const p = systemPrompt({ ...base, traveler: { lat: 40.177, lng: 44.504, label: 'Yerevan', isTraveler: false } });
        expect(p).toContain('Search centre: the centre of Yerevan');
        expect(p).toContain("traveler's own position is NOT known");
        expect(p).not.toContain('Traveler is at');
    });
    test('a real position is still the traveler', () => {
        const p = systemPrompt({ ...base, traveler: { lat: 40.18, lng: 44.51, label: 'Yerevan', isTraveler: true } });
        expect(p).toContain('Traveler is at: Yerevan');
    });
    test('cards: "from the centre of X" and no distance chip when the centre is not the traveler', () => {
        const place = { name: 'Level Eleven', distanceKm: 0.4, source: 'destination' };
        expect(factDescription(place, 'Restaurant', false, 'Yerevan')).toContain('0.4 km from the centre of Yerevan');
        expect(factDescription(place, 'Restaurant', true, 'Yerevan')).toContain('0.4 km away');
        expect(toRecommendation(place, 0, { nearbyMode: true, centreIsTraveler: false, centreLabel: 'Yerevan' }).distance).toBeUndefined();
        expect(toRecommendation(place, 0, { nearbyMode: true, centreIsTraveler: true }).distance).toBe('0.4 km');
    });
});
