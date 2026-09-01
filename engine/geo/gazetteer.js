// Owned gazetteer lookups — the local answer to "where is X" and "what city
// is this", so Google is a FALLBACK for the one thing it alone can do:
// resolve a VENUE name. See models/GeoName.js for why this exists.
//
// Engine rules (ENGINE.md §3): no express, no req/res. Every export takes an
// injectable `deps.model` so the whole module is jest-testable with no Mongo.
//
// FAIL-OPEN EVERYWHERE. A missing collection, an unseeded server or a broken
// query returns null — never throws — because every caller's next line is the
// Google path that works today. Adding this must not be able to break a turn.

const _model = () => require('../../models/GeoName');

// ── Two guards, both learned the hard way on the first test run (2026-09-01) ──
// Fail-open is only fail-open if it fails FAST. An unconnected mongoose does
// not reject: it BUFFERS the query for 10s and only then throws. Falling back
// to Google after a ten-second stall is worse than never having tried, so:
//   1. skip entirely unless the connection is actually up, and
//   2. race every query against a short deadline in case it is up but stuck.
const GUARD_MS = 1500;

// GeoNames feature codes that are NOT a city in their own right: sections of a
// populated place (Yerevan's Avan), subdivisions, and abandoned / destroyed /
// historical / religious entries. Excluded from reverse geocoding.
const SUBPLACE_CODES = ['PPLX', 'PPLL', 'PPLR', 'PPLQ', 'PPLW', 'PPLH', 'PPLCH', 'PPLF'];

function _ready() {
    try { return require('mongoose').connection?.readyState === 1; } catch { return false; }
}

/** The real model when Mongo is up, an injected one in tests, else null. */
function _pick(deps) {
    if (deps && deps.model) return deps.model;
    return _ready() ? _model() : null;
}

const _guard = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`query exceeded ${GUARD_MS}ms`)), GUARD_MS);
        if (typeof t.unref === 'function') t.unref();
    }),
]);

// Google-compatible type strings, so `isGeographic()` in context/destination.js
// and anything else reading `.types` keeps working unchanged whether the geo
// came from here or from Google.
const TYPES_BY_KIND = {
    country: ['country', 'political'],
    region:  ['administrative_area_level_1', 'political'],
    city:    ['locality', 'political'],
};

/** Search keys are matched exactly, so both sides must normalize the same way:
 *  case-folded, accents stripped, punctuation dropped. "T'bilisi" → "tbilisi". */
