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
        expect(svc.sanitizeApplication({ ...ok, handle: 'x', instagram: 'x' }).error).toMatch(/page address/);
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

describe('Instagram username field (live bug 2026-10-02)', () => {
    test('a real account named like a reserved word is accepted — reserved words guard page addresses only', () => {
        expect(svc.normalizeInstagram('jinni.travel')).toBe('jinni.travel');
        expect(svc.normalizeInstagram('admin')).toBe('admin');
    });
    test('pasted profile links, @ and capitals are cleaned', () => {
        expect(svc.normalizeInstagram('https://www.instagram.com/Ani.Travels/?igsh=abc')).toBe('ani.travels');
        expect(svc.normalizeInstagram('instagram.com/ani_t')).toBe('ani_t');
        expect(svc.normalizeInstagram('@Ani.Travels ')).toBe('ani.travels');
        expect(svc.normalizeInstagram('ab')).toBe('ab');
    });
    test('impossible usernames are refused', () => {
        for (const bad of ['', 'has space', '.dot', 'dot.', 'two..dots', 'a'.repeat(31), 'ümlaut']) expect(svc.normalizeInstagram(bad)).toBeNull();
    });
    test('applying with Instagram "jinni.travel": the Instagram passes, the reserved page address is named as the problem', () => {
        const base = { displayName: 'Arsen', region: 'Yerevan', acceptTerms: true };
        const r = svc.sanitizeApplication({ ...base, instagram: 'jinni.travel', handle: 'jinni.travel' });
        expect(r.error).toMatch(/page address/);
        expect(r.error).not.toMatch(/Instagram/);
        const ok = svc.sanitizeApplication({ ...base, instagram: 'jinni.travel', handle: 'arsen.guide' });
        expect(ok).toMatchObject({ instagram: 'jinni.travel', handle: 'arsen.guide' });
    });
});

test('only admins and staff with the validateGuides permission can moderate guides', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/guideRoutes.js'), 'utf8');
    const m = src.match(/const canValidateGuides = \(u\) => ([\s\S]*?\));\n/);
    expect(m).toBeTruthy();
    const can = eval(`(u) => ${m[1]}`);
    expect(can({ role: 'admin' })).toBe(true);
    expect(can({ role: 'user', isAdmin: true })).toBe(true);
    expect(can({ role: 'staff', staffAssignment: { permissions: { validateGuides: true } } })).toBe(true);
    expect(can({ role: 'staff', staffAssignment: { permissions: { validateBusinesses: true } } })).toBe(false);
    expect(can({ role: 'user', staffAssignment: { permissions: { validateGuides: true } } })).toBe(false);
    expect(can(null)).toBe(false);
});

test('a removed-pick history entry is a valid action (later saves must not fail)', () => {
    const Guide = require('../models/Guide');
    const g = new Guide({ user: '0123456789abcdef01234567', handle: 'abc', displayName: 'A', instagram: 'abc', region: 'Yerevan',
        guideType: 'local', verification: { code: 'jinni-ABCD', history: [{ action: 'pick_removed', notes: 'x' }] } });
    const err = g.validateSync();
    expect(err?.errors?.['verification.history.0.action']).toBeUndefined();
});

