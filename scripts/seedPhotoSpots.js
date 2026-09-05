// Seed photo-spot Destinations from OpenStreetMap + Wikimedia Commons.
//
//   node scripts/seedPhotoSpots.js                          # DRY-RUN: writes review JSON, no DB writes
//   node scripts/seedPhotoSpots.js --apply                  # insert as isActive:false (staff activate after review)
//   node scripts/seedPhotoSpots.js --apply --activate       # insert live (pre-reviewed runs only)
//   node scripts/seedPhotoSpots.js --city=Gyumri --lat=40.7894 --lng=43.8475 --radius=8
//
// ⚠ RUN THIS ON THE SERVER — the Atlas IP whitelist blocks local connections
//   (same lesson as scripts/backfillPlaceActions.js).
//
// WHY (founder, 2026-09-05: "my database of photo spots will be correct"):
// photo_spots is the one category whose normal fill pipeline is structurally
// broken. The quick-action path has the model propose poetic names ("Republic
// Square Illuminated Fountains") and verifies them against Google Places — but
// photo spots are VIEWS, not businesses, and views have no Places entry, so
// they drop as unresolved placeholders and Yerevan sits at 3 destinations
// while restaurants sit at 40. This starves the itinerary photo-decoration
// pass shipped 2026-09-04 (live builds attached 0/1, 0/3, 0/1 — pool of 1-3).
//
// The seed uses sources whose native unit IS "a place people photograph":
//   1. OSM Overpass  tourism=viewpoint (+ observation towers): real, named,
//      coordinated spots — with name:hy / name:ru where mapped. ODbL.
//   2. Wikimedia Commons geosearch around each spot: geotagged-photo COUNT is
//      empirical "people photograph here" evidence (ranks candidates), and the
//      best freely-licensed file becomes the spot's one image. Armenia is
//      unusually strong here via Wiki Loves Monuments.
//   3. Nominatim reverse geocode for the address line (spots rarely have one;
//      the district string is what the card's region line shows anyway).
//
// Invariants respected (CLAUDE.md):
//   - only SOURCED data — nothing model-named; unnamed viewpoints become
//     "Viewpoint – <locality>" from the geocoder, never an invented name.
//   - source + licence carried: every record stores image licence + author;
//     CC0/PD images preferred, CC-BY(-SA) accepted with the credit appended to
//     the description ("Photo: <author>, Wikimedia Commons, <licence>") so the
//     attribution is user-visible without schema changes.
//   - polite fetching: identifying User-Agent, sequential calls, throttled.
//   - human gate: --apply inserts isActive:false; staff review in admin and
//     flip on. DRY-RUN by default; the review JSON is the validation worksheet.
//
// Deliberately self-contained: no existing file is modified, no new deps
// (axios + mongoose already ship). Images are the Commons THUMB URL in
// images[0] — the explore/proximity paths use images[0] directly, so serving
// needs no PlaceCache work. Mirroring binaries into storage can reuse
// scripts/mirrorLegacyImages.js later if hotlinking ever bothers us.

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Destination = require('../models/Destination');

const UA = 'JinniTravel/1.0 (photo-spot seeding; contact via jinni.travel)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const arg = (name, dflt) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

// Small built-in gazetteer so the common runs need no coordinates typed.
const CITIES = {
    Yerevan:     { lat: 40.1792, lng: 44.4991, radiusKm: 12, region: 'Yerevan',  country: 'Armenia' },
    Gyumri:      { lat: 40.7894, lng: 43.8475, radiusKm: 8,  region: 'Shirak',   country: 'Armenia' },
    Dilijan:     { lat: 40.7417, lng: 44.8631, radiusKm: 10, region: 'Tavush',   country: 'Armenia' },
    Tsaghkadzor: { lat: 40.5321, lng: 44.7161, radiusKm: 8,  region: 'Kotayk',   country: 'Armenia' },
    Sevan:       { lat: 40.5559, lng: 44.9518, radiusKm: 12, region: 'Gegharkunik', country: 'Armenia' },
};

const city     = arg('city', 'Yerevan');
const base     = CITIES[city] || {};
const LAT      = parseFloat(arg('lat', base.lat));
const LNG      = parseFloat(arg('lng', base.lng));
const RADIUS   = parseFloat(arg('radius', base.radiusKm || 10));
const MIN_PHOTOS = parseInt(arg('min-photos', '3'), 10);   // Commons evidence floor
const LIMIT    = parseInt(arg('limit', '80'), 10);

