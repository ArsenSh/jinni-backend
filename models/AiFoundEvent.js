// models/AiFoundEvent.js
//
// Durable record of every DATED event the AI events pipeline actually served
// to a user. Events are deliberately never written to the places cache (an
// event is a moment in time, not a place), which until now meant AI-found
// events were ephemeral: streamed once and gone, invisible to validators.
// This collection is the human tier of the events trust ladder:
//
//   validator > feed > listing > extracted > model
//
// Every served event lands here as status 'new'. A validator can then:
//   • approve  → a validator Destination is created from it (top trust tier,
//                served like any curated event); doc keeps a pointer to it.
//   • hide     → permanent blocklist: the serving path drops any candidate
//                matching this identity, in any language, forever.
//   • dismiss  → delete the doc; the event may reappear if re-found.
//
// Identity is language-free (same rule as serve-time dedupe): placeId when the
// venue resolved, else rounded coords, else request city — plus the start DAY
// and the normalized name. Two users in two languages seeing the same concert
// produce ONE doc with timesShown=2.
//
// TTL: `expireAt` (start/end + grace) auto-cleans 'new' docs after the event
// passes — the validator queue never fills with dead events. Approving or
// hiding UNSETS expireAt, so moderated docs are permanent: an annual festival
// hidden once stays hidden next year.

const mongoose = require('mongoose');

const aiFoundEventSchema = new mongoose.Schema({
    // `${normalizedName}|${startDay}|${placeId || roundedCoords || city}`
    key:        { type: String, required: true, unique: true, index: true },
    name:        { type: String, required: true },
    description: { type: String, default: null },

    // Venue (whatever the venue-resolution pass produced; all optional)
    placeId:   { type: String, default: null },
    lat:       { type: Number, default: null },
    lng:       { type: Number, default: null },
    venueName: { type: String, default: null },
    address:   { type: String, default: null },

    // Request area at serve time — staff scope filtering (isWithinScope) and
    // the Explore merge both key off these.
    city:    { type: String, default: null },
    country: { type: String, default: null },

    startDate:   { type: Date, required: true },
    endDate:     { type: Date, default: null },
    isRecurring: { type: Boolean, default: false },

    // The image the card actually showed: the event's own poster (feed CDN
    // URL) when the source had one, else the venue photo proxy path.
    image:      { type: String, default: null },
    // Ticket price EXACTLY as the source printed it ("5000 AMD", "3000-10000
    // AMD", "Free") — verified to appear in that page's text before storing.
    // A price is a fact, so it may never come from model memory; null means the
    // page printed none (2026-08-24: tomsarkgh lists fixed and min/max prices).
    price:      { type: String, default: null },
    sourceUrl:  { type: String, default: null },
    // Provenance of the date, i.e. the trust tier it entered through.
    sourceTier: { type: String, enum: ['feed', 'listing', 'extracted', 'model', 'unknown'], default: 'unknown' },

    timesShown:  { type: Number, default: 1 },
    lastShownAt: { type: Date, default: Date.now },

    status: { type: String, enum: ['new', 'approved', 'hidden'], default: 'new', index: true },
    approvedDestinationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Destination', default: null },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // TTL — docs whose expireAt has passed are deleted by Mongo. Moderated
    // docs have this UNSET and live forever (see header).
    expireAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

// Serve-time blocklist + Explore merge both query "events near here".
aiFoundEventSchema.index({ lat: 1, lng: 1 });

module.exports = mongoose.model('AiFoundEvent', aiFoundEventSchema);