function normalizeName(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        // Apostrophes are DELETED, never turned into a separator: GeoNames
        // stores "Tbilisi", so "T'bilisi" → "t bilisi" would never match it.
        // (Caught by the first test run, 2026-09-01.) Everything else that is
        // not a letter or digit collapses to one space, so multi-word names
        // like "New York" keep their word boundary.
        .replace(/['’‘`´ʼ]/g, '')
        .replace(/[^a-z0-9Ѐ-ӿ԰-֏؀-ۿ一-鿿]+/gu, ' ')
        .trim();
}

/** A place's population → how wide to search around it, in km.
 *
 *  The flat 15 km cap this replaces was wrong at BOTH ends: too wide for
 *  Dilijan (~17k, the original complaint — 20–31 km regional places bled into
 *  the deck) and far too tight for a metro like Dubai. An unknown population
 *  keeps the old 15 km, so anything the gazetteer cannot size behaves exactly
 *  as it does today. Pure. */
function radiusForPopulation(population) {
    const p = Number(population) || 0;
    if (!p) return 15;              // unknown → today's behaviour, unchanged
    if (p < 5000) return 5;         // village
    if (p < 50000) return 10;       // small town (Dilijan lands here)
    if (p < 300000) return 15;      // mid city (Gyumri)
    if (p < 1500000) return 20;     // large city (Yerevan)
    return 30;                      // metro (Dubai, Istanbul)
}

const _km = (aLat, aLng, bLat, bLng) => {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
};

/** Rows → the shape `context/destination._geocode` already returns, so the
 *  caller cannot tell a local hit from a Google one except by `.source`. */
function _toGeo(doc) {
    if (!doc || doc.lat == null || doc.lng == null) return null;
    return {
        lat: doc.lat,
        lng: doc.lng,
        name: doc.name,
        placeId: null,                       // gazetteer rows have no Google place id
        types: TYPES_BY_KIND[doc.kind] || TYPES_BY_KIND.city,
        // Extras Google cannot give us — the reason this module exists.
        scale: doc.scale,
        population: doc.population || 0,
        countryCode: doc.countryCode || null,
        countryName: doc.countryName || null,
        source: 'gazetteer',
    };
}

/**
 * Forward lookup: a place NAME → coordinates, scale and population.
 *
 * Exact-match only. A miss is not a failure — it is evidence, and the caller
 * treats it as "Google's problem": either a venue ("Nairi", a restaurant) or a
 * spelling the gazetteer does not carry. Never guess here; a fuzzy gazetteer
 * hit that silently re-centres the search is worse than a paid Google call.
 *
 * @param {string} name
 * @param {{near?: {lat,lng}|null}} [opts]  disambiguates same-named places
 * @returns {Promise<object|null>} the _toGeo shape, or null
 */
async function lookupPlace(name, { near = null } = {}, deps = {}) {
    const key = normalizeName(name);
    if (!key) return null;
    const Model = _pick(deps);
    if (!Model) return null;
    try {
        // ── TIERED, not one population-sorted query (bug found live on the
        //    first seeded server, 2026-09-01) ──
        // Countries are seeded with population 0, so a single
        // `.sort({population:-1}).limit(10)` put "Armenia" the COUNTRY below
        // Armenia, Colombia (~300k) and every other populated namesake — and
        // the limit could drop it before any in-memory ranking ran. A country
        // ask would have re-centred on Colombia.
        //
        // The order is country → city → region:
        //  · an exact country name is unambiguous, so it wins outright;
        //  · CITY beats REGION because admin regions routinely share their
        //    capital's name (Yerevan, Moscow, Tashkent), and "hotels in
        //    Yerevan" means the city — resolving it as a region would also
        //    skip the town radius sizing entirely.
        const asCountry = await _guard(Model.find({ names: key, kind: 'country' }).limit(1).lean());
        if (asCountry && asCountry[0]) return _toGeo(asCountry[0]);

        const cities = await _guard(Model.find({ names: key, kind: 'city' })
            .sort({ population: -1 }).limit(10).lean());
        if (cities && cities.length) {
            let best = cities[0];
            // Same name, several real cities: prefer the one nearest the
            // traveler — but only among cities of COMPARABLE size. Nearest
            // alone would answer "Paris" with Paris, Texas (~25k) for a
            // traveler in the US; the 20% floor keeps that from outranking
            // Paris, France while still letting genuine local ties resolve
            // by distance.
            if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng) && cities.length > 1) {
                const floor = (cities[0].population || 0) * 0.2;
                const viable = cities.filter(c => c.lat != null && (c.population || 0) >= floor);
                if (viable.length > 1) {
                    best = viable.reduce((a, b) =>
                        _km(near.lat, near.lng, a.lat, a.lng) <= _km(near.lat, near.lng, b.lat, b.lng) ? a : b);
                }
            }
            return _toGeo(best);
        }

        const asRegion = await _guard(Model.find({ names: key, kind: 'region' }).limit(1).lean());
        return (asRegion && asRegion[0]) ? _toGeo(asRegion[0]) : null;
    } catch (err) {
        console.warn(`[gazetteer] lookup "${name}" failed: ${err.message} — falling back`);
        return null;
    }
}

