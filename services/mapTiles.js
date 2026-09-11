// ─────────────────────────────────────────────────────────────────────────────
//  mapTiles.js — self-hosted map coverage, chosen from the admin Coverage tab
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHY THIS EXISTS
//
//    Jinni serves ONE PMTiles archive (server.js mounts TILES_DIR at /tiles and
//    protomaps-leaflet reads it directly with HTTP range requests — there is no
//    tile-server process). That archive only covers the region it was built
//    for, so a traveler in Rome saw an EMPTY map: no error, no tiles, nothing
//    (founder, live 2026-09-06 — "if map is not downloaded Jinni is not
//    there"). Map coverage IS service coverage, so it belongs beside the other
//    coverage controls, decided by staff, not by rebuilding the container.
//
//  THE SHAPE THAT KEEPS THE FRONTEND UNTOUCHED
//
//    One archive stays one archive. Staff pick COUNTRIES; the server extracts
//    the union of their bounding boxes from the Protomaps planet build into a
//    fresh file and swaps it in atomically. Adding a country = rebuild the
//    union; removing one = rebuild without it. The map code never learns a new
//    trick, and no reader ever sees a half-written archive.
//
//  WHY EXTRACTION IS CHEAP
//
//    `pmtiles extract` reads only the byte RANGES it needs out of the remote
//    ~138 GB planet — Armenia costs megabytes, not a planet download. And
//    `--dry-run` prices a selection before a single tile is fetched, which is
//    what the admin page shows before staff commit to it.
//
//  HONESTY RULES (the same ones the rest of the engine lives by)
//
//    · Sizes and progress come from the tool's own output, never a number we
//      invented — unknown renders as unknown.
//    · The CLI is fetched from a PINNED release and must answer `pmtiles
//      version` before it is trusted with a build.
//    · A failed build never touches the archive currently being served.
// ─────────────────────────────────────────────────────────────────────────────

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

// Pinned so a surprise upstream change can never alter a production build.
const CLI_VERSION = process.env.PMTILES_CLI_VERSION || '1.31.2';
// Derived from the host, not hardcoded to the production platform — otherwise
// the whole feature is untestable anywhere but the server. The upstream release
// names are NOT uniform: Linux ships `go-pmtiles_<v>_Linux_x86_64.tar.gz`,
// macOS/Windows ship `go-pmtiles-<v>_Darwin_x86_64.zip` (dash, and a zip).
const CLI_ASSET = (() => {
    const os = { linux: 'Linux', darwin: 'Darwin', win32: 'Windows' }[process.platform] || 'Linux';
    const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch] || 'x86_64';
    return os === 'Linux'
        ? { name: `go-pmtiles_${CLI_VERSION}_Linux_${arch}.tar.gz`, zip: false }
        : { name: `go-pmtiles-${CLI_VERSION}_${os}_${arch}.zip`, zip: true };
})();
const CLI_URL = `https://github.com/protomaps/go-pmtiles/releases/download/v${CLI_VERSION}/${CLI_ASSET.name}`;

// Planet builds are dated; pinning one keeps rebuilds reproducible until staff
// deliberately move to a newer planet.
const PLANET_URL = process.env.PMTILES_PLANET_URL || 'https://build.protomaps.com/20260905.pmtiles';
const MAX_ZOOM = Number(process.env.PMTILES_MAX_ZOOM) || 15;
const ARCHIVE_NAME = 'jinni.pmtiles';

const tilesDir = () => process.env.TILES_DIR || null;
const archivePath = () => (tilesDir() ? path.join(tilesDir(), ARCHIVE_NAME) : null);
const manifestPath = () => (tilesDir() ? path.join(tilesDir(), 'regions.json') : null);
const cliPath = () => (tilesDir() ? path.join(tilesDir(), 'bin', 'pmtiles') : null);

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Longitude is a CIRCLE, not a number line.
 *
 *  The plain min/max of Russia's 5017 seeded settlements is −179.12…179.35,
 *  because Chukotka sits just PAST the date line (Egvekinot −179.12, Lavrentiya
 *  −171.00). That box is not Russia: it is a belt round the ENTIRE planet at
 *  Russia's latitudes — Europe, Japan, northern China, half of North America —
 *  which is why the rebuild ran out of memory (2026-09-12). Four countries in
 *  the gazetteer straddle the line: RU, NZ (the Chathams), FJ (Vanua Levu), KI.
 *
 *  So the extent is measured TWICE — once on [−180,180), once on [0,360) — and
 *  the narrower span wins. Russia's second framing is 19.91…188.99: 169° wide,
 *  the real country. A country straddling the PRIME meridian (the UK, France,
 *  Ghana) is the mirror case, and there the first framing wins.
 *
 *  The winning extent may reach past +180. It stays that way through padding
 *  and is cut into legal boxes by splitAtAntimeridian() when the region file is
 *  written — GeoJSON cannot express a ring that crosses the line.
 */
