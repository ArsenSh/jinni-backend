// Tests for the V2 Canonical Place Store — pure helpers + loadCandidates with
// injected fakes (no Mongo, no services). Gate semantics mirror v1's
// findCachedBackfill; cases below pin them.

const {
    loadCandidates, googleFallback, buildCacheQuery, cacheDocToCandidate, dbDocToCandidate,
    scoreCachedDoc, mergeAndDedupe, isCommunityRejected,
} = require('../engine/places/canonicalStore');

const CENTER = { lat: 40.18, lng: 44.51 };   // Yerevan

const cacheDoc = (over = {}) => ({
    placeId: 'p_' + (over.name || 'x'),
    name: 'Lavash',
    rating: 4.5,
    likes: 0, dislikes: 0, useCount: 5,
    types: ['restaurant'], primaryType: 'restaurant', priceLevel: null,
    photos: [{ url: 'x' }],
    details: { geometry: { location: { lat: CENTER.lat + 0.01, lng: CENTER.lng + 0.01 } } },
    opening_hours: { periods: [] },
    interests: [], actions: ['restaurants'], city: 'Yerevan', country: 'Armenia',
    ...over,
});

describe('isCommunityRejected (v1 rules, byte-identical)', () => {
    test('floor + votes + ratio all required', () => {
        expect(isCommunityRejected(0, 3)).toBe(true);     // net −3, 3 votes, 100% dislikes
        expect(isCommunityRejected(1, 3)).toBe(false);    // net −2 → floor not met
        expect(isCommunityRejected(0, 2)).toBe(false);    // small sample can never hide
        expect(isCommunityRejected(50, 4)).toBe(false);   // popular place, low share
        expect(isCommunityRejected()).toBe(false);
    });
});

describe('buildCacheQuery', () => {
    test('category adds the ground-truth actions filter; null omits it', () => {
        const withCat = buildCacheQuery({ center: CENTER, radiusKm: 50, category: 'restaurants' });
        expect(withCat.actions).toBe('restaurants');
        expect(withCat.aiBlocked).toEqual({ $ne: true });
        expect(withCat['explore.status']).toEqual({ $ne: 'hidden' });
        const noCat = buildCacheQuery({ center: CENTER, radiusKm: 50 });
        expect(noCat.actions).toBeUndefined();
    });
    test('bbox straddles the center; excludes become $nin', () => {
        const q = buildCacheQuery({ center: CENTER, radiusKm: 50, excludePlaceIds: ['a'] });
        expect(q['details.geometry.location.lat'].$gte).toBeLessThan(CENTER.lat);
        expect(q['details.geometry.location.lat'].$lte).toBeGreaterThan(CENTER.lat);
        expect(q.placeId).toEqual({ $nin: ['a'] });
    });
});

describe('candidate mapping', () => {
    test('cacheDocToCandidate: fields, distance, BM25 text, embedding→vector', () => {
        const c = cacheDocToCandidate(cacheDoc({ embedding: [1, 2] }), CENTER);
        expect(c.source).toBe('cache');
        expect(c.placeId).toBe('p_x');
        expect(c.distanceKm).toBeGreaterThan(0);
        expect(c.distanceKm).toBeLessThan(3);
        expect(c.text).toContain('Lavash');
        expect(c.text).toContain('restaurant');
        expect(c.text).toContain('Yerevan');
        expect(c.vector).toEqual([1, 2]);
        expect(c.opening_hours).toEqual({ periods: [] });
    });
    test('dbDocToCandidate: business/destination rows map defensively', () => {
        const d = dbDocToCandidate({
            _id: 'abc', name: 'Tashir Arena', type: ['events'],
            location: { coordinates: { lat: CENTER.lat, lng: CENTER.lng }, city: 'Yerevan' },
            partnership: { isPartner: true, tier: 'signature' },   // the REAL schema field (subscription.tier never existed)
            // Business.description is an OBJECT — must become words, not "[object Object]"
            description: { short: 'Grand arena', detailed: 'Concerts and sports' },
            embedding: [0.1, 0.2],                                  // battery fix #3: curated rows carry vectors now
        }, 'business', CENTER);
        expect(d.source).toBe('business');
        expect(d.verifiedId).toBe('abc');
        expect(d.tier).toBe('signature');
        expect(d.isPartner).toBe(true);
        expect(d.opening_hours).toBe(null);               // day-name schedule → unknown, kept
        expect(d.vector).toEqual([0.1, 0.2]);
        expect(d.text).toContain('Grand arena');
        expect(d.text).not.toContain('object Object');
        expect(dbDocToCandidate({ type: [] }, 'business', CENTER)).toBe(null);   // no name → skip
    });
});

