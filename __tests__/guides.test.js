// Guide pages (founder 2026-10-02). The rules every guide input passes through.
const svc = require('../services/guideService');

describe('page names (jinni.travel/@handle)', () => {
    test('Instagram-style handles are accepted and normalised', () => {
        expect(svc.normalizeHandle('@Ani.Travels ')).toBe('ani.travels');
        expect(svc.normalizeHandle('yerevan_eats_2')).toBe('yerevan_eats_2');
    });
    test('bad shapes and app paths are refused', () => {
        for (const bad of ['ab', 'a'.repeat(31), 'has space', 'ümlaut', '.dot', 'dot.', 'two..dots', 'admin', 'chat', 'business', 'guides', 'jinni']) {
            expect(svc.normalizeHandle(bad)).toBeNull();
        }
    });
});

describe('Instagram post links', () => {
    test('reels, posts and tv links become one canonical form with an embed url', () => {
        expect(svc.parseInstagramPost('https://www.instagram.com/reel/C9xYz12AbC/?igsh=abc')).toEqual({
            kind: 'reel', code: 'C9xYz12AbC', url: 'https://www.instagram.com/reel/C9xYz12AbC/', embedUrl: 'https://www.instagram.com/reel/C9xYz12AbC/embed',
        });
        expect(svc.parseInstagramPost('https://instagram.com/reels/C9xYz12AbC').kind).toBe('reel');
        expect(svc.parseInstagramPost('https://www.instagram.com/p/C9xYz12AbC/').kind).toBe('p');
        expect(svc.parseInstagramPost('https://www.instagram.com/ani.travels/reel/C9xYz12AbC/').code).toBe('C9xYz12AbC');
    });
    test('profiles, stories, other sites and plain http are refused', () => {
        for (const bad of ['https://www.instagram.com/ani.travels/', 'https://www.instagram.com/stories/ani/123/',
            'https://tiktok.com/@ani/video/1', 'http://www.instagram.com/reel/C9xYz12AbC/', 'not a url', '']) {
            expect(svc.parseInstagramPost(bad)).toBeNull();
        }
    });
});

test('verification codes read by eye: jinni- plus 4 letters, never 0/O/1/I', () => {
    for (let i = 0; i < 50; i++) expect(svc.makeVerificationCode()).toMatch(/^jinni-[A-HJ-NP-Z2-9]{4}$/);
});

describe('application form', () => {
    const ok = { handle: 'ani.travels', instagram: '@Ani.Travels', displayName: 'Ani', region: 'Dilijan', languages: ['en', 'HY', 'xx'], acceptTerms: true, guideType: 'licensed', bio: '  I love   the north ' };
    test('a good form is cleaned', () => {
        expect(svc.sanitizeApplication(ok)).toEqual({
            handle: 'ani.travels', instagram: 'ani.travels', displayName: 'Ani', region: 'Dilijan',
            languages: ['en', 'hy'], bio: 'I love the north', guideType: 'licensed',
        });
    });
    test('each missing piece is named, and terms must be accepted', () => {
        expect(svc.sanitizeApplication({ ...ok, handle: 'x', instagram: 'x' }).error).toMatch(/page name/);
        expect(svc.sanitizeApplication({ ...ok, displayName: 'A' }).error).toMatch(/name/);
        expect(svc.sanitizeApplication({ ...ok, region: '' }).error).toMatch(/where you guide/);
        expect(svc.sanitizeApplication({ ...ok, acceptTerms: false }).error).toMatch(/terms/);
        expect(svc.sanitizeApplication({ ...ok, guideType: 'hacker' }).guideType).toBe('local');
    });
});

describe('picks', () => {
    test('only the guide categories — never hotels, flights or events', () => {
        for (const c of ['restaurant', 'hidden_gem', 'photo_spot', 'activity']) expect(svc.sanitizePick({ category: c, placeId: 'ChIJ1' }).error).toBeUndefined();
        for (const c of ['hotels', 'flight', 'events', '']) expect(svc.sanitizePick({ category: c, placeId: 'ChIJ1' }).error).toBeTruthy();
    });
    test('a pick must name a place from search', () => {
        expect(svc.sanitizePick({ category: 'restaurant' }).error).toMatch(/search/);
    });
    test('the reel link is canonicalised; a non-Instagram link is refused', () => {
        expect(svc.sanitizePick({ category: 'photo_spot', placeId: 'p', reelUrl: 'https://instagram.com/reel/ABCDE12345?x=1' }).reelUrl).toBe('https://www.instagram.com/reel/ABCDE12345/');
        expect(svc.sanitizePick({ category: 'photo_spot', placeId: 'p', reelUrl: 'https://youtube.com/watch?v=1' }).error).toMatch(/Instagram/);
    });
    test('a tour lives only on an activity and must say how to book', () => {
        const tour = { title: 'Sunrise hike', durationHours: '4', price: '15000', currency: 'amd', languages: ['en', 'ru'], contact: 'WhatsApp +374 00 000000' };
        expect(svc.sanitizePick({ category: 'activity', placeId: 'p', tour }).tour).toEqual({ title: 'Sunrise hike', durationHours: 4, price: 15000, currency: 'AMD', languages: ['en', 'ru'], contact: 'WhatsApp +374 00 000000' });
        expect(svc.sanitizePick({ category: 'restaurant', placeId: 'p', tour }).tour).toBeNull();
        expect(svc.sanitizePick({ category: 'activity', placeId: 'p', tour: { ...tour, contact: '' } }).error).toMatch(/book/);
    });
});

