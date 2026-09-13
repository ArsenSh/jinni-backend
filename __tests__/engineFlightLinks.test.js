// Live 2026-09-13: a reply carrying four ~400-character Aviasales URLs ran
// out of tokens mid-URL, and the chat's `_x_` italics rule broke the first
// one. The narrator now writes /go/f/<id>; the id redirects to the real URL.
const { shortenBookUrl, resolveBookUrl, shortId, ID_RE } = require('../engine/travel/flightLinks');
const { fareRedirect } = require('../routes/goRoutes');
const { makeExecutors } = require('../engine/narrator/tools');

const REAL = 'https://www.aviasales.com/search/EVN1509MOW1?t=3F1789455600_e6a502b7373f047b_8348&expected_price=99&marker=774501';

const memStore = () => {
    const rows = new Map();
    return {
        rows,
        async save(id, url) { if (rows.has(id)) { const e = new Error('dup'); e.code = 11000; throw e; } rows.set(id, url); return true; },
        async load(id) { return rows.get(id) || null; },
    };
};

describe('short booking links', () => {
    test('ids are 8 base62 characters — nothing markdown can misread', () => {
        for (let i = 0; i < 50; i++) expect(shortId()).toMatch(ID_RE);
        expect(shortId()).not.toMatch(/[_*~`]/);
    });

    test('a real URL becomes a short one that resolves back to it', async () => {
        const store = memStore();
        const short = await shortenBookUrl(REAL, { store, publicUrl: 'https://api.jinni.travel' });
        expect(short).toMatch(/^https:\/\/api\.jinni\.travel\/go\/f\/[A-Za-z0-9]{8}$/);
        expect(await resolveBookUrl(short.split('/').pop(), { store })).toBe(REAL);
    });

    test('an id collision is retried, not surfaced', async () => {
        const store = memStore();
        let calls = 0;
        const flaky = { ...store, async save(id, url) { calls++; if (calls === 1) { const e = new Error('dup'); e.code = 11000; throw e; } return store.save(id, url); } };
        const short = await shortenBookUrl(REAL, { store: flaky, publicUrl: 'https://x' });
        expect(short).toMatch(/^https:\/\/x\/go\/f\//);
        expect(calls).toBe(2);
    });

    test('with no store the REAL url is handed back — a long link beats no link', async () => {
        const down = { async save() { return false; }, async load() { return null; } };
        expect(await shortenBookUrl(REAL, { store: down })).toBe(REAL);
        const broken = { async save() { throw new Error('mongo down'); }, async load() { return null; } };
        expect(await shortenBookUrl(REAL, { store: broken })).toBe(REAL);
        expect(await shortenBookUrl(null, { store: down })).toBeNull();
        expect(await shortenBookUrl('/search/relative', { store: down })).toBe('/search/relative');
    });

    test('unknown, expired or malformed ids resolve to nothing', async () => {
        const store = memStore();
        expect(await resolveBookUrl('ZZZZZZZZ', { store })).toBeNull();
        expect(await resolveBookUrl('../etc', { store })).toBeNull();
        expect(await resolveBookUrl('', { store })).toBeNull();
    });
});

describe('GET /go/f/:id', () => {
    const fakeRes = () => {
        const r = { code: null, headers: {}, body: null, redirected: null };
        r.status = (c) => { r.code = c; return r; };
        r.type = () => r;
        r.send = (b) => { r.body = b; return r; };
        r.redirect = (c, url) => { r.code = c; r.redirected = url; return r; };
        return r;
    };
    test('an unknown id is a plain sentence, never a guessed page', async () => {
        const res = fakeRes();
        await fareRedirect({ params: { id: 'nope' } }, res);
        expect(res.code).toBe(404);
        expect(res.body).toMatch(/expired/i);
        expect(res.redirected).toBeNull();
    });
});

describe('the executor hands the narrator short links and honest wording', () => {
    test('every fare\'s bookUrl is shortened; the note forbids "cheapest" and asks for one fare a day', async () => {
        const store = memStore();
        const exec = makeExecutors({}, {
            searchFlightsWindow: async () => ({
                origin: 'EVN', destination: 'MOW', currency: 'USD', window: { from: '2026-09-14', to: '2026-09-20' },
                offers: [
                    { price: 99, airline: '3F', airlineName: 'FlyOne Armenia', departureAt: '2026-09-15T07:00:00+04:00', transfers: 0, bookUrl: REAL },
                    { price: 120, airline: '3F', airlineName: 'FlyOne Armenia', departureAt: '2026-09-16T07:00:00+04:00', transfers: 0, bookUrl: REAL + '&x=2' },
                ],
                nearest: [],
            }),
            shortenBookUrl: (url) => shortenBookUrl(url, { store, publicUrl: 'https://api.jinni.travel' }),
        });
        const out = await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-20' });
        expect(out.offers).toHaveLength(2);
        for (const o of out.offers) expect(o.bookUrl).toMatch(/^https:\/\/api\.jinni\.travel\/go\/f\/[A-Za-z0-9]{8}$/);
        expect(store.rows.size).toBe(2);
        expect(out.note).toMatch(/never "the cheapest"/);
        expect(out.note).toMatch(/ONE fare per day/);
        expect(out.note).toMatch(/\[Wizz Air\]\(<bookUrl>\)/);
    });
});
