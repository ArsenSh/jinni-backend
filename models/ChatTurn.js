// One record per V2 chat turn — the engine's own flight recorder.
//
// WHY (2026-08-26): every fact needed to steer the engine is already printed by
// the `[v2]` console line, and every one of them is unqueryable. Reading a day
// of Coolify output by hand answered "what happened in this turn" and could
// never answer "what happens in turns". So a live decision — where to put the
// relevance floor — came down to three data points typed by hand, which is not
// a measurement.
//
// This stores exactly what that log line prints, as fields. The questions it
// exists to answer:
//
//   • what share of deck turns end with evidence 'none'?  → the floor sets itself
//   • which asks buy a Google search, and how often?      → cost, and the
//                                                           person-seeking leak
//   • which branch actually fires?                        → is the router right
//   • p95 ms per branch?                                  → the 8–24s event hunts
//   • tokensEst vs tokensActual?                          → limits are charged on
//                                                           the estimate
//
// NOT AN ANALYTICS EVENT. models/Analytics.js records what the TRAVELER did
// (clicked, saved, shared); this records what the ENGINE decided. Mixing them
// would put diagnostics into the collection the admin charts aggregate.
//
// PRIVACY: the message itself is never stored — only its length and the signals
// derived from it. A turn log that quietly became a transcript archive would be
// a different thing from the one anyone agreed to. Rows self-delete after 90
// days (the PlaceView TTL precedent): long enough for a trend, short enough that
// this never becomes a permanent record of anyone's questions.

const mongoose = require('mongoose');

const TTL_DAYS = 90;

const chatTurnSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    sessionId: { type: String, default: null },
    at: { type: Date, default: Date.now },

    // ── Which answer the router chose ──
    // The branches of /chat-stream-v2, first-match-wins. 'error' is included
    // deliberately: a turn that threw is exactly the kind nobody sees.
    branch: {
        type: String,
        enum: ['deck', 'no_match', 'empty', 'transport', 'settings', 'tool', 'chitchat', 'no_centre', 'error'],
        index: true,
    },

    // ── What was asked, without storing what was said ──
    askLen: { type: Number, default: 0 },
    lang: { type: String, default: null },
    category: { type: String, default: null },   // null = the 'free' query that opens every gate
    subType: { type: String, default: null },
    refill: { type: Boolean, default: false },

    // ── Whether ANYTHING about the ask constrained the result set ──
    // The reason this collection exists. 'none' means no category and no text
    // match: the deck is then "places near you", which is not an answer.
    evidence: { type: String, enum: ['none', 'category', 'text', 'category+text'], default: 'none', index: true },
    lexical: { type: Number, default: 0 },        // candidates with a BM25 hit
    lexicalTop: { type: Number, default: 0 },     // best BM25 score
    lexicalShare: { type: Number, default: 0 },   // hits / candidates — a HIGH share is a
                                                  // warning, not comfort: a term matching most
                                                  // of the corpus describes the corpus
    vector: { type: Boolean, default: false },
    taste: { type: Boolean, default: false },
    candidateCount: { type: Number, default: 0 },
    shown: { type: Number, default: 0 },

    // ── Where, and how far ──
    mode: { type: String, default: null },         // nearby | discovery
    radiusKm: { type: Number, default: null },
    centreSource: { type: String, default: null }, // gps | named | here | session | saved | none
    city: { type: String, default: null },

    // ── What the turn spent ──
    googleCalls: { type: Number, default: 0 },
    huntFired: { type: Boolean, default: false },
    cacheHit: { type: Boolean, default: false },
    provider: { type: String, default: null },
    tokensEst: { type: Number, default: 0 },
    tokensActual: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },

    // Mongo deletes the row once this passes.
    expireAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: false });

// The three shapes of question this is for: trend over time, per-branch
// behaviour, and "show me the turns where nothing matched".
chatTurnSchema.index({ at: -1 });
chatTurnSchema.index({ branch: 1, at: -1 });
chatTurnSchema.index({ evidence: 1, at: -1 });

/**
 * Record one turn. FIRE-AND-FORGET by contract: never awaited, never able to
 * fail a reply. A diagnostics write that can break the thing it measures is
 * worse than no diagnostics — the engine's own fail-open rule, applied to
 * itself.
 */
chatTurnSchema.statics.record = function record(doc = {}) {
    try {
        const at = doc.at instanceof Date ? doc.at : new Date();
        this.create({ ...doc, at, expireAt: new Date(at.getTime() + TTL_DAYS * 24 * 3600 * 1000) })
            .catch(err => console.warn('[v2][turnlog] write failed:', err.message));
    } catch (err) {
        console.warn('[v2][turnlog] record error:', err.message);
    }
};

const ChatTurn = mongoose.model('ChatTurn', chatTurnSchema);
ChatTurn.TTL_DAYS = TTL_DAYS;

module.exports = ChatTurn;