describe('pick categories follow Jinni\'s own data (founder 2026-10-02)', () => {
    const svc = require('../services/guideService');
    const rules = svc.categoryRules;

    test('team-set categories limit the guide to those (plus photo spot for landmarks)', () => {
        expect(rules({ curated: true, actions: ['restaurants'] }).allowed).toEqual(['restaurant']);
        expect(rules({ curated: true, actions: ['historical'] }).allowed).toEqual(['photo_spot']);
        expect(rules({ curated: true, actions: ['historical', 'hidden_gems'] }).allowed).toEqual(['hidden_gem', 'photo_spot']);
        expect(rules({ curated: true, actions: ['souvenirs'] }).allowed).toEqual([]);
        expect(rules({ curated: true, actions: ['restaurants'] }).suggested).toBe('restaurant');
    });

    test('uncurated places: the guide chooses, but only food places can be restaurants', () => {
        expect(rules({ curated: false, actions: ['historical'], types: ['church'] }).allowed).toEqual(['hidden_gem', 'photo_spot', 'activity']);
        expect(rules({ curated: false, actions: [], types: ['armenian_restaurant', 'food'] }).allowed).toContain('restaurant');
        expect(rules({ curated: false, actions: [], types: [] }).allowed).toEqual(svc.CATEGORIES);   // legacy rows stay open
    });

    test('hotels and events are never guide picks; a hotel restaurant still is a restaurant', () => {
        expect(rules({ curated: false, actions: ['hotels'], types: ['lodging', 'hotel'] }).allowed).toEqual([]);
        expect(rules({ curated: false, actions: [], types: ['lodging'] }).outOfScope).toBe(true);
        expect(rules({ curated: true, actions: ['events'], isEvent: true }).outOfScope).toBe(true);
        expect(rules({ curated: false, actions: ['hotels', 'restaurants'], types: ['lodging', 'restaurant'] }).allowed).toContain('restaurant');
    });

    test('staff mismatch hint only when Jinni\'s data says otherwise', () => {
        expect(svc.categoryMismatch('restaurant', { actions: ['historical'], types: ['church'] })).toBe(true);
        expect(svc.categoryMismatch('photo_spot', { actions: ['historical'] })).toBe(false);
        expect(svc.categoryMismatch('hidden_gem', { actions: [] })).toBe(false);
    });

    const q = (rows) => { const c = { select: () => c, limit: () => c, lean: async () => rows }; return c; };
    const dest = (o) => ({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Garni Temple', type: ['historical'], location: { city: 'Garni', coordinates: { lat: 40.112, lng: 44.73 } }, images: [], ...o });

    test('search: staff Destinations first, same-named cache row nearby dropped, far one kept, hotels left out', async () => {
        let destQuery = null;
        const Destination = { find: (f) => { destQuery = f; return q([dest()]); } };
        const PlaceCache = { find: () => q([
            { placeId: 'G1', name: 'Garni Temple', details: { geometry: { location: { lat: 40.1121, lng: 44.7301 } } }, actions: ['historical'] },
            { placeId: 'G2', name: 'Garni Temple', details: { geometry: { location: { lat: 41.5, lng: 45.9 } } }, actions: [] },
            { placeId: 'H1', name: 'Garni Hotel', types: ['lodging'], actions: ['hotels'] },
        ]) };
        const out = await svc.placeSearch('garni', {}, { Destination, PlaceCache });
        expect(out.map(p => p.placeId)).toEqual(['dest:aaaaaaaaaaaaaaaaaaaaaaaa', 'G2']);
        expect(out[0].categories.curated).toBe(true);
        expect(out[0].categories.allowed).toEqual(['photo_spot']);
        expect(destQuery.isActive).toEqual({ $ne: false });          // deleted Destinations never searchable
        expect(out[0]._rules).toBeUndefined();                        // internals not sent to the browser
    });

    test('a Destination flagged isHiddenGem may be a hidden-gem pick', async () => {
        const Destination = { find: () => q([dest({ isHiddenGem: true })]) };
        const PlaceCache = { find: () => q([]) };
        const [p] = await svc.placeSearch('garni', {}, { Destination, PlaceCache });
        expect(p.categories.allowed).toEqual(['hidden_gem', 'photo_spot']);
    });

    test('loader: inactive Destinations and malformed dest refs resolve to nothing', async () => {
        let f = null;
        const Destination = { find: (x) => { f = x; return q([]); } };
        const PlaceCache = { find: () => q([]) };
        const m = await svc.loadPickPlaces(['dest:aaaaaaaaaaaaaaaaaaaaaaaa', 'dest:nope', 'dest:{"$gt":""}'], { Destination, PlaceCache });
        expect(m.size).toBe(0);
        expect(f._id.$in).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa']);
        expect(f.isActive).toEqual({ $ne: false });
    });

    test('chat: a staff Destination card gets "Picked by" through its Destination id', async () => {
        const recs = [{ name: 'Garni Temple', placeId: null, _verifiedModel: 'destination', verifiedId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }];
        const GuidePick = { find: () => ({ select: () => ({ lean: async () => [{ guide: 'g1', placeId: 'dest:aaaaaaaaaaaaaaaaaaaaaaaa', category: 'photo_spot' }] }) }) };
        const Guide = { find: () => ({ select: () => ({ lean: async () => [{ _id: 'g1', handle: 'anna', displayName: 'Anna' }] }) }) };
        await svc.attachGuidePicks(recs, { GuidePick, Guide });
        expect(recs[0].guidePicks[0].handle).toBe('anna');
    });
});

test('routes: category is checked on add, and on edit only when it changes (older picks stay editable)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/guideRoutes.js'), 'utf8');
    const add = src.slice(src.indexOf("router.post('/me/picks'"), src.indexOf("router.put('/me/picks/:id'"));
    const edit = src.slice(src.indexOf("router.put('/me/picks/:id'"), src.indexOf("router.delete('/me/picks/:id'"));
    expect(add).toMatch(/categoryProblem\(place, clean\.category\)/);
    expect(edit).toMatch(/if \(clean\.category !== pick\.category\)[\s\S]*categoryProblem/);
});

