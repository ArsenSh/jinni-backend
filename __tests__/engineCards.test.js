// Tests for V2 card emission — the payload must match v1's chat-rec shape
// field-for-field, since JinniChat renders it unchanged.

const { toRecommendation, buildContentParts, hoistNarrated, categoryFor, factDescription } = require('../engine/narrator/cards');

const CAND = {
    placeId: 'gp123',
    name: 'Tufenkian Heritage Hotels',
    source: 'cache',
    rating: 4.6,
    types: ['lodging', 'hotel'],
    primaryType: 'hotel',
    geometry: { lat: 40.18, lng: 44.51 },
    distanceKm: 5.83,
    city: 'Yerevan',
    country: 'Armenia',
    _openNow: true,
};

describe('toRecommendation (v1 payload parity)', () => {
    const rec = toRecommendation(CAND, 2, { action: 'hotels' });
    test('carries every v1 field the frontend reads', () => {
        for (const key of ['id', 'name', 'category', 'type', 'description', 'region', 'location',
                           'image', 'cachedImageUrl', 'source', 'verifiedId', 'isPartner', 'partnerTier',
                           '_verifiedModel', 'placeId', 'latitude', 'longitude', 'website', 'phone',
                           'isChatRecommendation', 'isLargeCard', 'appearsInline', 'isStreaming',
                           'eventSchedule', '_isExpired', '_action', 'metadata']) {
            expect(rec).toHaveProperty(key);
        }
        expect(rec.isChatRecommendation).toBe(true);
        expect(rec.isLargeCard).toBe(true);
        expect(rec.appearsInline).toBe(true);
        expect(rec.isStreaming).toBe(false);
    });
    test('identity, coords, image endpoint, action', () => {
        expect(rec.name).toBe('Tufenkian Heritage Hotels');
        expect(rec.category).toBe('Hotel');
        expect(rec.type).toBe('hotel');
        expect(rec.placeId).toBe('gp123');
        expect(rec.latitude).toBe(40.18);
        expect(rec.longitude).toBe(44.51);
        expect(rec.image).toBe('/api/ai/place-image/gp123/0');
        expect(rec.cachedImageUrl).toBe('/api/ai/place-image/gp123/0');
        expect(rec._action).toBe('hotels');
        expect(rec.metadata.originalPosition).toBe(2);
        expect(rec.metadata.detectedActionType).toBe('hotels');
    });
    test('validator rows: verifiedId + model set; explicit image wins over endpoint', () => {
        const v = toRecommendation({ ...CAND, source: 'destination', verifiedId: 'abc',
            placeId: null, image: 'https://cdn/img.jpg' }, 0, { action: 'hotels' });
        expect(v._verifiedModel).toBe('destination');
        expect(v.verifiedId).toBe('abc');
        expect(v.source).toBe('database');
        expect(v.image).toBe('https://cdn/img.jpg');
        expect(v.cachedImageUrl).toBe(null);
    });
    test('distance only rides in nearbyMode (v1 behavior)', () => {
        expect(toRecommendation(CAND, 0, { action: 'hotels' }).distance).toBeUndefined();
        expect(toRecommendation(CAND, 0, { action: 'hotels', nearbyMode: true }).distance).toBe('5.8 km');
    });
    test('description asserts only held facts', () => {
        expect(factDescription(CAND, 'Hotel')).toBe('Hotel · 5.8 km away · rated 4.6 · open now');
        expect(factDescription({ name: 'X' }, 'Attraction')).toBe('Attraction');
    });
});

describe('hoistNarrated (prose and deck agree — the DABOO/COBA case)', () => {
    const PLACES = [{ name: 'Equestrian Center' }, { name: 'COBA' }, { name: 'DABOO Cocktail Bar' }];
    const BLURBS = ['daytime spot', 'open late', 'best tonight'];
    test('intro-named places lead the deck, blurbs ride along, others keep order', () => {
        const { places, blurbs } = hoistNarrated(
            'Head to DABOO Cocktail Bar or COBA for a social night.', PLACES, BLURBS);
        expect(places.map(p => p.name)).toEqual(['COBA', 'DABOO Cocktail Bar', 'Equestrian Center']);
        expect(blurbs).toEqual(['open late', 'best tonight', 'daytime spot']);
    });
    test('no mentions or empty intro → untouched', () => {
        expect(hoistNarrated('Nothing named here.', PLACES, BLURBS).places[0].name).toBe('Equestrian Center');
        expect(hoistNarrated('', PLACES, BLURBS).places).toHaveLength(3);
    });
});

describe('categoryFor', () => {
    test('action label wins; type heuristics fall back; Attraction is the floor', () => {
        expect(categoryFor({}, 'restaurants')).toBe('Restaurant');
        expect(categoryFor({ primaryType: 'museum' }, null)).toBe('Museum');
        expect(categoryFor({ types: ['park'] }, 'general')).toBe('Park');
        expect(categoryFor({}, null)).toBe('Attraction');
    });
});

describe('buildContentParts (v1 complete-event shape)', () => {
    test('prose first, then one part per card by index', () => {
        expect(buildContentParts('Hello', 2)).toEqual([
            { type: 'text', content: 'Hello' },
            { type: 'recommendation', index: 0 },
            { type: 'recommendation', index: 1 },
        ]);
        expect(buildContentParts('Just prose', 0)).toEqual([{ type: 'text', content: 'Just prose' }]);
    });
    test('optional trailing text part (the follow-up question, after the cards)', () => {
        const parts = buildContentParts('Intro', 1, 'Prefer quiet or lively?');
        expect(parts[parts.length - 1]).toEqual({ type: 'text', content: 'Prefer quiet or lively?' });
        expect(parts).toHaveLength(3);
    });
});

describe('narrator blurbs + address on cards', () => {
    test('description override wins; fact line is the fallback', () => {
        const withBlurb = toRecommendation(CAND, 0, { action: 'hotels', description: 'Cozy rooms with an Ararat view.' });
        expect(withBlurb.description).toBe('Cozy rooms with an Ararat view.');
        expect(withBlurb.metadata.originalDescription).toBe('Cozy rooms with an Ararat view.');
        expect(toRecommendation(CAND, 0, { action: 'hotels', description: null }).description)
            .toBe('Hotel · 5.8 km away · rated 4.6 · open now');
    });
    test('full street address wins over city/country', () => {
        const rec = toRecommendation({ ...CAND, address: '2 Marshal Baghramyan Ave, Yerevan' }, 0, { action: 'hotels' });
        expect(rec.location).toBe('2 Marshal Baghramyan Ave, Yerevan');
        expect(toRecommendation(CAND, 0, { action: 'hotels' }).location).toBe('Yerevan, Armenia');
    });
});