if (!Number.isFinite(LAT) || !Number.isFinite(LNG)) {
    console.error(`Unknown city "${city}" — pass --lat= and --lng= (and optionally --radius=km).`);
    process.exit(1);
}

// ── 1. OSM Overpass: the inventory ──────────────────────────────────────────
async function fetchOsmViewpoints() {
    const q = `
[out:json][timeout:60];
(
  node["tourism"="viewpoint"](around:${RADIUS * 1000},${LAT},${LNG});
  way["tourism"="viewpoint"](around:${RADIUS * 1000},${LAT},${LNG});
  node["man_made"="observation_tower"](around:${RADIUS * 1000},${LAT},${LNG});
);
out center tags;`;
    const res = await axios.post('https://overpass-api.de/api/interpreter', q, {
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' }, timeout: 90000,
    });
    return (res.data.elements || []).map(el => ({
        osmId: `${el.type}/${el.id}`,
        lat: el.lat ?? el.center?.lat,
        lng: el.lon ?? el.center?.lon,
        name: el.tags?.['name:en'] || el.tags?.name || null,
        nameHy: el.tags?.['name:hy'] || null,
        nameRu: el.tags?.['name:ru'] || null,
        osmTags: { tourism: el.tags?.tourism, man_made: el.tags?.man_made },
    })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

// ── 2. Wikimedia Commons: evidence + the one image ──────────────────────────
const FREE_RE = /public domain|cc0|cc[- ]by(?![^-])|cc[- ]by[- ]sa/i;   // PD/CC0/CC-BY/CC-BY-SA
const licenceRank = (l) => /public domain|cc0/i.test(l) ? 0 : /cc[- ]by(?!.*sa)/i.test(l) ? 1 : 2;

async function commonsAround(lat, lng, radiusM = 250) {
    const url = 'https://commons.wikimedia.org/w/api.php';
    const geo = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000, params: {
        action: 'query', format: 'json', list: 'geosearch', gsnamespace: 6,
        gscoord: `${lat}|${lng}`, gsradius: radiusM, gslimit: 50,
    }});
    const files = geo.data?.query?.geosearch || [];
    if (!files.length) return { count: 0, image: null };

    // One follow-up call for the whole batch: sizes + licence + author + EXIF time.
    const info = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000, params: {
        action: 'query', format: 'json', prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata', iiurlwidth: 1280,
        pageids: files.map(f => f.pageid).join('|'),
    }});
    const pages = Object.values(info.data?.query?.pages || {});
    const candidates = pages.map(p => {
        const ii = p.imageinfo?.[0]; if (!ii) return null;
        const meta = ii.extmetadata || {};
        const licence = meta.LicenseShortName?.value || '';
        if (!FREE_RE.test(licence)) return null;               // only free licences
        // mime needs iiprop=mime; belt-and-braces fall back to the extension.
        const mime = ii.mime || '';
        const looksImage = /^image\/(jpe?g|png|webp)/.test(mime) || /\.(jpe?g|png|webp)$/i.test(p.title || '');
        if (!looksImage) return null;
        return {
            title: p.title,
            thumbUrl: ii.thumburl || ii.url,
            width: ii.width, height: ii.height,
            licence,
            author: (meta.Artist?.value || '').replace(/<[^>]*>/g, '').trim().slice(0, 120),
            captured: meta.DateTimeOriginal?.value || null,
        };
    }).filter(Boolean);
    candidates.sort((a, b) =>
        licenceRank(a.licence) - licenceRank(b.licence) || (b.width * b.height) - (a.width * a.height));
    return { count: files.length, image: candidates[0] || null };
}