describe('sign-up fixes found while building the guide sign-up (2026-10-02)', () => {
    const { schemas } = require('../utils/validation');
    const ok = (name) => !schemas.sendVerification.validate({ name, email: 'a@b.co', password: 'Abc123' }).error;
    test('names in every app alphabet pass; HTML characters still never do', () => {
        for (const n of ['Anna Petrosyan', 'Աննա Պետրոսյան', 'Анна', '安娜', 'آنا', "D'Artagnan", 'Jean-Luc', 'Zoë']) expect(ok(n)).toBe(true);
        for (const n of ['<b>x</b>', 'a&b', 'x"y', 'ab1']) expect(ok(n)).toBe(false);
    });
    test('the wrong-code block is keyed on the visitor, not the shared proxy', () => {
        const { clientIp } = require('../controllers/authController');
        expect(clientIp({ headers: { 'cf-connecting-ip': '5.6.7.8' }, ip: '172.70.1.1' })).toBe('5.6.7.8');
        expect(clientIp({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
        const src = require('fs').readFileSync(require('path').join(__dirname, '../controllers/authController.js'), 'utf8');
        const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        expect(code.match(/req\.ip/g)).toHaveLength(1);   // only inside clientIp()
    });
});

// ── Questions ABOUT guides (founder 2026-10-04; live 2026-10-03 22:59 "Are there
//    any guide with you?" was answered "No, I'm not a guide") ──
describe('guide questions', () => {
    const { isGuideAsk, guidesForAsk, guideAskContext } = require('../services/guideService');
    test('isGuideAsk: every app language yes; travel-guide / guide-me / guidebook no', () => {
        for (const m of ['Are there any guide with you?', 'can you recommend a local guide in Dilijan?', 'I need a tour guide for Garni',
            'есть ли гид в Дилижане?', 'je cherche un guide à Erevan', '有导游吗', 'هل يوجد مرشد سياحي', 'Կա՞ գիդ']) expect(isGuideAsk(m)).toBe(true);
        for (const m of ['travel guide to Paris', 'guide me to Cascade', 'any guidebook for Armenia?', 'hidden gems in Garni', '']) expect(isGuideAsk(m)).toBe(false);
    });
    const fakeGuides = (rows) => ({
        Guide: { find: () => ({ select: () => ({ lean: async () => rows }) }) },
        GuidePick: { aggregate: async () => [{ _id: 'g2', n: 5 }, { _id: 'g1', n: 1 }] },
    });
    const ROWS = [
        { _id: 'g1', handle: 'ani.travels', displayName: 'Ani Petrosyan', region: 'Dilijan, Tavush', languages: ['en', 'hy'], guideType: 'local', bio: '' },
        { _id: 'g2', handle: 'haykshahinyan_', displayName: 'Hayk Shahinyan', region: 'Garni, Kotayk', languages: ['hy'], guideType: 'local', bio: 'Nature' },
    ];
    test('guidesForAsk: region match comes first; the rest fill up to 3 by picks', async () => {
        const r = await guidesForAsk({ area: 'dilijan' }, fakeGuides(ROWS));
        expect(r.covering.map(g => g.handle)).toEqual(['ani.travels']);
        expect(r.others.map(g => g.handle)).toEqual(['haykshahinyan_']);
        expect(r.covering[0].url).toBe('https://jinni.travel/@ani.travels');
    });
    test('guidesForAsk: no area → everyone, most picks first; failure → empty, never throws', async () => {
        const r = await guidesForAsk({}, fakeGuides(ROWS));
        expect(r.covering).toEqual([]);
        expect(r.others.map(g => g.handle)).toEqual(['haykshahinyan_', 'ani.travels']);
        const broken = await guidesForAsk({ area: 'x' }, { Guide: { find: () => { throw new Error('db down'); } } });
        expect(broken).toEqual({ area: 'x', covering: [], others: [] });
    });
    test('guideAskContext: names only the given guides and tells the truth when none cover the area', () => {
        const none = guideAskContext({ area: 'Sisian', covering: [], others: [] });
        expect(none).toMatch(/ONLY guides you may name/);
        expect(none).toMatch(/no local guides have joined/);
        expect(none).toMatch(/jinni\.travel\/guides/);
        const elsewhere = guideAskContext({ area: 'Sisian', covering: [], others: [{ name: 'Hayk Shahinyan', handle: 'haykshahinyan_', region: 'Garni', languages: [], picks: 2, url: 'https://jinni.travel/@haykshahinyan_', bio: '' }] });
        expect(elsewhere).toMatch(/none yet/);
        expect(elsewhere).toMatch(/no local guide for that area has joined/);
        expect(elsewhere).toMatch(/@haykshahinyan_/);
    });
    test('guidesForAsk: a pick in the area or a country-wide region counts as covering', async () => {
        const rows = [
            { _id: 'g1', handle: 'ani.travels', displayName: 'Ani', region: 'Dilijan', languages: [], guideType: 'local', bio: '' },
            { _id: 'g2', handle: 'haykshahinyan_', displayName: 'Hayk', region: 'Armenia', languages: [], guideType: 'local', bio: '' },
            { _id: 'g3', handle: 'garni.walks', displayName: 'Gor', region: 'Yerevan', languages: [], guideType: 'local', bio: '' },
        ];
        const deps = { Guide: { find: () => ({ select: () => ({ lean: async () => rows }) }) },
            GuidePick: { aggregate: async () => [{ _id: 'g3', n: 1, places: ['Garni temple'] }, { _id: 'g2', n: 2, places: ['Tatev'] }] } };
        const r = await guidesForAsk({ area: 'Garni' }, deps);
        expect(r.covering.map(g => g.handle)).toEqual(['garni.walks', 'haykshahinyan_']);   // pick match first, then country-wide
        expect(r.others.map(g => g.handle)).toEqual(['ani.travels']);
    });
});
