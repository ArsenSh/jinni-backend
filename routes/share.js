// ─────────────────────────────────────────────────────────────────────────────
// routes/share.js
// ─────────────────────────────────────────────────────────────────────────────
const express  = require('express');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const router   = express.Router();

// ── Mongoose schema ───────────────────────────────────────────────────────────
const ShareSchema = new mongoose.Schema({
  token:     { type: String, unique: true, index: true },
  payload:   mongoose.Schema.Types.Mixed,   // { type, rec?, message?, recommendations?, contentParts?, itinerary?, theme }
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }, // 24 hour TTL
});
const Share = mongoose.model('Share', ShareSchema);

// ── Public-endpoint hardening ─────────────────────────────────────────────────
// POST /api/share is intentionally unauthenticated (the app creates shares
// without a token), and the repo is open source, so the endpoint is guessable.
// A small in-memory limiter caps abuse without adding a dependency that could
// break the server if it's missing. For a multi-instance deploy, swap this for
// express-rate-limit backed by Redis.
const RL_WINDOW_MS = 60 * 1000;   // 1 minute
const RL_MAX       = 12;          // share links per IP per window
const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB stored payload ceiling
const rlHits = new Map();         // ip -> [timestamps]

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();
}
function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (rlHits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    return res.status(429).json({ error: 'Too many share links created. Please wait a minute and try again.' });
  }
  hits.push(now);
  rlHits.set(ip, hits);
  next();
}
// Periodically drop stale IP buckets so the map can't grow unbounded.
const rlSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rlHits) {
    const keep = arr.filter(t => now - t < RL_WINDOW_MS);
    if (keep.length) rlHits.set(ip, keep); else rlHits.delete(ip);
  }
}, RL_WINDOW_MS);
rlSweep.unref?.();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Snapshot a Place sub-object down to the fields the public share view renders.
// Mirrors PlaceSchema in models/Itinerary.js. Relative image paths
// ('/api/ai/place-image/<id>/0') still resolve on the share page since it's
// served from the same origin.
function pickPlace(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    placeId:     p.placeId     ?? null,
    name:        p.name        ?? null,
    image:       p.image       ?? null,
    latitude:    p.latitude    ?? null,
    longitude:   p.longitude   ?? null,
    location:    p.location    ?? null,
    region:      p.region      ?? null,
    website:     p.website     ?? null,
    phone:       p.phone       ?? null,
    rating:      p.rating      ?? null,
    description: p.description ?? null,
  };
}

// Freeze a client-sent itinerary into a self-contained, sanitized snapshot.
// Whitelist only — strips userId / _id / timestamps and any unexpected fields,
// and caps days at the model's max (14) so a public payload can't be inflated.
function sanitizeItinerary(it) {
  if (!it || typeof it !== 'object') return null;

  const days = (Array.isArray(it.days) ? it.days : []).slice(0, 14).map((d) => ({
    dayNumber: d.dayNumber,
    title:     d.title || '',
    slots: (Array.isArray(d.slots) ? d.slots : []).map((s) => ({
      slotId:   s.slotId,
      order:    s.order,
      time:     s.time ?? null,
      name:     s.name,
      category: s.category || 'hidden_gems',
      note:     s.note || '',
      locked:   !!s.locked,
      status:   s.status || 'enriched',
      place:    pickPlace(s.place),
    })),
  }));

  return {
    title: it.title || '',
    destination: {
      name: it.destination?.name || '',
      lat:  it.destination?.lat ?? null,
      lng:  it.destination?.lng ?? null,
    },
    startDate:  it.startDate ?? null,
    daysCount:  it.daysCount ?? days.length,
    pace:       it.pace || 'balanced',
    interests:  Array.isArray(it.interests) ? it.interests : [],
    nearbyMode: !!it.nearbyMode,
    radiusKm:   it.radiusKm ?? null,
    homeBase:   pickPlace(it.homeBase),
    language:   it.language || 'en',
    status:     'ready',   // a share is always a finished, read-only trip
    days,
  };
}

// ── POST /api/share  ──────────────────────────────────────────────────────────
router.post('/', rateLimit, async (req, res) => {
  try {
    const { type, rec, message, recommendations, theme, contentParts, itinerary, language } = req.body;

    if (!type || !['recommendation', 'message', 'itinerary'].includes(type)) {
      return res.status(400).json({ error: 'Invalid share type' });
    }
    if (type === 'recommendation' && !rec?.name) {
      return res.status(400).json({ error: 'rec.name is required' });
    }
    if (type === 'message' && !message) {
      return res.status(400).json({ error: 'message text is required' });
    }
    if (type === 'itinerary') {
      if (!itinerary?.destination?.name || !Array.isArray(itinerary?.days) || itinerary.days.length === 0) {
        return res.status(400).json({ error: 'itinerary with a destination and at least one day is required' });
      }
    }

    const token = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const payload = { type, theme: theme || 'night-mode' };
    // Language the share opens in on the public page. Whitelisted to the app's
    // supported locales; anything else is dropped (JinniShare falls back to en).
    const SHARE_LOCALES = ['en', 'ru', 'ar', 'zh', 'fr'];
    if (SHARE_LOCALES.includes(language)) payload.language = language;

    if (type === 'recommendation') payload.rec = rec;
    if (type === 'message') {
      payload.message = message;
      payload.recommendations = (recommendations || []).slice(0, 10);
      // ✅ store contentParts to preserve interleaved text + inline rec cards
      if (contentParts && Array.isArray(contentParts)) { payload.contentParts = contentParts }
    }
    if (type === 'itinerary') {
      // ✅ store a sanitized, self-contained snapshot of the trip
      payload.itinerary = sanitizeItinerary(itinerary);
    }

    // Guard against oversized stored payloads (a public, unauthenticated write).
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'Share content is too large' });
    }

    await Share.create({ token, payload });
    return res.json({ token });
  } catch (err) {
    console.error('Share create error:', err);
    return res.status(500).json({ error: 'Could not create share link' });
  }
});

// ── GET /api/share/:token  ────────────────────────────────────────────────────
router.get('/:token', async (req, res) => {
  try {
    const share = await Share.findOne({ token: req.params.token }).lean();
    if (!share) return res.status(404).json({ error: 'Share not found or expired' });
    return res.json(share.payload);
  } catch (err) {
    console.error('Share fetch error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;