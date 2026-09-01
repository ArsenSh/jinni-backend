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
        const rows = await _guard(Model.find({ names: key })
            .sort({ population: -1 })
            .limit(10)
            .lean());
        if (!rows || !rows.length) return null;

        // Countries and regions outrank cities on an exact name tie ("Armenia"
        // the country, not some village of the same name), then population.
        const rank = { country: 0, region: 1, city: 2 };
        let best = [...rows].sort((a, b) =>
            (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) || (b.population || 0) - (a.population || 0))[0];

        // Same name, several real cities (Springfield, Tripoli): prefer the one
        // nearest the traveler — but only among cities, so a nearby village can
        // never outrank the country the name actually denotes.
        if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
            const cities = rows.filter(r => r.kind === 'city' && r.lat != null);
            if (cities.length > 1 && best.kind === 'city') {
                best = cities.reduce((a, b) =>
                    _km(near.lat, near.lng, a.lat, a.lng) <= _km(near.lat, near.lng, b.lat, b.lng) ? a : b);
            }
        }
        return _toGeo(best);
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
async function regionAt({ lat, lng } = {}, { maxKm = 120 } = {}, deps = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const Model = _pick(deps);
    if (!Model) return null;
    try {
        const rows = await _guard(Model.find({
            kind: 'city',
            location: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] },
                                 $maxDistance: maxKm * 1000 } },
        }).limit(1).lean());
        const near = (rows || [])[0];
        if (!near) return null;
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
    normalizeName, isSeeded, TYPES_BY_KIND, _toGeo, _km,
};
