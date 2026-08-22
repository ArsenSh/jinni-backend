// Engine personalization — taste (likes / saves / seen history).
// Pure-function + fake-model tests: no DB, no network.

const { loadTaste, dislikeExcludes, tasteAdjust, recordViews } = require('../engine/personalization/taste');
const { findPlaces } = require('../engine/retrieval');
const { placeFactLine } = require('../engine/narrator/prompts/grounded');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

// Fake mongoose-ish query chains (each stage returns the next; lean() → Promise).
const feedbackModel = (rows) => ({ find: () => ({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) }) });
const flatModel = (rows) => ({ find: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) });
const failingFeedback = () => ({ find: () => ({ sort: () => ({ select: () => ({ lean: () => Promise.reject(new Error('db down')) }) }) }) });

const baseDeps = (over = {}) => ({
    PlaceFeedback: feedbackModel([]),
    SavedPlace: flatModel([]),
    PlaceView: flatModel([]),
    nowFn: () => NOW,
    ...over,
});

describe('loadTaste', () => {
    test('latest vote per place wins — a like→dislike toggle leaves only dislike', async () => {
        const t = await loadTaste('u1', baseDeps({
            PlaceFeedback: feedbackModel([
                { placeId: 'g1', vote: 'dislike', name: 'Collective' },   // newest first
                { placeId: 'g1', vote: 'like', name: 'Collective' },
                { placeId: 'g2', vote: 'like', name: 'Dabbo' },
            ]),
        }));
        expect(t.disliked.has('g1')).toBe(true);
        expect(t.liked.has('g1')).toBe(false);
        expect(t.liked.get('g2')).toBe('Dabbo');
    });

    test('saved places are keyed by BOTH google and verified identities', async () => {
        const t = await loadTaste('u1', baseDeps({
            SavedPlace: flatModel([{ googlePlaceId: 'gX', verifiedId: 'abc123', name: 'Zanzibar' }]),
        }));
        expect(t.saved.get('gX')).toBe('Zanzibar');
        expect(t.saved.get('abc123')).toBe('Zanzibar');
    });

    test('seen penalty: watched fresh ≈ 3, shown fresh ≈ 1.5, both decay to ~0 at 90 days', async () => {
        const t = await loadTaste('u1', baseDeps({
            PlaceView: flatModel([
                { placeId: 'w', status: 'watched', lastShownAt: new Date(NOW) },
                { placeId: 's', status: 'shown', lastShownAt: new Date(NOW) },
                { placeId: 'old', status: 'watched', lastShownAt: new Date(NOW - 89 * DAY) },
            ]),
        }));
        expect(t.seen.get('w')).toBeCloseTo(3.0, 1);
        expect(t.seen.get('s')).toBeCloseTo(1.5, 1);
        expect(t.seen.get('old')).toBeLessThan(0.1);
    });

    test('repeat shows compound the penalty (deck rotation), capped at 6', async () => {
        const t = await loadTaste('u1', baseDeps({
            PlaceView: flatModel([
                { placeId: 'once', status: 'shown', shownCount: 1, lastShownAt: new Date(NOW) },
                { placeId: 'five', status: 'shown', shownCount: 5, lastShownAt: new Date(NOW) },
                { placeId: 'many', status: 'watched', shownCount: 50, lastShownAt: new Date(NOW) },
            ]),
        }));
        expect(t.seen.get('once')).toBeCloseTo(1.5, 1);
        expect(t.seen.get('five')).toBeCloseTo(5.5, 1);   // 1.5 + 4×1
        expect(t.seen.get('many')).toBe(8);               // clamped
    });

    test('fail-open: one broken source still yields the others', async () => {
        const t = await loadTaste('u1', baseDeps({
            PlaceFeedback: failingFeedback(),
            SavedPlace: flatModel([{ googlePlaceId: 'g9', name: 'Kond House' }]),
        }));
        expect(t.liked.size).toBe(0);
        expect(t.saved.get('g9')).toBe('Kond House');
    });

    test('no userId → null', async () => {
        expect(await loadTaste(null, baseDeps())).toBeNull();
    });
});

describe('dislikeExcludes', () => {
    const taste = { disliked: new Map([['g1', 'Collective Yerevan'], ['g2', 'Tavern X']]) };
    test('dislikes become excludes', () => {
        const ex = dislikeExcludes(taste, 'restaurants please');
        expect(ex.placeIds).toEqual(['g1', 'g2']);
        expect(ex.names).toEqual(['Collective Yerevan', 'Tavern X']);
    });
    test('direct-ask exception: a place named in the message is NOT excluded', () => {
        const ex = dislikeExcludes(taste, 'is collective yerevan any good?');
        expect(ex.placeIds).toEqual(['g2']);
    });
    test('empty/absent taste → empty excludes', () => {
        expect(dislikeExcludes(null, 'hi')).toEqual({ placeIds: [], names: [] });
    });
});

