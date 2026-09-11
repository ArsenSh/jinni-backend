// Map-coverage tests. No Mongo, no network, no planet: the pure helpers run for
// real, and the IO paths are exercised against a throwaway TILES_DIR on disk.
//
// Every assertion here executes the shipped function. Nothing inspects source
// text — the last time a change was "verified" that way it shipped a crash.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mapTiles = require('../services/mapTiles');
const {
    lonExtent, padBbox, splitAtAntimeridian, bboxRing, regionGeoJSON, parseProgress,
    parseExtractSummary, normalizeCodes, checkFits, checkMeasurable, tilesInBox, tilesInBoxes,
} = mapTiles;

// The real numbers the live gazetteer returns, measured 2026-09-12. Each of
// these four countries has settlements on BOTH sides of the date line, which is
// the whole reason lonExtent exists.
const GAZETTEER = {
    RU: { minLon: -179.12, maxLon: 179.35, minLon360: 19.91, maxLon360: 188.99, minLat: 41.42, maxLat: 73.51 },
    NZ: { minLon: -176.56, maxLon: 178.30, minLon360: 166.42, maxLon360: 183.44, minLat: -46.60, maxLat: -34.99 },
    FJ: { minLon: -178.81, maxLon: 179.36, minLon360: 176.92, maxLon360: 181.19, minLat: -18.24, maxLat: -12.50 },
    KI: { minLon: -159.39, maxLon: 173.26, minLon360: 173.26, maxLon360: 200.61, minLat: 1.33, maxLat: 3.91 },
    // The mirror case: Britain straddles the PRIME meridian, so the [0,360)
    // framing is the broken one and the plain one must win.
    GB: { minLon: -7.56, maxLon: 1.75, minLon360: 1.75, maxLon360: 352.44, minLat: 49.92, maxLat: 60.15 },
};

describe('padBbox — proportional padding', () => {
    test('a point country stays small (a flat 0.6° pad made Vatican City 101 MB of Italy)', () => {
        const [minLon, minLat, maxLon, maxLat] = padBbox([12.45, 41.90, 12.45, 41.90]);
        expect(maxLon - minLon).toBeCloseTo(0.2, 5);
        expect(maxLat - minLat).toBeCloseTo(0.2, 5);
    });

    test('a wide country is padded but never by more than 0.6° a side', () => {
        const [minLon, minLat, maxLon, maxLat] = padBbox([-5, 41, 10, 51]);
        expect(minLon).toBeCloseTo(-5.6, 5);
        expect(maxLon).toBeCloseTo(10.6, 5);
        expect(minLat).toBeCloseTo(40.5, 5);
        expect(maxLat).toBeCloseTo(51.5, 5);
    });

    test('padding never escapes real world bounds', () => {
        const [minLon, minLat, maxLon, maxLat] = padBbox([-180, -85, 180, 85]);
        expect(minLon).toBe(-180);
        expect(maxLon).toBe(180);
        expect(minLat).toBe(-85);
        expect(maxLat).toBe(85);
    });
});

describe('lonExtent — longitude measured on a circle', () => {
    test('RUSSIA stops being a belt round the planet (the OOM, 2026-09-12)', () => {
        const [west, east] = lonExtent(GAZETTEER.RU);
        // Before: -179.12…179.35, a 358° box holding Europe, Japan, north China
        // and half of North America. After: Kaliningrad eastwards to Chukotka.
        expect(east - west).toBeCloseTo(169.08, 2);
        expect(west).toBeCloseTo(19.91, 2);
        expect(east).toBeGreaterThan(180);            // carried past the line on purpose
    });

    test('the other three date-line countries shrink the same way', () => {
        expect(lonExtent(GAZETTEER.NZ)[1] - lonExtent(GAZETTEER.NZ)[0]).toBeCloseTo(17.02, 2);
        expect(lonExtent(GAZETTEER.FJ)[1] - lonExtent(GAZETTEER.FJ)[0]).toBeCloseTo(4.27, 2);
        expect(lonExtent(GAZETTEER.KI)[1] - lonExtent(GAZETTEER.KI)[0]).toBeCloseTo(27.35, 2);
    });

    test('a PRIME-meridian country is left alone — the plain framing wins', () => {
        expect(lonExtent(GAZETTEER.GB)).toEqual([-7.56, 1.75]);
    });

    test('an ordinary country is untouched, and a tie keeps the plain framing', () => {
        // Chile: both framings are 9° wide, so nothing should move.
        expect(lonExtent({ minLon: -75, maxLon: -66, minLon360: 285, maxLon360: 294 }))
            .toEqual([-75, -66]);
    });

    test('a country with no second framing falls back rather than inventing one', () => {
        expect(lonExtent({ minLon: 4, maxLon: 9 })).toEqual([4, 9]);
    });
});