describe('mergeAndDedupe', () => {
    test('first list wins — validator word beats a cache duplicate (by name)', () => {
        const validator = [{ verifiedId: 'v1', name: 'Sherep', source: 'destination' }];
        const cache = [{ placeId: 'g1', name: 'SHEREP!', source: 'cache' },
                       { placeId: 'g2', name: 'Uzbechka', source: 'cache' }];
        const merged = mergeAndDedupe(validator, cache);
        expect(merged.map(m => m.source)).toEqual(['destination', 'cache']);
        expect(merged[1].name).toBe('Uzbechka');
    });
    test('placeId dedupe too', () => {
        const merged = mergeAndDedupe([{ placeId: 'x', name: 'A' }], [{ placeId: 'x', name: 'B' }]);
        expect(merged).toHaveLength(1);
    });
});

// Live 2026-08-26: the deck for "where can I meet someone" came back a jewellery
// shop, a diamond gallery, a dried-fruit shop and a mall — the asker's own four
// votes, ranked above everything. feedbackScore was the ONLY unbounded term in
// the prior: one like was worth 3 points, a perfect 5.0 rating 5, and the entire
// 0-50km distance range 1. So a single vote outweighed proximity three times.
describe('community feedback is bounded, like every other signal', () => {
    const { feedbackScoreFor, scoreCachedDoc } = require('../engine/places/canonicalStore');

    test('one vote is a hint, not a verdict', () => {
        expect(feedbackScoreFor(1, 0)).toBeCloseTo(0.67, 1);
        expect(feedbackScoreFor(3, 0)).toBeCloseTo(2.0, 1);
    });

    test('praise saturates — a hundred likes is not worth more than three', () => {
        expect(feedbackScoreFor(100, 0)).toBeCloseTo(feedbackScoreFor(3, 0), 5);
        expect(feedbackScoreFor(100, 0)).toBeLessThanOrEqual(2);
    });

    test('the asymmetry survives: dislikes still bite harder', () => {
        expect(Math.abs(feedbackScoreFor(0, 3))).toBeGreaterThan(feedbackScoreFor(3, 0));
        expect(feedbackScoreFor(0, 3)).toBeCloseTo(-4.0, 1);
    });

    test('it reads a SHARE, so a mixed record is not a rave', () => {
        expect(feedbackScoreFor(8, 2)).toBeLessThan(feedbackScoreFor(10, 0));
        expect(feedbackScoreFor(5, 5)).toBe(0);
    });

    test('no votes contributes nothing at all', () => {
        expect(feedbackScoreFor(0, 0)).toBe(0);
    });

    // The property that actually failed live: a single like must not be able to
    // beat a genuinely better, closer place on its own.
    test('one like cannot outrank a higher-rated, nearer place', () => {
        const liked  = scoreCachedDoc({ likes: 1, dislikes: 0, rating: 4.3, useCount: 1 }, 6.8, 50, null, {});
        const better = scoreCachedDoc({ likes: 0, dislikes: 0, rating: 4.8, useCount: 8 }, 0.9, 50, null, {});
        expect(better).toBeGreaterThan(liked);
    });
});

describe('scoreCachedDoc (v1 backfill prior, same weights)', () => {
    test('community feedback dominates; negative bites harder', () => {
        const liked = scoreCachedDoc(cacheDoc({ likes: 2, dislikes: 0 }), 1, 50, null, {});
        const neutral = scoreCachedDoc(cacheDoc(), 1, 50, null, {});
        const disliked = scoreCachedDoc(cacheDoc({ likes: 0, dislikes: 2 }), 1, 50, null, {});
        expect(liked).toBeGreaterThan(neutral);
        expect(neutral).toBeGreaterThan(disliked);
        expect(neutral - disliked).toBeGreaterThan(liked - neutral);   // asymmetric
    });
});

