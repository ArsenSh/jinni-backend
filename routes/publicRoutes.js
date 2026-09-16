// ── PUBLIC DISCOVERY (founder 2026-09-16) ────────────────────────────────────
// Read-only, login-free views of what Jinni already owns, so a search engine
// (and a shared link) can open a real page: /discover/<city> on the frontend
// reads these. Rules, all deliberate:
//   · CACHE ONLY. Nothing here ever calls Google. An open page that bought
//     details would let bots run up the bill — the SEO record (memory
//     jinni-seo-state) scoped it this way with the founder.
//   · OWNED DATA FIRST. Rows come from PlaceCache exactly as Jinni's
//     Discoveries shows them (same hide rules), minus anything personal:
//     no likes, no preference weighting, no partner pricing.
//   · The shop window, not the shop: names, category, photo, area, rating,
//     stored hours. Every action that needs Jinni goes to sign-up.
//
// Cities are DERIVED from the data, never hardcoded: a gazetteer city gets a
// page once enough approved places sit within its radius. The sitemap is
// generated from the same rule, so a newly filled city appears in search on
// its own.
const express = require('express');
const router = express.Router();
const PlaceCache = require('../models/PlaceCache');

const EXPLORE_CATEGORIES = ['restaurants', 'hotels', 'historical', 'events', 'photo_spots', 'hidden_gems', 'shopping', 'activities'];
const CATEGORY_ORDER = ['restaurants', 'historical', 'hidden_gems', 'activities', 'photo_spots', 'shopping', 'hotels'];
const CITY_MIN_PLACES = Number(process.env.PUBLIC_CITY_MIN_PLACES) || 12;   // a page with fewer reads thin
const CITY_MIN_POPULATION = Number(process.env.PUBLIC_CITY_MIN_POPULATION) || 50000;
const CITY_RADIUS_KM = Number(process.env.PUBLIC_CITY_RADIUS_KM) || 30;     // a city page, not a region
const PER_CATEGORY = 24;
const CACHE_MS = 60 * 60 * 1000;

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Same visibility rules as GET /api/ai/explore (aiRoutes): hidden never,
// community-buried never, low-rated never unless a validator verified it.
function publicVisible(r) {
    if (!r?.placeId) return false;
    const status = r.explore?.status || 'visible';
    if (status === 'hidden' || r.aiBlocked) return false;
    if (r.business_status && r.business_status !== 'OPERATIONAL') return false;
    const likes = r.likes || 0, dislikes = r.dislikes || 0;
    const hardHide = dislikes >= 3 && dislikes > likes * 2;
    const autoHide = (Number.isFinite(r.rating) && r.rating < 3.5) || (dislikes >= 2 && dislikes > likes);
    if (status !== 'verified' && (hardHide || autoHide)) return false;
    const loc = r.details?.geometry?.location;
    return !!(loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
}

function slugify(name) {
    return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Pure: assign every visible row to the nearest gazetteer city within
 * CITY_RADIUS_KM, then keep the cities that reach CITY_MIN_PLACES. A 1° grid
 * over the cities keeps this cheap (rows × nearby cells, not rows × world).
 * Two cities that produce the same slug keep the one with more places.
 */
function clusterCities(rows, cities, { radiusKm = CITY_RADIUS_KM, minPlaces = CITY_MIN_PLACES } = {}) {
    const grid = new Map();
    const cellOf = (lat, lng) => `${Math.floor(lat)}:${Math.floor(lng)}`;
    for (const c of cities) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
        const k = cellOf(c.lat, c.lng);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(c);
    }
    const byCity = new Map();     // city name+country → { city, rows }
    for (const r of rows) {
        const loc = r.details.geometry.location;
        let best = null, bestKm = radiusKm;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            for (const c of grid.get(`${Math.floor(loc.lat) + dy}:${Math.floor(loc.lng) + dx}`) || []) {
                const km = haversineKm(loc.lat, loc.lng, c.lat, c.lng);
                if (km < bestKm) { bestKm = km; best = c; }
            }
        }
        if (!best) continue;
        const key = `${best.name}|${best.countryCode || ''}`;
        if (!byCity.has(key)) byCity.set(key, { city: best, rows: [] });
        byCity.get(key).rows.push({ row: r, km: bestKm });
    }
    const bySlug = new Map();
    for (const { city, rows: members } of byCity.values()) {
        if (members.length < minPlaces) continue;
        const slug = slugify(city.asciiName || city.name);
        if (!slug) continue;
        const prev = bySlug.get(slug);
        if (prev && prev.rows.length >= members.length) continue;
        bySlug.set(slug, { slug, city, rows: members });
    }
    return [...bySlug.values()].sort((a, b) => b.rows.length - a.rows.length);
}

function cardOf(r, km) {
    const hasImage = Array.isArray(r.photos) && r.photos.length > 0;
    return {
        placeId: r.placeId,
        name: r.name,
        rating: Number.isFinite(r.rating) ? r.rating : null,
        image: hasImage ? `/api/ai/place-image/${r.placeId}/0` : null,
        photoCount: hasImage ? r.photos.length : 0,
        region: r.details?.vicinity || r.details?.formatted_address || null,
        distanceKm: Math.round(km * 10) / 10,
        verified: (r.explore?.status || 'visible') === 'verified',
    };
}