function lonExtent({ minLon, maxLon, minLon360, maxLon360 }) {
    const naive = maxLon - minLon;
    const shifted = maxLon360 - minLon360;
    if (!Number.isFinite(shifted) || !(shifted < naive)) return [minLon, maxLon];
    // Put the west edge back on the map and let the east edge run past +180, so
    // the pair still reads west → east.
    const west = minLon360 > 180 ? minLon360 - 360 : minLon360;
    return [west, west + shifted];
}

/** A country's seeded settlements give its extent; the pad covers coastline and
 *  border towns the gazetteer never seeded. Proportional, not fixed: a flat
 *  0.6° pad turned Vatican City — a single point — into a 101 MB slab of Italy
 *  (measured 2026-09-06). 5% of each span, floored so a point still gets ~11 km
 *  of context and ceilinged so a wide country does not swallow its neighbours.
 *
 *  Longitude is deliberately NOT clamped to ±180: an extent that crosses the
 *  date line is carried past +180 and made legal later by splitAtAntimeridian().
 *  Clamping here is precisely what flattened Russia into a planet-wide belt. A
 *  full circle is the one thing that cannot be padded — there is nowhere left.
 */
function padBbox([minLon, minLat, maxLon, maxLat]) {
    const pad = (span) => Math.min(0.6, Math.max(0.1, Math.abs(span) * 0.05));
    const padLon = pad(maxLon - minLon);
    const padLat = pad(maxLat - minLat);
    const full = (maxLon - minLon) + 2 * padLon > 360;
    return [
        full ? minLon : minLon - padLon, Math.max(-85, minLat - padLat),
        full ? minLon + 360 : maxLon + padLon, Math.min(85, maxLat + padLat),
    ];
}

/** One extent → the 1 or 2 boxes GeoJSON can actually hold.
 *
 *  A box whose east edge runs past +180 becomes two: one up to the line, one
 *  resuming at −180. pmtiles takes a MultiPolygon, so both halves travel in the
 *  same build and every caller downstream stays exactly as it was.
 */
function splitAtAntimeridian([minLon, minLat, maxLon, maxLat] = []) {
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return [];
    // Already legal — hand it straight back. Every country but four takes this
    // path, and round-tripping them through the modulo below would buy nothing
    // but floating-point drift (−5.6 came back as −5.600000000000023).
    if (minLon >= -180 && maxLon <= 180 && maxLon >= minLon) return [[minLon, minLat, maxLon, maxLat]];
    const span = Math.min(360, Math.max(0, maxLon - minLon));
    const west = ((minLon + 180) % 360 + 360) % 360 - 180;
    const east = west + span;
    return east <= 180
        ? [[west, minLat, east, maxLat]]
        : [[west, minLat, 180, maxLat], [-180, minLat, east - 360, maxLat]];
}

/** One bbox → a closed GeoJSON ring (lon,lat order, first point repeated). */
function bboxRing([minLon, minLat, maxLon, maxLat]) {
    return [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
}

/** The whole selection as ONE MultiPolygon — pmtiles extract takes a single
 *  region file, so every chosen country travels in one build. */
function regionGeoJSON(bboxes = []) {
    return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: bboxes.filter(Boolean).map(b => [bboxRing(b)]) },
    };
}

/** pmtiles reports progress in its own words; we read them rather than guess.
 *  Returns { percent } / { bytes } / null — null means "nothing quotable". */
function parseProgress(line) {
    const s = String(line || '');
    const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(s);
    if (pct) {
        const p = Math.max(0, Math.min(100, Number(pct[1])));
        if (Number.isFinite(p)) return { percent: p };
    }
    const size = /([\d.]+)\s*(kB|KB|KiB|MB|MiB|GB|GiB)\b/.exec(s);
    if (size) {
        const mult = { kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3 };
        const bytes = Number(size[1]) * (mult[size[2].toLowerCase()] || 1);
        if (Number.isFinite(bytes)) return { bytes: Math.round(bytes) };
    }
    return null;
}

