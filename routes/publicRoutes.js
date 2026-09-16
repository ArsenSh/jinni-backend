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
const { priceTier, isPriceAction } = require('../services/priceTier');
// Same vocabulary the Discoveries page matches onboarding interests against.
const INTEREST_TAGS = new Set(['nature', 'family', 'romantic', 'art', 'cultural', 'history', 'adventure', 'relaxation', 'nightlife', 'food&drink']);

const EXPLORE_CATEGORIES = ['restaurants', 'hotels', 'historical', 'events', 'photo_spots', 'hidden_gems', 'shopping', 'activities'];
const CATEGORY_ORDER = ['restaurants', 'historical', 'hidden_gems', 'activities', 'photo_spots', 'shopping', 'hotels'];
// Founder 2026-09-17: "there is also Tavush and lots of other regions that
// the cache has verified locations" — a 50k-population bar left Dilijan and
// Ijevan out. Every settlement may now own a page; the LARGEST settlement
// whose population-based reach (gazetteer radiusForPopulation: village 5 km
// … metro 30 km) covers a place claims it, so a monastery near Dilijan goes
// to Dilijan, not to Yerevan. Six verified places make a page.
const CITY_MIN_PLACES = Number(process.env.PUBLIC_CITY_MIN_PLACES) || 6;
const CITY_MIN_POPULATION = Number(process.env.PUBLIC_CITY_MIN_POPULATION) || 1000;
const CITY_RADIUS_KM = Number(process.env.PUBLIC_CITY_RADIUS_KM) || 30;     // hard cap on any reach
const { radiusForPopulation } = require('../engine/geo/gazetteer');
const PER_CATEGORY = 24;
// Founder 2026-09-17: the public page says "checked by local validators", so
// by default ONLY validator-verified rows are published. Set
// PUBLIC_INCLUDE_VISIBLE=true to widen it to ordinary visible cache rows (the
// Discoveries rule) for a city that has too few verified places to get a page.
const VERIFIED_ONLY = String(process.env.PUBLIC_INCLUDE_VISIBLE || '').toLowerCase() !== 'true';
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
    // Founder 2026-09-17: Tsaghkadzor (1,200 people, 5 km reach) sits 6 km
    // from Hrazdan (52k, 15 km reach); "largest covering settlement wins"
    // handed every Tsaghkadzor place to Hrazdan. So: the NEAREST settlement
    // whose reach covers the place claims it, and a settlement that cannot
    // reach the page minimum on its own folds its places into the most
    // populous settlement that also covers them (a hamlet next to a city
    // never steals the city's page; a real resort town keeps its own).
    const keyOf = (c) => `${c.name}|${c.countryCode || ''}`;
    const byCity = new Map();     // key → { city, rows: [{ row, km, fallback }] }
    for (const r of rows) {
        const loc = r.details.geometry.location;
        let nearest = null, nearKm = radiusKm, biggest = null, bigPop = -1, bigKm = radiusKm;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            for (const c of grid.get(`${Math.floor(loc.lat) + dy}:${Math.floor(loc.lng) + dx}`) || []) {
                const km = haversineKm(loc.lat, loc.lng, c.lat, c.lng);
                if (km > radiusKm || km > radiusForPopulation(c.population)) continue;   // outside this settlement's reach
                if (km < nearKm) { nearKm = km; nearest = c; }
                const pop = c.population || 0;
                if (pop > bigPop || (pop === bigPop && km < bigKm)) { bigPop = pop; bigKm = km; biggest = c; }
            }
        }
        if (!nearest) continue;
        const key = keyOf(nearest);
        if (!byCity.has(key)) byCity.set(key, { city: nearest, rows: [] });
        byCity.get(key).rows.push({ row: r, km: nearKm, fallback: biggest && biggest !== nearest ? { city: biggest, km: bigKm } : null });
    }
    // Fold clusters under the minimum into their fallback settlement.
    for (const [key, cl] of [...byCity.entries()]) {
        if (cl.rows.length >= minPlaces) continue;
        for (const m of cl.rows) {
            if (!m.fallback) continue;
            const fk = keyOf(m.fallback.city);
            if (!byCity.has(fk)) byCity.set(fk, { city: m.fallback.city, rows: [] });
            byCity.get(fk).rows.push({ row: m.row, km: m.fallback.km, fallback: null });
        }
        byCity.delete(key);
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

// ── Owned rows: validator Destinations and partner Businesses (founder
//    2026-09-17: "it is pure cache, add destination and businesses"). Both
//    carry their OWN photos and words, so they are the safest thing to
//    publish. Shaped like a cache row so the same clustering/visibility
//    code runs; `_owned` carries what the card and More window need. ──
const OWNED_CATS = new Set(['restaurants', 'hotels', 'historical', 'hidden_gems', 'activities', 'photo_spots']);
const SHOP_TYPES = new Set(['souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food']);
const normName = (n) => String(n || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function ownedRow(d, source) {
    const lat = d?.location?.coordinates?.lat, lng = d?.location?.coordinates?.lng;
    if (!d?.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const types = Array.isArray(d.type) ? d.type.map(t => String(t).toLowerCase()) : [];
    const actions = [...new Set(types.filter(t => OWNED_CATS.has(t)).concat(types.some(t => SHOP_TYPES.has(t)) ? ['shopping'] : []))];
    if (!actions.length) return null;                       // events are dated, not places; untyped rows have no rail
    const images = (Array.isArray(d.images) ? d.images : []).map(i => (typeof i === 'string' ? i : i?.url)).filter(u => typeof u === 'string' && u);
    if (!images.length) return null;                        // a public card needs a photo the visitor can see
    let hours = null;
    try { const { scheduleToWeekdayText } = require('../engine/context/contextEngine'); hours = Array.isArray(d.openingHours?.days) && d.openingHours.days.length || d.openingHours?.is24Hours ? scheduleToWeekdayText(d.openingHours) : null; } catch (_) { hours = null; }
    const desc = d.description && typeof d.description === 'object' ? (d.description.short || d.description.detailed || null) : (d.description || null);
    return {
        placeId: `${source === 'business' ? 'biz' : 'dest'}_${d._id}`,
        name: d.name,
        rating: Number.isFinite(d.rating) ? d.rating : (Number.isFinite(d.engagement?.rating) ? d.engagement.rating : null),
        actions,
        interests: types.filter(t => INTEREST_TAGS.has(t)),
        // Owned rows have no Google price level; the validator's luxury/budget tag stands in.
        _styleTier: types.includes('luxury') ? 4 : types.includes('budget') ? 1 : null,
        explore: { status: 'verified' },
        photos: images.map(u => ({ url: u })),
        details: { geometry: { location: { lat, lng } }, formatted_address: d.location?.address || null, vicinity: d.location?.city || null },
        _owned: {
            source,
            tier: source === 'business' ? (d.partnership?.tier || 'verified') : null,
            images, description: desc || null,
            website: d.contact?.website || null, phone: d.contact?.phone || null, hours,
            address: d.location?.address || [d.location?.city, d.location?.country].filter(Boolean).join(', ') || null,
        },
    };
}

function cardOf(r, km) {
    const hasImage = Array.isArray(r.photos) && r.photos.length > 0;
    return {
        placeId: r.placeId,
        name: r.name,
        rating: Number.isFinite(r.rating) ? r.rating : null,
        image: r._owned ? r._owned.images[0] : (hasImage ? `/api/ai/place-image/${r.placeId}/0` : null),
        photoCount: hasImage ? r.photos.length : 0,
        photos: r._owned ? r._owned.images : undefined,     // owned rows ship their own gallery URLs
        source: r._owned ? r._owned.source : 'cache',
        tier: r._owned ? r._owned.tier : null,               // verified | spotlight | signature — businesses only
        region: r.details?.vicinity || r.details?.formatted_address || null,
        distanceKm: Math.round(km * 10) / 10,
        verified: (r.explore?.status || 'visible') === 'verified',
        // Founder 2026-09-17: the public page gets the onboarding filters
        // (interests, style, budget) — these two fields are what they read.
        interests: (r.interests || []).map(t => String(t).toLowerCase()).filter(t => INTEREST_TAGS.has(t)),
        priceTier: r._owned ? r._styleTier : priceTier(r.types, r.primaryType, r.priceLevel).tier,
        priced: (r.actions || []).some(isPriceAction),
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
    }).select('placeId name rating actions likes dislikes explore aiBlocked business_status photos.url interests types primaryType priceLevel details.geometry.location details.vicinity details.formatted_address').lean())
        .filter(publicVisible)
        .filter(r => !VERIFIED_ONLY || r.explore?.status === 'verified');
    // Owned rows join the same pool; a cache row with the same name as an
    // owned one is dropped so the owned photo and words win.
    let owned = [];
    try {
        const Destination = require('../models/Destination');
        const Business = require('../models/Business');
        const [dests, bizs] = await Promise.all([
            Destination.find({ isActive: { $ne: false }, 'location.coordinates.lat': { $type: 'number' }, 'images.0': { $exists: true } })
                .select('name type images location rating engagement description contact openingHours').lean(),
            Business.find({ status: 'active', 'location.coordinates.lat': { $type: 'number' }, 'images.0': { $exists: true } })
                .select('name type images location rating engagement description contact openingHours partnership').lean(),
        ]);
        owned = [...dests.map(d => ownedRow(d, 'destination')), ...bizs.map(b => ownedRow(b, 'business'))].filter(Boolean);
    } catch (err) { console.warn(`[public] owned rows unavailable: ${err.message} — cache only`); }
    const ownedNames = new Set(owned.map(o => normName(o.name)));
    const cacheRows = rows.filter(r => !ownedNames.has(normName(r.name)));
    const pool = [...owned, ...cacheRows];
    let cities = [];
    try {
        const GeoName = require('../models/GeoName');
        // PPLX = a section of a city (Kentron, Arabkir…). GeoNames lists
        // Yerevan's districts as populated places above 50k, so places were
        // split among them and the landing listed districts, not cities
        // (founder 2026-09-17). Only whole settlements may own a page.
        cities = await GeoName.find({ kind: 'city', population: { $gte: CITY_MIN_POPULATION },
                                      featureCode: { $nin: ['PPLX', 'PPLQ', 'PPLW', 'PPLH'] } })
            .select('name asciiName lat lng countryCode countryName population').lean();
    } catch (err) { console.warn(`[public] gazetteer unavailable: ${err.message} — no city pages`); }
    const clusters = clusterCities(pool, cities);
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
    console.log(`[public] discovery snapshot (${VERIFIED_ONLY ? 'verified only' : 'visible + verified'}): ${cacheRows.length} cache + ${owned.length} owned place(s) → ${snap.cities.length} city page(s)${snap.cities.length ? ` (${snap.cities.map(c => `${c.name} ${c.count}`).join(', ')})` : ''}`);
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
        // Cloudflare stamps the visitor's country on every request; the
        // landing lists that country's cities first (founder 2026-09-17:
        // "what if a user from the Emirates enters?"). Per-visitor, so the
        // response must not be cached by a shared proxy.
        const visitorCountry = String(req.headers['cf-ipcountry'] || '').toUpperCase().slice(0, 2) || null;
        res.set('Cache-Control', 'private, max-age=300');
        res.json({ success: true, cities: s.cities, visitorCountry: /^[A-Z]{2}$/.test(visitorCountry || '') ? visitorCountry : null, builtAt: s.builtAt });
    } catch (err) {
        console.error('[public cities] error:', err);
        res.status(500).json({ success: false, error: 'Failed to load cities' });
    }
});

