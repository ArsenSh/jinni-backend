// Engine events tier (battery fix #1) — owned-data events candidates.
// Fake models, fixed clock — no DB, no network.

const { loadEventCandidates, aiEventToCandidate, parseEventWindow, EVENT_HORIZON_DAYS } = require('../engine/places/eventStore');
const { toRecommendation } = require('../engine/narrator/cards');
const { placeFactLine } = require('../engine/narrator/prompts/grounded');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);   // Sat Aug 22 2026 12:00 UTC
const CENTER = { lat: 40.18, lng: 44.51 };     // Yerevan

const destModel = (rows) => ({ find: () => ({ lean: () => Promise.resolve(rows) }) });
const aiModel = (rows) => ({ find: (q) => { aiModel.lastQuery = q; return { limit: () => ({ lean: () => Promise.resolve(rows) }) }; } });

const aiEvent = (over = {}) => ({
    name: 'Jazz Night', description: 'Live jazz', placeId: 'gv1',
    lat: 40.19, lng: 44.52, venueName: 'Mezzo Club', address: '28 Isahakyan St',
    city: 'Yerevan', country: 'Armenia', image: 'https://cdn/poster.jpg',
    startDate: new Date(NOW + 2 * DAY), endDate: null, isRecurring: false, status: 'new',
    ...over,
});

const destEvent = (over = {}) => ({
    _id: 'dst1', name: 'Wine Days Festival', description: 'City festival', type: ['events'],
    location: { city: 'Yerevan', country: 'Armenia', address: 'Saryan St', coordinates: { lat: 40.185, lng: 44.505 } },
    images: ['https://cdn/wine.jpg'], rating: 4.8,
    eventSchedule: { startDate: new Date(NOW + 1 * DAY), endDate: new Date(NOW + 3 * DAY), isRecurring: false, timezone: 'Asia/Yerevan' },
    ...over,
});

const deps = (destRows = [], aiRows = []) => ({
    Destination: destModel(destRows), AiFoundEvent: aiModel(aiRows), nowFn: () => NOW,
});

describe('loadEventCandidates', () => {
    test('merges validator destinations + pipeline finds, soonest first', async () => {
        const out = await loadEventCandidates({ center: CENTER }, deps([destEvent()], [aiEvent()]));
        expect(out.map(c => c.name)).toEqual(['Wine Days Festival', 'Jazz Night']);   // +1d before +2d
        expect(out[0].source).toBe('destination');
        expect(out[0].verifiedId).toBe('dst1');
        expect(out[0].vector).toBeUndefined();   // no embedding on fixture → no vector claim
        expect(out[1].source).toBe('event');
        expect(out[1].image).toBe('https://cdn/poster.jpg');                          // poster survives
    });

    test('ended and beyond-horizon destination events are skipped; recurring survives', async () => {
        const out = await loadEventCandidates({ center: CENTER }, deps([
            destEvent({ _id: 'past', eventSchedule: { startDate: new Date(NOW - 5 * DAY), endDate: new Date(NOW - 2 * DAY), isRecurring: false } }),
            destEvent({ _id: 'far', eventSchedule: { startDate: new Date(NOW + (EVENT_HORIZON_DAYS + 5) * DAY), isRecurring: false } }),
            destEvent({ _id: 'rec', name: 'Vernissage Market', eventSchedule: { isRecurring: true } }),
            destEvent({ _id: 'bare', eventSchedule: undefined }),
        ], []));
        expect(out.map(c => c.name)).toEqual(['Vernissage Market']);
    });

    test('pipeline query only serves status new, upcoming-window rows', async () => {
        await loadEventCandidates({ center: CENTER }, deps([], []));
        expect(aiModel.lastQuery.status).toBe('new');                 // hidden/approved never queried
        expect(aiModel.lastQuery.startDate.$lte).toBeInstanceOf(Date);
    });

    test('radius filters coord rows; coordless survive ONLY on an in-radius city match', async () => {
        const out = await loadEventCandidates({ center: CENTER, radiusKm: 10 }, deps([], [
            aiEvent({ name: 'Near', lat: 40.19, lng: 44.52 }),
            aiEvent({ name: 'Gyumri Fest', lat: 40.79, lng: 43.85 }),                    // ~120 km
            aiEvent({ name: 'City-wide', lat: null, lng: null }),                        // city Yerevan → kept
            aiEvent({ name: 'Dubai Comedy', lat: null, lng: null, city: 'Dubai' }),      // the live bug → dropped
        ]));
        expect(out.map(c => c.name)).toEqual(['Near', 'City-wide']);
    });

    test('no in-radius city evidence → coordless rows drop too', async () => {
        const out = await loadEventCandidates({ center: CENTER, radiusKm: 10 }, deps([], [
            aiEvent({ name: 'Orphan City-wide', lat: null, lng: null }),
        ]));
        expect(out).toEqual([]);
    });

    test('no center → no candidates (events need a where)', async () => {
        expect(await loadEventCandidates({ center: null }, deps([destEvent()], [aiEvent()]))).toEqual([]);
    });
});

