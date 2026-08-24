// The network-capture tier: events out of the JSON a single-page app fetched
// for itself. Arsen 2026-08-24: "lets build the network capture tier".
//
// The payload shapes below are the ones this class of site actually uses —
// nested under data/props, epoch seconds in one place and ISO in another, venue
// as an object, price as {amount, currency}.

const { eventsFromApi, eventsFromJson, _dateish, _price, _venue } = require('../engine/events/apiEvents');

const soon = (days) => new Date(Date.now() + days * 86400000);

describe('reading events out of a page\'s own API', () => {
    test('finds a listing nested several levels down', () => {
        const iso = soon(5).toISOString();
        const payload = { data: { page: { props: { events: [
            { id: 1, title: 'Coldplay Live', start_date: iso, venue: { name: 'Coca-Cola Arena' },
              url: '/e/coldplay', image: 'https://cdn.x/p.jpg', price: { amount: 250, currency: 'AED' } },
        ] } } } };
        const [ev] = eventsFromJson(payload, 'https://dubai.platinumlist.net/');
        expect(ev.name).toBe('Coldplay Live');
        expect(ev.venueName).toBe('Coca-Cola Arena');
        expect(ev.url).toBe('https://dubai.platinumlist.net/e/coldplay');
        expect(ev.price).toBe('250 AED');
        expect(ev.startDate.toISOString()).toBe(iso);
    });

    test('key names are irrelevant — shape decides', () => {
        // No 'name', no 'startDate'. A redesign that renames its fields must not
        // silently return nothing, which is how "proposed 0" happened before.
        const payload = [{ eventName: 'Desert Jazz', beginDate: soon(3).toISOString(), hall: 'Opera House' }];
        const [ev] = eventsFromJson(payload, 'https://x.ae/');
        expect(ev.name).toBe('Desert Jazz');
        expect(ev.venueName).toBe('Opera House');
    });

    test('epoch seconds and milliseconds both read correctly', () => {
        const target = soon(4);
        expect(_dateish(Math.floor(target.getTime() / 1000)).getUTCFullYear()).toBe(target.getUTCFullYear());
        expect(_dateish(target.getTime()).getUTCFullYear()).toBe(target.getUTCFullYear());
        // A 1970 epoch slip is a parse failure, not an event.
        expect(_dateish(1)).toBeNull();
        expect(_dateish(0)).toBeNull();
    });

    test('an undated row is dropped, never defaulted', () => {
        const payload = [{ title: 'Mystery Night', venue: 'Somewhere' }];
        expect(eventsFromJson(payload, 'https://x.ae/')).toHaveLength(0);
    });

    test('a time is not a date', () => {
        expect(_dateish('19:30')).toBeNull();
        expect(_dateish('12')).toBeNull();
    });

    test('a name is a name, not a URL', () => {
        const payload = [{ name: 'https://x.ae/e/1', date: soon(2).toISOString() }];
        expect(eventsFromJson(payload, 'https://x.ae/')).toHaveLength(0);
    });

    test('an ambiguous zero price is not a fact', () => {
        expect(_price({ price: 0 })).toBeNull();
        expect(_price({ price: '' })).toBeNull();
        expect(_price({ minPrice: 150, currencyCode: 'aed' })).toBe('150 AED');
        expect(_price({ price: 99 })).toBe('99');          // no currency stated ⇒ none invented
    });

    test('a venue may be a string or an object', () => {
        expect(_venue({ venue: 'Dubai Opera' })).toBe('Dubai Opera');
        expect(_venue({ location: { name: 'Coca-Cola Arena', city: 'Dubai' } })).toBe('Coca-Cola Arena');
        expect(_venue({ title: 'no venue here' })).toBeNull();
    });

    test('the same event across two responses appears once', () => {
        const iso = soon(6).toISOString();
        const api = [
            { url: 'https://x.ae/api/list', data: { events: [{ name: 'Expo Opening', startDate: iso }] } },
            { url: 'https://x.ae/api/page2', data: { events: [{ name: 'Expo Opening', startDate: iso }] } },
        ];
        expect(eventsFromApi(api, 'https://x.ae/')).toHaveLength(1);
    });

    test('a self-referencing payload terminates and does not lose the others', () => {
        const cyclic = {};
        cyclic.self = cyclic;                              // held in check by the depth cap
        const api = [
            { url: 'https://x.ae/api/bad', data: cyclic },
            { url: 'https://x.ae/api/good', data: [{ title: 'Comedy Night', date: soon(1).toISOString() }] },
        ];
        expect(eventsFromApi(api, 'https://x.ae/').map(e => e.name)).toContain('Comedy Night');
    });

    test('a page of settings JSON yields no events', () => {
        const api = [{ url: 'https://x.ae/api/config', data: { theme: 'dark', locale: 'en', version: '2026.8' } }];
        expect(eventsFromApi(api, 'https://x.ae/')).toHaveLength(0);
    });
});