describe('splitAtAntimeridian — two boxes where GeoJSON needs two', () => {
    test('Russia is handed over as Kaliningrad→line and line→Chukotka', () => {
        const { minLat, maxLat } = GAZETTEER.RU;
        const [west, east] = lonExtent(GAZETTEER.RU);
        const [a, b] = splitAtAntimeridian(padBbox([west, minLat, east, maxLat]));
        expect(a[0]).toBeCloseTo(19.31, 2);
        expect(a[2]).toBe(180);
        expect(b[0]).toBe(-180);
        expect(b[2]).toBeCloseTo(-170.41, 2);
        expect(a[1]).toBeCloseTo(b[1], 5);            // same latitudes in both halves
        expect(a[3]).toBeCloseTo(b[3], 5);
    });

    test('a box that never reaches the line stays a single box', () => {
        expect(splitAtAntimeridian([-5.6, 40.5, 10.6, 51.5])).toEqual([[-5.6, 40.5, 10.6, 51.5]]);
    });

    test('every produced box is legal longitude, even for the whole planet', () => {
        for (const code of Object.keys(GAZETTEER)) {
            const g = GAZETTEER[code];
            const [west, east] = lonExtent(g);
            for (const box of splitAtAntimeridian(padBbox([west, g.minLat, east, g.maxLat]))) {
                expect(box[0]).toBeGreaterThanOrEqual(-180);
                expect(box[2]).toBeLessThanOrEqual(180);
                expect(box[2]).toBeGreaterThan(box[0]);
            }
        }
        expect(splitAtAntimeridian(padBbox([-180, -85, 180, 85]))).toEqual([[-180, -85, 180, 85]]);
    });

    test('nonsense in, nothing out — never a malformed ring', () => {
        expect(splitAtAntimeridian([])).toEqual([]);
        expect(splitAtAntimeridian([NaN, 1, 2, 3])).toEqual([]);
        expect(splitAtAntimeridian()).toEqual([]);
    });
});

describe('tilesInBox — pricing the selection without spawning anything', () => {
    // `--dry-run` downloads no tiles but builds the same in-memory index, so
    // PRICING costs the same RAM as building. Live 2026-09-11 the size check
    // for AE+AM+FR+GE+IT+RU was itself killed 13s in. These numbers are the
    // real dry-run counts the prediction is calibrated against.
    const ARMENIA = [43.3, 38.7, 46.7, 41.4];
    const RUSSIA = [[19.309, 40.822, 180, 74.108], [-180, 40.822, -170.397, 74.108]];

    test('dense land is predicted almost exactly (Armenia measured 101,549)', () => {
        const p = tilesInBox(ARMENIA);
        expect(p / 101549).toBeGreaterThan(0.9);
        expect(p / 101549).toBeLessThan(1.1);
    });

    test('a sparse region is OVER-counted, never under (Russia measured 38,568,270)', () => {
        // Candidate cells, where the archive holds only cells that exist: empty
        // Arctic and sea inflate this. Erring high is the safe direction.
        const p = tilesInBoxes(RUSSIA);
        expect(p).toBeGreaterThan(38568270);
        expect(p / 38568270).toBeLessThan(4);
    });

    test('both halves of a date-line country are counted', () => {
        expect(tilesInBoxes(RUSSIA)).toBeGreaterThan(tilesInBox(RUSSIA[0]));
    });

    test('latitude runs the opposite way to tile Y, and a box is never negative', () => {
        // The first cut of this returned 0 for every country by subtracting the
        // edges the wrong way round.
        expect(tilesInBox([0, 0, 1, 1])).toBeGreaterThan(0);
        expect(tilesInBox([0, 50, 1, 51])).toBeGreaterThan(0);
        expect(tilesInBox([10, 40, 10, 40])).toBeGreaterThanOrEqual(0);
    });

    test('the poles do not produce infinity', () => {
        expect(Number.isFinite(tilesInBox([-180, -90, 180, 90]))).toBe(true);
        expect(tilesInBox([-180, -90, 180, 90])).toBeGreaterThan(0);
    });

    test('nonsense counts as nothing rather than crashing a build', () => {
        expect(tilesInBox([NaN, 1, 2, 3])).toBe(0);
        expect(tilesInBoxes([])).toBe(0);
        expect(tilesInBoxes(null)).toBe(0);
    });
});

