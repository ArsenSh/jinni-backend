// LocalFact — owned answers to the questions travelers ask that have no place
// cards: how to get around, entry requirements, safety, money, connectivity.
// (Arsen 2026-08-23: "lets build wikivoyage and fcdo".)
//
// Every row is SOURCED. Two ingesters fill it today — Wikivoyage (practical
// city knowledge, CC BY-SA 4.0) and UK FCDO travel advice via the GOV.UK
// Content API (entry requirements + safety, Open Government Licence v3) — and
// validators may write or correct rows by hand, which is the top tier. Model
// memory is NEVER stored here: it is free to regenerate and might be wrong, so
// freezing it in would poison owned data with hallucination.
//
// Freshness is enforced, not hoped for: `reviewedAt` carries the SOURCE's own
// review date (FCDO publishes one) and `staleAfter` decides when an answer
// must be re-read instead of served.

const mongoose = require('mongoose');

const localFactSchema = new mongoose.Schema({
    // scope|topic — 'yerevan|armenia|get_around', 'armenia|entry_requirements'
    key: { type: String, required: true, unique: true, trim: true },
    city: { type: String, default: null, trim: true },      // null ⇒ country-wide
    country: { type: String, default: null, trim: true },
    // Open vocabulary, mirroring intent.infoAsk: get_around, entry_requirements,
    // safety, money, connect, health…
    topic: { type: String, required: true, trim: true },
    title: { type: String, default: null },
    body: { type: String, required: true },

    sourceName: { type: String, required: true },           // 'Wikivoyage', 'UK FCDO'
    sourceUrl: { type: String, required: true },
    license: { type: String, default: null },               // attribution is a licence duty
    tier: { type: String, enum: ['validator', 'fcdo', 'wikivoyage'], default: 'wikivoyage' },
    // FCDO entry rules are written for British passport holders; anything with
    // an audience caveat carries it so the answer can say so out loud.
    caveat: { type: String, default: null },

    reviewedAt: { type: Date, default: null },              // the SOURCE's review date
    fetchedAt: { type: Date, default: Date.now },
    staleAfter: { type: Date, default: null },              // never serve past this
    status: { type: String, enum: ['new', 'approved', 'hidden'], default: 'new' },
    timesServed: { type: Number, default: 0 },
    lastServedAt: { type: Date, default: null },
}, { timestamps: true });

localFactSchema.index({ city: 1, topic: 1, status: 1 });
localFactSchema.index({ country: 1, topic: 1, status: 1 });

module.exports = mongoose.models.LocalFact || mongoose.model('LocalFact', localFactSchema);