describe('loadCandidates (injected fakes, gates end to end)', () => {
    const fakes = (cacheDocs, proximityRes) => ({
        cacheFind: async () => cacheDocs,
        proximity: async () => proximityRes,
        placeMatches: () => true,
        coverage: async () => false,     // fallback off unless a test enables it
    });

    test('events hunt triggers on UNSEEN-thin shelves and on explicit force', async () => {
        const huntEvents = jest.fn(async () => [{ name: 'Hunted Show', placeId: null, city: 'Yerevan', eventSchedule: { startDate: new Date() } }]);
        const evDeps = {
            ...fakes([], {}),
            huntEvents,
            Destination: { find: () => ({ lean: () => Promise.resolve([]) }) },
            AiFoundEvent: { find: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) },
        };
        const base = { category: 'events', center: { ...CENTER, city: 'Yerevan' }, eventWindow: { start: new Date(), end: new Date(Date.now() + 86400000), label: 'today' }, eventsHunt: { webSearch: null } };
        // Shelf empty for this user → hunt fires and its finds are served.
        const out = await loadCandidates({ ...base, excludes: { placeIds: [], names: [] } }, evDeps);
        expect(huntEvents).toHaveBeenCalledTimes(1);
        expect(out.map(c => c.name)).toContain('Hunted Show');
        // Explicit force hunts even when the raw shelf looks fine.
        huntEvents.mockClear();
        const evDeps2 = { ...evDeps, AiFoundEvent: { find: () => ({ limit: () => ({ lean: () => Promise.resolve([
            { name: 'A', placeId: 'a', startDate: new Date(), status: 'new' },
            { name: 'B', placeId: 'b', startDate: new Date(), status: 'new' },
            { name: 'C', placeId: 'c', startDate: new Date(), status: 'new' },
        ]) }) }) } };
        await loadCandidates({ ...base, eventsHunt: { webSearch: null, force: true } }, evDeps2);
        expect(huntEvents).toHaveBeenCalledTimes(1);
        // No permission → no hunt.
        huntEvents.mockClear();
        await loadCandidates({ ...base, eventsHunt: null }, evDeps);
        expect(huntEvents).not.toHaveBeenCalled();
    });

    test('no center → []; events delegate to the events tier, never the cache', async () => {
        expect(await loadCandidates({}, fakes([], {}))).toEqual([]);
        // Events branch (2026-08-22): served by eventStore (owned event data),
        // NOT by cached venues — a cache doc must not leak into an events ask.
        const evDeps = {
            ...fakes([cacheDoc()], {}),
            Destination: { find: () => ({ lean: () => Promise.resolve([]) }) },
            AiFoundEvent: { find: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) },
        };
        expect(await loadCandidates({ category: 'events', center: CENTER }, evDeps)).toEqual([]);
    });

    test('gates: photo-less, out-of-radius and community-rejected docs drop; validator first', async () => {
        const docs = [
            cacheDoc({ name: 'Good' }),
            cacheDoc({ name: 'NoPhoto', photos: [] }),
            cacheDoc({ name: 'Far', details: { geometry: { location: { lat: CENTER.lat + 5, lng: CENTER.lng } } } }),
            cacheDoc({ name: 'Hated', likes: 0, dislikes: 5 }),
        ];
        const prox = { destinations: [{ _id: 'd1', name: 'Matenadaran', type: ['historical'],
            location: { coordinates: { lat: CENTER.lat, lng: CENTER.lng }, city: 'Yerevan' } }], businesses: [] };
        const out = await loadCandidates({ category: 'restaurants', center: CENTER, radiusKm: 50 }, fakes(docs, prox));
        expect(out[0].source).toBe('destination');
        expect(out.map(c => c.name)).toEqual(['Matenadaran', 'Good']);
    });

    test('type comparator gate applies when category present; skipped for free query', async () => {
        const docs = [cacheDoc({ name: 'School', types: ['school'] })];
        const rejecting = { cacheFind: async () => docs, proximity: async () => ({}), placeMatches: () => false, coverage: async () => false };
        const withCat = await loadCandidates({ category: 'restaurants', center: CENTER }, rejecting);
        expect(withCat).toEqual([]);
        const freeQuery = await loadCandidates({ category: null, center: CENTER }, rejecting);
        expect(freeQuery.map(c => c.name)).toEqual(['School']);   // comparator not consulted
    });

    test('validator tier failure is fail-open (cache still answers)', async () => {
        const out = await loadCandidates({ center: CENTER }, {
            cacheFind: async () => [cacheDoc({ name: 'Solo' })],
            proximity: async () => { throw new Error('service down'); },
            placeMatches: () => true,
            coverage: async () => false,
        });
        expect(out.map(c => c.name)).toEqual(['Solo']);
    });

    test('cache tier failure is fail-open (validator still answers)', async () => {
        const out = await loadCandidates({ center: CENTER }, {
            cacheFind: async () => { throw new Error('db down'); },
            proximity: async () => ({ destinations: [{ _id: 'd', name: 'Cascade', type: ['historical'],
                location: { coordinates: { lat: CENTER.lat, lng: CENTER.lng } } }], businesses: [] }),
            placeMatches: () => true,
            coverage: async () => false,
        });
        expect(out.map(c => c.name)).toEqual(['Cascade']);
    });
});