describe('parseEventWindow (the asked period rules)', () => {
    // NOW is Sat Aug 22 2026 12:00 UTC (see top).
    test('weekend from mid-weekend → now through Sunday; from a Wednesday → next Sat–Sun', () => {
        const w = parseEventWindow('things to do this weekend', NOW);
        expect(w.label).toBe('weekend');
        expect(w.start.getTime()).toBe(NOW);                                  // already Saturday
        expect(w.end.getUTCDay()).toBe(0);                                    // ends Sunday
        const wed = Date.UTC(2026, 7, 19, 12, 0, 0);                          // Wed Aug 19
        const w2 = parseEventWindow('на выходных куда сходить', wed);
        expect(w2.start.getUTCDay()).toBe(6);                                 // next Saturday
        expect(w2.end.getUTCDay()).toBe(0);
    });
    test('windowFromPeriod — the AI names the period, code does clamped math', () => {
        const { windowFromPeriod } = require('../engine/places/eventStore');
        expect(windowFromPeriod('next_week', NOW).label).toBe('next-week');
        expect(windowFromPeriod('3days', NOW).label).toBe('next-3-days');
        expect(windowFromPeriod('weekend', NOW).start.getTime()).toBe(NOW);   // mid-weekend ⇒ now
        const r = windowFromPeriod('2026-09-05..2026-09-07', NOW);
        expect(r.start.toISOString()).toContain('2026-09-05');
        expect(r.end.toISOString()).toContain('2026-09-07');
        expect(windowFromPeriod('2026-01-01..2026-01-02', NOW)).toBeNull();   // past ⇒ brakes
        expect(windowFromPeriod('2026-09-07..2026-09-05', NOW)).toBeNull();   // reversed ⇒ brakes
        expect(windowFromPeriod('garbage', NOW)).toBeNull();                  // fallback path
    });

    test('numeric spans — "next 3 days" and friends get an exact window', () => {
        const w = parseEventWindow('events for the next 3 days', NOW);
        expect(w.label).toBe('next-3-days');
        expect(w.start.getTime()).toBe(NOW);
        expect(w.end.getUTCDate()).toBe(24);                                  // Aug 22+2, end of day
        expect(parseEventWindow('ближайшие 5 дней', NOW).label).toBe('next-5-days');
        expect(parseEventWindow('未来3天有什么活动', NOW).label).toBe('next-3-days');
        expect(parseEventWindow('events for the next 99 days', NOW).label).toBe('next-30-days');   // capped
    });

    test('tonight / tomorrow / next week / default', () => {
        expect(parseEventWindow('concerts tonight', NOW).label).toBe('today');
        expect(parseEventWindow('что завтра?', NOW).label).toBe('tomorrow');
        expect(parseEventWindow('events next week', NOW).label).toBe('next-week');
        const d = parseEventWindow('suggest events', NOW);
        expect(d.label).toBe('default');
        expect(d.end.getTime() - d.start.getTime()).toBe(EVENT_HORIZON_DAYS * 24 * 3600 * 1000);
    });
    test('loadEventCandidates honors the window — weekend ask excludes Tuesday and Thursday events', async () => {
        const rows = [
            aiEvent({ name: 'SatConcert', startDate: new Date(NOW + 6 * 3600 * 1000) }),        // tonight (Sat)
            aiEvent({ name: 'SunParty', startDate: new Date(Date.UTC(2026, 7, 23, 11)) }),      // Sunday
            aiEvent({ name: 'TueSymphony', startDate: new Date(NOW + 3 * DAY) }),               // Tuesday
            aiEvent({ name: 'ThuAnime', startDate: new Date(NOW + 5 * DAY) }),                  // Thursday
        ];
        // Fake model returns everything; the JS-side dest filter + the window
        // math on aiRows happens in Mongo normally — here assert via the
        // query the store builds:
        await loadEventCandidates(
            { center: CENTER, eventWindow: parseEventWindow('this weekend', NOW) },
            deps([], rows));
        expect(aiModel.lastQuery.startDate.$lte.getUTCDay()).toBe(0);          // capped at Sunday
    });
});

