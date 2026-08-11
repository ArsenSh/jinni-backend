// ─────────────────────────────────────────────────────────────────────────────
//  eventCleanup.js — removes finished one-time event destinations
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHY DESTINATIONS ARE DELETED BUT BUSINESSES ARE NOT
//
//    A destination tagged 'events' is editorial content a validator added to
//    help the platform — a concert, a festival, a one-off happening. Once it
//    has happened it carries no further value: nobody owns it, nobody will
//    edit it, and it cannot be "rescheduled" into a new event the way a
//    business owner reworks their own listing. Leaving it behind only grows
//    the collection with dead rows.
//
//    An event BUSINESS is the opposite — a paid listing belonging to a real
//    owner. Those are frozen/expired via `status`, never deleted, so the owner
//    keeps their listing, their analytics and their ability to reschedule.
//    This sweep therefore touches the Destination collection only.
//
//  TIMEZONES
//
//    No timezone maths happens here, and that is correct rather than an
//    omission. eventSchedule.startDate / endDate are absolute UTC instants,
//    converted from the validator's wall-clock entry against the EVENT's own
//    zone at save time (see staffRoutes.normalizeEventSchedule). Comparing
//    those instants to `new Date()` is therefore already right for an event in
//    any country — a 20:00 concert in Auckland and one in Lisbon each expire
//    at their own local 20:00, because that difference is baked into the
//    stored instant.
//
//  TIMING
//
//    The sweep runs every minute with no grace period, so a finished event is
//    gone within a minute of ending. Travelers stop seeing it earlier still —
//    the instant it ends, enforced at query time by
//    proximityService.eventFreshnessClause(), which owes nothing to this sweep.
//
//    Deletion is irreversible and there is no undo, so the one thing to be
//    aware of: an event saved with a mistyped date that is already in the past
//    expires immediately and will be deleted on the next sweep. The validator
//    form warns before saving such an event ("this event's end time is already
//    in the past"), which is the point at which a typo is meant to be caught.
//    Both knobs below are env-overridable if a hold is ever wanted.
//
//  WHAT ELSE GETS REMOVED
//
//    Validator-supplied images are not stored on the destination. They are
//    downloaded and mirrored into a synthetic PlaceCache document keyed
//    `dest_<id>`, with dest.images pointing at /api/ai/place-image/dest_<id>/N
//    (see staffRoutes.storeDestinationUrlImages). Deleting only the
//    destination would orphan those image BYTES in PlaceCache permanently —
//    unreferenced, invisible, and accumulating with every expired event. So
//    both are removed together.
// ─────────────────────────────────────────────────────────────────────────────

const Destination = require('../models/Destination');
const PlaceCache  = require('../models/PlaceCache');

// How long after an event ends before its record is removed. Zero by default:
// a staff-added event destination has no owner and no second life, so once it
// has happened there is nothing to keep.
//
// Overridable via env so a hold can be introduced without a code change —
// EVENT_CLEANUP_GRACE_MS=86400000 would give a 24h window, which is worth
// considering if validators ever mistype a year and want time to catch it.
const GRACE_MS = Number(process.env.EVENT_CLEANUP_GRACE_MS ?? 0);

// How often the sweep runs — this is what bounds "how soon after expiry".
// One minute, so a finished event is gone within a minute of ending.
const SWEEP_INTERVAL_MS = Number(process.env.EVENT_CLEANUP_SWEEP_MS ?? 60 * 1000);

/**
 * Deletes one-time event destinations whose end (or start, when no end was
 * given) passed more than GRACE_MS ago, along with their mirrored images.
 *
 * Recurring events are never touched — a weekly market has no end date and is
 * perpetually upcoming.
 *
 * @returns {Promise<{deleted: number, images: number}>}
 */
async function runEventCleanup() {
    const cutoff = new Date(Date.now() - GRACE_MS);

    // Mirrors Destination.isEventExpired(), expressed as a query so the work
    // happens in the database rather than by loading every event destination.
    //   - must be tagged 'events'
    //   - must not be recurring
    //   - endDate passed, OR (no endDate and startDate passed)
    // An event with neither date is left alone: those are pre-feature rows
    // with no schedule to judge, and deleting them on a guess is not something
    // an automated sweep should ever do.
    const expired = await Destination.find({
        type: 'events',
        'eventSchedule.isRecurring': { $ne: true },
        $or: [
            { 'eventSchedule.endDate': { $lt: cutoff } },
            { $and: [
                { 'eventSchedule.endDate':   { $in: [null, undefined] } },
                { 'eventSchedule.startDate': { $lt: cutoff } }
            ]}
        ]
    }).select('_id name eventSchedule').lean();

    if (!expired.length) return { deleted: 0, images: 0 };

    const ids     = expired.map(d => d._id);
    const imgKeys = expired.map(d => `dest_${d._id}`);

    // Images first. If the process dies between the two deletes, an orphaned
    // PlaceCache entry is worse than a destination that survives one more
    // sweep — the latter self-corrects on the next run, the former never does.
    const imgResult = await PlaceCache.deleteMany({ placeId: { $in: imgKeys } });
    const delResult = await Destination.deleteMany({ _id: { $in: ids } });

    console.log(
        `[event-cleanup] removed ${delResult.deletedCount} finished event destination(s), ` +
        `${imgResult.deletedCount} mirrored image record(s): ` +
        expired.map(d => `"${d.name}"`).join(', ')
    );
    return { deleted: delResult.deletedCount, images: imgResult.deletedCount };
}

let sweepTimer = null;

/**
 * Starts the recurring sweep. Safe to call once at boot; calling it again is a
 * no-op so a double-import can't schedule two timers against the same data.
 * The timer is unref'd so it never holds the process open on shutdown.
 */
function startEventCleanup() {
    if (sweepTimer) return sweepTimer;
    const safeRun = () => runEventCleanup().catch(
        err => console.error('[event-cleanup] sweep failed:', err.message)
    );
    // First run is delayed, not immediate: startEventCleanup() is called during
    // boot and Mongo may not have finished connecting yet. Capped at 30s (the
    // allowance the zone-auction sweep uses) but never longer than the sweep
    // interval itself, so a fast test cadence isn't held up by a slow first run.
    const firstRun = setTimeout(safeRun, Math.min(30 * 1000, SWEEP_INTERVAL_MS));
    if (firstRun.unref) firstRun.unref();
    sweepTimer = setInterval(safeRun, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
    console.log(
        `[event-cleanup] scheduled every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s` +
        `${GRACE_MS > 0 ? ` (grace ${Math.round(GRACE_MS / 1000)}s)` : ' (no grace — delete as soon as expired)'}`
    );
    return sweepTimer;
}

function stopEventCleanup() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = { runEventCleanup, startEventCleanup, stopEventCleanup, GRACE_MS, SWEEP_INTERVAL_MS };