describe('uncoveredQueryTokens (the Uzbek lesson — relevance-thin, not count-thin)', () => {
    const { uncoveredQueryTokens } = require('../engine/places/canonicalStore');
    const CANDS = [
        { text: 'Lavash Restaurant restaurant food Yerevan' },
        { text: 'Nairi Restaurant restaurant Yerevan' },
    ];
    test('demanded term with zero matches is reported; covered terms are not', () => {
        expect(uncoveredQueryTokens('uzbek restaurant', CANDS)).toEqual(['uzbek']);
        expect(uncoveredQueryTokens('restaurant yerevan', CANDS)).toEqual([]);
    });
    test('short tokens, empty query, empty corpus → no trigger', () => {
        expect(uncoveredQueryTokens('bbq', CANDS)).toEqual([]);
        expect(uncoveredQueryTokens('', CANDS)).toEqual([]);
        expect(uncoveredQueryTokens('uzbek', [])).toEqual([]);
    });
    test('vibe words never count as demands (no paid searches for "cozy quiet")', () => {
        expect(uncoveredQueryTokens('cozy quiet cafe talk hours', CANDS)).toEqual(['cafe']);
        expect(uncoveredQueryTokens('quiet place to talk evening', CANDS)).toEqual([]);
        expect(uncoveredQueryTokens('uzbek restaurant near me', CANDS)).toEqual(['uzbek']);
    });
    test('maxShare relaxes zero-match to rare (the demand-seat check)', () => {
        const pool = [...CANDS, { text: 'Sushi House sushi restaurant Yerevan' }];
        expect(uncoveredQueryTokens('sushi restaurant', pool)).toEqual([]);        // matched → not uncovered
        expect(uncoveredQueryTokens('sushi restaurant', pool, 0.5)).toEqual(['sushi']); // but RARE
    });
});

