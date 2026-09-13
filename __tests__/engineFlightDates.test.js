// Live 2026-09-13, Yerevan, 00:23 local: "Find tickets to Moscow in this
// week" → "no fares"; "any flight to Moscow tomorrow?" → "no fares"; "flights
// for 15 September" → one FlyOne fare, 100 USD. The route had exactly one
// dated fare in the cache. Two things were missing: the model was never told
// what day it was, and a day that holds nothing said nothing about the days
// around it. Every assertion here runs the shipped code.
const { describeDate, buildTimeContext } = require('../engine/context/contextEngine');
const { searchFlightsWindow, windowFor, monthsCovering, pickWindow } = require('../engine/travel/flights');
const { makeExecutors } = require('../engine/narrator/tools');
const { buildGettingAroundMessages } = require('../engine/narrator/prompts/grounded');

describe('describeDate — the narrator is told what day it is', () => {
    // The live moment: 2026-09-13 20:23 UTC is Monday 2026-09-14 00:23 in Yerevan.
    const live = buildTimeContext({ timezone: 'Asia/Yerevan', now: new Date('2026-09-13T20:23:00Z') });

    test('the traveler\'s LOCAL date, not the server\'s — Yerevan was already Monday the 14th', () => {
        const d = describeDate(live);
        expect(d).toMatch(/^Monday 2026-09-14, 00:23 local time \(Asia\/Yerevan\)/);
        expect(d).toContain('"tomorrow" = 2026-09-15');
    });

    test('"this week" runs to the coming Sunday — a full seven days when today is Sunday', () => {
        expect(describeDate(live)).toContain('"this week" = 2026-09-14 to 2026-09-20');
        expect(describeDate(live)).toContain('"next week" = 2026-09-21 to 2026-09-27');
        const sun = buildTimeContext({ timezone: 'Asia/Yerevan', now: new Date('2026-09-20T08:00:00Z') });
        expect(describeDate(sun)).toContain('"this week" = 2026-09-20 to 2026-09-27');
        expect(describeDate(sun)).toContain('"next week" = 2026-09-28 to 2026-10-04');
        const wed = buildTimeContext({ timezone: 'Asia/Yerevan', now: new Date('2026-09-16T08:00:00Z') });
        expect(describeDate(wed)).toContain('"this week" = 2026-09-16 to 2026-09-20');
        expect(describeDate(wed)).toContain('"next week" = 2026-09-21 to 2026-09-27');
        expect(describeDate(wed)).toContain('"this weekend" = 2026-09-19 to 2026-09-20');
    });

    test('an unknown zone is SAID, not hidden', () => {
        const utc = buildTimeContext({ now: new Date('2026-09-13T20:23:00Z') });
        expect(describeDate(utc)).toContain('UTC — the traveler\'s zone is unknown');
    });

    test('garbage in, nothing out — never a made-up date', () => {
        expect(describeDate(null)).toBeNull();
        expect(describeDate({ localISO: 'soon' })).toBeNull();
    });

    test('the getting-around prompt carries the line and the rule to use it', () => {
        const msgs = buildGettingAroundMessages({ message: 'flights to Moscow this week', dateNote: describeDate(live), canQuoteFares: true });
        expect(msgs[0].content).toContain('DATE for the traveler: Monday 2026-09-14');
        expect(msgs[0].content).toMatch(/never from memory/);
        expect(msgs[0].content).toMatch(/depart_from \+ depart_to/);
        expect(msgs[0].content).toMatch(/NEAREST/);
    });
});

