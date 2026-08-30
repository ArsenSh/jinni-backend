const mongoose = require('mongoose');

const contentPartSchema = new mongoose.Schema({
  type: { type: String, enum: ['text', 'recommendation'], required: true },
  content: String,
  index: Number
}, { _id: false });

// Clarifier chip shown on an AI "What are you shopping for?" message.
// labelKey is an i18n key (e.g. 'chat.shopping.souvenirs') so the chip label
// localises on render; subType is what gets sent to the quick-action endpoint.
const shoppingOptionSchema = new mongoose.Schema({
  subType:  String,
  labelKey: String
}, { _id: false });

const recommendationSchema = new mongoose.Schema({
  id: String,
  name: String,
  category: String,
  type: String,
  description: String,
  image: String,
  address: String,
  location: String,
  distance: String,
  rating: Number,
  placeId: String,
  // Coordinates for the recommendation map. Without these declared here,
  // Mongoose strips them on save and the map vanishes on reloaded sessions.
  latitude: Number,
  longitude: Number,
  website: String,
  phone: String,
  photos: [String],
  verifiedId: String,
  partnerTier: String,
  // 'business' | 'destination' — which collection verifiedId points to.
  // Destinations must NOT get the partner badge; without persisting this the
  // frontend's "is it a destination?" check dies on reload and every
  // verifiedId rec falls back to a wrong "Jinni Verified" label.
  _verifiedModel: String,
  // Event-specific fields. Only set for recommendations whose business
  // type includes 'events'; null/absent for everything else. Persisted so
  // the rec card's date/time row still renders after a session is reloaded
  // from history (without this, Mongoose would strip the fields on save).
  eventSchedule: {
    startDate: Date,
    endDate: Date,
    isRecurring: Boolean
  },
  // true when a non-recurring event's end (or start) is already in the past
  _isExpired: { type: Boolean, default: false },
  // The listing page the event's date was read from (visityerevan.am, tkt.am,
  // ticket-am.com…). Powers the card's "check the listing" link, which is how a
  // user verifies a date we cannot verify ourselves — so it has to survive a
  // reload, or the date outlives the evidence for it.
  sourceUrl: String,
  // An event is not a place: it keeps its own name and borrows the venue's
  // geography. venueName is where it is held; venuePlaceId is the venue's Google
  // id, deliberately NOT copied into placeId (identity everywhere in this app
  // keys on placeId, so sharing it would make disliking an event suppress the
  // venue itself).
  venueName: String,
  venuePlaceId: String,
  // Which fields came from the source listing rather than the model's recall,
  // e.g. { startDate: 'listing', image: 'listing' }. Mixed because the key set
  // grows as more fields become source-verified.
  provenance: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Action this rec was produced under — a quick-action ('events', 'hotels', …)
  // or the type detected from a chat message ('restaurants', …, 'general').
  // Echoed back by the client on like/dislike so the vote lands in PlaceFeedback
  // under the right action. Without this declared, Mongoose strips it on save
  // and a vote cast on a RELOADED session's card loses its action scope.
  _action: { type: String, default: null },
  // 'like' | 'dislike' | null  — last state only, null means no feedback / toggled off
  feedback: { type: String, enum: ['like', 'dislike', null], default: null }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  id: String,
  sender: { type: String, enum: ['user', 'ai'], required: true },
  text: String,
  timestamp: { type: Date, default: Date.now }, // ✅ always set on message creation
  streaming: Boolean,
  isChatRecommendation: Boolean,
  actionType: String,
  // Sub-type for actions that ask a follow-up question before searching.
  // Currently only 'shopping' uses it (e.g. 'souvenirs', 'crafts', 'clothing',
  // 'market', 'mall', 'jewelry'). Persisted so a reloaded session can run
  // "View More" with the SAME sub-type instead of falling back to generic shops.
  subType: String,
  // Clarifier chips shown on an AI message ("What are you shopping for?").
  // Each entry is { subType, labelKey }. Persisted so the chips still render
  // after a session is reloaded from history.
  shoppingOptions: [shoppingOptionSchema],
  quickActions: [String],
  // Id of a generated itinerary rendered on this AI message. Stored so a
  // reloaded session restores the trip from the Itinerary collection (via GET
  // /api/itinerary/:id) instead of regenerating it. Without this declared,
  // Mongoose strips it on save and the itinerary vanishes on reload.
  itineraryId: String,
  recommendations: [recommendationSchema],
  viewMoreCount: Number,
  isViewMore: Boolean,
  isLoadingMore: Boolean,
  contentParts: [contentPartSchema],
  // 'like' | 'dislike' | null  — last state only, null means no feedback / toggled off
  feedback: { type: String, enum: ['like', 'dislike', null], default: null }
});

const chatSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: String,
  // The conversation's current destination ("restaurants in Pafos" → Pafos).
  // Written whenever a message names a place; read as the search center for
  // follow-up turns that don't repeat the name ("compare the first two…"),
  // so the session stays correctly centered with ZERO extra Google calls,
  // works before any recommendation cards exist, and survives reloads.
  // One open "shall I change your saved preference?" question, waiting for the
  // traveler's answer on the NEXT turn. Cleared the moment they answer either
  // way — Jinni asks once and does not nag (Arsen 2026-08-24).
  pendingPrefChange: {
    field:    { type: String, default: null },
    value:    { type: mongoose.Schema.Types.Mixed, default: null },
    label:    { type: String, default: null },
    askedAt:  { type: Date, default: null },
  },
  activeDestination: {
    name: String,
    latitude: Number,
    longitude: Number,
    placeId: String,
    // Whether the town was named ALONE in the ask that set it — the v2
    // named-town radius cap reads this on refill turns. Absent on old
    // sessions ⇒ no cap (the pre-2026-08-31 behavior).
    singleTown: Boolean,
    updatedAt: Date
  },
  messages: [messageSchema],
  isNearLimit: { type: Boolean, default: false },
  suggestedNewChat: { type: Boolean, default: false },
  // ✅ createdAt & updatedAt removed — managed automatically by timestamps: true
}, { timestamps: true });

module.exports = mongoose.model('ChatSession', chatSessionSchema);