describe('checkMeasurable — refusing before anything is spawned', () => {
    const RUSSIA = [[19.309, 40.822, 180, 74.108], [-180, 40.822, -170.397, 74.108]];
    const ARMENIA = [[43.3, 38.7, 46.7, 41.4]];

    test('Russia is refused on the live box WITHOUT running pmtiles at all', () => {
        const msg = checkMeasurable(RUSSIA, 2.3e9);
        expect(msg).toMatch(/too big for this server/i);
        expect(msg).toMatch(/nothing was started/i);
    });

    test('Armenia is measurable on the very same box', () => {
        expect(checkMeasurable(ARMENIA, 2.3e9)).toBeNull();
    });

    test('a bigger machine measures what the small one cannot', () => {
        expect(checkMeasurable(RUSSIA, 32e9)).toBeNull();
    });

    test('with no memory reading we do not invent a refusal', () => {
        expect(checkMeasurable(RUSSIA, null)).toBeNull();
        expect(checkMeasurable([], 1)).toBeNull();
    });
});

describe('checkFits — refusing a build this server cannot finish', () => {
    // Measured 2026-09-12 with pmtiles --dry-run against the pinned planet, and
    // peak RSS sampled while each ran. Fixing the date line made Russia Russia;
    // it did not make Russia small enough for an 8 GB box.
    const RUSSIA = { archiveBytes: 26e9, tiles: 38_568_270 };   // peaked at 3.25 GB RSS
    const ARMENIA = { archiveBytes: 132e6, tiles: 101_549 };    // peaked at 48 MB
    const LIVE_SERVER = { freeBytes: 112e9, availBytes: 2.3e9 };

    test('Armenia fits the live server exactly as it stands today', () => {
        expect(checkFits(ARMENIA, LIVE_SERVER)).toBeNull();
    });

    test('Russia is refused for MEMORY, though 112 GB of disk sat free', () => {
        const msg = checkFits(RUSSIA, LIVE_SERVER);
        expect(msg).toMatch(/memory/i);
        expect(msg).toMatch(/38,568,270/);          // the tool's own count, not ours
        expect(msg).not.toMatch(/disk/i);           // the true reason, not the loudest one
    });

    test('disk is judged against the archive PLUS room beside the one being served', () => {
        // 26 GB into 27 GB free leaves nowhere for the archive still in use.
        expect(checkFits(RUSSIA, { freeBytes: 27e9, availBytes: 16e9 })).toMatch(/disk/i);
        expect(checkFits(RUSSIA, { freeBytes: 40e9, availBytes: 16e9 })).toBeNull();
    });

    test('given room for both, nothing is refused', () => {
        expect(checkFits(RUSSIA, { freeBytes: 112e9, availBytes: 16e9 })).toBeNull();
    });

    test('an UNKNOWN estimate never blocks a build — unknown must look unknown', () => {
        expect(checkFits({ archiveBytes: null, tiles: null }, { freeBytes: 1e6, availBytes: 1e6 })).toBeNull();
        expect(checkFits({}, {})).toBeNull();
        expect(checkFits(RUSSIA, { freeBytes: null, availBytes: null })).toBeNull();
        expect(checkFits()).toBeNull();
    });

    test('a reading we do not have is never rendered as zero', () => {
        // statfs can fail and /proc/meminfo can be absent. "0.00 GB free" would
        // read as a full disk rather than as no answer.
        const msg = checkFits(RUSSIA, { freeBytes: 1e9, availBytes: null });
        expect(msg).toMatch(/disk/i);
        expect(msg).not.toMatch(/0\.00 GB/);
    });

    test('the refusal says what to do next, not merely that it failed', () => {
        expect(checkFits(RUSSIA, LIVE_SERVER)).toMatch(/fewer countries/);
        expect(checkFits(RUSSIA, { freeBytes: 27e9, availBytes: 16e9 })).toMatch(/fewer countries/);
    });
});