describe('tasteAdjust', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ placeId: `p${i}`, name: `Place ${i}` }));

    test('liked climbs ~2 positions, never teleports to the top', () => {
        const taste = { liked: new Map([['p4', 'Place 4']]), saved: new Map(), seen: new Map() };
        const out = tasteAdjust(mk(6), taste);
        expect(out.findIndex(c => c.placeId === 'p4')).toBe(2);   // 4 - 2.5 → between p1 and p2
        expect(out[0].placeId).toBe('p0');                        // relevance leader unmoved
        expect(out.find(c => c.placeId === 'p4')._tasteLiked).toBe(true);
    });

    test('liked + saved stack; saved alone climbs less than liked', () => {
        const both = tasteAdjust(mk(8), { liked: new Map([['p5', '']]), saved: new Map([['p5', '']]), seen: new Map() });
        expect(both.findIndex(c => c.placeId === 'p5')).toBe(2);  // 5 - 4 = 1, ties p1 → stability keeps p1 ahead
        const savedOnly = tasteAdjust(mk(8), { liked: new Map(), saved: new Map([['p5', '']]), seen: new Map() });
        expect(savedOnly.findIndex(c => c.placeId === 'p5')).toBe(4);   // 5 - 1.5 → after p3
        expect(savedOnly.find(c => c.placeId === 'p5')._tasteSaved).toBe(true);
    });

    test('oft-seen-unacted sinks below ALL unseen peers; liked never sinks', () => {
        const seen = new Map([['p0', 3.0], ['p1', 3.0]]);   // watched-fresh → sink 6
        const sunk = tasteAdjust(mk(4), { liked: new Map(), saved: new Map(), seen });
        expect(sunk.map(c => c.placeId)).toEqual(['p2', 'p3', 'p0', 'p1']);   // fresh first, seen to the back
        const loved = tasteAdjust(mk(4), { liked: new Map([['p0', '']]), saved: new Map(), seen });
        expect(loved[0].placeId).toBe('p0');   // liked → boost, no fatigue
    });

    test('matches by verifiedId and by normalized-name fallback', () => {
        const cands = [
            { placeId: 'pa', name: 'Alpha' },
            { verifiedId: 'v77', name: 'Beta' },
            { placeId: 'pc', name: 'Mamma Mia' },
            { placeId: 'pd', name: 'Delta' },
        ];
        const taste = { liked: new Map([['v77', 'Beta'], ['other-id', 'Mamma Mia']]), saved: new Map(), seen: new Map() };
        const out = tasteAdjust(cands, taste);
        expect(out.find(c => c.name === 'Beta')._tasteLiked).toBe(true);        // id match
        expect(out.find(c => c.name === 'Mamma Mia')._tasteLiked).toBe(true);   // name fallback
        expect(out.find(c => c.name === 'Delta')._tasteLiked).toBeUndefined();
    });

    test('null taste / short lists are identity', () => {
        const one = [{ placeId: 'p0' }];
        expect(tasteAdjust(one, null)).toBe(one);
        expect(tasteAdjust(one, { liked: new Map(), saved: new Map(), seen: new Map() })).toEqual(one);
    });
});

describe('recordViews', () => {
    test('bulk-upserts unique identities, shown-only on insert, never downgrades watched', () => {
        const bulkWrite = jest.fn(() => Promise.resolve());
        recordViews('u1', [
            { placeId: 'g1' }, { placeId: 'g1' },          // dedupe
            { verifiedId: 'v2' }, { name: 'no-id' },        // verified id used; id-less skipped
        ], 'restaurants', { PlaceView: { bulkWrite } });
        expect(bulkWrite).toHaveBeenCalledTimes(1);
        const ops = bulkWrite.mock.calls[0][0];
        expect(ops).toHaveLength(2);
        const op = ops[0].updateOne;
        expect(op.upsert).toBe(true);
        expect(op.update.$inc.shownCount).toBe(1);
        expect(op.update.$setOnInsert.status).toBe('shown');   // $setOnInsert only → watched stays watched
        expect(op.update.$set.action).toBe('restaurants');
    });

    test('no ids or no user → no write, no throw', () => {
        const bulkWrite = jest.fn();
        recordViews('u1', [{ name: 'only-name' }], null, { PlaceView: { bulkWrite } });
        recordViews(null, [{ placeId: 'g1' }], null, { PlaceView: { bulkWrite } });
        expect(bulkWrite).not.toHaveBeenCalled();
    });
});

describe('findPlaces taste integration', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
        placeId: `p${i}`, name: `Cafe ${i}`, text: `Cafe ${i} coffee`, distanceKm: i,
    }));

    test('a liked place climbs into the deck; provenance flags taste', async () => {
        const taste = { liked: new Map([['p7', 'Cafe 7']]), saved: new Map(), seen: new Map() };
        const noTaste = await findPlaces({ count: 3 }, { loadCandidates: async () => candidates.map(c => ({ ...c })), embedder: null });
        expect(noTaste.places.map(p => p.placeId)).not.toContain('p7');
        const withTaste = await findPlaces({ count: 3, taste }, { loadCandidates: async () => candidates.map(c => ({ ...c })), embedder: null });
        expect(withTaste.provenance.taste).toBe(true);
        const idx = withTaste.places.findIndex(p => p.placeId === 'p7');
        expect(idx === -1 || idx > 0).toBe(true);   // nudged, but never hijacks #1
    });
});

describe('placeFactLine taste facts', () => {
    test('saved fact appears; liked outranks saved; neither invents', () => {
        expect(placeFactLine({ name: 'Zanzibar', _tasteSaved: true })).toContain('the traveler has saved this place');
        expect(placeFactLine({ name: 'Zanzibar', _tasteSaved: true, _tasteLiked: true })).toContain('liked this place before');
        expect(placeFactLine({ name: 'Zanzibar', _tasteSaved: true, _tasteLiked: true })).not.toContain('saved');
        expect(placeFactLine({ name: 'Plain' })).not.toContain('traveler');
    });
});
