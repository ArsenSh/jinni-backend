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
    test('the place\'s own type wins; the turn\'s action only fills gaps', () => {
        expect(categoryFor({ primaryType: 'museum' }, null)).toBe('Museum');
        expect(categoryFor({ types: ['park'] }, 'general')).toBe('Park');
        // A mobile operator found on a "shopping" turn is not merely "Shop".
        expect(categoryFor({ primaryType: 'telecommunications_service_provider' }, 'shopping')).toBe('Mobile operator');
        expect(categoryFor({}, 'restaurants')).toBe('Restaurant');
    });
    test('the live 2026-08-24 cards that all read "Attraction"', () => {
        expect(categoryFor({ primaryType: 'shopping_mall' }, 'general')).toBe('Shopping centre');
        expect(categoryFor({ primaryType: 'performing_arts_theater' }, 'general')).toBe('Theatre');
        expect(categoryFor({ primaryType: 'real_estate_agency' }, 'general')).toBe('Rental agency');
        expect(categoryFor({ primaryType: 'apartment_complex' }, 'general')).toBe('Apartments');
    });
    test('suffix families cover the long tail', () => {
        expect(categoryFor({ primaryType: 'greek_restaurant' }, null)).toBe('Restaurant');
        expect(categoryFor({ primaryType: 'sporting_goods_store' }, null)).toBe('Shop');
    });
    test('a dated listing is an Event whatever else it looks like', () => {
        expect(categoryFor({ primaryType: 'stadium', eventSchedule: { startDate: '2026-09-04' } }, 'general')).toBe('Event');
    });
    test('an unknown row says only what we know', () => {
        expect(categoryFor({}, null)).toBe('Place');
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

// Blurb-less event cards (Arsen 2026-08-23: "lets fix blurbs too"). Five
// tomsarkgh cards each read only "Event" because the model asked a clarifying
// question instead of emitting the <<<CARDS>>> tail — so the FALLBACK has to
// carry real facts.
describe('factDescription: events describe themselves without a blurb', () => {
    const { toRecommendation } = require('../engine/narrator/cards');
    const descOf = (startDate, venueName = null) => toRecommendation(
        { name: 'X', eventSchedule: { startDate }, venueName, distanceKm: 6.5 }, 0, { action: 'events' }).description;

    test('date + venue, and midnight stays time-less (an unknown time is not 12:00)', () => {
        expect(descOf(new Date('2026-08-30T00:00:00Z'), 'Bohem theatre')).toBe('Sunday, Aug 30 — Bohem theatre');
        expect(descOf(new Date('2026-08-25T19:30:00Z'), 'Adana Complex')).toBe('Tuesday, Aug 25 at 19:30 — Adana Complex');
        expect(descOf(new Date('2026-08-24T00:00:00Z'))).toBe('Monday, Aug 24');
    });

    test('non-events keep the category fact line', () => {
        expect(toRecommendation({ name: 'Y', rating: 4.6, distanceKm: 1.2 }, 0, { action: 'restaurants' }).description)
            .toBe('Restaurant · 1.2 km away · rated 4.6');
    });

    test('a narrator blurb still wins over the fallback', () => {
        const r = toRecommendation({ name: 'X', eventSchedule: { startDate: new Date('2026-08-30T00:00:00Z') } }, 0,
            { action: 'events', description: 'An Armenian dance celebration.' });
        expect(r.description).toBe('An Armenian dance celebration.');
    });
});

// ── The model names the category, code checks the word (Arsen 2026-08-24) ────
// "ai is leader not an employee... code just helps". The type table stops
// leading and becomes the fallback; a named kind wins, but only if it is one
// of ours.
describe('category vocabulary', () => {
    const { CATEGORY_VOCABULARY, normalizeCategory } = require('../engine/narrator/cards');

    test('a vocabulary word from the model beats the type table', () => {
        expect(categoryFor({ _kind: 'Rental agency', primaryType: 'lodging' }, 'hotels')).toBe('Rental agency');
    });
    test('a word outside the vocabulary is dropped, not rewritten', () => {
        expect(categoryFor({ _kind: 'Teleporter', primaryType: 'shopping_mall' }, 'general')).toBe('Shopping centre');
        expect(categoryFor({ _kind: 'Teleporter' }, null)).toBe('Place');
    });
    test('a dated listing still outranks anything the model says', () => {
        expect(categoryFor({ _kind: 'Bar', eventSchedule: { startDate: '2026-09-04' } }, 'general')).toBe('Event');
    });
    test('normalizeCategory is forgiving about spelling, strict about membership', () => {
        expect(normalizeCategory('  rENTAL AGENCY ')).toBe('Rental agency');
        for (const junk of ['', null, undefined, 42, {}, 'Teleporter', 'Кафе']) expect(normalizeCategory(junk)).toBeNull();
    });
    test('the vocabulary covers the labels the table can emit, so the two cannot drift', () => {
        expect(CATEGORY_VOCABULARY).toContain('Place');
        expect(CATEGORY_VOCABULARY).toContain('Event');
        for (const t of ['shopping_mall', 'performing_arts_theater', 'real_estate_agency', 'apartment_complex']) {
            expect(CATEGORY_VOCABULARY).toContain(categoryFor({ primaryType: t }, null));
        }
    });
});

describe('parseCardsTail kinds', () => {
    const { parseCardsTail } = require('../engine/narrator/prompts/grounded');

    test('valid kinds survive, invented ones become null', () => {
        const t = parseCardsTail('{"cards":[{"i":0,"kind":"Rental agency","blurb":"a"},{"i":1,"kind":"Teleporter","blurb":"b"}],"question":"q?"}', 2);
        expect(t.kinds).toEqual(['Rental agency', null]);
        expect(t.blurbs).toEqual(['a', 'b']);
    });
    test('a tail with no kinds at all still parses (older shape)', () => {
        const t = parseCardsTail('{"cards":[{"i":0,"blurb":"a"}],"question":null}', 1);
        expect(t.blurbs).toEqual(['a']);
        expect(t.kinds).toEqual([null]);
    });
    test('the salvage pass recovers kinds from a truncated tail', () => {
        const t = parseCardsTail('{"cards":[{"i":0,"kind":"Museum","blurb":"a"},{"i":1,"kind":"Bar","blur', 2);
        expect(t.kinds[0]).toBe('Museum');
        expect(t.blurbs[0]).toBe('a');
    });
});

describe('realignBlurbs: blurbs seat on the card they NAME (live 2026-09-04)', () => {
    const { realignBlurbs } = require('../engine/narrator/cards');
    const places = ['Bamboo Restaurant', 'Ginetun Restaurant', 'Tsirani Restaurant',
        'Bellagio Restaurant', 'Cascade Royal', 'Blanca by Melonpan'].map(n => ({ name: n }));
    test('the live praise-order shuffle is corrected', () => {
        const blurbs = [
            "Closest overall at 2.1 km, Ginetun's 4.7 rating makes it a strong pick.",
            'Bellagio, 3.5 km away, pairs dining with lodging.',
            'Tsirani at 3.6 km offers a solid option.',
            'Bamboo, 4.1 km out, blends elegant dining with nightlife.',
            'Cascade Royal, 4.6 km away, is dependable.',
            'Blanca by Melonpan, the farthest at 4.8 km.'];
        const out = realignBlurbs(places, blurbs);
        expect(out[0]).toMatch(/^Bamboo/);
        expect(out[1]).toMatch(/Ginetun/);
        expect(out[3]).toMatch(/^Bellagio/);
        expect(out.filter(Boolean)).toHaveLength(6);
    });
    test('nameless or ambiguous blurbs never move, none are dropped', () => {
        const out = realignBlurbs([{ name: 'A B C' }, { name: 'Xyzzy Bar' }],
            ['great vibes here', 'Xyzzy has the best wine']);
        expect(out).toEqual(['great vibes here', 'Xyzzy has the best wine']);
    });
    test('already-correct blurbs stay put', () => {
        const blurbs = places.map(p => `${p.name} is lovely.`);
        expect(realignBlurbs(places, blurbs)).toEqual(blurbs);
    });
});