// ── One-hour in-memory snapshot of the whole public set ──
let _snap = null, _snapAt = 0, _building = null;
async function buildSnapshot() {
    const rows = (await PlaceCache.find({
        actions: { $in: EXPLORE_CATEGORIES },
        'explore.status': { $ne: 'hidden' },
        aiBlocked: { $ne: true },
        'photos.0': { $exists: true },
    }).select('placeId name rating actions likes dislikes explore aiBlocked business_status photos.url details.geometry.location details.vicinity details.formatted_address').lean())
        .filter(publicVisible);
    let cities = [];
    try {
        const GeoName = require('../models/GeoName');
        cities = await GeoName.find({ kind: 'city', population: { $gte: CITY_MIN_POPULATION } })
            .select('name asciiName lat lng countryCode countryName population').lean();
    } catch (err) { console.warn(`[public] gazetteer unavailable: ${err.message} — no city pages`); }
    const clusters = clusterCities(rows, cities);
    const snap = { cities: [], pages: new Map(), builtAt: new Date() };
    for (const cl of clusters) {
        const categories = {};
        for (const c of EXPLORE_CATEGORIES) categories[c] = [];
        // Verified first, then rating — no personal weighting on a public page.
        const ordered = cl.rows.slice().sort((a, b) =>
            (Number(b.row.explore?.status === 'verified') - Number(a.row.explore?.status === 'verified'))
            || ((b.row.rating || 0) - (a.row.rating || 0)));
        for (const { row, km } of ordered) {
            for (const c of row.actions || []) {
                if (categories[c] && categories[c].length < PER_CATEGORY && c !== 'events') categories[c].push(cardOf(row, km));
            }
        }
        for (const c of Object.keys(categories)) if (!categories[c].length) delete categories[c];
        const cover = ordered.find(m => Array.isArray(m.row.photos) && m.row.photos.length)?.row;
        const city = {
            slug: cl.slug, name: cl.city.name, country: cl.city.countryName || null, countryCode: cl.city.countryCode || null,
            lat: cl.city.lat, lng: cl.city.lng, count: cl.rows.length,
            image: cover ? `/api/ai/place-image/${cover.placeId}/0` : null,
        };
        snap.cities.push(city);
        snap.pages.set(cl.slug, { city, categories, order: CATEGORY_ORDER.filter(c => categories[c]) });
    }
    console.log(`[public] discovery snapshot: ${rows.length} place(s) → ${snap.cities.length} city page(s)${snap.cities.length ? ` (${snap.cities.map(c => `${c.name} ${c.count}`).join(', ')})` : ''}`);
    return snap;
}
async function snapshot() {
    if (_snap && Date.now() - _snapAt < CACHE_MS) return _snap;
    if (!_building) {
        _building = buildSnapshot().then(s => { _snap = s; _snapAt = Date.now(); return s; }).finally(() => { _building = null; });
    }
    // A stale snapshot beats a wait while the next one builds.
    return _snap || _building;
}

const cacheHeader = (res) => res.set('Cache-Control', 'public, max-age=300');

router.get('/discover/cities', async (req, res) => {
    try {
        const s = await snapshot();
        cacheHeader(res);
        res.json({ success: true, cities: s.cities, builtAt: s.builtAt });
    } catch (err) {
        console.error('[public cities] error:', err);
        res.status(500).json({ success: false, error: 'Failed to load cities' });
    }
});

router.get('/discover/place/:placeId', async (req, res) => {
    try {
        const r = await PlaceCache.findOne({ placeId: String(req.params.placeId).slice(0, 200) })
            .select('placeId name rating explore aiBlocked business_status likes dislikes website formatted_phone_number opening_hours.weekday_text details.formatted_address details.vicinity details.geometry.location photos.url').lean();
        if (!r || !publicVisible(r)) return res.status(404).json({ success: false, error: 'Place not found' });
        cacheHeader(res);
        res.json({ success: true, data: {
            name: r.name,
            address: r.details?.formatted_address || r.details?.vicinity || null,
            rating: Number.isFinite(r.rating) ? r.rating : null,
            hours: Array.isArray(r.opening_hours?.weekday_text) && r.opening_hours.weekday_text.length ? r.opening_hours.weekday_text : null,
            website: r.website || null,
            phone: r.formatted_phone_number || null,
            photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
        } });
    } catch (err) {
        console.error('[public place] error:', err);
        res.status(500).json({ success: false, error: 'Failed to load place' });
    }
});

router.get('/discover/:slug', async (req, res) => {
    try {
        const s = await snapshot();
        const page = s.pages.get(slugify(req.params.slug));
        if (!page) return res.status(404).json({ success: false, error: 'No public page for this city yet' });
        cacheHeader(res);
        res.json({ success: true, ...page, builtAt: s.builtAt });
    } catch (err) {
        console.error('[public city] error:', err);
        res.status(500).json({ success: false, error: 'Failed to load city' });
    }
});

// Referenced from the frontend's robots.txt (a sitemap may live on another
// host when robots.txt names it). URLs are the FRONTEND's city pages.
router.get('/sitemap.xml', async (req, res) => {
    try {
        const s = await snapshot();
        const base = String(process.env.FRONTEND_URL || 'https://jinni.travel').replace(/\/+$/, '');
        const day = s.builtAt.toISOString().slice(0, 10);
        const urls = s.cities.map(c => `  <url><loc>${base}/discover/${c.slug}</loc><lastmod>${day}</lastmod><changefreq>weekly</changefreq></url>`);
        res.set('Content-Type', 'application/xml; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
    } catch (err) {
        console.error('[public sitemap] error:', err);
        res.status(500).send('');
    }
});

module.exports = router;
module.exports._test = { clusterCities, publicVisible, slugify };