describe('windowFor — every dated ask becomes a window', () => {
    test('one day, a range, a month', () => {
        expect(windowFor({ departDate: '2026-09-15' })).toEqual({ from: '2026-09-15', to: '2026-09-15' });
        expect(windowFor({ departFrom: '2026-09-14', departTo: '2026-09-21' })).toEqual({ from: '2026-09-14', to: '2026-09-21' });
        expect(windowFor({ departDate: '2026-10' })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
        expect(windowFor({ departDate: '2026-02' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    });
    test('a lone bound or reversed bounds still make a window; no date makes none', () => {
        expect(windowFor({ departFrom: '2026-09-14' })).toEqual({ from: '2026-09-14', to: '2026-09-14' });
        expect(windowFor({ departFrom: '2026-09-21', departTo: '2026-09-14' })).toEqual({ from: '2026-09-14', to: '2026-09-21' });
        expect(windowFor({})).toBeNull();
        expect(windowFor({ departDate: 'next week' })).toBeNull();
    });
    test('monthsCovering spans a month end and never runs away', () => {
        expect(monthsCovering('2026-09-28', '2026-10-03')).toEqual(['2026-09', '2026-10']);
        expect(monthsCovering('2026-12-30', '2027-01-02')).toEqual(['2026-12', '2027-01']);
        expect(monthsCovering('2026-09-14', '2026-09-14')).toEqual(['2026-09']);
    });
});

describe('pickWindow — inside the window, else the nearest', () => {
    const rows = [
        { departure_at: '2026-09-15T07:00:00+04:00', price: 100 },
        { departure_at: '2026-09-20T09:00:00+04:00', price: 80 },
        { departure_at: '2026-09-25T09:00:00+04:00', price: 60 },
        { departure_at: null, price: 1 },                                   // undated: answers nothing
    ];
    test('the week holds two fares, cheapest first; nothing else is mixed in', () => {
        const { inWindow } = pickWindow(rows, '2026-09-14', '2026-09-21');
        expect(inWindow.map(r => r.price)).toEqual([80, 100]);
    });
    test('the 14th holds nothing; the nearest is the 15th, then the 20th', () => {
        const { inWindow, nearest } = pickWindow(rows, '2026-09-14', '2026-09-14');
        expect(inWindow).toEqual([]);
        expect(nearest.map(r => r.departure_at.slice(0, 10))).toEqual(['2026-09-15', '2026-09-20', '2026-09-25']);
    });
});

describe('searchFlightsWindow + the executor — the live conversation, answered', () => {
    const ENV = { TRAVELPAYOUTS_TOKEN: 'tok', TRAVELPAYOUTS_MARKER: '774501' };
    const calls = [];
    const fetchLive = async (url) => {
        calls.push(url);
        if (url.includes('autocomplete')) return { ok: true, json: async () => [{ code: url.includes('Moscow') ? 'MOW' : 'EVN' }] };
        const ym = new URL(url).searchParams.get('departure_at');
        return { ok: true, json: async () => ({ data: ym === '2026-09'
            ? [{ origin: 'EVN', destination: 'MOW', price: 100, airline: '3F', flight_number: '101', departure_at: '2026-09-15T07:00:00+04:00', transfers: 0, duration: 180, link: '/search/EVN1509MOW1?t=x' }]
            : [] }) };
    };
    beforeEach(() => { calls.length = 0; });

    test('"tomorrow" (the 14th) has none — the 15th comes back as the NEAREST, and the executor says so', async () => {
        const r = await searchFlightsWindow({ origin: 'Yerevan', destination: 'Moscow', from: '2026-09-14' }, { env: ENV, fetch: fetchLive });
        expect(r.offers).toEqual([]);
        expect(r.nearest).toHaveLength(1);
        expect(r.nearest[0]).toMatchObject({ price: 100, airline: '3F', airlineName: 'FlyOne Armenia' });
        expect(calls.filter(u => u.includes('prices_for_dates')).map(u => new URL(u).searchParams.get('departure_at'))).toEqual(['2026-09']);

        const exec = makeExecutors({}, { searchFlightsWindow: async (a) => searchFlightsWindow(a, { env: ENV, fetch: fetchLive }) });
        const out = await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow', depart_date: '2026-09-14' });
        expect(out.nearestOnly).toBe(true);
        expect(out.asked).toEqual({ from: '2026-09-14', to: '2026-09-14' });
        expect(out.offers[0].label).toBe('2026-09-15 07:00 · FlyOne Armenia · 100 USD · direct');
        expect(out.note).toMatch(/NONE of these fall on the asked dates \(2026-09-14\)/);
        expect(out.note).toMatch(/NEAREST dated fares/);
    });

    test('"this week" (14th–21st) HOLDS the 15th — a plain answer, no nearest talk', async () => {
        const exec = makeExecutors({}, { searchFlightsWindow: async (a) => searchFlightsWindow(a, { env: ENV, fetch: fetchLive }) });
        const out = await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow', depart_from: '2026-09-14', depart_to: '2026-09-21' });
        expect(out.nearestOnly).toBeUndefined();
        expect(out.offers).toHaveLength(1);
        expect(out.asked).toEqual({ from: '2026-09-14', to: '2026-09-21' });
        expect(out.note).not.toMatch(/NONE of these/);
        expect(out.note).toMatch(/\[Wizz Air\]\(<bookUrl>\)/);
    });

    test('a month with nothing at all is an honest empty, with the window it asked about', async () => {
        const exec = makeExecutors({}, { searchFlightsWindow: async (a) => searchFlightsWindow(a, { env: ENV, fetch: fetchLive }) });
        const out = await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow', depart_date: '2026-11' });
        expect(out.offers).toEqual([]);
        expect(out.asked).toEqual({ from: '2026-11-01', to: '2026-11-30' });
        expect(out.note).toMatch(/do not state any price/);
    });

    test('a round trip keeps the plain query — the feed prices the pair', async () => {
        let plain = 0;
        const exec = makeExecutors({}, {
            searchFlights: async () => { plain++; return null; },
            searchFlightsWindow: async () => { throw new Error('window must not be used for a return'); },
        });
        const out = await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow', depart_date: '2026-09-15', return_date: '2026-09-20' });
        expect(plain).toBe(1);
        expect(out.offers).toEqual([]);
    });

    test('no date at all keeps the plain query too', async () => {
        let plain = 0;
        const exec = makeExecutors({}, { searchFlights: async () => { plain++; return null; } });
        await exec.find_flights({ origin: 'Yerevan', destination: 'Moscow' });
        expect(plain).toBe(1);
    });

    test('feature off → null, never an empty answer dressed as data', async () => {
        expect(await searchFlightsWindow({ origin: 'Yerevan', destination: 'Moscow', from: '2026-09-14' }, { env: {}, fetch: fetchLive })).toBeNull();
    });
});
