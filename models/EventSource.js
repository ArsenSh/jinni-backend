// EventSource — the curated registry of event-listing pages (Arsen
// 2026-08-23: "i can give urls for yerevan, validator also, can give page
// urls and name each page one … if there are 8 sources for instance in the
// location needed claude will not fill that database").
//
// Validators/admins register named URLs per city or per country. The events
// hunt reads registered sources DIRECTLY (free fetches, no paid web search);
// web search remains only the automatic fallback for locations nobody has
// curated yet. The nightly sweep reads every enabled source with patient
// timeouts so the shelf is warm before anyone asks.

const mongoose = require('mongoose');

const eventSourceSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },       // "Tomsarkgh", "AllEvents Yerevan"
    url: { type: String, required: true, trim: true },
    // city null ⇒ country-wide source; country null ⇒ city-only match.
    city: { type: String, default: null, trim: true },
    country: { type: String, default: null, trim: true },
    enabled: { type: Boolean, default: true },
    // Reserved for per-site adapters (Arsen 2026-08-23: "we can write tools
    // for differnet type of websites to fetch data") — names a specialized
    // parser for this site; null ⇒ the generic reader.
    adapter: { type: String, default: null, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Yield tracking — a source that reads 0 events night after night is
    // visibly dead in the staff list instead of silently missing.
    lastReadAt: { type: Date, default: null },
    lastFoundCount: { type: Number, default: null },
}, { timestamps: true });

eventSourceSchema.index({ enabled: 1, city: 1, country: 1 });
eventSourceSchema.index({ url: 1, city: 1 }, { unique: true });

module.exports = mongoose.models.EventSource || mongoose.model('EventSource', eventSourceSchema);