test('the public view never leaks the account, code or staff notes', () => {
    const v = svc.publicGuide({ handle: 'ani', displayName: 'Ani', instagram: 'ani', bio: 'b', region: 'Dilijan', languages: ['en'], guideType: 'local',
        user: 'u1', verification: { code: 'jinni-ABCD', staffNotes: 'secret' }, status: 'active' });
    expect(Object.keys(v).sort()).toEqual(['bio', 'displayName', 'guideType', 'handle', 'instagram', 'languages', 'region']);
});

describe('attachGuidePicks — "Picked by @guide" on chat cards', () => {
    const q = (rows) => ({ select: () => ({ lean: async () => rows }) });
    const deps = (picks, guides) => ({ GuidePick: { find: () => q(picks) }, Guide: { find: () => q(guides) } });

    test('a card whose place an ACTIVE guide picked gets the badge data (max two)', async () => {
        const recs = [{ placeId: 'A', name: 'Cafe A' }, { placeId: 'B', name: 'B' }];
        await svc.attachGuidePicks(recs, deps(
            [{ guide: 'g1', placeId: 'A', note: 'Best gata', reelUrl: 'https://www.instagram.com/reel/X1/', category: 'restaurant' },
             { guide: 'g2', placeId: 'A', note: '', category: 'restaurant' }, { guide: 'g3', placeId: 'A', category: 'restaurant' }],
            [{ _id: 'g1', handle: 'ani', displayName: 'Ani' }, { _id: 'g2', handle: 'aram', displayName: 'Aram' }, { _id: 'g3', handle: 'mari', displayName: 'Mari' }]));
        expect(recs[0].guidePicks).toHaveLength(2);
        expect(recs[0].guidePicks[0]).toEqual({ handle: 'ani', displayName: 'Ani', note: 'Best gata', reelUrl: 'https://www.instagram.com/reel/X1/', category: 'restaurant' });
        expect(recs[1].guidePicks).toBeUndefined();
    });
    test('picks of a guide who is not active (pending/suspended) never show', async () => {
        const recs = [{ placeId: 'A' }];
        await svc.attachGuidePicks(recs, deps([{ guide: 'g9', placeId: 'A', category: 'restaurant' }], []));
        expect(recs[0].guidePicks).toBeUndefined();
    });
    test('a database failure never costs the reply', async () => {
        const recs = [{ placeId: 'A' }];
        const broken = { GuidePick: { find: () => { throw new Error('db down'); } }, Guide: { find: () => q([]) } };
        await expect(svc.attachGuidePicks(recs, broken)).resolves.toBe(recs);
    });
});

test('reserved words are exported so the availability check can say "reserved"', () => {
    for (const w of ['admin', 'chat', 'guides', 'jinni']) expect(svc.RESERVED.has(w)).toBe(true);
    expect(svc.normalizeHandle('admin')).toBeNull();
});

describe('security', () => {
    test('account deletion removes the guide page and its picks', async () => {
        const calls = [];
        const deps = {
            Guide: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'g1', handle: 'ani' }) }) }), deleteOne: async (q) => calls.push(['guide', q]) },
            GuidePick: { deleteMany: async (q) => calls.push(['picks', q]) },
        };
        expect(await svc.deleteGuideForUser('u1', deps)).toBe(1);
        expect(calls).toEqual([['picks', { guide: 'g1' }], ['guide', { _id: 'g1' }]]);
    });
    test('a user with no guide page: nothing to delete, and a db error never blocks account deletion', async () => {
        const none = { Guide: { findOne: () => ({ select: () => ({ lean: async () => null }) }) }, GuidePick: {} };
        expect(await svc.deleteGuideForUser('u1', none)).toBe(0);
        const broken = { Guide: { findOne: () => { throw new Error('db down'); } }, GuidePick: {} };
        expect(await svc.deleteGuideForUser('u1', broken)).toBe(0);
    });
    test('object/operator payloads cannot pass the input cleaners (NoSQL-injection shapes)', () => {
        expect(svc.normalizeHandle({ $gt: '' })).toBeNull();
        expect(svc.sanitizeApplication({ handle: { $ne: null }, instagram: ['a'], displayName: 'Ani', region: 'Yerevan', acceptTerms: true }).error).toBeTruthy();
        expect(svc.sanitizeApplication({ handle: 'ani', instagram: 'ani', displayName: 'Ani', region: 'Yerevan', acceptTerms: 'true' }).error).toMatch(/terms/);
        const p = svc.sanitizePick({ category: 'restaurant', placeId: { $gt: '' } });
        expect(typeof p.placeId).toBe('string');
        expect(svc.sanitizePick({ category: { $in: ['restaurant'] }, placeId: 'x' }).error).toBeTruthy();
    });
    test('a javascript: or data: link can never become a reel', () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'https://instagram.com.evil.com/reel/ABCDE12345/', 'https://evil.com/?u=https://www.instagram.com/reel/ABCDE12345/']) {
            expect(svc.parseInstagramPost(bad)).toBeNull();
        }
    });
});