/**
 * Reverse lookup: a coordinate → the city and country it sits in.
 * Shape matches what googleService.detectUserRegion returns, minus `region`,
 * which nothing in the v2 path reads.
 *
 * `maxKm` guards the open sea and the empty desert: the nearest settlement to
 * a mid-ocean coordinate can be hundreds of km away, and naming it would be a
 * confident lie. Past the limit we return null and Google gets the call.
 *
 * @returns {Promise<{city, country, countryCode, distanceKm}|null>}
 */
async function regionAt({ lat, lng } = {}, { maxKm = 30, mergeKm = 12 } = {}, deps = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const Model = _pick(deps);
    if (!Model) return null;
    try {
        const rows = await _guard(Model.find({
            kind: 'city',
            // Sections, subdivisions and abandoned/historical entries are never
            // the answer to "what city is this".
            featureCode: { $nin: SUBPLACE_CODES },
            location: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] },
                                 $maxDistance: maxKm * 1000 } },
        }).limit(5).lean());
        if (!rows || !rows.length) return null;

        // ── Nearest is not the same as RIGHT (live 2026-09-01) ──
        // Standing in Yerevan, the nearest gazetteer entry was "Avan" — one of
        // the city's own districts, which GeoNames carries as its own row.
        // Google said "Yerevan", and Yerevan is the true answer: the label
        // reaches the model as "you are in X" and is appended to fallback
        // search queries, so a district name is both a small lie and a worse
        // query ("best places to visit Armenia Avan"). Among entries within
        // mergeKm of each other, the most POPULOUS one is the city; a genuinely
        // separate town further out still wins on its own, because it is the
        // only candidate in range.
        let near = rows[0];
        for (const r of rows) {
            if (r.lat == null) continue;
            if (_km(lat, lng, r.lat, r.lng) <= mergeKm
                && (r.population || 0) > (near.population || 0)) near = r;
        }
        return {
            city: near.name,
            country: near.countryName || null,
            countryCode: near.countryCode || null,
            distanceKm: near.lat != null ? _km(lat, lng, near.lat, near.lng) : null,
        };
    } catch (err) {
        console.warn(`[gazetteer] regionAt failed: ${err.message} — falling back`);
        return null;
    }
}

/**
 * A country (or region) → the cities worth searching in it.
 *
 * This is the honest answer to "best places to visit in Armenia": no single
 * radius covers a country, so the search runs at each of these centres at town
 * scale and the results merge. Ordered by population, the closest free proxy
 * we have for "where a traveler would actually go".
 *
 * @returns {Promise<Array<{name, lat, lng, population, radiusKm}>>} (never throws)
 */
async function mainCities(countryCode, { limit = 4, minPopulation = 5000 } = {}, deps = {}) {
    if (!countryCode) return [];
    const Model = _pick(deps);
    if (!Model) return [];
    try {
        const rows = await _guard(Model.find({
            countryCode: String(countryCode).toUpperCase(),
            kind: 'city',
            population: { $gte: minPopulation },
        }).sort({ population: -1 }).limit(Math.max(1, limit)).lean());
        return (rows || [])
            .filter(r => r.lat != null && r.lng != null)
            .map(r => ({
                name: r.name, lat: r.lat, lng: r.lng,
                population: r.population || 0,
                radiusKm: radiusForPopulation(r.population),
            }));
    } catch (err) {
        console.warn(`[gazetteer] mainCities(${countryCode}) failed: ${err.message}`);
        return [];
    }
}

/** Is the gazetteer seeded on this server? For logging and the seed script's
 *  own reporting only — callers must NOT gate on it, because fail-open already
 *  covers an empty collection. */
async function isSeeded(deps = {}) {
    const Model = _pick(deps);
    if (!Model) return false;
    try { return (await _guard(Model.estimatedDocumentCount())) > 0; } catch { return false; }
}

module.exports = {
    lookupPlace, regionAt, mainCities, radiusForPopulation,
    normalizeName, isSeeded, TYPES_BY_KIND, SUBPLACE_CODES, _toGeo, _km,
};