/** The one line that actually prices a selection, verbatim from pmtiles:
 *    "Extract transferred 254 MB (overfetch 0.05) for an archive size of 241 MB"
 *  Two different numbers matter and they are NOT interchangeable — transferred
 *  is bandwidth off the planet, archive size is what lands on the disk. The
 *  panel shows the disk figure, because that is the one staff are choosing.
 *  Also picks up "Region tiles 245163" when it goes by. */
function parseExtractSummary(line, into = {}) {
    const s = String(line || '');
    const unit = (n, u) => Math.round(Number(n) * ({ kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 }[u.toLowerCase()] || 1));
    const m = /transferred\s+([\d.]+)\s*(kB|MB|GB|TB).*?archive size of\s+([\d.]+)\s*(kB|MB|GB|TB)/i.exec(s);
    if (m) { into.transferBytes = unit(m[1], m[2]); into.archiveBytes = unit(m[3], m[4]); }
    const t = /Region tiles\s+(\d+)/i.exec(s);
    if (t) into.tiles = Number(t[1]);
    return into;
}

/** ISO-3166 alpha-2, uppercased; anything else is refused rather than repaired
 *  — these codes end up selecting what a paid-for build contains. */
function normalizeCodes(codes = []) {
    const seen = new Set();
    for (const c of Array.isArray(codes) ? codes : []) {
        const up = String(c || '').trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(up)) seen.add(up);
    }
    return [...seen].sort();
}

// ── Catalog: what can be installed, and where Jinni already has content ──────

/** Bounding boxes straight from the gazetteer we already ship: every seeded
 *  settlement of a country defines its extent. No boundary download, no third
 *  party, $0. A thinly seeded country still gets its capital's box plus the
 *  pad, and staff see the numbers before they build. */