describe('google fallback tier (bootstrap, coverage-gated, bounded)', () => {
    const googleRow = (id, name, dLat = 0.01) => ({
        place_id: id, name,
        geometry: { location: { lat: CENTER.lat + dLat, lng: CENTER.lng } },
        types: ['restaurant'], primaryType: 'restaurant',
    });

    test('thin corpus triggers the fallback; resolved places carry image + address', async () => {
        const out = await loadCandidates({ category: 'restaurants', center: CENTER, count: 4, query: 'khinkali' }, {
            cacheFind: async () => [cacheDoc({ name: 'OnlyOne' })],
            proximity: async () => ({}),
            placeMatches: () => true,
            coverage: async () => true,
            findPlaces: async () => [googleRow('g1', 'Khinkali House'), googleRow('g2', 'Dumpling Spot')],
            resolveDetails: async (id) => ({ name: null, rating: 4.3, formatted_address: `${id} St`, imagesStored: true }),
        });
        const google = out.filter(c => c.source === 'google');
        expect(google.map(c => c.name)).toEqual(['Khinkali House', 'Dumpling Spot']);
        expect(google[0].image).toBe('/api/ai/place-image/g1/0');
        expect(google[0].address).toBe('g1 St');
        expect(out[0].name).toBe('OnlyOne');          // owned data still leads
    });

    test('coverage OFF → no google calls at all', async () => {
        let searched = false;
        const out = await loadCandidates({ category: 'restaurants', center: CENTER, count: 6, query: 'x' }, {
            cacheFind: async () => [], proximity: async () => ({}), placeMatches: () => true,
            coverage: async () => false,
            findPlaces: async () => { searched = true; return [googleRow('g', 'X')]; },
        });
        expect(searched).toBe(false);
        expect(out).toEqual([]);
    });

    test('sufficient corpus → fallback never fires', async () => {
        let searched = false;
        const docs = [cacheDoc({ name: 'A' }), cacheDoc({ name: 'B', placeId: 'p_b' })];
        await loadCandidates({ category: 'restaurants', center: CENTER, count: 2 }, {
            cacheFind: async () => docs, proximity: async () => ({}), placeMatches: () => true,
            coverage: async () => true,
            findPlaces: async () => { searched = true; return []; },
        });
        expect(searched).toBe(false);
    });

    // Junk-query guard (live 2026-08-29): "what do I do tonight?" reduced to
    // q="tonight" and bought a Text Search that returned one arbitrary bar.
    test('a query of only vibe/time words yields the paid search to the CATEGORY noun', async () => {
        const asked = [];
        await googleFallback({
            coreQuery: 'tonight', query: 'tonight', category: 'activities',
            center: CENTER, radiusKm: 15, needed: 3,
        }, {
            coverage: async () => true,
            findPlaces: async (q) => { asked.push(q); return []; },
        });
        expect(asked).toEqual(['activities']);
    });

    test('a concrete query still wins the pick; non-Latin scripts pass through untouched', async () => {
        const asked = [];
        const deps = { coverage: async () => true, findPlaces: async (q) => { asked.push(q); return []; } };
        await googleFallback({ coreQuery: 'uzbek restaurant', category: 'restaurants', center: CENTER, radiusKm: 15, needed: 3 }, deps);
        await googleFallback({ coreQuery: 'مطعم سوشي', category: 'restaurants', center: CENTER, radiusKm: 15, needed: 3 }, deps);
        expect(asked).toEqual(['uzbek restaurant', 'مطعم سوشي']);
    });

    // REVERSED 2026-08-31 (founder quality direction): the old contract served
    // a details-failed place with no image — live it carded "Location not
    // specified" with a dead image (Sunny Lodge ECONNRESET). Details are now
    // REQUIRED; a failed resolve skips the place, never the turn.
    test('googleFallback: out-of-radius dropped; failed details SKIP the place', async () => {
        const out = await googleFallback({ query: 'q', category: 'restaurants', center: CENTER, radiusKm: 15, needed: 5 }, {
            coverage: async () => true,
            findPlaces: async () => [googleRow('near', 'Near Place'), googleRow('far', 'Far Place', 5)],
            resolveDetails: async () => { throw new Error('details down'); },
        });
        expect(out).toEqual([]);
    });

    test('dedupe: a google row matching an owned placeId ships once (owned wins)', async () => {
        const out = await loadCandidates({ category: 'restaurants', center: CENTER, count: 4, query: 'x' }, {
            cacheFind: async () => [cacheDoc({ name: 'Lavash' })],   // factory → placeId 'p_Lavash'
            proximity: async () => ({}),
            placeMatches: () => true,
            coverage: async () => true,
            findPlaces: async () => [googleRow('p_Lavash', 'Lavash Google Copy'), googleRow('g9', 'Fresh Find')],
            // Details are required since 2026-08-31 — return a minimal real
            // resolve so the dedupe intent of this test stays testable.
            resolveDetails: async () => ({ name: null, types: ['restaurant'], primaryType: 'restaurant' }),
        });
        expect(out.filter(c => c.placeId === 'p_Lavash')).toHaveLength(1);
        expect(out.find(c => c.placeId === 'p_Lavash').source).toBe('cache');
        expect(out.map(c => c.name)).toContain('Fresh Find');
    });
});

describe("_prefFitScore 'cultural' interest (the culture-regex gap, 2026-08-30)", () => {
    const { _prefFitScore } = require('../engine/places/canonicalStore');
    test("interest 'cultural' alone lifts museums over unrelated types", () => {
        expect(_prefFitScore(['museum'], 'museum', { interests: ['cultural'] })).toBe(1);
        expect(_prefFitScore(['car_repair'], 'car_repair', { interests: ['cultural'] })).toBe(0);
    });
    test('every saved interest key triggers at least one want-branch', () => {
        const keys = ['family','romantic','nature','adventure','cultural','history','art','food_drink','nightlife','relaxation'];
        for (const k of keys) {
            const neutral = _prefFitScore(['car_repair'], 'car_repair', { interests: [k] });
            expect(neutral).toBe(0);   // 0 (not 0.5) proves a branch FIRED and discriminated
        }
    });
});
