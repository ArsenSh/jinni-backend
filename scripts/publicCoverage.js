// Why does the landing list only these cities? Read-only report for the
// public /discover pages (founder 2026-09-17: "see why it is not showing all
// locations, I mean all country names").
//
//   node scripts/publicCoverage.js
//
// ⚠ RUN THIS ON THE SERVER — the Atlas IP whitelist blocks local connections.
//
// Prints, per country (from the stored address): visible cache rows, how
// many are validator-verified (only those can be published), how many found
// NO gazetteer settlement within reach (unseeded country or remote place),
// and which settlements fell under the page minimum.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const PlaceCache = require('../models/PlaceCache');
    const GeoName = require('../models/GeoName');
    const { publicVisible, clusterCities, EXPLORE_CATEGORIES, CITY_MIN_PLACES, CITY_MIN_POPULATION, CITY_RADIUS_KM, VERIFIED_ONLY } = require('../routes/publicRoutes')._internals;
    const { radiusForPopulation } = require('../engine/geo/gazetteer');
    console.log(`rules: verified only=${VERIFIED_ONLY} · min places/page=${CITY_MIN_PLACES} · settlement pop ≥ ${CITY_MIN_POPULATION} · reach cap ${CITY_RADIUS_KM} km`);

    const rows = (await PlaceCache.find({ actions: { $in: EXPLORE_CATEGORIES }, 'explore.status': { $ne: 'hidden' }, aiBlocked: { $ne: true }, 'photos.0': { $exists: true } })
        .select('placeId name rating actions likes dislikes explore aiBlocked business_status photos.url details.geometry.location details.formatted_address details.vicinity').lean())
        .filter(publicVisible);
    const country = (r) => String(r.details?.formatted_address || '').split(',').pop().trim() || '(no address)';
    const per = new Map();
    for (const r of rows) {
        const c = country(r);
        if (!per.has(c)) per.set(c, { visible: 0, verified: 0, noSettlement: 0, sample: [] });
        const e = per.get(c); e.visible++;
        if (r.explore?.status === 'verified') e.verified++;
    }
    const cities = await GeoName.find({ kind: 'city', population: { $gte: CITY_MIN_POPULATION }, featureCode: { $nin: ['PPLX', 'PPLQ', 'PPLW', 'PPLH'] } })
        .select('name asciiName lat lng countryCode countryName population').lean();
    const byCC = new Map();
    for (const c of cities) byCC.set(c.countryCode, (byCC.get(c.countryCode) || 0) + 1);
    console.log(`gazetteer settlements eligible: ${cities.length} across ${byCC.size} countries` + (byCC.size <= 12 ? ` (${[...byCC.entries()].map(([k, v]) => `${k}:${v}`).join(', ')})` : ''));

    const published = VERIFIED_ONLY ? rows.filter(r => r.explore?.status === 'verified') : rows;
    // which published rows find no settlement within reach?
    const grid = new Map();
    for (const c of cities) { const k = `${Math.floor(c.lat)}:${Math.floor(c.lng)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
    const km = (a, b, c, d) => { const R = 6371, t = x => x * Math.PI / 180; const dl = t(c - a), dn = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
    for (const r of published) {
        const loc = r.details.geometry.location; let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) {
            for (const c of grid.get(`${Math.floor(loc.lat) + dy}:${Math.floor(loc.lng) + dx}`) || []) {
                const d = km(loc.lat, loc.lng, c.lat, c.lng);
                if (d <= CITY_RADIUS_KM && d <= radiusForPopulation(c.population)) { found = true; break; }
            }
        }
        if (!found) { const e = per.get(country(r)); e.noSettlement++; if (e.sample.length < 3) e.sample.push(r.name); }
    }
    console.log('\nper country (visible → verified → verified with no settlement in reach):');
    for (const [c, e] of [...per.entries()].sort((a, b) => b[1].visible - a[1].visible)) {
        console.log(`  ${c.padEnd(24)} visible ${String(e.visible).padStart(4)} · verified ${String(e.verified).padStart(4)} · no settlement ${String(e.noSettlement).padStart(3)}${e.sample.length ? `  e.g. ${e.sample.join(', ')}` : ''}`);
    }
    const all = clusterCities(published, cities, { minPlaces: 1 });
    console.log(`\nsettlements with published places (≥ ${CITY_MIN_PLACES} gets a page):`);
    for (const cl of all) console.log(`  ${cl.rows.length >= CITY_MIN_PLACES ? 'PAGE ' : '     '} ${cl.city.name} (${cl.city.countryCode}) — ${cl.rows.length}`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