describe('regionGeoJSON — what pmtiles is actually handed', () => {
    test('a ring is closed and in lon,lat order', () => {
        const ring = bboxRing([1, 2, 3, 4]);
        expect(ring).toHaveLength(5);
        expect(ring[0]).toEqual([1, 2]);
        expect(ring[4]).toEqual(ring[0]);
        expect(ring[2]).toEqual([3, 4]);
    });

    test('several countries travel as ONE MultiPolygon, one polygon each', () => {
        const gj = regionGeoJSON([[1, 2, 3, 4], [10, 20, 11, 21]]);
        expect(gj.type).toBe('Feature');
        expect(gj.geometry.type).toBe('MultiPolygon');
        expect(gj.geometry.coordinates).toHaveLength(2);
        expect(gj.geometry.coordinates[0][0][0]).toEqual([1, 2]);
        expect(JSON.parse(JSON.stringify(gj))).toEqual(gj);   // survives the file write
    });

    test('empty and holey input do not produce a malformed geometry', () => {
        expect(regionGeoJSON([]).geometry.coordinates).toEqual([]);
        expect(regionGeoJSON([null, [1, 2, 3, 4], undefined]).geometry.coordinates).toHaveLength(1);
    });
});

describe('reading the tool rather than guessing', () => {
    test('the summary line separates disk size from bytes transferred', () => {
        // Verbatim from a live run against the planet, 2026-09-06.
        const out = parseExtractSummary(
            '2026/09/06 16:42:52 extract.go:612: Extract transferred 254 MB (overfetch 0.05) for an archive size of 241 MB');
        expect(out.transferBytes).toBe(254000000);
        expect(out.archiveBytes).toBe(241000000);   // the figure the panel shows
    });

    test('tile counts are picked up, and unrelated lines say nothing', () => {
        expect(parseExtractSummary('extract.go:441: Region tiles 245163, result tile entries 209864').tiles).toBe(245163);
        expect(parseExtractSummary('fetching 24 dirs, 24 chunks, 15 requests')).toEqual({});
    });

    test('progress frames give a percentage', () => {
        expect(parseProgress('fetching chunks  93% |████| (94/101 MB, 2.8 MB/s) [22s:2s]')).toEqual({ percent: 93 });
        expect(parseProgress('nothing quotable here')).toBeNull();
    });

    test('a percentage can never leave 0–100', () => {
        expect(parseProgress('999%').percent).toBe(100);
    });
});

describe('normalizeCodes — these strings reach an argument list', () => {
    test('uppercases, de-duplicates and sorts', () => {
        expect(normalizeCodes(['ge', 'AM', 'am', 'It'])).toEqual(['AM', 'GE', 'IT']);
    });

    test('anything that is not an ISO alpha-2 code is dropped, not repaired', () => {
        expect(normalizeCodes(['AM; rm -rf /', '../../etc', 'ARM', '', null, 42, 'A'])).toEqual([]);
        expect(normalizeCodes('AM')).toEqual([]);        // not an array
        expect(normalizeCodes()).toEqual([]);
    });
});

