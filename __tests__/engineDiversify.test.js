// Geo tokens must not rank, and a browse ask must not come back all one kind.
// Both from the live Dilijan decks of 2026-09-01.
const { diversify, familyOf, perBucketFor } = require('../engine/retrieval/diversify');
const { stripGeoTokens, buildRetrievalQuery } = require('../engine/retrieval/tuning');
const { isSubstantiveAsk } = require('../engine/places/canonicalStore');
const { findPlaces } = require('../engine/retrieval');

const p = (name, primaryType, extra = {}) => ({ name, primaryType, placeId: name, ...extra });

describe('stripGeoTokens', () => {
    test('removes the destination name and keeps the real ask', () => {
        expect(stripGeoTokens('top attractions dilijan locations', ['Dilijan']))
            .toBe('top attractions locations');
        expect(stripGeoTokens('sushi dilijan', ['Dilijan'])).toBe('sushi');
    });
    test('a query that was ONLY a place name becomes null', () => {
        expect(stripGeoTokens('dilijan', ['Dilijan'])).toBeNull();
    });
    test('multi-word names strip whole', () => {
        // "bars" -> "bar" is the shared tokenizer's _TYPE_PLURALS table, not
        // stemming: BM25 normalizes venue-type plurals the same way on both
        // sides, so the stripped query still matches exactly what it will be
        // scored against. Both halves of "New York" go.
        expect(stripGeoTokens('rooftop bars new york', ['New York'])).toBe('rooftop bar');
    });
    test('nothing named leaves the query untouched', () => {
        expect(stripGeoTokens('rooftop bars', [])).toBe('rooftop bars');
    });
    test('it is case and accent insensitive, like BM25', () => {
        expect(stripGeoTokens('cafes tbilisi', ["T'bilisi"])).toBe('cafe');
    });
});

describe('diversify', () => {
    const deck = [
        p('Dilijan Resort', 'restaurant'), p('Kchuch', 'restaurant'),
        p('Conservatory', 'cafe'), p('Old Town', 'tourist_attraction'),
        p('Dilijan Park', 'park'), p('Hotel Old Center', 'hotel'),
    ];
    test('groups hotels and guesthouses as one family, cafes with restaurants', () => {
        expect(familyOf(p('x', 'guest_house'))).toBe(familyOf(p('y', 'hotel')));
        expect(familyOf(p('x', 'cafe'))).toBe(familyOf(p('y', 'restaurant')));
        expect(familyOf(p('x', 'museum'))).not.toBe(familyOf(p('y', 'park')));
    });
    test('a 3-card deck gets 3 different kinds; a 6-card deck allows 2 each', () => {
        expect(perBucketFor(3)).toBe(1);
        expect(perBucketFor(6)).toBe(2);
        const top3 = diversify(deck, { want: 3 }).slice(0, 3).map(x => x.name);
        expect(top3).toEqual(['Dilijan Resort', 'Old Town', 'Dilijan Park']);
    });
    test('it re-orders and NEVER drops — the pool is preserved', () => {
        const out = diversify(deck, { want: 3 });
        expect(out).toHaveLength(deck.length);
        expect(new Set(out.map(x => x.name))).toEqual(new Set(deck.map(x => x.name)));
    });
    test('rank order still holds inside a family', () => {
        const out = diversify(deck, { want: 6 });
        expect(out.indexOf(deck[0])).toBeLessThan(out.indexOf(deck[1]));
    });
    test('unknown types separate from each other, not into one bucket', () => {
        const odd = [p('a', 'zzz'), p('b', 'yyy'), p('c', 'zzz')];
        expect(diversify(odd, { want: 3 }).slice(0, 2).map(x => x.name)).toEqual(['a', 'b']);
    });
    test('an empty or single-item list is returned untouched', () => {
        expect(diversify([], { want: 3 })).toEqual([]);
        expect(diversify([deck[0]], { want: 3 })).toEqual([deck[0]]);
    });
});

describe('findPlaces: diversify fires only on a category-less BROWSE ask', () => {
    const pool = [
        p('R1', 'restaurant', { text: 'R1 restaurant' }), p('R2', 'restaurant', { text: 'R2 restaurant' }),
        p('C1', 'cafe', { text: 'C1 cafe' }), p('Museum', 'museum', { text: 'Museum museum' }),
        p('Park', 'park', { text: 'Park park' }),
    ];
    const deps = { loadCandidates: async () => pool, embedder: null };

    test('a browse ask (null query) mixes the kinds', async () => {
        const r = await findPlaces({ query: null, category: null, count: 3, center: { lat: 40, lng: 44 } }, deps);
        expect(r.places.map(x => x.name)).toEqual(['R1', 'Museum', 'Park']);
        expect(r.provenance.diversified).toBe(true);
    });

    test('a vibe-only query is still a browse ask', async () => {
        const r = await findPlaces({ query: 'good locations', category: null, count: 3, center: { lat: 40, lng: 44 } }, deps);
        expect(new Set(r.places.map(familyOf)).size).toBe(3);
    });

    test('a DEMAND query is never diversified — sushi must stay sushi', async () => {
        const sushi = [
            p('Sushi A', 'restaurant', { text: 'Sushi A sushi restaurant' }),
            p('Sushi B', 'restaurant', { text: 'Sushi B sushi restaurant' }),
            p('Park', 'park', { text: 'Park park' }),
        ];
        const r = await findPlaces({ query: 'sushi', category: null, count: 3, center: { lat: 40, lng: 44 } },
            { loadCandidates: async () => sushi, embedder: null });
        expect(r.places.slice(0, 2).map(x => x.name)).toEqual(['Sushi A', 'Sushi B']);
    });

    test('a CATEGORY ask is never diversified — it asked for one kind', async () => {
        const r = await findPlaces({ query: null, category: 'restaurants', count: 3, center: { lat: 40, lng: 44 } }, deps);
        expect(r.places.map(x => x.name)).toEqual(['R1', 'R2', 'C1']);
        expect(r.provenance.diversified).toBeUndefined();
    });
});

describe('the two fixes compose on the real Dilijan ask', () => {
    test('"suggest 3 good locations in Dilijan" becomes a browse ask', () => {
        const q = buildRetrievalQuery('top attractions dilijan locations', 'suggest 3 good locations in Dilijan');
        const stripped = stripGeoTokens(q, ['Dilijan']);
        expect(stripped).not.toMatch(/dilijan/i);
        expect(isSubstantiveAsk(stripped)).toBe(false);   // → diversify fires
    });
});