describe('huntEvents (the fresh tier — search fills the database)', () => {
    const { huntEvents } = require('../engine/events/hunt');
    const LD = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;
    const page = LD({
        '@context': 'https://schema.org', '@type': 'Event',
        name: 'Jazz Fest', startDate: '2026-08-23T18:00:00Z',
        image: 'https://cdn/jazz.jpg', url: 'https://tickets/jazz',
        location: { '@type': 'Place', name: 'Club X' },
    });
    const huntDeps = (bulkWrite, { html = page, urls = [{ url: 'https://x/events' }] } = {}) => ({
        AiFoundEvent: { bulkWrite },
        searchWeb: async () => urls,
        fetchHtml: async () => html,
        nowFn: () => NOW,
    });

    test('stores JSON-LD-verified events with the v1 key formula and serves them as candidates', async () => {
        const bulkWrite = jest.fn(() => Promise.resolve());
        const win = parseEventWindow('this weekend', NOW);
        const out = await huntEvents({ city: 'Yerevan', center: CENTER, window: win }, huntDeps(bulkWrite));
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('Jazz Fest');
        expect(out[0].image).toBe('https://cdn/jazz.jpg');
        expect(out[0].eventSchedule.startDate.toISOString()).toContain('2026-08-23');
        const op = bulkWrite.mock.calls[0][0][0].updateOne;
        expect(op.filter.key).toBe('jazz fest|2026-08-23|yerevan');
        expect(op.update.$setOnInsert.sourceTier).toBe('listing');
        expect(op.update.$setOnInsert.status).toBe('new');
    });

    test('out-of-window events are skipped; no city or no results → [] and no writes', async () => {
        const bulkWrite = jest.fn(() => Promise.resolve());
        const tue = LD({ '@type': 'Event', name: 'Tue Show', startDate: '2026-08-25T19:00:00Z' });
        const win = parseEventWindow('this weekend', NOW);
        expect(await huntEvents({ city: 'Yerevan', window: win }, huntDeps(bulkWrite, { html: tue }))).toEqual([]);
        expect(await huntEvents({ city: null, window: win }, huntDeps(bulkWrite))).toEqual([]);
        expect(await huntEvents({ city: 'Yerevan', window: win }, huntDeps(bulkWrite, { urls: [] }))).toEqual([]);
        expect(bulkWrite).not.toHaveBeenCalled();
    });
});

