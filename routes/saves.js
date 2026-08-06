/**
 * routes/saves.js
 *
 * Mount in your main app:
 *   const savesRouter = require('./routes/saves');
 *   app.use('/api/saves', authMiddleware, savesRouter);
 *
 * Endpoints:
 *   GET    /api/saves              — list user's saved places (paginated)
 *   POST   /api/saves              — save a place
 *   DELETE /api/saves/:id          — unsave by SavedPlace _id
 *   GET    /api/saves/check/:ref   — check if a place is saved
 */

const express    = require('express');
const router     = express.Router();
const mongoose   = require('mongoose');
const SavedPlace = require('../models/SavedPlace');
const Analytics  = require('../models/Analytics');
const Business   = require('../models/Business');

// ── Live event-schedule re-hydration ─────────────────────────────────────────
//
//  A SavedPlace stores a snapshot frozen at save-time. For events that is a
//  problem: an owner can later edit the event (recurring → one-time, change
//  the date/time, change the timezone), and the saved card would keep showing
//  the old schedule — e.g. "Weekly" for an event that is now a single Saturday
//  gig. For events specifically, a stale schedule is genuinely harmful: a
//  traveler could turn up on the wrong day.
//
//  So whenever we return saved places, we overwrite the event fields of any
//  saved VERIFIED BUSINESS event with the current values from the live
//  Business document. One indexed batch query covers the whole page. Saves
//  that point at Google places (no DB record) keep their snapshot as-is —
//  there is no live source to read from.
//
//  Mutates the lean `saves` array in place.
async function rehydrateEventSchedules(saves) {
    // Candidates: any save with a verifiedId that looks like an event. We do
    // NOT hard-require verifiedModel === 'business' because some older saves
    // were stored with a null verifiedModel; instead we test the snapshot for
    // event-ness and let the Business lookup below naturally no-op if the id
    // turns out to be a Destination (Destinations have no eventSchedule).
    const eventSaves = saves.filter(s => {
        if (!s.verifiedId) return false;
        if (s.verifiedModel === 'destination') return false;   // definitely not an event
        const snap = s.snapshot || {};
        if (snap.eventSchedule && snap.eventSchedule.startDate) return true;
        const cat = String(snap.category || snap.type || '').toLowerCase();
        return cat === 'event' || cat === 'events';
    });
    if (!eventSaves.length) return;

    // One query for every candidate's live Business doc.
    const ids = [...new Set(eventSaves.map(s => String(s.verifiedId)))];
    let liveById;
    try {
        const live = await Business.find({ _id: { $in: ids } })
            .select('eventSchedule type')
            .lean();
        liveById = new Map(live.map(b => [String(b._id), b]));
    } catch (err) {
        // Re-hydration is best-effort — on failure the stale snapshot still
        // renders, which is better than failing the whole saved-places list.
        console.error('rehydrateEventSchedules error:', err);
        return;
    }

    for (const s of eventSaves) {
        const biz = liveById.get(String(s.verifiedId));
        if (!biz) continue;   // business deleted — leave the snapshot untouched
        const sched = biz.eventSchedule || null;
        s.snapshot = s.snapshot || {};
        // Overwrite with the live schedule (includes timezone). null when the
        // listing somehow lost its eventSchedule.
        s.snapshot.eventSchedule = sched
            ? {
                startDate:   sched.startDate   || null,
                endDate:     sched.endDate     || null,
                isRecurring: !!sched.isRecurring,
                timezone:    sched.timezone    || 'UTC'
              }
            : null;
        // Recompute _isExpired from the live schedule — same rule as
        // Business.isEventExpired(): a non-recurring event whose end (or start,
        // if no end) is in the past. Recurring events never expire.
        if (sched && !sched.isRecurring) {
            const end = sched.endDate || sched.startDate;
            s.snapshot._isExpired = end
                ? new Date(end).getTime() < Date.now()
                : false;
        } else {
            s.snapshot._isExpired = false;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/saves
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const userId = req.user._id;
        const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
        const before = req.query.before ? new Date(req.query.before) : null;

        const query = { userId };
        if (before) query.savedAt = { $lt: before };

        const saves = await SavedPlace.find(query)
            .sort({ savedAt: -1 })
            .limit(limit + 1)
            .lean();

        const hasMore = saves.length > limit;
        if (hasMore) saves.pop();

        // Refresh event schedules from the live Business docs so saved cards
        // never show a stale schedule for an event the owner has since edited.
        await rehydrateEventSchedules(saves);

        res.json({
            success: true,
            data: saves,
            pagination: {
                hasMore,
                nextCursor: hasMore ? saves[saves.length - 1].savedAt.toISOString() : null,
                count: saves.length
            }
        });
    } catch (err) {
        console.error('GET /api/saves error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch saved places' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/saves/check/:ref
// :ref is either a 24-hex Mongo ObjectId (verifiedId) or a Google placeId.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/check/:ref', async (req, res) => {
    try {
        const userId = req.user._id;
        const ref    = req.params.ref;
        const isObjectId = mongoose.Types.ObjectId.isValid(ref) && ref.length === 24;

        const query = isObjectId
            ? { userId, verifiedId: ref }
            : { userId, googlePlaceId: ref };

        const saved = await SavedPlace.findOne(query).select('_id').lean();
        res.json({ success: true, isSaved: !!saved, savedId: saved?._id || null });
    } catch (err) {
        console.error('GET /api/saves/check error:', err);
        res.status(500).json({ success: false, message: 'Check failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/saves
//
// Body (JSON):
//   {
//     verifiedId?:    string,   // 24-hex Mongo id (Business._id or Destination._id)
//     verifiedModel?: string,   // 'business' | 'destination'
//     googlePlaceId?: string,   // Google Places id (non-DB places)
//     snapshot: {
//       name, category, type, description,
//       image, address, location, distance, rating, website, partnerTier,
//       eventSchedule?, _isExpired?   // events only
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const userId = req.user._id;
        const { verifiedId, verifiedModel, googlePlaceId, snapshot } = req.body;

        if (!verifiedId && !googlePlaceId) {
            return res.status(400).json({ success: false, message: 'verifiedId or googlePlaceId required' });
        }
        if (!snapshot?.name) {
            return res.status(400).json({ success: false, message: 'snapshot.name is required' });
        }

        // Upsert — silently deduplicate if already saved
        const matchQuery = verifiedId
            ? { userId, verifiedId }
            : { userId, googlePlaceId };

        // Normalize the event schedule. The sub-schema defines
        // snapshot.eventSchedule as a nested object, so we set its leaf
        // paths individually rather than assigning a whole object to a
        // dotted path (which Mongoose can mis-cast). Non-events → all null.
        const es = snapshot.eventSchedule || null;
        const esStart      = es?.startDate   != null ? new Date(es.startDate) : null;
        const esEnd        = es?.endDate     != null ? new Date(es.endDate)   : null;
        const esRecurring  = es?.isRecurring != null ? !!es.isRecurring       : null;
        const esTimezone   = es?.timezone    || null;

        const update = {
            $setOnInsert: {
                userId,
                verifiedId:    verifiedId    || null,
                verifiedModel: verifiedModel || null,
                googlePlaceId: googlePlaceId || null,
                'snapshot.name':        snapshot.name,
                'snapshot.category':    snapshot.category    || null,
                'snapshot.type':        snapshot.type        || null,
                'snapshot.description': snapshot.description || '',
                'snapshot.image':       snapshot.image       || '',
                'snapshot.address':     snapshot.address     || '',
                'snapshot.location':    snapshot.location    || '',
                'snapshot.distance':    snapshot.distance    || '',
                'snapshot.rating':      snapshot.rating      || null,
                'snapshot.website':     snapshot.website     || '',
                'snapshot.partnerTier': snapshot.partnerTier || null,
                // Event-specific. Persisted so the saved-places panel can show
                // the event date/time without re-fetching. null for non-events.
                'snapshot.eventSchedule.startDate':   esStart,
                'snapshot.eventSchedule.endDate':     esEnd,
                'snapshot.eventSchedule.isRecurring': esRecurring,
                'snapshot.eventSchedule.timezone':    esTimezone,
                'snapshot._isExpired':    snapshot._isExpired    || false,
                savedAt: new Date()
            }
        };

        const result = await SavedPlace.findOneAndUpdate(matchQuery, update, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        });

        // ── Analytics (non-blocking) ──────────────────────────────────────────
        Analytics.create({
            type: 'place_interaction',
            userId,
            metadata: {
                action:        'place_saved',
                verifiedId:    verifiedId    || null,
                verifiedModel: verifiedModel || null,
                googlePlaceId: googlePlaceId || null,
                placeName:     snapshot.name,
                category:      snapshot.category
            }
        }).catch(() => {});

        // ── Increment Business.analytics.saves ────────────────────────────────
        // Use verifiedId directly — don't rely on verifiedModel being sent correctly from client.
        if (verifiedId) {
            const Business = require('../models/Business');
            Business.findByIdAndUpdate(verifiedId, { $inc: { 'analytics.saves': 1 } }).catch(() => {});
        }

        res.status(201).json({ success: true, data: result });
    } catch (err) {
        console.error('POST /api/saves error:', err);
        res.status(500).json({ success: false, message: 'Failed to save place' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/saves/:id
// Ownership is enforced — users can only delete their own saves.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.user._id;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }

        const deleted = await SavedPlace.findOneAndDelete({ _id: id, userId });

        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Saved place not found' });
        }

        // Decrement Business.analytics.saves
        if (deleted.verifiedId) {
            const Business = require('../models/Business');
            Business.findByIdAndUpdate(deleted.verifiedId, {
                $inc: { 'analytics.saves': -1 }
            }).catch(() => {});
        }

        // ── Analytics (non-blocking) ──────────────────────────────────────────
        Analytics.create({
            type: 'place_unsaved',
            userId,
            metadata: {
                action:        'place_unsaved',
                verifiedId:    deleted.verifiedId    || null,
                verifiedModel: deleted.verifiedModel || null,
                googlePlaceId: deleted.googlePlaceId || null,
                placeName:     deleted.snapshot?.name || null,
                category:      deleted.snapshot?.category || null
            }
        }).catch(() => {});

        res.json({ success: true, message: 'Unsaved' });
    } catch (err) {
        console.error('DELETE /api/saves/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to unsave place' });
    }
});

module.exports = router;