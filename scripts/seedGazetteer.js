// Seed the owned gazetteer from GeoNames (CC BY 4.0) — see models/GeoName.js
// for why. Repo convention: DRY-RUN by default, --apply writes.
//
//   node scripts/seedGazetteer.js                          # counts + samples, no writes
//   node scripts/seedGazetteer.js --apply                   # seed EVERY country
//   node scripts/seedGazetteer.js --apply --countries=AM,GE,AE
//   node scripts/seedGazetteer.js --apply --alt             # + alternate names (ru/hy/ar…)
//   node scripts/seedGazetteer.js --apply --file=/tmp/cities1000.txt
//
// ⚠ RUN THIS ON THE SERVER, not locally — the Atlas IP whitelist blocks local
//   connections (the same lesson scripts/embedPlaceCache.js records).
//
// ⚠ ATLAS FLEX IS CAPPED AT 100 OPS/SEC. Writes therefore go through
//   bulkWrite in batches of 1,000 — one command per batch, not one per row.
//   Seeding row-by-row would burn the whole ops budget for ~22 minutes.
//
// Re-running is safe and incremental: every write is an upsert keyed on
// geonameId, so a second run updates in place rather than duplicating.
//
// SIZING: cities1000 is ~130k rows. Seeded worldwide WITHOUT --alt that is
// ~25-32 MB of documents plus ~30 MB of indexes — roughly 1% of the 5 GB Atlas
// Flex allowance. --alt multiplies the `names` multikey index several-fold;
// start without it.

require('dotenv').config();
const zlib = require('zlib');
const fs = require('fs');
const mongoose = require('mongoose');
const axios = require('axios');
const GeoName = require('../models/GeoName');
const { normalizeName } = require('../engine/geo/gazetteer');

const ARG = (k, dflt = null) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : dflt;
};
const APPLY = process.argv.includes('--apply');
const WITH_ALT = process.argv.includes('--alt');
const ONLY = (ARG('countries') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const MIN_POP = Number(ARG('min-pop', '0')) || 0;
const LOCAL_FILE = ARG('file');
const BATCH = 1000;

const BASE = 'https://download.geonames.org/export/dump';

// ── Dependency-free ZIP reader ───────────────────────────────────────────────
// Only cities1000 is zipped; countryInfo/admin1 are plain text. Adding adm-zip
// for one archive is not worth a dependency, and `unzip` is not guaranteed to
// exist in a Coolify container. We read the CENTRAL DIRECTORY rather than the
// local file header, because a streamed archive can carry zero sizes in the
// local header. (ZIP64 is not handled — cities1000.zip is a few MB.)
function unzipFirstTxt(buf) {
    const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('corrupt central directory');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (!entryName.toLowerCase().endsWith('.txt')) continue;
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(start, start + compSize);
        return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    }
    throw new Error('no .txt entry inside the archive');
}

async function fetchText(url) {
    const res = await axios.get(url, { responseType: 'text', timeout: 120000 });
    return res.data;
}
async function fetchZipText(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000 });
    return unzipFirstTxt(Buffer.from(res.data));
}

const rows = (text) => text.split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('\t'));

