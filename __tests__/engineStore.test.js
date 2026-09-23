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
        const { LOCAL_MODEL } = require('../engine/retrieval/embedder');
        const c = cacheDocToCandidate(cacheDoc({ embedding: [1, 2], embeddingModel: LOCAL_MODEL }), CENTER);
        expect(c.source).toBe('cache');
        expect(c.placeId).toBe('p_x');
        expect(c.distanceKm).toBeGreaterThan(0);
        expect(c.distanceKm).toBeLessThan(3);
        expect(c.text).toContain('Lavash');
        expect(c.text).toContain('restaurant');
        expect(c.text).toContain('Yerevan');
        expect(c.vector).toEqual([1, 2]);
        expect(c.opening_hours).toEqual({ periods: [] });
        // Model gate (multilingual swap 2026-08-31): a vector embedded by a
        // DIFFERENT model is noise in the current space — dropped, not mixed.
        const stale = cacheDocToCandidate(cacheDoc({ embedding: [1, 2], embeddingModel: 'Xenova/all-MiniLM-L6-v2' }), CENTER);
        expect(stale.vector).toBeUndefined();
    });
    test('dbDocToCandidate: business/destination rows map defensively', () => {
        const d = dbDocToCandidate({
            _id: 'abc', name: 'Tashir Arena', type: ['events'],
            location: { coordinates: { lat: CENTER.lat, lng: CENTER.lng }, city: 'Yerevan' },
            partnership: { isPartner: true, tier: 'signature' },   // the REAL schema field (subscription.tier never existed)
            // Business.description is an OBJECT — must become words, not "[object Object]"
            description: { short: 'Grand arena', detailed: 'Concerts and sports' },
            embedding: [0.1, 0.2],                                  // battery fix #3: curated rows carry vectors now
            embeddingModel: require('../engine/retrieval/embedder').LOCAL_MODEL,
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
        // A bookshop, not a school: schools joined the non-leisure type
        // exclusion on 2026-09-16, and this test is about the comparator gate.
        const docs = [cacheDoc({ name: 'Bookshop', types: ['book_store'] })];
        const rejecting = { cacheFind: async () => docs, proximity: async () => ({}), placeMatches: () => false, coverage: async () => false };
        const withCat = await loadCandidates({ category: 'restaurants', center: CENTER }, rejecting);
        expect(withCat).toEqual([]);
        const freeQuery = await loadCandidates({ category: null, center: CENTER }, rejecting);
        expect(freeQuery.map(c => c.name)).toEqual(['Bookshop']);   // comparator not consulted
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

    // Live 2026-09-16 03:30: Cascade Royal (CLOSED_TEMPORARILY on Google) was
    // carded again by the fallback — a search-cache hit from before the live
    // filter replayed it, and the resolved details were never checked.
    test('googleFallback: a CLOSED_* business in the resolved details is skipped', async () => {
        const out = await googleFallback({ query: 'late dinner', category: 'restaurants', center: CENTER, radiusKm: 15, needed: 5 }, {
            coverage: async () => true,
            findPlaces: async () => [googleRow('cr', 'Cascade Royal'), googleRow('ok', 'Open Bistro')],
            resolveDetails: async (id) => ({ name: null, types: ['restaurant'], primaryType: 'restaurant',
                business_status: id === 'cr' ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL' }),
        });
        expect(out.map(c => c.name)).toEqual(['Open Bistro']);
    });

    test('googleFallback: a null business status (never checked) is kept', async () => {
        const out = await googleFallback({ query: 'late dinner', category: 'restaurants', center: CENTER, radiusKm: 15, needed: 5 }, {
            coverage: async () => true,
            findPlaces: async () => [googleRow('u', 'Unknown Status')],
            resolveDetails: async () => ({ name: null, types: ['restaurant'], primaryType: 'restaurant', business_status: null }),
        });
        expect(out.map(c => c.name)).toEqual(['Unknown Status']);
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

    // Live 2026-08-31: Aero Hotel was curated + set BUDGET by staff, yet its
    // Google cache twin appeared in a LUXURY user's deck — the staff verdict
    // must suppress the twin (Google's own tier guess never overrides it).
    test('validator style verdict suppresses the cache twin of an opposite-style curated place', async () => {
        const deps = {
            cacheFind: async () => [
                cacheDoc({ name: 'Aero Hotel', placeId: 'p_aero' }),
                cacheDoc({ name: 'Fine Palace', placeId: 'p_fine' }),
            ],
            proximity: async () => ({}),
            placeMatches: () => true,
            coverage: async () => false,
            styleMismatched: async (tag) => (tag === 'budget' ? [{ name: 'Aero Hotel', placeId: 'p_aero' }] : []),
        };
        const luxury = await loadCandidates({
            category: 'restaurants', center: CENTER, count: 4,
            preferences: { travelStyle: 'luxury' },
        }, deps);
        expect(luxury.map(c => c.name)).not.toContain('Aero Hotel');
        expect(luxury.map(c => c.name)).toContain('Fine Palace');
        // No gating style → no suppression, the twin serves normally.
        const anyStyle = await loadCandidates({
            category: 'restaurants', center: CENTER, count: 4, preferences: {},
        }, deps);
        expect(anyStyle.map(c => c.name)).toContain('Aero Hotel');
    });
});

describe('style gate softens when the owned pool is thin (2026-09-23, session 6ab3a61e)', () => {
    const hotel = (name, over = {}) => cacheDoc({ name, placeId: 'p_' + name.replace(/\s/g, ''), types: ['lodging'], primaryType: 'lodging', actions: ['hotels'], ...over });
    const deps = (docs) => ({ cacheFind: async () => docs, proximity: async () => ({}), placeMatches: () => true, coverage: async () => false, styleMismatched: async () => [] });
    test('thin town: an unpriced sub-4.2 row comes back last in prior order, marked', async () => {
        // Luxury demands evidence from unpriced rows (rating >= 4.2); Plain Inn
        // has none — but it is nearly all the town owns for a 4-card ask.
        const out = await loadCandidates({ category: 'hotels', center: CENTER, count: 4, preferences: { travelStyle: 'luxury' } },
            deps([hotel('Fine Palace', { rating: 4.7 }), hotel('Plain Inn', { rating: 3.9 })]));
        const names = out.map(c => c.name);
        expect(names).toContain('Fine Palace');
        expect(names).toContain('Plain Inn');
        expect(out.find(c => c.name === 'Plain Inn')._styleSoft).toBe('luxury');
        expect(names.indexOf('Plain Inn')).toBeGreaterThan(names.indexOf('Fine Palace'));   // prior is positional
    });
    test('plenty owned: the gate stays hard', async () => {
        const many = ['A', 'B', 'C', 'D', 'E'].map(n => hotel('Grand ' + n, { rating: 4.6 }));
        const out = await loadCandidates({ category: 'hotels', center: CENTER, count: 4, preferences: { travelStyle: 'luxury' } },
            deps([...many, hotel('Plain Inn', { rating: 3.9 })]));
        expect(out.map(c => c.name)).not.toContain('Plain Inn');
    });
    test('softStyleGate:false keeps the old hard behaviour', async () => {
        const out = await loadCandidates({ category: 'hotels', center: CENTER, count: 4, preferences: { travelStyle: 'luxury' }, softStyleGate: false },
            deps([hotel('Fine Palace', { rating: 4.7 }), hotel('Plain Inn', { rating: 3.9 })]));
        expect(out.map(c => c.name)).not.toContain('Plain Inn');
    });
});

describe('partner inventory tier (founder 2026-09-23: "search from booking initially too")', () => {
    const hotelDoc = (name, over = {}) => cacheDoc({ name, placeId: 'p_' + name.replace(/\s/g, ''), types: ['lodging'], primaryType: 'lodging', actions: ['hotels'], ...over });
    const PARTNER = (over = {}) => ({
        ok: true, rooms: 6, hotels: [
            // the twin of a cache row — same hotel, the partner's price
            { hotel_id: 'lp1', name: 'Green Stone Boutique Hotel', stars: 4, guest_rating: 8.8, lat: CENTER.lat + 0.01, lng: CENTER.lng + 0.01, address: '2 Gladzor', city: 'Yeghegnadzor', image: 'https://cdn.partner/1.jpg', available: true, price_per_night: 210, currency: 'USD', rooms: 6, nights: 1, check_in: '2026-09-26', check_out: '2026-09-27', booking_url: 'https://wl/hotels/lp1' },
            // a hotel only the partner sells
            { hotel_id: 'lp2', name: 'Vayots Dzor Villa', stars: 3, guest_rating: 9.1, review_count: 40, lat: CENTER.lat + 0.02, lng: CENTER.lng + 0.02, address: '5 Shahumyan', city: 'Yeghegnadzor', image: 'https://cdn.partner/2.jpg', available: true, price_per_night: 180, currency: 'USD', rooms: 6, nights: 1, check_in: '2026-09-26', check_out: '2026-09-27', booking_url: 'https://wl/hotels/lp2' },
        ], diag: { hotels_in_index: 2, hotels_priced: 2 }, ...over,
    });
    const deps = (docs, partner) => ({
        cacheFind: async () => docs, proximity: async () => ({}), placeMatches: () => true,
        coverage: async () => false, styleMismatched: async () => [],
        gazetteer: { regionAt: async () => ({ countryCode: 'AM', city: 'Yeghegnadzor' }) },
        hotelsApi: { ...require('../engine/travel/hotels'), hotelsEnabled: () => true, areaHotels: async (a) => { partner.calls.push(a); return partner.out; } },
    });
    test('a cache twin KEEPS its identity and inherits the price; a partner-only hotel joins as a new card', async () => {
        const partner = { calls: [], out: PARTNER() };
        const out = await loadCandidates({ category: 'hotels', center: CENTER, radiusKm: 10, count: 6, partySize: 12 },
            deps([hotelDoc('Green Stone Boutique Hotel')], partner));
        expect(partner.calls[0]).toMatchObject({ party: 12, radiusKm: 10 });
        const twin = out.find(c => c.name === 'Green Stone Boutique Hotel');
        expect(twin.placeId).toBe('p_GreenStoneBoutiqueHotel');      // still saveable, still its stored image
        expect(twin.source).toBe('cache');
        expect(twin.hotelPrice).toMatchObject({ perNight: 210, rooms: 6, url: 'https://wl/hotels/lp1' });
        const fresh = out.find(c => c.name === 'Vayots Dzor Villa');
        expect(fresh).toBeTruthy();
        expect(fresh.source).toBe('partner');
        expect(fresh.placeId).toBeNull();                            // never a faked Google id
        expect(fresh.image).toBe('https://cdn.partner/2.jpg');
        expect(fresh.address).toBe('5 Shahumyan');
        expect(fresh.rating).toBeNull();                             // a 0-10 score is not a 0-5 rating
        expect(fresh._guestRating).toBe(9.1);
        expect(out.indexOf(fresh)).toBeGreaterThan(out.indexOf(twin));   // tail = lowest prior
    });
    test('only hotels, only with a key, and any partner failure leaves the pool untouched', async () => {
        const partner = { calls: [], out: PARTNER() };
        const asRestaurant = await loadCandidates({ category: 'restaurants', center: CENTER, count: 6 }, deps([cacheDoc({ name: 'Lavash' })], partner));
        expect(partner.calls).toHaveLength(0);
        expect(asRestaurant.map(c => c.name)).toEqual(['Lavash']);
        const off = { ...deps([hotelDoc('Green Stone Boutique Hotel')], partner), hotelsApi: { hotelsEnabled: () => false } };
        expect((await loadCandidates({ category: 'hotels', center: CENTER, count: 6 }, off)).map(c => c.name)).toEqual(['Green Stone Boutique Hotel']);
        const broken = { ...deps([hotelDoc('Green Stone Boutique Hotel')], partner) };
        broken.hotelsApi = { ...broken.hotelsApi, areaHotels: async () => { throw new Error('partner 503'); } };
        const out = await loadCandidates({ category: 'hotels', center: CENTER, count: 6 }, broken);
        expect(out.map(c => c.name)).toEqual(['Green Stone Boutique Hotel']);
        expect(out[0].hotelPrice).toBeUndefined();
    });
    test('an unbookable partner hotel is added only while the deck is short, and is marked', async () => {
        const unpriced = PARTNER({ hotels: [{ hotel_id: 'lp3', name: 'Full House Inn', lat: CENTER.lat + 0.02, lng: CENTER.lng + 0.02, city: 'Yeghegnadzor', available: false, price_per_night: null, currency: 'USD', rooms: 6, nights: 1 }] });
        const partner = { calls: [], out: unpriced };
        const thin = await loadCandidates({ category: 'hotels', center: CENTER, radiusKm: 10, count: 6 }, deps([hotelDoc('Green Stone Boutique Hotel')], partner));
        const row = thin.find(c => c.name === 'Full House Inn');
        expect(row._partnerUnpriced).toBe(true);
        expect(row.hotelPrice).toBeNull();                           // no rate ⇒ no number, ever
        const full = await loadCandidates({ category: 'hotels', center: CENTER, radiusKm: 10, count: 1 },
            deps([hotelDoc('Green Stone Boutique Hotel')], { calls: [], out: unpriced }));
        expect(full.map(c => c.name)).not.toContain('Full House Inn');
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

// Name-ask quarantine (founder 2026-08-31: "this location will not appear
// for other users if staff or admin have not admited yet"): the cache query
// must exclude quarantined rows the same way it excludes aiBlocked ones.
describe('buildCacheQuery — name-ask quarantine', () => {
    test('quarantined rows are excluded at the source', () => {
        const q = require('../engine/places/canonicalStore').buildCacheQuery({
            center: { lat: 40.18, lng: 44.51 }, radiusKm: 15, category: 'hotels',
        });
        expect(q.nameAskPending).toEqual({ $ne: true });
        expect(q.aiBlocked).toEqual({ $ne: true });   // the pattern it rides on
    });
});

// Staff verdict on CACHE rows (founder 2026-09-01, 4th budget-in-luxury
// report): validator tags cached places via INTERESTS chips — a different
// field from curated type tags — and nothing read it. Plus: luxury demands
// evidence from untagged rows (Google tier / rating), budget keeps unknowns.
describe('cache style gate — interests verdict + luxury evidence', () => {
    const { cacheDocToCandidate } = require('../engine/places/canonicalStore');
    const mk = (over) => cacheDocToCandidate({
        placeId: 'p', name: 'X Hotel', rating: 4.6, types: ['hotel', 'lodging'],
        primaryType: 'hotel', priceLevel: null, interests: [], details: {}, photos: [],
        ...over,
    }, null);
    test('candidate carries the staff interests chips', () => {
        expect(mk({ interests: ['budget'] }).interests).toEqual(['budget']);
        expect(mk({}).interests).toEqual([]);
    });
});

// ── A BROAD ASK IS NOT A NARROW ONE (founder design; live 2026-09-03) ──
// "I'm at Khor Virap. What should I visit next?" was read as `historical`, and
// four separate gates — cache actions, Destination type, Business type, the
// Google type check — then discarded the traveler's own restaurant and hidden
// gem a few km away, and paid Google to replace them with strangers.
describe('broad-ask widening', () => {
    const { alsoTypesFor, namesVenueType } = require('../engine/retrieval/tuning');
    const { buildCacheQuery } = require('../engine/places/canonicalStore');
    const CENTRE = { lat: 39.878, lng: 44.576 };

    test('widens only inside the sightseeing family', () => {
        expect(alsoTypesFor('historical', 'What should I visit next?'))
            .toEqual(['historical', 'activities', 'photo_spots', 'hidden_gems']);
        expect(alsoTypesFor('activities', 'What can I do within 10 km?')[0]).toBe('activities');
        // Food and lodging must never widen into museums.
        expect(alsoTypesFor('restaurants', 'somewhere to eat')).toBeNull();
        expect(alsoTypesFor('hotels', 'where should I stay')).toBeNull();
        expect(alsoTypesFor('events', 'what is on')).toBeNull();
        expect(alsoTypesFor(null, 'anything')).toBeNull();
    });

    test('a named venue type keeps the ask narrow', () => {
        expect(alsoTypesFor('historical', 'What is the closest monastery?')).toBeNull();
        expect(alsoTypesFor('activities', 'any good bars nearby?')).toBeNull();
        expect(namesVenueType('ближайший монастырь')).toBe(true);
        expect(namesVenueType('что посмотреть рядом')).toBe(false);
    });

    test('the leading category still comes first — it leads the deck', () => {
        expect(alsoTypesFor('photo_spots', 'what should I see here')[0]).toBe('photo_spots');
    });

    test('the cache gate opens to the whole admissible set', () => {
        const wide = buildCacheQuery({ center: CENTRE, radiusKm: 5, category: 'historical',
            alsoTypes: ['historical', 'activities', 'photo_spots', 'hidden_gems'] });
        expect(wide.actions).toEqual({ $in: ['historical', 'activities', 'photo_spots', 'hidden_gems'] });
    });

    test('without it the gate is exactly as strict as before', () => {
        const narrow = buildCacheQuery({ center: CENTRE, radiusKm: 5, category: 'historical' });
        expect(narrow.actions).toBe('historical');
    });
});

// ── A row tagged with BOTH styles serves both audiences (live 2026-09-03) ──
// A curated restaurant near Khor Virap carried `luxury` AND `budget` — the
// validator's chip grid lets staff tick both — and the style verdict, which
// tested the OPPOSITE tag first, hid it from every luxury traveler.
describe('styleVerdict', () => {
    const { styleVerdict } = require('../engine/places/canonicalStore');

    test('both tags → the traveler\'s own style wins, the row is kept', () => {
        expect(styleVerdict(['luxury', 'budget'], 'luxury')).toBe(true);
        expect(styleVerdict(['budget', 'luxury'], 'budget')).toBe(true);
    });

    test('the opposite tag alone is still a staff verdict', () => {
        expect(styleVerdict(['budget'], 'luxury')).toBe(false);
        expect(styleVerdict(['luxury'], 'budget')).toBe(false);
    });

    test('no style tag → no verdict, the caller decides', () => {
        expect(styleVerdict(['romantic', 'nature'], 'luxury')).toBeNull();
        expect(styleVerdict([], 'luxury')).toBeNull();
    });

    test('no style preference → never a verdict', () => {
        expect(styleVerdict(['budget'], null)).toBeNull();
        expect(styleVerdict(['budget'], 'mid')).toBeNull();
    });

    test('case and junk are folded, never thrown', () => {
        expect(styleVerdict(['LUXURY', 'Budget'], 'luxury')).toBe(true);
        expect(styleVerdict(null, 'luxury')).toBeNull();
    });
});

// ── Hide means hidden everywhere, including when Google re-sells it ──
// Founder, 2026-09-03: "i have set hide from admin page some locations in
// placecache but it shows". buildCacheQuery honoured explore.status, so the
// cache tier dropped the row — and the paid fallback then bought the same
// place back and carded it. Proof in that turn's own log: "[images] … is
// hidden — downloaded photos NOT stored", then that place in the pool as
// source 'google'.
describe('googleFallback respects the staff hide', () => {
    const { googleFallback } = require('../engine/places/canonicalStore');
    const CENTRE = { lat: 39.878, lng: 44.576 };
    const found = [
        { place_id: 'p_hidden', name: 'Virap View Point', geometry: { location: { lat: 39.8784, lng: 44.5762 } } },
        { place_id: 'p_ok', name: 'Artashat site', geometry: { location: { lat: 39.879, lng: 44.577 } } },
    ];
    const deps = (hiddenIds) => ({
        coverage: async () => true,
        findPlaces: async () => found,
        resolveDetails: async (id) => ({ name: id, types: ['tourist_attraction'], primaryType: 'tourist_attraction',
            photos: [{ url: 'x' }], details: { formatted_address: 'a' }, formatted_address: 'a',
            geometry: { location: { lat: 39.879, lng: 44.577 } } }),
        typeGate: () => true,
        hiddenIds,
    });

    test('a hidden place is not re-bought', async () => {
        const out = await googleFallback({ query: 'historical', category: 'historical', center: CENTRE,
            radiusKm: 15, needed: 5 }, deps(async () => [{ placeId: 'p_hidden', name: 'Virap View Point' }]));
        expect(out.map(p => p.placeId)).not.toContain('p_hidden');
        expect(out.map(p => p.placeId)).toContain('p_ok');
    });

    test('nothing hidden → both survive', async () => {
        const out = await googleFallback({ query: 'historical', category: 'historical', center: CENTRE,
            radiusKm: 15, needed: 5 }, deps(async () => []));
        expect(out).toHaveLength(2);
    });

    test('a failed lookup never blocks the turn', async () => {
        const out = await googleFallback({ query: 'historical', category: 'historical', center: CENTRE,
            radiusKm: 15, needed: 5 }, deps(async () => { throw new Error('mongo down'); }));
        expect(out).toHaveLength(2);
    });
});

describe('closed businesses and non-leisure types never reach a deck (2026-09-16)', () => {
    const ok = { proximity: async () => ({}), placeMatches: () => true, coverage: async () => false };
    test('a business Google marks closed is dropped from the cache tier; null status is kept', async () => {
        const docs = [
            cacheDoc({ name: 'Cascade Royal', types: ['restaurant'], business_status: 'CLOSED_TEMPORARILY' }),
            cacheDoc({ name: 'Gone For Good', types: ['restaurant'], business_status: 'CLOSED_PERMANENTLY' }),
            cacheDoc({ name: 'Never Checked', types: ['restaurant'] }),
            cacheDoc({ name: 'Open Business', types: ['restaurant'], business_status: 'OPERATIONAL' }),
        ];
        const out = await loadCandidates({ category: null, center: CENTER }, { ...ok, cacheFind: async () => docs });
        expect(out.map(c => c.name).sort()).toEqual(['Never Checked', 'Open Business']);
    });
    test('a hospital, a pharmacy and a school are not a night out', async () => {
        const docs = [
            cacheDoc({ name: 'Medical Center', types: ['hospital', 'health'] }),
            cacheDoc({ name: 'Pharmacy', types: ['pharmacy'] }),
            cacheDoc({ name: 'School', types: ['school'] }),
            cacheDoc({ name: 'Rooftop Bar', types: ['bar'] }),
        ];
        const out = await loadCandidates({ category: null, center: CENTER }, { ...ok, cacheFind: async () => docs });
        expect(out.map(c => c.name)).toEqual(['Rooftop Bar']);
    });
});

describe('right-now asks (2026-09-16, 03:00 live)', () => {
    const ok = { proximity: async () => ({}), placeMatches: () => true, coverage: async () => false };
    const night = { dayOfWeek: 2, hour: 3, minute: 0 };
    const dayHours = { periods: [{ open: { day: 2, time: '0900' }, close: { day: 2, time: '1800' } }] };
    const allNight = { periods: [{ open: { day: 0, time: '0000' } }] };

    test('a grocery store is a shopping answer and nothing else', async () => {
        const docs = [
            cacheDoc({ name: 'Yerevan City', types: ['supermarket', 'grocery_store'] }),
            cacheDoc({ name: 'Vernissage', types: ['market'] }),
            cacheDoc({ name: 'Danny\'s', types: ['bar'] }),
        ];
        const general = await loadCandidates({ category: null, center: CENTER }, { ...ok, cacheFind: async () => docs });
        expect(general.map(c => c.name).sort()).toEqual(['Danny\'s', 'Vernissage']);
        const shopping = await loadCandidates({ category: 'shopping', center: CENTER }, { ...ok, cacheFind: async () => docs });
        expect(shopping.map(c => c.name)).toContain('Yerevan City');
    });

    test('when few owned rows are confirmed open, the paid search fires with openNow even though the pool looked full', async () => {
        // Every name carries the query word, so no "uncovered token" can fire
        // the paid search on its own — only the confirmed-open shortfall can.
        const docs = [];
        for (let i = 0; i < 12; i++) docs.push(cacheDoc({ name: `Day Bar ${i}`, opening_hours: dayHours }));
        docs.push(cacheDoc({ name: 'All Night Bar', opening_hours: allNight }));
        let call = null;
        const out = await loadCandidates(
            { category: 'restaurants', center: CENTER, query: 'bar', coreQuery: 'bar', enforceOpenNow: true, timeContext: night },
            { ...ok, cacheFind: async () => docs, coverage: async () => true,
              findPlaces: async (q, loc, rid, opts) => { call = { q, opts }; return [{ place_id: 'g1', name: 'Open Club', geometry: { location: { lat: CENTER.lat + 0.01, lng: CENTER.lng } }, types: ['restaurant'], primaryType: 'restaurant' }]; },
              resolveDetails: async (id) => ({ name: null, rating: 4.3, formatted_address: `${id} St`, imagesStored: true }),
              searchCache: { get: async () => null, set: async () => {} } });
        expect(call).not.toBeNull();
        expect(call.opts.openNow).toBe(true);
        expect(out.map(c => c.name)).toContain('Open Club');
    });

    test('by day the same full pool asks Google for nothing', async () => {
        const docs = [];
        for (let i = 0; i < 13; i++) docs.push(cacheDoc({ name: `Day Bar ${i}`, opening_hours: dayHours }));
        let called = false;
        await loadCandidates(
            { category: 'restaurants', center: CENTER, query: 'bar', coreQuery: 'bar' },
            { ...ok, cacheFind: async () => docs, coverage: async () => true, findPlaces: async () => { called = true; return []; },
              resolveDetails: async () => null, searchCache: { get: async () => null, set: async () => {} } });
        expect(called).toBe(false);
    });
});
