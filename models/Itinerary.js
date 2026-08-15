const mongoose = require('mongoose');

/**
 * A persisted trip itinerary.
 *
 * Design notes:
 *  - Slots keep BOTH the AI-planned identity (name/category/time/note) and the
 *    enriched Google identity (`place`). Enrichment is asynchronous — a slot is
 *    born `pending`, becomes `enriched` when the PlaceCache/Google pipeline
 *    resolves it, or `failed` when nothing real could be matched (the UI then
 *    offers a one-tap "find replacement").
 *  - `slotId` is a stable string id so the frontend can PATCH individual slots
 *    while streaming is still in flight (array indexes shift; ids don't).
 *  - `locked: true` means "the user chose/kept this" — day regeneration must
 *    plan AROUND locked slots, never replace them.
 *  - Structural edits (reorder / remove / move) are plain CRUD on this
 *    document and never cost an AI call.
 */

const PlaceSchema = new mongoose.Schema({
  placeId:   { type: String, default: null },   // Google place_id
  // ── DB identity (verified Business / Destination stops) ─────────────────
  // Verified stops usually have NO Google placeId, so verifiedId is their
  // only saveable identity. Without these declared, Mongoose strips them on
  // save and the itinerary save ribbon vanishes for verified stops (the
  // ribbon is gated on place.verifiedId || place.placeId in ItineraryView).
  verifiedId:    { type: String, default: null },   // Business._id or Destination._id (string)
  verifiedModel: { type: String, enum: ['business', 'destination', null], default: null },
  partnerTier:   { type: String, default: null },   // 'verified' | 'spotlight' | 'signature' | null
  name:      { type: String, default: null },
  image:     { type: String, default: null },   // '/api/ai/place-image/<id>/0' or absolute URL
  latitude:  { type: Number, default: null },
  longitude: { type: Number, default: null },
  location:  { type: String, default: null },   // formatted address
  region:    { type: String, default: null },   // vicinity / short area label
  website:   { type: String, default: null },
  phone:     { type: String, default: null },
  rating:    { type: Number, default: null },
  // Review COUNT, not just the score. Both were available from the enrichment
  // pipeline and dropped on the floor; the count is what stops a
  // 4.9-from-3-reviews place outranking a 4.6-from-8000 one (see ratingScore
  // in itineraryRoutes.js). Absent on documents written before this field
  // existed — ratingScore treats that as "no signal", not "zero reviews".
  userRatingsTotal: { type: Number, default: null },
  // Google's weekday_text lines, e.g. ["Monday: 9:00 AM – 6:00 PM", …].
  openingHours: { type: [String], default: [] },
  description: { type: String, default: null },
  // Dated events (approved jinni-events, saved events) carry a real calendar
  // date + clock time so the itinerary can pin them to their ACTUAL day and
  // time instead of a scheduler-invented one (see pinDatedEvents). Absent on
  // ordinary places — the pin pass simply skips those.
  eventSchedule: {
    startDate:   { type: Date, default: null },
    endDate:     { type: Date, default: null },
    isRecurring: { type: Boolean, default: false },
    timezone:    { type: String, default: null },   // IANA zone the time is written in
  },
}, { _id: false });

const SlotSchema = new mongoose.Schema({
  slotId:   { type: String, required: true },
  order:    { type: Number, required: true },          // 0-based position within the day
  time:     { type: String, default: null },           // 'HH:MM' suggestion, freely editable
  name:     { type: String, required: true },          // AI-planned place name (pre-enrichment)
  category: { type: String, default: 'hidden_gems' },  // maps to quick-action ids for "replace"
  note:     { type: String, default: '' },             // one-line tip from the planner
  locked:   { type: Boolean, default: false },
  status:   { type: String, enum: ['pending', 'enriched', 'failed'], default: 'pending' },
  // WHY a slot failed — the UI said "couldn't verify this place exists" for
  // every failure, which is a lie for a duplicate (it was verified; it was
  // already on the trip) and for a geofence rejection (it exists, just in the
  // wrong city). 'unverified' | 'duplicate' | 'out_of_area' | null.
  failedReason: { type: String, enum: ['unverified', 'duplicate', 'out_of_area', null], default: null },
  // 'like' | 'dislike' | null — the user's vote on this stop (last state only).
  // Mirrors the chat rec-card pattern; the slot-feedback route also syncs the
  // vote into PlaceFeedback so dislikes personalize future suggestions.
  feedback: { type: String, enum: ['like', 'dislike', null], default: null },
  place:    { type: PlaceSchema, default: null },
}, { _id: false });

const DaySchema = new mongoose.Schema({
  dayNumber: { type: Number, required: true },   // 1-based
  title:     { type: String, default: '' },      // e.g. "Old town & viewpoints"
  // Who wrote the title — decides whether edits may refresh it:
  //   'auto' → algorithmic (area/theme); recomputed when the day's stops change
  //   'ai'   → model-written theme; kept until the day is regenerated
  //   'user' → typed by the traveler; never touched automatically
  titleSource: { type: String, enum: ['auto', 'ai', 'user'], default: 'auto' },
  slots:     { type: [SlotSchema], default: [] },
}, { _id: false });

const ItinerarySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  destination: {
    name: { type: String, required: true },      // "Yerevan, Armenia"
    lat:  { type: Number, required: true },
    lng:  { type: Number, required: true },
  },

  startDate: { type: Date, default: null },      // optional — "3 days sometime" is valid
  daysCount: { type: Number, required: true, min: 1, max: 14 },
  pace:      { type: String, enum: ['relaxed', 'balanced', 'packed'], default: 'balanced' },
  interests: { type: [String], default: [] },

  // Planning geofence. Nearby mode stores the user's compact nearby radius;
  // Discovery stores the wider one. Reused by day regeneration so a Nearby
  // trip stays compact when a day is replanned.
  nearbyMode: { type: Boolean, default: false },
  radiusKm:   { type: Number, default: 60 },

  // Optional anchor (hotel / apartment). Days start and end here when set.
  homeBase: { type: PlaceSchema, default: null },

  days: { type: [DaySchema], default: [] },

  // generating → skeleton exists, enrichment in flight (server restart mid-way
  // leaves this state; the GET endpoint downgrades stale 'generating' docs to
  // 'ready' so the UI never spins forever).
  status:   { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' },
  language: { type: String, default: 'en' },
  title:    { type: String, default: '' },       // display title, editable
}, {
  timestamps: true,
  // Every write here is read-modify-write on the whole document, and day
  // regeneration holds a doc across ~10s of AI + enrichment before saving it.
  // Without a version check, any edit made in that window was silently
  // erased. Now the losing writer gets a VersionError and the caller can
  // re-read and retry instead of losing the user's work.
  optimisticConcurrency: true,
});

ItinerarySchema.index({ userId: 1, updatedAt: -1 });

/** All Google placeIds currently used anywhere in this itinerary (dedupe guard). */
ItinerarySchema.methods.allPlaceIds = function () {
  const ids = [];
  for (const day of this.days) for (const s of day.slots) if (s.place?.placeId) ids.push(s.place.placeId);
  return ids;
};

/** All slot names (planned or enriched) — used to tell the model what to avoid. */
ItinerarySchema.methods.allNames = function () {
  const names = [];
  for (const day of this.days) for (const s of day.slots) names.push(s.place?.name || s.name);
  return names;
};

module.exports = mongoose.model('Itinerary', ItinerarySchema);