async function catalog() {
    const mongoose = require('mongoose');
    if (mongoose.connection?.readyState !== 1) return [];
    const coll = mongoose.connection.db.collection('geonames');
    const rows = await coll.aggregate([
        { $match: { countryCode: { $ne: null }, lat: { $ne: null }, lng: { $ne: null } } },
        {
            $group: {
                _id: '$countryCode',
                countryName: { $max: { $cond: [{ $eq: ['$kind', 'country'] }, '$name', null] } },
                minLon: { $min: '$lng' }, maxLon: { $max: '$lng' },
                // The same longitudes on [0,360), so a country that crosses the
                // date line can be measured without wrapping round the planet.
                // See lonExtent(). Costs nothing — it rides the same pass.
                minLon360: { $min: { $mod: [{ $add: ['$lng', 360] }, 360] } },
                maxLon360: { $max: { $mod: [{ $add: ['$lng', 360] }, 360] } },
                minLat: { $min: '$lat' }, maxLat: { $max: '$lat' },
                places: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ], { allowDiskUse: true }).toArray().catch(() => []);

    return rows
        .filter(r => /^[A-Za-z]{2}$/.test(String(r._id || '')))
        .map(r => {
            const [west, east] = lonExtent(r);
            return {
                code: String(r._id).toUpperCase(),
                name: r.countryName || String(r._id).toUpperCase(),
                bbox: padBbox([west, r.minLat, east, r.maxLat]),
                // Unpadded: pads overlap across borders, so the tight extent is
                // what decides which country a coordinate belongs to.
                tight: [west, r.minLat, east, r.maxLat],
                // True when the east edge runs past +180 — the country is drawn
                // in two pieces, and staff deserve to see why the number reads
                // 189 rather than a silent surprise in the build log.
                crossesDateLine: east > 180,
                seededPlaces: r.places,
            };
        });
}

/** Where Jinni actually HOLDS content, by ISO country code.
 *
 *  Resolved from coordinates, never from country NAMES: the cache stores
 *  whatever Google returned ("USA", "UK", "Türkiye", and once a whole Dubai
 *  address), so any name match would silently report those countries as empty.
 *  Instead every cached place and destination is rounded to a 0.25° cell — 1789
 *  places collapse to a few dozen cells — and each cell is reverse-looked-up
 *  once against the gazetteer we own (2dsphere on `location`), which carries a
 *  countryCode on every row. Structural, language-independent, $0.
 */
const CONTENT_TTL_MS = 5 * 60 * 1000;
let contentMemo = { at: 0, value: {}, list: [] };

async function contentByCountry() {
    const mongoose = require('mongoose');
    if (mongoose.connection?.readyState !== 1) return {};
    if (Date.now() - contentMemo.at < CONTENT_TTL_MS) return contentMemo.value;
    const db = mongoose.connection.db;
    const cell = (v) => Math.round(Number(v) * 4) / 4;
    const cells = new Map();                       // "lat|lng" → places held there
    const add = (lat, lng, n) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const key = `${cell(lat)}|${cell(lng)}`;
        cells.set(key, (cells.get(key) || 0) + n);
    };

    const sources = [
        ['placecaches', '$details.geometry.location.lat', '$details.geometry.location.lng'],
        ['destinations', '$location.coordinates.lat', '$location.coordinates.lng'],
    ];
    for (const [coll, latPath, lngPath] of sources) {
        const rows = await db.collection(coll).aggregate([
            { $match: { [latPath.slice(1)]: { $type: 'number' }, [lngPath.slice(1)]: { $type: 'number' } } },
            { $group: { _id: { lat: { $round: [latPath, 1] }, lng: { $round: [lngPath, 1] } }, n: { $sum: 1 } } },
        ], { allowDiskUse: true }).toArray().catch(() => []);
        for (const r of rows) add(r._id?.lat, r._id?.lng, r.n);
    }

    // One reverse lookup per CELL, not per place, and run in parallel: the
    // serial version took 29s on live data, this is about a second.
    const counts = {};
    const geo = db.collection('geonames');
    const entries = [...cells];
    const LANES = 16;
    await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
        for (let i = lane; i < entries.length; i += LANES) {
            const [key, n] = entries[i];
            const [lat, lng] = key.split('|').map(Number);
            const near = await geo.findOne(
                { location: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: 300000 } } },
                { projection: { countryCode: 1 } },
            ).catch(() => null);
            const code = String(near?.countryCode || '').toUpperCase();
            if (/^[A-Z]{2}$/.test(code)) counts[code] = (counts[code] || 0) + n;
        }
    }));
    // Names, so callers other than the admin table can say "Italy" rather than
    // "IT". One indexed query, and it happens inside the memoized path.
    const nameRows = await geo.find(
        { kind: 'country', countryCode: { $in: Object.keys(counts) } },
        { projection: { countryCode: 1, name: 1 } },
    ).toArray().catch(() => []);
    const byCode = Object.fromEntries(nameRows.map(r => [String(r.countryCode).toUpperCase(), r.name]));
    const list = Object.entries(counts)
        .map(([code, places]) => ({ code, name: byCode[code] || code, places }))
        .sort((a, b) => b.places - a.places);
    contentMemo = { at: Date.now(), value: counts, list };
    return counts;
}

/** The same counts, but NEVER awaited by a chat turn. Returns the warm memo or
 *  null and refreshes in the background: a traveler's answer must not wait ~5s
 *  on an admin statistic, and an absent count simply means the answer is given
 *  without it. */
function contentPeek() {
    if (Date.now() - contentMemo.at < CONTENT_TTL_MS) return contentMemo.list;
    contentByCountry().catch(() => {});
    return null;
}

// ── Manifest + archive state ────────────────────────────────────────────────

async function readManifest() {
    if (!tilesDir()) return { countries: [], planet: null, maxzoom: MAX_ZOOM, updatedAt: null };
    try { return JSON.parse(await fsp.readFile(manifestPath(), 'utf8')); }
    catch { return { countries: [], planet: null, maxzoom: MAX_ZOOM, updatedAt: null }; }
}

async function writeManifest(m) {
    await fsp.mkdir(tilesDir(), { recursive: true });
    await fsp.writeFile(manifestPath(), JSON.stringify(m, null, 2));
}

async function archiveStat() {
    if (!tilesDir()) return { exists: false, bytes: 0, updatedAt: null };
    try {
        const st = await fsp.stat(archivePath());
        return { exists: true, bytes: st.size, updatedAt: st.mtime };
    } catch { return { exists: false, bytes: 0, updatedAt: null }; }
}