describe('readPage + extracted tier (the "enter any web and read" tool)', () => {
    const { readPage, extractEventsFromPage } = require('../engine/search/readPage');
    const HTML = `<html><head><title>Afisha Yerevan</title>
        <meta property="og:image" content="/img/poster.jpg">
        <meta name="description" content="City events guide"></head>
        <body><img src="https://cdn/logo.svg"><img src="/img/jazz.jpg">
        <p>Jazz Night at Club X on 24 August 2026, 20:00.</p></body></html>`;

    test('readPage: title, description, images (absolutized, chrome skipped), text', async () => {
        const p = await readPage('https://afisha.am/en', { deps: { fetchHtml: async () => HTML } });
        expect(p.title).toBe('Afisha Yerevan');
        expect(p.description).toBe('City events guide');
        expect(p.image).toBe('https://afisha.am/img/poster.jpg');       // og:image absolutized
        expect(p.images).not.toContain('https://cdn/logo.svg');          // chrome skipped
        expect(p.text).toContain('Jazz Night');
        expect(await readPage('https://x.am', { deps: { fetchHtml: async () => null } })).toBeNull();
    });

    test('extractEventsFromPage: model proposes, code disposes (dates + window)', async () => {
        const win = parseEventWindow('next week', NOW);
        const narrator = { stream: async () => ({ text: JSON.stringify([
            { name: 'Jazz Night', startDate: '2026-08-25', time: '20:00', venueName: 'Club X' },
            { name: 'Undated Fest' },                                    // no date → dropped
            { name: 'Too Far', startDate: '2026-10-01' },                // outside window → dropped
        ]) }) };
        const evs = await extractEventsFromPage(
            { url: 'https://afisha.am', title: 'Afisha', image: 'https://a/p.jpg', text: 'stuff' },
            { city: 'Yerevan', window: win }, { narrator });
        expect(evs).toHaveLength(1);
        expect(evs[0].name).toBe('Jazz Night');
        expect(evs[0]._tier).toBe('extracted');
        expect(evs[0].image).toBe('https://a/p.jpg');                    // page poster rides along
    });

    test('per-event posters: only images the page actually contains, no shared banner', async () => {
        const win = parseEventWindow('next week', NOW);
        const page = {
            url: 'https://afisha.am', title: 'Afisha', text: 'stuff',
            image: 'https://a/banner.jpg',
            imagePairs: [{ src: 'https://a/jazz.jpg', alt: 'Jazz Night poster' }],
        };
        const narrator = { stream: async () => ({ text: JSON.stringify([
            { name: 'Jazz Night', startDate: '2026-08-25', image: 'https://a/jazz.jpg' },        // offered → kept
            { name: 'Rock Fest', startDate: '2026-08-26', image: 'https://evil/x.jpg' },         // invented → dropped
            { name: 'Folk Eve', startDate: '2026-08-27' },                                       // unmatched → null, not banner
        ]) }) };
        const evs = await extractEventsFromPage(page, { city: 'Yerevan', window: win }, { narrator });
        expect(evs.map(e => e.image)).toEqual(['https://a/jazz.jpg', null, null]);
    });

    test('detail-page links: model-matched url becomes the event page; hunt pulls its og:image poster', async () => {
        const win = parseEventWindow('next week', NOW);
        const page = {
            url: 'https://afisha.am/all', title: 'Afisha', text: 'stuff', image: null,
            imagePairs: [{ src: 'https://a/unrelated.jpg', alt: 'ad' }],
            linkPairs: [{ href: 'https://afisha.am/e/jazz-night', text: 'Jazz Night' }],
        };
        const narrator = { stream: async () => ({ text: JSON.stringify([
            { name: 'Jazz Night', startDate: '2026-08-25', url: 'https://afisha.am/e/jazz-night' },
            { name: 'Rock Fest', startDate: '2026-08-26', url: 'https://evil/x' },               // invented link → page.url
        ]) }) };
        const evs = await extractEventsFromPage(page, { city: 'Yerevan', window: win }, { narrator });
        expect(evs[0].url).toBe('https://afisha.am/e/jazz-night');
        expect(evs[1].url).toBe('https://afisha.am/all');

        const bulkWrite = jest.fn(() => Promise.resolve());
        const { huntEvents } = require('../engine/events/hunt');
        const detailHtml = '<html><head><meta property="og:image" content="https://cdn/jazz-poster.jpg"></head></html>';
        const out = await huntEvents(
            { city: 'Yerevan', center: CENTER, window: win },
            { AiFoundEvent: { bulkWrite }, searchWeb: async () => [{ url: 'https://afisha.am/all' }],
              fetchHtml: async (u) => u === 'https://afisha.am/e/jazz-night' ? detailHtml : '<html><body>x</body></html>',
              page, narrator, nowFn: () => NOW });
        const jazz = out.find(e => e.name === 'Jazz Night');
        expect(jazz.image).toBe('https://cdn/jazz-poster.jpg');          // poster from the detail page
        const ops = bulkWrite.mock.calls[0][0];
        const jazzOp = ops.find(o => o.updateOne.update.$setOnInsert.name === 'Jazz Night').updateOne.update.$setOnInsert;
        expect(jazzOp.sourceUrl).toBe('https://afisha.am/e/jazz-night'); // Check listing → the event's own page
    });

    test('hunt falls back to the extracted tier on JSON-LD-free pages', async () => {
        const bulkWrite = jest.fn(() => Promise.resolve());
        const narrator = { stream: async () => ({ text: '[{"name":"Jazz Night","startDate":"2026-08-25","time":"20:00"}]' }) };
        const { huntEvents } = require('../engine/events/hunt');
        const out = await huntEvents(
            { city: 'Yerevan', center: CENTER, window: parseEventWindow('next week', NOW) },
            { AiFoundEvent: { bulkWrite }, searchWeb: async () => [{ url: 'https://afisha.am/list' }],
              fetchHtml: async () => HTML, narrator, nowFn: () => NOW });
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('Jazz Night');
        const op = bulkWrite.mock.calls[0][0][0].updateOne;
        expect(op.update.$setOnInsert.sourceTier).toBe('extracted');     // honest tier label
    });
});

describe('event cards + facts', () => {
    test('toRecommendation passes eventSchedule through (frontend date row)', () => {
        const rec = toRecommendation(aiEventToCandidate(aiEvent(), CENTER), 0, { action: 'events' });
        expect(rec.eventSchedule.startDate).toEqual(new Date(NOW + 2 * DAY));
        expect(rec.category).toBe('Event');
        expect(rec.image).toBe('https://cdn/poster.jpg');
        const place = toRecommendation({ name: 'Garni', placeId: 'g' }, 0, { action: 'historical' });
        expect(place.eventSchedule).toBeNull();
    });

    test('placeFactLine states the event date, nothing else invented', () => {
        const line = placeFactLine(aiEventToCandidate(aiEvent(), CENTER));
        expect(line).toContain('event on Mon, 24 Aug 2026');
        expect(placeFactLine({ name: 'Garni' })).not.toContain('event on');
    });
});