router.get('/discover/place/:placeId', async (req, res) => {
    try {
        const id = String(req.params.placeId).slice(0, 200);
        const m = /^(dest|biz)_([a-f0-9]{24})$/.exec(id);
        if (m) {
            const Model = m[1] === 'biz' ? require('../models/Business') : require('../models/Destination');
            const d = await Model.findById(m[2]).select('name type images location rating engagement description contact openingHours partnership status isActive').lean();
            const o = d && (m[1] === 'biz' ? d.status === 'active' : d.isActive !== false) ? ownedRow(d, m[1] === 'biz' ? 'business' : 'destination') : null;
            if (!o) return res.status(404).json({ success: false, error: 'Place not found' });
            cacheHeader(res);
            return res.json({ success: true, data: { name: o.name, address: o._owned.address, rating: o.rating, hours: o._owned.hours,
                website: o._owned.website, phone: o._owned.phone, description: o._owned.description, photos: o._owned.images, tier: o._owned.tier, source: o._owned.source } });
        }
        const r = await PlaceCache.findOne({ placeId: String(req.params.placeId).slice(0, 200) })
            .select('placeId name rating explore aiBlocked business_status likes dislikes website formatted_phone_number opening_hours.weekday_text details.formatted_address details.vicinity details.geometry.location photos.url').lean();
        if (!r || !publicVisible(r) || (VERIFIED_ONLY && r.explore?.status !== 'verified')) return res.status(404).json({ success: false, error: 'Place not found' });
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
        // Live USD-based rates so the page's budget filter can read any
        // currency the onboarding offers. Fail-open: no rates → USD only.
        let rates = null;
        try { const cs = require('../services/currencyService'); rates = (cs.getCurrentRates ? cs.getCurrentRates() : cs.getExchangeRates?.())?.rates || null; } catch (_) { rates = null; }
        cacheHeader(res);
        res.json({ success: true, ...page, rates, builtAt: s.builtAt });
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
// For scripts/publicCoverage.js (read-only diagnostics on the server).
module.exports._internals = { buildSnapshot, publicVisible, clusterCities, ownedRow, EXPLORE_CATEGORIES, CITY_MIN_PLACES, CITY_MIN_POPULATION, CITY_RADIUS_KM, VERIFIED_ONLY };