describe('builds against a real (throwaway) TILES_DIR', () => {
    let dir;
    const prev = process.env.TILES_DIR;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinni-tiles-'));
        process.env.TILES_DIR = dir;
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env.TILES_DIR; else process.env.TILES_DIR = prev;
    });

    const settle = async () => {
        for (let i = 0; i < 50; i++) {
            if (mapTiles.jobView()?.state !== 'running') return mapTiles.jobView();
            await new Promise(r => setTimeout(r, 20));
        }
        return mapTiles.jobView();
    };

    test('an empty selection removes the archive instead of leaving a stale one', async () => {
        const archive = path.join(dir, 'jinni.pmtiles');
        fs.writeFileSync(archive, 'old tiles');
        mapTiles.startBuild([]);
        const job = await settle();
        expect(job.state).toBe('done');
        expect(fs.existsSync(archive)).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'regions.json'), 'utf8')).countries).toEqual([]);
    });

    test('a second build is refused while one is running, rather than racing it', async () => {
        // No network is reachable in tests, so this one fails — but it is
        // *running* at the moment the second call arrives, which is the point.
        mapTiles.startBuild(['AM']);
        expect(() => mapTiles.startBuild(['GE'])).toThrow(/already running/i);
        await settle();
    });

    test('a failed build leaves the served archive untouched', async () => {
        const archive = path.join(dir, 'jinni.pmtiles');
        fs.writeFileSync(archive, 'known good tiles');
        mapTiles.startBuild(['AM']);          // no Mongo → no catalog → fails
        const job = await settle();
        expect(job.state).toBe('failed');
        expect(job.error).toBeTruthy();
        expect(fs.readFileSync(archive, 'utf8')).toBe('known good tiles');
        expect(fs.readdirSync(dir).filter(f => f.startsWith('.build-'))).toEqual([]);
        expect(fs.readdirSync(dir).filter(f => f.startsWith('.region-'))).toEqual([]);
    });

    test('status reports an absent archive honestly', async () => {
        const st = await mapTiles.status();
        expect(st.enabled).toBe(true);
        expect(st.archive).toEqual({ exists: false, bytes: 0, updatedAt: null });
        expect(st.installed).toEqual([]);
        expect(st.maxzoom).toBe(15);
    });

    // Live 2026-09-06: the archive predating this panel had no manifest, so the
    // panel believed nothing was installed, and a build for Italy silently
    // discarded Armenia's tiles. Tile reads are static file reads — no log, no
    // error, just a blank map.
    test('an archive with no manifest is flagged as unknown, not as empty', async () => {
        fs.writeFileSync(path.join(dir, 'jinni.pmtiles'), Buffer.alloc(1024));
        const st = await mapTiles.status();
        expect(st.archive.exists).toBe(true);
        expect(st.installed).toEqual([]);
        expect(st.unmanaged).toBe(true);
    });

    test('an archive this panel built is NOT flagged unknown', async () => {
        fs.writeFileSync(path.join(dir, 'jinni.pmtiles'), Buffer.alloc(1024));
        fs.writeFileSync(path.join(dir, 'regions.json'), JSON.stringify({
            countries: [{ code: 'IT', name: 'Italy', bbox: [6, 35, 19, 47] }], maxzoom: 15,
        }));
        const st = await mapTiles.status();
        expect(st.installed).toEqual(['IT']);
        expect(st.unmanaged).toBe(false);
    });

    test('no archive at all is not "unknown" either — there is nothing to lose', async () => {
        expect((await mapTiles.status()).unmanaged).toBe(false);
    });

    test('status reports the size of an archive that IS there', async () => {
        fs.writeFileSync(path.join(dir, 'jinni.pmtiles'), Buffer.alloc(4096));
        const st = await mapTiles.status();
        expect(st.archive.exists).toBe(true);
        expect(st.archive.bytes).toBe(4096);
    });
});

describe('without TILES_DIR the feature says so instead of half-working', () => {
    const prev = process.env.TILES_DIR;
    beforeAll(() => { delete process.env.TILES_DIR; });
    afterAll(() => { if (prev !== undefined) process.env.TILES_DIR = prev; });

    test('a build is refused outright', () => {
        expect(() => mapTiles.startBuild(['AM'])).toThrow(/TILES_DIR/);
    });

    test('status reports the feature as disabled', async () => {
        const st = await mapTiles.status();
        expect(st.enabled).toBe(false);
        expect(st.dir).toBeNull();
    });
});
