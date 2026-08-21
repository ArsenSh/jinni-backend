// Characterization tests for the V2 engine's events machinery (network-free parts):
// SSRF guards (safeFetch) and JSON-LD listing parsing (listing). Cases come from
// the documented production behavior (Events-Handoff rounds 42–47: the 36
// parser/SSRF assertions, the date-semantics rule, the @graph/ItemList handling).

const { _isPrivateIpAddress, _assertPublicHttpUrl } = require('../engine/utils/safeFetch');
const {
    _extractLdEvents, _normalizeLdEvent, _ldDate, _ldImage, _ldText, _ldAddress, _htmlToText,
} = require('../engine/events/listing');

describe('_isPrivateIpAddress (SSRF guard)', () => {
    test('private/reserved IPv4 ranges are blocked', () => {
        for (const ip of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '172.16.0.1', '172.31.255.255',
                          '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255']) {
            expect(_isPrivateIpAddress(ip)).toBe(true);
        }
    });
    test('public IPv4 passes', () => {
        for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
            expect(_isPrivateIpAddress(ip)).toBe(false);
        }
    });
    test('IPv6 loopback/link-local/unique-local blocked; public passes; IPv4-mapped recurses', () => {
        expect(_isPrivateIpAddress('::1')).toBe(true);
        expect(_isPrivateIpAddress('fe80::1')).toBe(true);
        expect(_isPrivateIpAddress('fc00::1')).toBe(true);
        expect(_isPrivateIpAddress('fd12:3456::1')).toBe(true);
        expect(_isPrivateIpAddress('2001:4860:4860::8888')).toBe(false);
        expect(_isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true);
        expect(_isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false);
    });
    test('unparseable input refuses (blocked) rather than resolves', () => {
        expect(_isPrivateIpAddress('not-an-ip')).toBe(true);
        expect(_isPrivateIpAddress('')).toBe(true);
    });
});

describe('_assertPublicHttpUrl (pre-DNS rejections + local resolution)', () => {
    test('blocked scheme', async () => {
        await expect(_assertPublicHttpUrl('ftp://example.com/')).rejects.toThrow(/blocked scheme/);
        await expect(_assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/blocked scheme/);
    });
    test('blocked non-standard port', async () => {
        await expect(_assertPublicHttpUrl('https://example.com:8080/')).rejects.toThrow(/blocked port/);
    });
    test('blocked credentials in URL', async () => {
        await expect(_assertPublicHttpUrl('https://user:pass@example.com/')).rejects.toThrow(/blocked credentials/);
    });
    test('localhost resolves to loopback → blocked private address', async () => {
        await expect(_assertPublicHttpUrl('http://localhost/')).rejects.toThrow(/blocked private address/);
    });
});

describe('_ldDate (the date-semantics rule: date-only lives out its day)', () => {
    test('date-only value → exactly midnight UTC (all-day marker preserved)', () => {
        expect(_ldDate('2026-08-15')).toBe('2026-08-15T00:00:00.000Z');
    });
    test('a TIMED value landing on midnight UTC is nudged 1 ms so it cannot masquerade as all-day', () => {
        expect(_ldDate('2026-08-15T00:00:00Z')).toBe('2026-08-15T00:00:00.001Z');
    });
    test('ordinary timed value passes through', () => {
        expect(_ldDate('2026-08-15T20:00:00+04:00')).toBe('2026-08-15T16:00:00.000Z');
    });
    test('@value object form supported; junk → null', () => {
        expect(_ldDate({ '@value': '2026-09-05' })).toBe('2026-09-05T00:00:00.000Z');
        expect(_ldDate('not a date')).toBe(null);
        expect(_ldDate(null)).toBe(null);
        expect(_ldDate('')).toBe(null);
    });
});

