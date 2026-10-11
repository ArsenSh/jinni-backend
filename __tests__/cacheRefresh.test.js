// Freshness is a background job, not a visibility gate (founder 2026-10-11).
const { runCacheRefresh, staleQuery, refreshUpdate } = require('../services/cacheRefresh');

const NOW = new Date('2026-10-11T08:00:00Z');
const row = (over = {}) => ({ _id: 'id_' + (over.name || 'x'), placeId: 'p_' + (over.name || 'x'), name: 'Zazoo', ...over });
const details = (over = {}) => ({ rating: 4.3, opening_hours: { periods: [{ open: 1 }] }, business_status: 'OPERATIONAL', types: ['hookah_bar', 'bar'], primaryType: 'hookah_bar', price_level: 'PRICE_LEVEL_MODERATE', website: 'https://z', ...over });

describe('staleQuery', () => {
    test('owned rows older than the threshold, not recently failed', () => {
        const q = staleQuery({ olderThanDays: 30, now: NOW.getTime() });
        expect(q.imagesStored).toBe(true);
        const cutoff = q.$and[0].$or[0].lastFetched.$lt;
        expect(NOW - cutoff).toBe(30 * 864e5);
        expect(q.$and[1].$or[2].refreshFailedAt.$lt).toEqual(cutoff);
    });
});

describe('refreshUpdate', () => {
    test('writes hours, rating, status, types; bumps lastFetched; never touches photos or tags', () => {
        const u = refreshUpdate(row(), details(), NOW);
        expect(u.$set.lastFetched).toBe(NOW);
        expect(u.$set.types).toEqual(['hookah_bar', 'bar']);
        expect(u.$set.business_status).toBe('OPERATIONAL');
        expect(u.$set.priceLevel).toBe('PRICE_LEVEL_MODERATE');
        expect(u.$set.refreshFailedAt).toBeNull();
        expect(u.$inc).toEqual({ fetchCount: 1 });
        for (const k of ['photos', 'imagesStored', 'actions', 'interests', 'details', 'name']) expect(u.$set[k]).toBeUndefined();
    });
    test('staff-curated hours outrank Google', () => {
        const curated = { periods: [{ open: 9 }] };
        const u = refreshUpdate(row({ hoursCurated: true, opening_hours: curated }), details(), NOW);
        expect(u.$set.opening_hours).toBe(curated);
    });
});

describe('runCacheRefresh', () => {
    const harness = (rows, detailsBy) => {
        const writes = [];
        const deps = {
            find: async (q, n) => rows.slice(0, n),
            getPlaceDetails: async (id) => detailsBy[id] === undefined ? details() : detailsBy[id],
            updateOne: async (f, u) => { writes.push([f, u]); },
            sleep: async () => {},
            now: () => NOW,
        };
        return { deps, writes };
    };

    test('refreshes each stale row, records failures without blocking the queue', async () => {
        const rows = [row({ name: 'a' }), row({ name: 'gone' }), row({ name: 'c' })];
        const { deps, writes } = harness(rows, { p_gone: null, p_c: details({ business_status: 'CLOSED_PERMANENTLY' }) });
        const s = await runCacheRefresh({ limit: 10, log: () => {} }, deps);
        expect(s).toMatchObject({ considered: 3, refreshed: 2, failed: 1 });
        expect(s.nonOperational).toEqual(['c (CLOSED_PERMANENTLY)']);
        const gone = writes.find(([f]) => f._id === 'id_gone')[1];
        expect(gone.$set.refreshFailedAt).toBe(NOW);
        expect(gone.$set.lastFetched).toBeUndefined();   // a failure is not a refresh
    });

    test('dry run writes nothing; limit bounds the batch', async () => {
        const rows = [row({ name: 'a' }), row({ name: 'b' })];
        const { deps, writes } = harness(rows, {});
        const dry = await runCacheRefresh({ limit: 1, dryRun: true, log: () => {} }, deps);
        expect(dry).toMatchObject({ considered: 1, refreshed: 0, dryRun: true });
        expect(writes).toHaveLength(0);
    });

    test('a throwing Details call is counted as failed and the sweep goes on', async () => {
        const rows = [row({ name: 'a' }), row({ name: 'b' })];
        const { deps, writes } = harness(rows, {});
        deps.getPlaceDetails = async (id) => { if (id === 'p_a') throw new Error('boom'); return details(); };
        const s = await runCacheRefresh({ limit: 10, log: () => {} }, deps);
        expect(s).toMatchObject({ refreshed: 1, failed: 1 });
        expect(writes).toHaveLength(2);
    });
});