async function diskInfo() {
    // Not merely unhelpful without a directory: fs.statfs(null) trips a NATIVE
    // assertion that ABORTS the process — no exception to catch. Opening the
    // admin panel on a server without TILES_DIR would have killed it.
    if (!tilesDir()) return { freeBytes: null, totalBytes: null };
    try {
        const st = await fsp.statfs(tilesDir());
        return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
    } catch { return { freeBytes: null, totalBytes: null }; }
}

// ── Running the tool ─────────────────────────────────────────────────────────

function run(cmd, args, { onLine } = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        const feed = (buf) => {
            const text = buf.toString();
            tail = (tail + text).slice(-4000);
            if (onLine) for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim());
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', (err) => resolve({ ok: false, code: -1, output: err.message }));
        child.on('close', (code) => resolve({ ok: code === 0, code, output: tail }));
    });
}

async function ensureCli(onLine) {
    const bin = cliPath();
    if (!bin) throw new Error('TILES_DIR is not set — there is nowhere to keep the archive');
    if ((await run(bin, ['version'])).ok) return bin;
    onLine?.(`installing pmtiles CLI v${CLI_VERSION}…`);
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    const pkg = path.join(path.dirname(bin), CLI_ASSET.name);
    // -f matters: without it curl saves GitHub's 404 page as the archive and the
    // failure only surfaces later as "unrecognized archive format".
    const dl = await run('curl', ['-fsSL', '--max-time', '300', '-o', pkg, CLI_URL], { onLine });
    if (!dl.ok) throw new Error(`could not download the pmtiles CLI (${CLI_ASSET.name}): ${dl.output}`);
    const ex = CLI_ASSET.zip
        ? await run('unzip', ['-o', '-j', pkg, 'pmtiles', '-d', path.dirname(bin)], { onLine })
        : await run('tar', ['-xzf', pkg, '-C', path.dirname(bin), 'pmtiles'], { onLine });
    if (!ex.ok) throw new Error(`could not unpack the pmtiles CLI: ${ex.output}`);
    await fsp.chmod(bin, 0o755).catch(() => {});
    await fsp.unlink(pkg).catch(() => {});
    const verify = await run(bin, ['version']);
    if (!verify.ok) throw new Error(`the pmtiles CLI will not run on this host: ${verify.output}`);
    onLine?.('pmtiles CLI ready');
    return bin;
}

// ── Jobs: one build at a time, reported in the tool's own words ──────────────

let job = null;   // { state, codes, startedAt, finishedAt, percent, bytes, log[], error }

const jobView = () => (job ? { ...job, log: job.log.slice(-40) } : null);

async function writeRegionFile(codes) {
    const all = await catalog();
    const chosen = all.filter(c => codes.includes(c.code));
    if (!chosen.length) throw new Error('none of those countries are in the gazetteer');
    const file = path.join(tilesDir(), `.region-${Date.now()}.geojson`);
    // flatMap, not map: a country crossing the date line contributes TWO boxes.
    await fsp.writeFile(file, JSON.stringify(regionGeoJSON(chosen.flatMap(c => splitAtAntimeridian(c.bbox)))));
    return { file, chosen };
}

/** Price a selection WITHOUT downloading tiles (pmtiles --dry-run). */
async function estimate(codesIn) {
    const codes = normalizeCodes(codesIn);
    if (!codes.length) return { codes: [], bytes: null, note: 'nothing selected' };
    const bin = await ensureCli();
    const { file, chosen } = await writeRegionFile(codes);
    const summary = {};
    const res = await run(bin, ['extract', PLANET_URL, path.join(tilesDir(), '.estimate.pmtiles'),
        `--region=${file}`, `--maxzoom=${MAX_ZOOM}`, '--dry-run'], {
        onLine: (l) => parseExtractSummary(l, summary),
    });
    await fsp.unlink(file).catch(() => {});
    if (!res.ok) throw new Error(res.output.slice(-400) || 'the estimate failed');
    return {
        codes,
        countries: chosen.map(c => c.name),
        // Nulls when pmtiles said nothing quotable — an unknown must look unknown.
        bytes: summary.archiveBytes ?? null,
        transferBytes: summary.transferBytes ?? null,
        tiles: summary.tiles ?? null,
        planet: PLANET_URL, maxzoom: MAX_ZOOM,
    };
}