describe('_extractLdEvents (JSON-LD extraction)', () => {
    const wrap = (json) => `<html><head><script type="application/ld+json">${json}</script></head></html>`;

    test('plain Event block found; EventVenue is NOT an event (anchored type regex)', () => {
        const html = wrap(JSON.stringify({ '@type': 'MusicEvent', name: 'Loboda Concert Tickets', startDate: '2026-08-15T20:00:00' }))
                   + wrap(JSON.stringify({ '@type': 'EventVenue', name: 'Some Hall' }));
        const events = _extractLdEvents(html);
        expect(events).toHaveLength(1);
        expect(events[0].name).toBe('Loboda Concert Tickets');
    });
    test('@graph and ItemList containers unwrapped', () => {
        const html = wrap(JSON.stringify({
            '@graph': [{ '@type': 'ItemList', itemListElement: [
                { item: { '@type': 'Event', name: 'A', startDate: '2026-09-01' } },
                { item: { '@type': 'TheaterEvent', name: 'B', startDate: '2026-09-02' } },
            ]}]
        }));
        expect(_extractLdEvents(html).map(e => e.name)).toEqual(['A', 'B']);
    });
    test('one malformed JSON block never kills the rest', () => {
        const html = wrap('{ broken json !!!') + wrap(JSON.stringify({ '@type': 'Event', name: 'Survivor', startDate: '2026-09-01' }));
        expect(_extractLdEvents(html).map(e => e.name)).toEqual(['Survivor']);
    });
    test('type given as array, and schema URL prefix stripped', () => {
        const html = wrap(JSON.stringify({ '@type': ['https://schema.org/Festival', 'Thing'], name: 'Fest', startDate: '2026-09-03' }));
        expect(_extractLdEvents(html)).toHaveLength(1);
    });
});

describe('_normalizeLdEvent (node → pipeline shape)', () => {
    test('full node: names, dates, image, url, venue from location object', () => {
        const n = _normalizeLdEvent({
            '@type': 'MusicEvent',
            name: 'Loboda Concert Tickets',
            startDate: '2026-08-15T20:00:00Z',
            endDate: '2026-08-15',
            image: { '@type': 'ImageObject', contentUrl: 'https://cdn.pbilet.net/origin/poster.jpg' },
            url: 'https://ticket-am.com/en/event/123',
            location: { '@type': 'Place', name: 'Altezza by Armenian Helicopters',
                        address: { streetAddress: 'Jrvezh', addressLocality: 'Yerevan', addressCountry: 'AM' } },
        });
        expect(n.name).toBe('Loboda Concert Tickets');
        expect(n.startDate).toBe('2026-08-15T20:00:00.000Z');
        expect(n.endDate).toBe('2026-08-15T00:00:00.000Z');           // date-only stays all-day
        expect(n.image).toBe('https://cdn.pbilet.net/origin/poster.jpg');
        expect(n.url).toBe('https://ticket-am.com/en/event/123');
        expect(n.venueName).toBe('Altezza by Armenian Helicopters');
        expect(n.venueAddress).toBe('Jrvezh, Yerevan, AM');
    });
    test('location as plain string; array location takes first; non-http url dropped', () => {
        expect(_normalizeLdEvent({ name: 'X', location: 'Opera House' }).venueName).toBe('Opera House');
        expect(_normalizeLdEvent({ name: 'X', location: [{ name: 'First' }, { name: 'Second' }] }).venueName).toBe('First');
        expect(_normalizeLdEvent({ name: 'X', url: '/relative/path' }).url).toBe(null);
    });
    test('_ldImage: array picks first valid; rejects non-http', () => {
        expect(_ldImage(['not-a-url', 'https://x.am/a.jpg'])).toBe('https://x.am/a.jpg');
        expect(_ldImage('/rel.jpg')).toBe(null);
        expect(_ldImage(null)).toBe(null);
    });
    test('_ldText: string / array / @value object', () => {
        expect(_ldText('  Hall  ')).toBe('Hall');
        expect(_ldText([null, 'Second'])).toBe('Second');
        expect(_ldText({ '@value': 'Wrapped' })).toBe('Wrapped');
        expect(_ldText({ name: 'Named' })).toBe('Named');
        expect(_ldText('')).toBe(null);
    });
    test('_ldAddress: object parts joined, string passthrough, array first', () => {
        expect(_ldAddress('16/8 Garni highway')).toBe('16/8 Garni highway');
        expect(_ldAddress([{ streetAddress: 'A St', addressLocality: 'Yerevan' }])).toBe('A St, Yerevan');
        expect(_ldAddress(null)).toBe(null);
    });
});

describe('_htmlToText (extractor input hygiene)', () => {
    test('strips script/style/tags, decodes basic entities, trims lines', () => {
        const text = _htmlToText('<html><script>evil()</script><style>.x{}</style><div>Concert&nbsp;A</div><p>Sep&amp;Oct</p></html>');
        expect(text).toBe('Concert A\nSep&Oct');
    });
    test('caps output at 12k chars', () => {
        expect(_htmlToText('<p>' + 'x'.repeat(20000) + '</p>').length).toBeLessThanOrEqual(12000);
    });
});