// ── Build ────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`[gazetteer] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`
        + `${ONLY.length ? ` · countries=${ONLY.join(',')}` : ' · ALL countries'}`
        + `${WITH_ALT ? ' · with alternate names' : ''}`
        + `${MIN_POP ? ` · min-pop=${MIN_POP}` : ''}`);

    console.log('[gazetteer] downloading dumps…');
    const [citiesTxt, countryTxt, admin1Txt] = await Promise.all([
        LOCAL_FILE ? Promise.resolve(fs.readFileSync(LOCAL_FILE, 'utf8')) : fetchZipText(`${BASE}/cities1000.zip`),
        fetchText(`${BASE}/countryInfo.txt`),
        fetchText(`${BASE}/admin1CodesASCII.txt`),
    ]);

    // countryInfo.txt: 0 ISO · 4 Country · 5 Capital · 16 geonameid
    const countries = new Map();
    for (const c of rows(countryTxt)) {
        if (!c[0] || !c[4]) continue;
        if (ONLY.length && !ONLY.includes(c[0])) continue;
        countries.set(c[0], {
            iso: c[0], name: c[4], capital: (c[5] || '').trim() || null,
            geonameId: Number(c[16]) || null,
        });
    }

    // cities1000.txt: 0 id · 1 name · 2 ascii · 3 alternates · 4 lat · 5 lng
    //                 6 class · 7 code · 8 country · 10 admin1 · 14 population
    const cities = [];
    for (const r of rows(citiesTxt)) {
        const cc = r[8];
        if (!cc || (ONLY.length && !ONLY.includes(cc))) continue;
        if (r[6] !== 'P') continue;                       // populated places only
        const population = Number(r[14]) || 0;
        if (population < MIN_POP) continue;
        const lat = Number(r[4]), lng = Number(r[5]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        cities.push({
            geonameId: Number(r[0]), name: r[1], asciiName: r[2] || null,
            alternates: WITH_ALT ? String(r[3] || '').split(',').filter(Boolean).slice(0, 8) : [],
            lat, lng, featureCode: r[7] || null, countryCode: cc,
            admin1: r[10] || null, population,
        });
    }
    console.log(`[gazetteer] parsed ${cities.length} cities across ${countries.size} country record(s)`);

    // Biggest city per country and per region — the coordinates a country or a
    // region entry gets. A country's geometric CENTROID is a field in the
    // countryside that answers nothing; its capital is where travelers go.
    const biggestInCountry = new Map();
    const biggestInAdmin1 = new Map();
    const capitalOf = new Map();
    for (const c of cities) {
        const k1 = c.countryCode, k2 = `${c.countryCode}.${c.admin1}`;
        if (!biggestInCountry.has(k1) || c.population > biggestInCountry.get(k1).population) biggestInCountry.set(k1, c);
        if (!biggestInAdmin1.has(k2) || c.population > biggestInAdmin1.get(k2).population) biggestInAdmin1.set(k2, c);
        if (c.featureCode === 'PPLC') capitalOf.set(c.countryCode, c);
    }

    const keysFor = (...vals) => [...new Set(vals.flat().filter(Boolean).map(normalizeName).filter(Boolean))];
    const docs = [];

    for (const c of cities) {
        docs.push({
            geonameId: c.geonameId, kind: 'city', scale: 'town',
            name: c.name, asciiName: c.asciiName,
            names: keysFor(c.name, c.asciiName, c.alternates),
            countryCode: c.countryCode, countryName: countries.get(c.countryCode)?.name || null,
            admin1: c.admin1, featureCode: c.featureCode, population: c.population,
            lat: c.lat, lng: c.lng,
            location: { type: 'Point', coordinates: [c.lng, c.lat] },
        });
    }

    // admin1CodesASCII.txt: 0 'CC.admin1' · 1 name · 2 ascii · 3 geonameid
    for (const a of rows(admin1Txt)) {
        const [code, name, ascii, gid] = a;
        const cc = String(code || '').split('.')[0];
        if (!cc || !name || (ONLY.length && !ONLY.includes(cc))) continue;
        const seat = biggestInAdmin1.get(code);
        if (!seat || !Number(gid)) continue;               // no coordinates → not useful
        docs.push({
            geonameId: Number(gid), kind: 'region', scale: 'region',
            name, asciiName: ascii || null, names: keysFor(name, ascii),
            countryCode: cc, countryName: countries.get(cc)?.name || null,
            admin1: String(code).split('.')[1] || null, featureCode: 'ADM1',
            population: 0, lat: seat.lat, lng: seat.lng,
            location: { type: 'Point', coordinates: [seat.lng, seat.lat] },
        });
    }

    for (const [iso, info] of countries) {
        const seat = capitalOf.get(iso) || biggestInCountry.get(iso);
        if (!seat || !info.geonameId) continue;
        docs.push({
            geonameId: info.geonameId, kind: 'country', scale: 'country',
            name: info.name, asciiName: info.name,
            names: keysFor(info.name, iso),
            countryCode: iso, countryName: info.name,
            admin1: null, featureCode: 'PCLI', population: 0,
            lat: seat.lat, lng: seat.lng,
            location: { type: 'Point', coordinates: [seat.lng, seat.lat] },
        });
    }

    const tally = docs.reduce((m, d) => ({ ...m, [d.kind]: (m[d.kind] || 0) + 1 }), {});
    console.log(`[gazetteer] built ${docs.length} entries — ${JSON.stringify(tally)}`);

    if (!APPLY) {
        for (const sample of ['country', 'region', 'city']) {
            const d = docs.find(x => x.kind === sample);
            if (d) console.log(`  would write [${sample}] ${d.name} (${d.countryCode}) `
                + `pop=${d.population} @ ${d.lat.toFixed(3)},${d.lng.toFixed(3)} keys=${d.names.slice(0, 4).join('|')}`);
        }
        console.log('[gazetteer] dry run — nothing written. Re-run with --apply.');
        process.exit(0);
    }

    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    let written = 0;
    for (let i = 0; i < docs.length; i += BATCH) {
        const slice = docs.slice(i, i + BATCH);
        await GeoName.bulkWrite(slice.map(d => ({
            updateOne: {
                filter: { geonameId: d.geonameId },
                update: { $set: { ...d, source: 'geonames', seededAt: new Date() } },
                upsert: true,
            },
        })), { ordered: false });
        written += slice.length;
        console.log(`  ${written}/${docs.length}…`);
    }
    // Indexes are declared on the schema; build them explicitly so the first
    // real lookup does not race an unbuilt 2dsphere.
    await GeoName.syncIndexes();
    console.log(`[gazetteer] seeded ${written} entries and synced indexes.`);
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error('[gazetteer] failed:', err.message); process.exit(1); });