/** Rebuild the served archive for exactly this set of countries. */
function startBuild(codesIn) {
    const codes = normalizeCodes(codesIn);
    if (job && job.state === 'running') throw new Error('a map build is already running');
    if (!tilesDir()) throw new Error('TILES_DIR is not set on this server');
    job = { state: 'running', codes, startedAt: new Date(), finishedAt: null, percent: 0, bytes: null, log: [], error: null };
    const say = (line) => {
        const p = parseProgress(line);
        if (p?.percent != null) job.percent = p.percent;
        parseExtractSummary(line, job);
        // pmtiles redraws its progress bar hundreds of times a second; those
        // frames drive the percentage but would bury every real line in the log.
        if (/\d+\s*%\s*\|/.test(line)) return;
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    };

    (async () => {
        const tmp = path.join(tilesDir(), `.build-${Date.now()}.pmtiles`);
        let region = null;
        try {
            if (!codes.length) {
                // An empty selection means "serve no tiles" — remove the archive
                // rather than keep a stale one that lies about coverage.
                await fsp.unlink(archivePath()).catch(() => {});
                await writeManifest({ countries: [], planet: PLANET_URL, maxzoom: MAX_ZOOM, updatedAt: new Date() });
                say('archive removed — no countries selected');
                job.state = 'done'; job.percent = 100;
                return;
            }
            // Validate the selection BEFORE fetching anything: a bad set of
            // codes should fail instantly, not after a CLI download.
            const r = await writeRegionFile(codes);
            region = r.file;
            const bin = await ensureCli(say);
            say(`extracting ${r.chosen.map(c => c.name).join(', ')} from the planet (z0-${MAX_ZOOM})…`);
            const res = await run(bin, ['extract', PLANET_URL, tmp, `--region=${region}`, `--maxzoom=${MAX_ZOOM}`], { onLine: say });
            if (!res.ok) throw new Error(res.output.slice(-400) || `pmtiles exited with ${res.code}`);
            const st = await fsp.stat(tmp);
            // Atomic swap — one syscall, so a reader never sees a partial file.
            await fsp.rename(tmp, archivePath());
            await writeManifest({
                countries: r.chosen.map(c => ({ code: c.code, name: c.name, bbox: c.bbox })),
                planet: PLANET_URL, maxzoom: MAX_ZOOM, updatedAt: new Date(), archiveBytes: st.size,
            });
            job.bytes = st.size;
            say(`done — the served archive is now ${(st.size / 1e6).toFixed(1)} MB`);
            job.state = 'done'; job.percent = 100;
        } catch (err) {
            await fsp.unlink(tmp).catch(() => {});
            job.state = 'failed';
            job.error = err.message;
            say(`failed: ${err.message}`);
        } finally {
            if (region) await fsp.unlink(region).catch(() => {});
            job.finishedAt = new Date();
        }
    })();

    return jobView();
}

async function status() {
    const [archive, disk, manifest, cat, content] = await Promise.all([
        archiveStat(), diskInfo(), readManifest(), catalog(), contentByCountry(),
    ]);
    const installed = new Set((manifest.countries || []).map(c => c.code));
    return {
        enabled: !!tilesDir(),
        dir: tilesDir(),
        planet: PLANET_URL,
        maxzoom: MAX_ZOOM,
        archive,
        disk,
        job: jobView(),
        installedAt: manifest.updatedAt || null,
        installed: [...installed],
        // An archive with no manifest was built before this panel existed, so
        // its contents are UNKNOWN. Live 2026-09-06: the panel showed nothing
        // ticked, a build for Italy replaced the archive, and Armenia's map
        // went blank with no error anywhere — tile requests are plain static
        // file reads and log nothing at all.
        unmanaged: archive.exists && !(manifest.countries || []).length,
        // Countries we hold content for but cannot draw — the gap the founder
        // named: "if map is not downloaded Jinni is not there".
        blind: Object.keys(content).filter(code => !installed.has(code)).sort(
            (a, b) => content[b] - content[a]),
        catalog: cat.map(c => ({ ...c, installed: installed.has(c.code), places: content[c.code] || 0 })),
    };
}

module.exports = {
    status, estimate, startBuild, jobView, catalog, contentByCountry, contentPeek,
    // pure, for tests
    lonExtent, padBbox, splitAtAntimeridian, bboxRing, regionGeoJSON, parseProgress,
    parseExtractSummary, normalizeCodes,
    PLANET_URL, MAX_ZOOM, ARCHIVE_NAME,
};
