// The owned gazetteer — GeoNames (CC BY 4.0) seeded into our own Mongo.
//
// WHY THIS EXISTS (analysis 2026-09-01): v2 paid Google twice per turn for
// facts that never change. `destination._geocode` spent a Places TEXT SEARCH
// — one of the priciest SKUs, drawing on the same 10k/mo free quota that real
// place searches need — just to learn that Yerevan is at 40.18,44.51. And
// `region.resolveRegion` spent a Geocoding reverse call up to 3× per turn to
// learn which city a coordinate sits in. Both are gazetteer lookups.
//
// It also carries the two things Google's response does NOT have and which the
// radius logic needs: POPULATION (Google cannot tell a village from a city —
// both come back as `locality`) and a country→cities expansion, so a
// country-scale ask can be searched where the cities actually are instead of
// at the country's geometric centre.
//
// Licence note: GeoNames is CC BY 4.0 — attribution required, commercial use
// permitted, and crucially NO share-alike. OSM-derived gazetteers (Nominatim,
// Photon, Pelias) are ODbL, whose share-alike on derived databases is a real
// question for a commercial place corpus. That is why this is GeoNames.
const mongoose = require('mongoose');

const GeoNameSchema = new mongoose.Schema({
    geonameId: { type: Number, required: true, unique: true },

    // What the entry IS. `scale` is the field the radius logic reads; `kind`
    // stays separate because a future admin2/village split would change kind
    // without changing how wide we search.
    kind:  { type: String, enum: ['country', 'region', 'city'], required: true },
    scale: { type: String, enum: ['country', 'region', 'town'], required: true },

    name: { type: String, required: true },
    asciiName: { type: String, default: null },

    // Lowercased search keys — name, asciiName, and (when seeded with --alt)
    // GeoNames alternate names. Multikey-indexed, EXACT match only: a miss
    // falls through to Google, which is the only layer that should be doing
    // fuzzy matching or resolving venue names.
    names: { type: [String], default: [] },

    countryCode: { type: String, default: null },   // ISO-2, e.g. 'AM'
    countryName: { type: String, default: null },   // 'Armenia' — what reverse geocode returns
    admin1: { type: String, default: null },        // GeoNames admin1 code, e.g. '11'
    featureCode: { type: String, default: null },   // PPLC, PPLA, PPL, ADM1, PCLI…

    // The whole point of keeping the population column: a flat radius is wrong
    // for an 800-person village AND for Dubai. See engine/geo/gazetteer.js.
    population: { type: Number, default: 0 },

    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // GeoJSON for $near. Countries and regions carry the coordinates of their
    // capital / largest city, because a country's geometric centre is a point
    // in the countryside that answers nothing (Armenia's lands near Lake
    // Sevan, ~47 km from Yerevan — the bug that started this work).
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: undefined },   // [lng, lat]
    },

    source: { type: String, default: 'geonames' },
    seededAt: { type: Date, default: Date.now },
}, { collection: 'geonames' });

// Forward lookup: exact name → entry, best population first.
GeoNameSchema.index({ names: 1, population: -1 });
// Reverse lookup: nearest city to a coordinate.
GeoNameSchema.index({ location: '2dsphere' });
// Country → its main cities (the country-scale expansion).
GeoNameSchema.index({ countryCode: 1, kind: 1, population: -1 });

module.exports = mongoose.models.GeoName || mongoose.model('GeoName', GeoNameSchema);
