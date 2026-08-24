// Discovery has to bootstrap ANY city, not the ones we happened to seed.
// Dubai exposed both halves (Arsen 2026-08-24): the probe looked at the bare
// domain root, where platinumlist.net lists nothing, and the gate demanded
// schema.org JSON-LD that our own best sources do not publish either.

const { _cityListingUrls, _datedEventCount } = require('../engine/events/discovery');
const { _onlyVerified } = require('../engine/events/hunt');

describe('_cityListingUrls', () => {
    test("the model's page leads, the patterns follow", () => {
        const urls = _cityListingUrls('platinumlist.net', 'Dubai', 'https://dubai.platinumlist.net/');
        expect(urls[0]).toBe('https://dubai.platinumlist.net/');
        expect(urls).toContain('https://platinumlist.net/dubai');
        expect(urls).toContain('https://platinumlist.net/');           // the old probe, last
    });

    test('without a model answer the patterns alone still find a city page', () => {
        const urls = _cityListingUrls('platinumlist.net', 'Dubai');
        expect(urls).toContain('https://dubai.platinumlist.net/');
        expect(urls).toContain('https://platinumlist.net/en/dubai');
    });

    test('an off-domain "listing page" is refused — that is a different site', () => {
        const urls = _cityListingUrls('platinumlist.net', 'Dubai', 'https://evil.example/dubai');
        expect(urls.some(u => u.includes('evil.example'))).toBe(false);
    });

    test('a subdomain of the proposed host is fine', () => {
        expect(_cityListingUrls('example.com', 'Nice', 'https://tickets.example.com/nice')[0])
            .toBe('https://tickets.example.com/nice');
    });

    test('city names are slugged, not pasted', () => {
        expect(_cityListingUrls('x.com', 'Rio de Janeiro')).toContain('https://rio-de-janeiro.x.com/');
        expect(_cityListingUrls('x.com', 'Zürich')).toContain('https://zurich.x.com/');
    });

    test('no city still yields the language and root probes', () => {
        expect(_cityListingUrls('tomsarkgh.am', null)).toEqual([
            'https://tomsarkgh.am/en', 'https://tomsarkgh.am/en/', 'https://tomsarkgh.am/',
        ]);
    });

    test('garbage from the model never becomes a URL', () => {
        expect(_cityListingUrls('x.com', 'Nice', 'not a url').some(u => u.includes('not a url'))).toBe(false);
    });
});

describe('_datedEventCount', () => {
    const ld = (n) => `<script type="application/ld+json">${JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ '@type': 'Event', name: `E${i}`, startDate: '2026-09-0' + (i + 1) })))}</script>`;

    test('JSON-LD still counts, as it always did', () => {
        expect(_datedEventCount(ld(4))).toBeGreaterThanOrEqual(4);
    });

    test('a page with NO JSON-LD still counts — the gate our own sources failed', () => {
        const microdata = ['2026-09-01', '2026-09-02', '2026-09-03']
            .map(d => `<div itemscope itemtype="http://schema.org/Event"><meta itemprop="startDate" content="${d} 19:00"></div>`).join('');
        expect(_datedEventCount(microdata)).toBeGreaterThanOrEqual(3);
    });

    test('a page with nothing dated counts zero', () => {
        expect(_datedEventCount('<html><body>welcome to our site</body></html>')).toBe(0);
        expect(_datedEventCount('')).toBe(0);
    });
});

describe('_onlyVerified', () => {
    const results = [
        { url: 'https://dubai.platinumlist.net/concerts' },
        { url: 'https://gulfnews.com/business/markets/dubais-biggest-events' },
        { url: 'https://www.ticketmaster.ae/' },
    ];

    test('a newspaper writing ABOUT events is dropped', () => {
        const kept = _onlyVerified(results, ['platinumlist.net', 'ticketmaster.ae'], 'Dubai');
        expect(kept.map(r => r.url)).toEqual([results[0].url, results[2].url]);
    });

    test('with nothing verified we cannot filter, so we do not', () => {
        expect(_onlyVerified(results, [], 'Dubai')).toHaveLength(3);
        expect(_onlyVerified(results, null, 'Dubai')).toHaveLength(3);
    });

    test('unparseable results are dropped rather than trusted', () => {
        expect(_onlyVerified([{ url: 'nonsense' }], ['platinumlist.net'], 'Dubai')).toHaveLength(0);
    });
});

// ── The model's key names are not a contract (Arsen 2026-08-24) ──────────────
// Asking for [{"host":…,"url":…}] and then reading exactly those two keys cost
// a whole Dubai run: "model proposed 0 → 0 real". The model had answered; we
// did not recognise the shape, and the log said only that nothing came back.
describe('proposal parsing is shape-agnostic', () => {
    const { _rowHost, _rowUrl } = require('../engine/events/discovery');

    test('a bare hostname string, the oldest shape', () => {
        expect(_rowHost('platinumlist.net')).toBe('platinumlist.net');
        expect(_rowHost('https://www.Platinumlist.net/dubai')).toBe('platinumlist.net');
    });

    test('the shape we asked for', () => {
        const row = { host: 'ticketmaster.ae', url: 'https://www.ticketmaster.ae/dubai' };
        expect(_rowHost(row)).toBe('ticketmaster.ae');
        expect(_rowUrl(row)).toBe('https://www.ticketmaster.ae/dubai');
    });

    test('other key names the model may reasonably pick', () => {
        expect(_rowHost({ hostname: 'visitdubai.com', link: 'https://visitdubai.com/en/whats-on' })).toBe('visitdubai.com');
        expect(_rowHost({ site: 'timeoutdubai.com' })).toBe('timeoutdubai.com');
        expect(_rowUrl({ hostname: 'visitdubai.com', link: 'https://visitdubai.com/x' })).toBe('https://visitdubai.com/x');
    });

    test('a host recovered from the URL when no host field exists at all', () => {
        expect(_rowHost({ name: 'Dubai Calendar', website: 'https://dubaicalendar.ae/events' })).toBe('dubaicalendar.ae');
    });

    test('nothing hostlike yields nothing — liberal, not credulous', () => {
        for (const row of [{ nothing: 'useful' }, 42, null, undefined, '', 'not a domain', []]) {
            expect(_rowHost(row)).toBe('');
        }
        expect(_rowUrl({ note: 'ask me later' })).toBeNull();
    });
});
