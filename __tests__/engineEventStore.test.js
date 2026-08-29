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
        // Venue pinning must never reach the real Google client from a test.
        findPlaces: async () => [],
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

    test('card matching: assets come from the markup around the title, past the nav chrome', async () => {
        const { _findAssetsNear } = require('../engine/search/readPage');
        // Realistic listing shape: 30+ chrome links first, then the event cards.
        const chrome = Array.from({ length: 30 }, (_, i) =>
            `<a href="/nav/${i}">Menu ${i}</a><img src="/img/icon-${i}.svg">`).join('');
        const html = `<html><body>${chrome}
            <div class="card"><a href="/e/jazz-night"><img data-src="https://cdn/jazz.jpg" src="/img/placeholder.png">
            <h3>Jazz Night at Club X</h3></a></div>
            <div class="card"><a href="/e/folk-eve"><img data-src="https://cdn/folk.jpg">
            <h3>Folk Evening</h3></a></div></body></html>`;

        const jazz = _findAssetsNear(html, 'https://allevents.in/yerevan/all', 'Jazz Night at Club X');
        expect(jazz.url).toBe('https://allevents.in/e/jazz-night');       // its own page, not the catalog
        expect(jazz.image).toBe('https://cdn/jazz.jpg');                  // lazy-load src beats the placeholder
        const folk = _findAssetsNear(html, 'https://allevents.in/yerevan/all', 'Folk Evening');
        expect(folk.image).toBe('https://cdn/folk.jpg');                  // each card matched separately
        expect(_findAssetsNear(html, 'https://x.am', 'Nonexistent Gala')).toEqual({ url: null, image: null });
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

    // Publishers annotate events in three interchangeable standards and which
    // one a site picked is arbitrary — so the reader must understand all three
    // (Arsen 2026-08-24: "i want code that can understand almost every type of
    // website it enters"). tomsarkgh's real markup is the microdata case.
    test('structured data: microdata, RDFa and JSON-LD normalise to one shape', () => {
        const { _structuredFromHtml } = require('../engine/search/readPage');
        const microdata = '<meta itemprop="startDate" content="2026-08-30 20:00">'
            + '<span itemprop="location" itemscope><span itemprop="name">Bohem theatre</span></span>'
            + '<span itemprop="offers" itemscope><meta itemprop="price" content="3000.00">'
            + '<meta itemprop="priceCurrency" content="AMD"></span>';
        expect(_structuredFromHtml(microdata)).toEqual([
            { day: '2026-08-30', time: '20:00', price: '3000 AMD', venue: 'Bohem theatre' },
        ]);

        const rdfa = '<div property="startDate" content="2026-09-04T21:30"></div>'
            + '<meta property="price" content="150.00"><meta property="priceCurrency" content="AED">';
        expect(_structuredFromHtml(rdfa)[0]).toMatchObject({ day: '2026-09-04', time: '21:30', price: '150 AED' });

        const jsonld = '<script type="application/ld+json">'
            + '{"@type":"Event","name":"Desert Gig","startDate":"2026-09-05T19:00:00Z",'
            + '"location":{"@type":"Place","name":"Coca-Cola Arena"}}</script>';
        expect(_structuredFromHtml(jsonld)[0]).toMatchObject({ day: '2026-09-05', time: '19:00', venue: 'Coca-Cola Arena' });

        expect(_structuredFromHtml('<p>no structured data here</p>')).toEqual([]);
    });

    // allevents.in publishes no schema.org at all — it hands the browser an
    // epoch attribute (Arsen pasted the markup 2026-08-24). VERIFIED against the
    // live page: data-stime is the LOCAL wall clock encoded as if UTC, so the
    // data-tz offset must NOT be applied or every event shifts four hours.
    test('epoch data attributes (allevents) parse to the visible local time', () => {
        const { _structuredFromHtml } = require('../engine/search/readPage');
        const html = '<p class="event-time-label" data-stime="1788555600" data-etime="1788555600" '
            + 'data-tz="+04:00">Fri, 4 Sep 2026 • 9:00 PM (+04)</p>';
        expect(_structuredFromHtml(html)[0]).toMatchObject({ day: '2026-09-04', time: '21:00' });
        expect(_structuredFromHtml('<i data-stime="1788555600000"></i>')[0].time).toBe('21:00');  // ms epoch
        expect(_structuredFromHtml('<i data-stime="not-a-number"></i>')).toEqual([]);
    });

    test('structured data OVERRULES the model — the "All day" that should be 20:00', async () => {
        const win = parseEventWindow('next week', NOW);
        const page = {
            url: 'https://a.am', title: 'T',
            text: 'Super Grig on 30 August at Bohem theatre',            // no time in the prose
            microdata: [{ day: '2026-08-30', time: '20:00', price: '3000 AMD', venue: 'Bohem theatre' }],
        };
        const narrator = { stream: async () => ({ text: JSON.stringify([
            { name: 'Super Grig', startDate: '2026-08-30', time: null, price: null },
        ]) }) };
        const evs = await extractEventsFromPage(page, { city: 'Yerevan', window: win }, { narrator });
        expect(evs[0].startDate.toISOString()).toContain('T20:00');      // was "All day"
        expect(evs[0].price).toBe('3000 AMD');
    });

    // A number the page does not print is not a fact (Arsen 2026-08-24: "jinni
    // said at 19:00 but in the soucre i found 20:00", plus tomsarkgh's prices).
    test('times and prices must be FINDABLE on the page, or they are dropped', async () => {
        const { _timeOnPage, _priceOnPage } = require('../engine/search/readPage');
        const text = 'Jazz Night starts at 20:00. Tickets 5000-15000 AMD. Doors 19\u058930.';
        expect(_timeOnPage(text, '20:00')).toBe(true);
        expect(_timeOnPage(text, '19:00')).toBe(false);          // the live bug
        expect(_timeOnPage(text, '19:30')).toBe(true);           // Armenian separator
        expect(_priceOnPage(text, '5000-15000 AMD')).toBe(true);
        expect(_priceOnPage(text, '9999 AMD')).toBe(false);
        expect(_priceOnPage(text, null)).toBe(false);

        const win = parseEventWindow('next week', NOW);
        const narrator = { stream: async () => ({ text: JSON.stringify([
            { name: 'Jazz Night', startDate: '2026-08-25', time: '20:00', price: '5000-15000 AMD' },
            { name: 'Rock Fest', startDate: '2026-08-26', time: '19:00', price: '9999 AMD' },
        ]) }) };
        const evs = await extractEventsFromPage(
            { url: 'https://a.am', title: 'T', text }, { city: 'Yerevan', window: win }, { narrator });
        expect(evs[0].startDate.toISOString()).toContain('T20:00');   // verified time kept
        expect(evs[0].price).toBe('5000-15000 AMD');                  // verified price kept
        expect(evs[1].startDate.toISOString()).toContain('T00:00');   // unverified → All day
        expect(evs[1].price).toBeNull();                              // unverified → no price
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

describe('curated source registry (validator URLs beat web search)', () => {
    const HTML_LD = `<html><head><script type="application/ld+json">
        {"@type":"Event","name":"Jazz Night","startDate":"2026-08-25T20:00:00"}
        </script></head><body></body></html>`;
    const _sources = (rows) => ({
        find: () => ({ limit: () => ({ lean: async () => rows }) }),
        bulkWrite: jest.fn(() => Promise.resolve()),
    });

    test('registered sources are read directly — web search never called', async () => {
        const { huntEvents } = require('../engine/events/hunt');
        const EventSource = _sources([{ _id: 'src1', url: 'https://tomsarkgh.am/en', name: 'Tomsarkgh' }]);
        const searchWeb = jest.fn(async () => [{ url: 'https://should-not-be-used' }]);
        const out = await huntEvents(
            { city: 'Yerevan', country: 'Armenia', center: CENTER, window: parseEventWindow('next week', NOW) },
            { AiFoundEvent: { bulkWrite: jest.fn(() => Promise.resolve()) }, EventSource, searchWeb,
              fetchHtml: async () => HTML_LD, nowFn: () => NOW });
        expect(searchWeb).not.toHaveBeenCalled();                        // "claude will not fill that database"
        expect(out).toHaveLength(1);
        const yieldOp = EventSource.bulkWrite.mock.calls[0][0][0].updateOne;
        expect(yieldOp.filter._id).toBe('src1');
        expect(yieldOp.update.$set.lastFoundCount).toBe(1);              // yield tracked
    });

    test('no registered sources → search fallback still works', async () => {
        const { huntEvents } = require('../engine/events/hunt');
        const searchWeb = jest.fn(async () => [{ url: 'https://found.by/search' }]);
        const out = await huntEvents(
            { city: 'Yerevan', center: CENTER, window: parseEventWindow('next week', NOW) },
            { AiFoundEvent: { bulkWrite: jest.fn(() => Promise.resolve()) }, EventSource: _sources([]), searchWeb,
              fetchHtml: async () => HTML_LD, nowFn: () => NOW });
        expect(searchWeb).toHaveBeenCalledTimes(1);
        expect(out).toHaveLength(1);
    });

    test('nightly sweep hunts each registered location with search hard-disabled', async () => {
        const { sweepEventSources } = require('../engine/events/sourceSweep');
        const calls = [];
        const r = await sweepEventSources({
            EventSource: { aggregate: async () => [
                { _id: { city: 'Yerevan', country: 'Armenia' }, n: 2 },
                { _id: { city: null, country: 'Armenia' }, n: 1 },       // country-wide source
            ] },
            huntEvents: async (args, deps) => { calls.push({ args, deps }); return [{}, {}]; },
        });
        expect(r).toEqual({ locations: 2, events: 4 });
        expect(calls.map(c => c.args.city)).toEqual(['Yerevan', 'Armenia']);
        expect(await calls[0].deps.searchWeb()).toEqual([]);             // cron can never spend a search
        expect(calls[0].deps.timeoutMs).toBe(30000);                     // patient overnight reads
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

// ── The 32s Dubai re-hunt bug (live 2026-08-29) — two guards, tested apart ──

describe('regionCity seeds the in-radius city set', () => {
    test('an all-coordless shelf serves for its own city instead of reading "thin"', async () => {
        const DUBAI = { lat: 25.2, lng: 55.27 };
        const rows = [
            aiEvent({ name: 'Candlelight', lat: null, lng: null, city: 'Dubai' }),
            aiEvent({ name: 'Afro Connect', lat: null, lng: null, city: 'Dubai' }),
        ];
        // Without the seed nothing coord-bearing exists to vouch for the city,
        // the whole shelf drops, and the hunt re-fires on every ask.
        expect(await loadEventCandidates({ center: DUBAI, radiusKm: 50 }, deps([], rows))).toEqual([]);
        const out = await loadEventCandidates({ center: DUBAI, radiusKm: 50, regionCity: 'Dubai' }, deps([], rows));
        expect(out.map(c => c.name)).toEqual(['Candlelight', 'Afro Connect']);
    });

    test('the seed is the CENTRE\'s city — it never rescues another city\'s rows', async () => {
        const out = await loadEventCandidates({ center: CENTER, radiusKm: 10, regionCity: 'Yerevan' }, deps([], [
            aiEvent({ name: 'Dubai Comedy', lat: null, lng: null, city: 'Dubai' }),
        ]));
        expect(out).toEqual([]);
    });
});

describe('hunt source freshness (lastReadAt guard)', () => {
    const { huntEvents } = require('../engine/events/hunt');
    const WIN = { start: new Date(NOW), end: new Date(NOW + 14 * DAY), label: 'default' };
    const MIN = 60 * 1000;
    const srcRows = (rows) => ({
        find: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }),
        bulkWrite: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({})),
    });
    const baseDeps = (ES, fetchHtml) => ({
        EventSource: ES, fetchHtml, nowFn: () => NOW,
        AiFoundEvent: { bulkWrite: async () => ({}) },
        renderAvailable: () => false,
        allowExtracted: false,
    });

    test('all sources read minutes ago → zero fetches, the shelf serves', async () => {
        const fetchHtml = jest.fn(async () => null);
        const ES = srcRows([
            { _id: 's1', url: 'https://a.example', lastReadAt: new Date(NOW - 10 * MIN) },
            { _id: 's2', url: 'https://b.example', lastReadAt: new Date(NOW - 20 * MIN) },
        ]);
        const out = await huntEvents({ city: 'Dubai', window: WIN }, baseDeps(ES, fetchHtml));
        expect(out).toEqual([]);
        expect(fetchHtml).not.toHaveBeenCalled();
    });

    test('only stale sources are read; a row with no lastReadAt counts as stale', async () => {
        const fetchHtml = jest.fn(async () => null);
        const ES = srcRows([
            { _id: 'fresh', url: 'https://fresh.example', lastReadAt: new Date(NOW - 5 * MIN) },
            { _id: 'old', url: 'https://old.example', lastReadAt: new Date(NOW - 180 * MIN) },
            { _id: 'never', url: 'https://never.example' },
        ]);
        await huntEvents({ city: 'Dubai', window: WIN }, baseDeps(ES, fetchHtml));
        expect(fetchHtml.mock.calls.map(c => c[0])).toEqual(['https://old.example', 'https://never.example']);
    });

    test('an explicit search order (force) outranks the clock', async () => {
        const fetchHtml = jest.fn(async () => null);
        const ES = srcRows([{ _id: 's1', url: 'https://a.example', lastReadAt: new Date(NOW - 5 * MIN) }]);
        await huntEvents({ city: 'Dubai', window: WIN, force: true }, baseDeps(ES, fetchHtml));
        expect(fetchHtml).toHaveBeenCalledTimes(1);
    });
});