// ── 3. Nominatim: the address line ──────────────────────────────────────────
async function reverseGeocode(lat, lng) {
    try {
        const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            headers: { 'User-Agent': UA }, timeout: 20000,
            params: { format: 'jsonv2', lat, lon: lng, zoom: 16, 'accept-language': 'en' },
        });
        const a = res.data?.address || {};
        const locality = a.suburb || a.neighbourhood || a.village || a.town || a.city_district || a.city || null;
        const line = [a.road, locality].filter(Boolean).join(', ') || res.data?.display_name?.split(',').slice(0, 2).join(',') || null;
        return { address: line, locality };
    } catch (e) { return { address: null, locality: null }; }
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`📸 Photo-spot seed — ${city} (${LAT}, ${LNG}, r=${RADIUS}km)  ${has('apply') ? 'APPLY' : 'DRY-RUN'}`);

    const spots = await fetchOsmViewpoints();
    console.log(`OSM viewpoints/towers found: ${spots.length}`);

    const out = [];
    for (const s of spots.slice(0, LIMIT)) {
        await sleep(300);                                       // politeness across all three APIs
        const { count, image } = await commonsAround(s.lat, s.lng).catch(() => ({ count: 0, image: null }));
        await sleep(1100);                                      // Nominatim: max 1 req/s
        const geo = await reverseGeocode(s.lat, s.lng);
        // Unnamed viewpoints: road+locality keeps siblings distinct
        // ("Viewpoint – Kentron" x3 collided in the first live run).
        const name = s.name || (geo.address ? `Viewpoint – ${geo.address}` : (geo.locality ? `Viewpoint – ${geo.locality}` : null));
        const rec = {
            name, nameHy: s.nameHy, nameRu: s.nameRu,
            lat: s.lat, lng: s.lng, address: geo.address,
            photoEvidence: count, image,
            source: { osm: s.osmId, licence: 'ODbL (OpenStreetMap contributors)' },
            verdict: !name ? 'SKIP: no name resolvable'
                   : count < MIN_PHOTOS && !s.name ? `SKIP: weak evidence (${count} Commons photos)`
                   : !image ? 'REVIEW: no freely-licensed image'
                   : 'OK',
        };
        out.push(rec);
        console.log(`  ${rec.verdict.padEnd(38)} ${String(count).padStart(3)} 📷  ${name || s.osmId}`);
    }

    const ok = out.filter(r => r.verdict === 'OK');
    const review = out.filter(r => r.verdict.startsWith('REVIEW'));
    const file = path.join(__dirname, `photoSpots.${city}.${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify({ city, LAT, LNG, RADIUS, generated: new Date(), spots: out }, null, 2));
    console.log(`\n${ok.length} OK, ${review.length} need review, ${out.length - ok.length - review.length} skipped → ${file}`);

    if (!has('apply')) { console.log('DRY-RUN — review the JSON, then re-run with --apply.'); return; }

    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    let inserted = 0, dupes = 0;
    for (const r of ok) {
        // Dedupe: same-ish name OR anything already within ~120 m.
        const dLat = 0.0011, dLng = 0.0014;
        const existing = await Destination.findOne({
            $or: [
                { name: new RegExp(`^${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                { 'location.coordinates.lat': { $gte: r.lat - dLat, $lte: r.lat + dLat },
                  'location.coordinates.lng': { $gte: r.lng - dLng, $lte: r.lng + dLng } },
            ],
        }).select('_id name').lean();
        if (existing) { dupes++; console.log(`  ↷ exists (${existing.name}) — skipped: ${r.name}`); continue; }

        const credit = licenceRank(r.image.licence) === 0
            ? '' : `\n\nPhoto: ${r.image.author || 'Wikimedia Commons contributor'}, Wikimedia Commons, ${r.image.licence}.`;
        await Destination.create({
            name: r.name,
            type: ['photo_spots'],
            location: {
                city, region: base.region || null, country: base.country || null,
                coordinates: { lat: r.lat, lng: r.lng },
                address: r.address || null,
            },
            description: `A popular photo spot${r.address ? ` near ${r.address}` : ''}. ` +
                         `Documented by ${r.photoEvidence} geotagged photos on Wikimedia Commons.` + credit,
            images: [r.image.thumbUrl],
            pricing: { isFree: true },
            isActive: has('activate'),          // default false: staff flip on after review
        });
        inserted++;
        console.log(`  ＋ ${r.name}  (${r.photoEvidence} 📷, ${r.image.licence})`);
    }
    console.log(`\nInserted ${inserted} (isActive:${has('activate')}), skipped ${dupes} duplicates.`);
    await mongoose.disconnect();
})().catch(e => { console.error('seed failed:', e.message); process.exit(1); });
