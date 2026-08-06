/**
 * zoneAuction.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Zone Auction logic for Jinni — the ONLY waitlist mechanism on the platform.
 *
 * It applies in exactly one situation: a zone already holds 3 Signature
 * listings and a 4th (or 5th, 6th...) Signature wants in. Every other
 * full-zone case is a displacement or a tier-upgrade prompt — never a waitlist.
 * See plan.txt → "Zone Auction" for the full spec this module implements.
 *
 * Design summary (matches plan.txt):
 *   - $49/month is the price FLOOR for a Signature slot. No bid may be below it.
 *   - Challengers submit a MAX BID above the floor. All challengers for a zone
 *     form a sorted bid book.
 *   - Open auction: participants can see the current live high bid.
 *   - Winning / defending a slot LOCKS its price for 3 months (one quarter).
 *   - Each slot has its own renewal date → auctions are staggered, not synced.
 *   - ~7 days before a slot's renewal, that slot's auction resolves: the
 *     lowest-performing incumbent Signature must BEAT the high bid (strictly
 *     greater — a tie goes to the challenger) within 72 HOURS, or forfeit.
 *   - Forfeit → incumbent is `frozen`, highest bidder takes the slot.
 *   - A cancelling Signature creates a clean future vacancy → highest bidder
 *     enters freely, no displacement.
 *   - Frozen businesses keep their analytics and may re-bid later.
 *
 * Billing: this module only RECORDS the agreed monthly price on the business
 * document (partnership.monthlyFee + auction.wonAtPrice). Wiring the actual
 * charge to a payment provider is left to the caller — there is no billing
 * integration in the project yet.
 *
 * Dependencies: the Mongoose `Business` model. `emailService` is optional and
 * called defensively (?.) so missing notification methods never break a flow.
 */

'use strict';

const Business = require('../models/Business');

// emailService is optional — load defensively so the module works even if the
// service or its newer methods don't exist yet.
// NOTE: this file is expected to live in the backend `services/` folder,
// alongside emailService.js — hence './emailService', not '../services/...'.
let emailService = null;
try { emailService = require('./emailService'); } catch (_e) { /* no-op */ }

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const ZONE_MAX_SLOTS      = 3;            // slots per zone per category
const SIGNATURE_FLOOR     = 49;           // $/month — minimum any bid may be
const LOCK_IN_DAYS        = 90;           // price locked for one quarter
const RESOLVE_LEAD_DAYS   = 7;            // auction resolves this many days pre-renewal
const DEFEND_WINDOW_HOURS = 72;           // incumbent's response window

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Auction-related notification helpers, all optional + non-blocking.
async function notify(method, ...args) {
    if (!emailService || typeof emailService[method] !== 'function') return;
    try { await emailService[method](...args); }
    catch (e) { console.warn(`[zoneAuction] ${method} failed:`, e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZONE INSPECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the active Signature occupants of a zone (max 3 when full).
 * Only `active` Signatures count as occupants — frozen / waitlisted / pending
 * businesses are not holding a slot.
 */
async function getZoneSignatures(zoneKey) {
    if (!zoneKey) return [];
    return Business.find({
        zoneKey,
        status: 'active',
        'partnership.tier': 'signature',
    })
    .select('name contact analytics.performanceScore partnership owner zoneKey auction')
    .lean();
}

/**
 * Count Signatures that have WON a slot in the auction but are sitting in
 * `pending` while they await staff verification. These businesses are not yet
 * `active` (so getZoneSignatures doesn't see them) but they have RESERVED the
 * slot — the opening must not be promised to anyone else. We identify them by
 * the reservation marker written at promotion time: a recorded won price plus
 * `awaitingApprovalSince`, while no longer bidding.
 */
async function getReservedSignatures(zoneKey) {
    if (!zoneKey) return [];
    return Business.find({
        zoneKey,
        status: 'pending',
        'partnership.tier': 'signature',
        'auction.awaitingApprovalSince': { $ne: null },
    })
    .select('name contact partnership owner zoneKey auction')
    .lean();
}

/**
 * Total slots a zone has spoken for: live Signatures PLUS pending auction
 * winners holding a reserved slot. This is the number that governs whether a
 * further promotion may happen.
 */
async function getZoneOccupancy(zoneKey) {
    const [active, reserved] = await Promise.all([
        getZoneSignatures(zoneKey),
        getReservedSignatures(zoneKey),
    ]);
    return active.length + reserved.length;
}

/**
 * True when the zone is held by exactly 3 active Signatures — the only state
 * in which an incoming Signature is sent to the auction. Reserved (pending)
 * winners count toward fullness too, so a slot already promised to a
 * pending winner is not offered again.
 */
async function isFullSignatureZone(zoneKey) {
    return (await getZoneOccupancy(zoneKey)) >= ZONE_MAX_SLOTS;
}

/**
 * The current bid book for a zone: every business that has a standing bid for
 * this zone, sorted highest-bid-first. Ties broken by who bid earliest.
 */
async function getBidBook(zoneKey) {
    if (!zoneKey) return [];
    const bidders = await Business.find({
        'auction.isBidding':      true,
        'auction.targetZoneKey':  zoneKey,
    })
    .select('name contact auction analytics.performanceScore partnership owner')
    .lean();

    return bidders.sort((a, b) => {
        const diff = (b.auction.maxBid || 0) - (a.auction.maxBid || 0);
        if (diff !== 0) return diff;
        // earlier bid wins the tie
        return new Date(a.auction.bidAt || 0) - new Date(b.auction.bidAt || 0);
    });
}

/** The highest standing bid amount for a zone, or null if the book is empty. */
async function getHighBid(zoneKey) {
    const book = await getBidBook(zoneKey);
    return book.length ? (book[0].auction.maxBid || null) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BID SUBMISSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a proposed bid amount against the floor and the live high bid.
 * Returns { ok, reason, floor, currentHigh }.
 *
 * A bid must be strictly above the $49 floor. It does NOT have to beat the
 * current high bid to be accepted into the book — a lower bid simply sits
 * lower in the book — but the caller is told the current high so the UI can
 * advise the bidder.
 */
async function validateBid(zoneKey, amount) {
    const currentHigh = await getHighBid(zoneKey);
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
        return { ok: false, reason: 'Bid must be a number.', floor: SIGNATURE_FLOOR, currentHigh };
    }
    if (amount <= SIGNATURE_FLOOR) {
        return {
            ok: false,
            reason: `Bid must be above the $${SIGNATURE_FLOOR} Signature floor.`,
            floor: SIGNATURE_FLOOR,
            currentHigh,
        };
    }
    return { ok: true, reason: null, floor: SIGNATURE_FLOOR, currentHigh };
}

/**
 * Place (or update) a challenger's bid for a full-Signature zone.
 *
 * `business` is a Mongoose document (not lean) — it is mutated and saved.
 * Returns { ok, reason, position, currentHigh }.
 *
 * Notifies the 3 sitting Signatures that an auction exists / the high bid moved.
 */
async function placeBid(business, zoneKey, amount) {
    const check = await validateBid(zoneKey, amount);
    if (!check.ok) return { ok: false, reason: check.reason };

    const previousHigh = check.currentHigh;

    business.auction = business.auction || {};
    business.auction.isBidding     = true;
    business.auction.targetZoneKey = zoneKey;
    business.auction.maxBid        = amount;
    business.auction.bidAt         = business.auction.bidAt || new Date();
    business.auction.bidUpdatedAt  = new Date();
    // A bidding business is not holding a slot — it waits in the book.
    business.status = 'waitlisted';
    await business.save();

    const book = await getBidBook(zoneKey);
    const position = book.findIndex(b => String(b._id) === String(business._id)) + 1;
    const newHigh  = book.length ? book[0].auction.maxBid : amount;

    // Notify sitting Signatures if this bid created or raised the high bid.
    if (previousHigh == null || newHigh > (previousHigh || 0)) {
        const sigs = await getZoneSignatures(zoneKey);
        for (const sig of sigs) {
            await notify(
                'sendAuctionBidUpdate',
                sig.contact?.email,
                sig.name,
                zoneKey,
                newHigh,
            );
        }
    }

    return { ok: true, reason: null, position, currentHigh: newHigh };
}

/**
 * Withdraw a business from a zone's bid book (e.g. owner changed their mind).
 * `business` is a Mongoose document. Returns the updated high bid.
 */
async function withdrawBid(business) {
    const zoneKey = business.auction?.targetZoneKey || null;
    business.auction = business.auction || {};
    business.auction.isBidding    = false;
    business.auction.maxBid       = null;
    business.auction.bidUpdatedAt = new Date();
    await business.save();
    return zoneKey ? getHighBid(zoneKey) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUCTION RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identify the incumbent that must defend a contested zone: the lowest
 * performer among the 3 sitting Signatures (by analytics.performanceScore).
 * Returns the lean business object, or null if the zone isn't full.
 */
async function getDefendingIncumbent(zoneKey) {
    const sigs = await getZoneSignatures(zoneKey);
    if (sigs.length < ZONE_MAX_SLOTS) return null;
    return sigs.reduce((lowest, b) => {
        const score = b.analytics?.performanceScore ?? 0;
        const lowScore = lowest.analytics?.performanceScore ?? 0;
        return score < lowScore ? b : lowest;
    });
}

/**
 * Open a defend window on a contested slot. Called ~7 days before a slot's
 * renewal date when there is at least one standing bid above the floor.
 *
 * Marks the lowest-performing incumbent as `mustDefend`, records the bid it
 * must beat and the 72-hour deadline, and notifies the incumbent.
 * Returns { opened, incumbentId, bidToBeat, deadline } — opened=false when
 * there is nothing to contest.
 */
async function openDefendWindow(zoneKey, now = new Date()) {
    const highBid = await getHighBid(zoneKey);
    if (highBid == null) return { opened: false, reason: 'No standing bids.' };

    const incumbentLean = await getDefendingIncumbent(zoneKey);
    if (!incumbentLean) return { opened: false, reason: 'Zone is not a full Signature zone.' };

    const incumbent = await Business.findById(incumbentLean._id);
    if (!incumbent) return { opened: false, reason: 'Incumbent not found.' };

    // Already defending this exact contest — don't reset the clock.
    if (incumbent.auction?.mustDefend &&
        incumbent.auction.defendDeadline &&
        new Date(incumbent.auction.defendDeadline).getTime() > now.getTime()) {
        return {
            opened: false,
            reason: 'Defend window already open.',
            incumbentId: incumbent._id,
            bidToBeat: incumbent.auction.bidToBeat,
            deadline: incumbent.auction.defendDeadline,
        };
    }

    const deadline = new Date(now.getTime() + DEFEND_WINDOW_HOURS * HOUR_MS);
    incumbent.auction = incumbent.auction || {};
    incumbent.auction.mustDefend       = true;
    incumbent.auction.bidToBeat        = highBid;
    incumbent.auction.defendOpenedAt   = now;
    incumbent.auction.defendDeadline   = deadline;
    await incumbent.save();

    await notify(
        'sendAuctionDefendNotice',
        incumbent.contact?.email,
        incumbent.name,
        zoneKey,
        highBid,
        deadline,
    );

    return { opened: true, incumbentId: incumbent._id, bidToBeat: highBid, deadline };
}

/**
 * Incumbent responds to a defend window by committing to a new price.
 *
 * Beat-to-stay (plan.txt Rule B): the incumbent keeps the slot ONLY by bidding
 * STRICTLY MORE than the bid to beat. A tie goes to the challenger.
 *
 * `business` is the incumbent Mongoose document.
 * Returns { ok, kept, reason, lockedPrice, lockUntil }.
 */
async function submitDefense(business, defenseAmount, now = new Date()) {
    const a = business.auction || {};
    if (!a.mustDefend) {
        return { ok: false, kept: false, reason: 'This listing is not currently defending a slot.' };
    }
    if (a.defendDeadline && new Date(a.defendDeadline).getTime() < now.getTime()) {
        return { ok: false, kept: false, reason: 'The 72-hour defend window has already closed.' };
    }
    const bidToBeat = a.bidToBeat || 0;
    if (typeof defenseAmount !== 'number' || Number.isNaN(defenseAmount)) {
        return { ok: false, kept: false, reason: 'Defense amount must be a number.' };
    }
    if (defenseAmount <= bidToBeat) {
        // Not enough to keep the slot — beat-to-stay means strictly greater.
        return {
            ok: false,
            kept: false,
            reason: `To keep your slot you must bid strictly more than $${bidToBeat}.`,
        };
    }

    // Incumbent successfully defends — price locked for the next quarter.
    const lockUntil = new Date(now.getTime() + LOCK_IN_DAYS * DAY_MS);
    business.partnership.monthlyFee       = defenseAmount;
    business.partnership.subscriptionEnd  = lockUntil;
    business.auction = {
        isBidding:     false,
        mustDefend:    false,
        bidToBeat:     null,
        wonAtPrice:    defenseAmount,
        lockUntil,
        lastResolvedAt: now,
    };
    business.status = 'active';
    await business.save();

    await notify(
        'sendAuctionDefenseWon',
        business.contact?.email,
        business.name,
        defenseAmount,
        lockUntil,
    );

    return { ok: true, kept: true, reason: null, lockedPrice: defenseAmount, lockUntil };
}

/**
 * Resolve a single contested slot once the incumbent's 72-hour window has
 * passed without a successful defense. Freezes the incumbent and promotes the
 * highest bidder into the slot at their bid price, locked for a quarter.
 *
 * Returns { resolved, frozenId, winnerId, winningPrice }.
 */
async function resolveForfeit(zoneKey, now = new Date()) {
    const incumbentLean = await getDefendingIncumbent(zoneKey);
    if (!incumbentLean) return { resolved: false, reason: 'No defending incumbent.' };

    const incumbent = await Business.findById(incumbentLean._id);
    if (!incumbent || !incumbent.auction?.mustDefend) {
        return { resolved: false, reason: 'Incumbent is not in a defend window.' };
    }
    if (incumbent.auction.defendDeadline &&
        new Date(incumbent.auction.defendDeadline).getTime() > now.getTime()) {
        return { resolved: false, reason: 'Defend window has not yet closed.' };
    }

    const book = await getBidBook(zoneKey);
    if (!book.length) {
        // No bidders left (all withdrew) — incumbent keeps the slot uncontested.
        incumbent.auction.mustDefend     = false;
        incumbent.auction.bidToBeat      = null;
        incumbent.auction.lastResolvedAt = now;
        await incumbent.save();
        return { resolved: false, reason: 'No bidders remain; incumbent retained.' };
    }

    const winnerLean   = book[0];
    const winningPrice = winnerLean.auction.maxBid;

    // Freeze the forfeiting incumbent. Analytics are preserved on the document
    // so it can re-bid for a future opening with its real performance score.
    incumbent.status = 'frozen';
    incumbent.auction = {
        isBidding:      false,
        mustDefend:     false,
        bidToBeat:      null,
        forfeitedAt:    now,
        lastResolvedAt: now,
    };
    await incumbent.save();

    await notify(
        'sendAuctionForfeitNotice',
        incumbent.contact?.email,
        incumbent.name,
        zoneKey,
        incumbent.analytics?.performanceScore ?? null,
    );

    // Promote the winner into the slot. Delegate to the shared core so the
    // staff-approval branch (activate-if-verified, otherwise reserve into
    // `pending`) is applied identically here and in clean-vacancy promotion.
    // The incumbent is already frozen and out of the book above, so the top of
    // the book is the same winner identified as winnerLean.
    const promotion = await _promoteTopBidder(zoneKey, now, { dryRun: false });

    return {
        resolved: true,
        frozenId: incumbent._id,
        winnerId: promotion.winnerId || null,
        winningPrice: promotion.price ?? winningPrice,
        needsVerification: promotion.needsVerification === true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION → CLEAN HANDOFF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A sitting Signature cancels. The slot becomes a known future vacancy that
 * frees at the end of the current billing period (subscriptionEnd). No
 * displacement, no auction — when the date arrives the highest bidder simply
 * takes the slot for free (their bid price still applies going forward).
 *
 * This only marks intent + notifies the front-runner; the actual promotion
 * happens in runAuctionResolution() once the vacancy date passes.
 *
 * `business` is the cancelling Mongoose document.
 * Returns { ok, vacancyDate, frontRunnerId }.
 */
async function cancelSignature(business, now = new Date()) {
    if (business.partnership?.tier !== 'signature' || business.status !== 'active') {
        return { ok: false, reason: 'Only an active Signature can be cancelled this way.' };
    }
    const vacancyDate = business.partnership.subscriptionEnd || now;

    business.auction = business.auction || {};
    business.auction.cancelled        = true;
    business.auction.cancelledAt      = now;
    business.auction.vacancyDate      = vacancyDate;
    await business.save();

    // Tell the front-runner (if any) that a clean slot is coming.
    const book = await getBidBook(business.zoneKey);
    let frontRunnerId = null;
    if (book.length) {
        frontRunnerId = book[0]._id;
        await notify(
            'sendAuctionCleanVacancyNotice',
            book[0].contact?.email,
            book[0].name,
            business.zoneKey,
            vacancyDate,
        );
    }

    return { ok: true, vacancyDate, frontRunnerId };
}

/**
 * Shared promotion core. Given a zone that has just had a slot freed, promote
 * the top bidder in that zone's bid book into a Signature slot.
 *
 * This logic was previously inline inside resolveCleanVacancy(). It is now
 * shared with forceVacate() so admin force-vacate and scheduled clean-vacancy
 * resolution behave identically (same price-lock, same notification, same
 * auction-state reset).
 *
 * dryRun: when true, NOTHING is written and NO email is sent. The function
 * computes exactly what it WOULD do and returns it in `plan`. Used by
 * runAuctionResolution({ dryRun:true }) so the first real-world runs can be
 * inspected before any business records are mutated.
 *
 * Returns:
 *   { promoted:true,  winnerId, price, plan }   on success (or planned, if dryRun)
 *   { promoted:false, reason }                  when there's nothing/no one to promote
 */
async function _promoteTopBidder(zoneKey, now = new Date(), { dryRun = false } = {}) {
    if (!zoneKey) return { promoted: false, reason: 'No zoneKey.' };

    const book = await getBidBook(zoneKey);
    if (!book.length) return { promoted: false, reason: 'No bidders to promote.' };

    const winner = await Business.findById(book[0]._id);
    if (!winner) return { promoted: false, reason: 'Winner not found.' };

    const price     = winner.auction.maxBid;
    const lockUntil = new Date(now.getTime() + LOCK_IN_DAYS * DAY_MS);

    // Has this winner already passed staff verification? If not, it may not go
    // live on its own — it is promoted into `pending` and reserves the slot
    // until a staff member approves it through the normal verification flow
    // (businessRoutes.js approve route). This mirrors a fresh registration,
    // which also sits in `pending` until staff acts.
    const isApproved = winner.verification?.staffApproved === true;

    const plan = {
        action:     isApproved ? 'promote' : 'promote-pending',
        zoneKey,
        winnerId:   String(winner._id),
        winnerName: winner.name,
        price,
        lockUntil,
        needsVerification: !isApproved,
    };

    if (dryRun) {
        return { promoted: true, winnerId: winner._id, price, plan, dryRun: true, needsVerification: !isApproved };
    }

    // Won-slot data is written in BOTH cases so the price/tier/lock are fixed at
    // the moment the auction resolved (not re-derived later). The only
    // difference is the status: `active` for an already-verified winner, or
    // `pending` (slot reserved) for one still awaiting staff approval.
    winner.partnership.tier            = 'signature';
    winner.partnership.monthlyFee      = price;
    winner.partnership.subscriptionEnd = lockUntil;
    winner.zoneKey = zoneKey;
    winner.auction = {
        isBidding:      false,   // leaves the bid book either way
        mustDefend:     false,
        wonAtPrice:     price,
        lockUntil,
        lastResolvedAt: now,
        // Reservation marker — set only while awaiting approval, cleared on
        // activation. getReservedSignatures() keys off this so the slot counts
        // as occupied and isn't promised to another bidder.
        awaitingApprovalSince: isApproved ? null : now,
    };
    winner.status = isApproved ? 'active' : 'pending';
    await winner.save();

    if (isApproved) {
        await notify(
            'sendAuctionWonNotice',
            winner.contact?.email,
            winner.name,
            price,
            lockUntil,
        );
    } else {
        // Won, but pending staff review — tell the owner the slot is held for
        // them and verification is the last step.
        await notify(
            'sendAuctionWonPendingVerification',
            winner.contact?.email,
            winner.name,
            price,
            lockUntil,
        );
    }

    return { promoted: true, winnerId: winner._id, price, plan, needsVerification: !isApproved };
}

/**
 * Promote the highest bidder into a slot freed by a cancellation, once the
 * vacancy date has passed. Free entry — no displacement.
 *
 * dryRun is threaded through to _promoteTopBidder AND gates the act of freeing
 * the cancelling business's own slot, so a dry run mutates nothing at all.
 *
 * Returns { promoted, winnerId, price, plan } or { promoted:false, reason }.
 */
async function resolveCleanVacancy(cancelledBusiness, now = new Date(), { dryRun = false } = {}) {
    const vac = cancelledBusiness.auction?.vacancyDate;
    if (!cancelledBusiness.auction?.cancelled || !vac) {
        return { promoted: false, reason: 'Not a cancelled slot.' };
    }
    if (new Date(vac).getTime() > now.getTime()) {
        return { promoted: false, reason: 'Vacancy date not yet reached.' };
    }

    const zoneKey = cancelledBusiness.zoneKey;

    if (dryRun) {
        // Report what would happen without touching anything.
        const preview = await _promoteTopBidder(zoneKey, now, { dryRun: true });
        return {
            promoted: preview.promoted,
            winnerId: preview.winnerId,
            price:    preview.price,
            reason:   preview.reason,
            dryRun:   true,
            plan: {
                action:        'resolveCleanVacancy',
                vacatingId:    String(cancelledBusiness._id),
                vacatingName:  cancelledBusiness.name,
                zoneKey,
                promotion:     preview.plan || null,
            },
        };
    }

    // Free the cancelling business's slot.
    cancelledBusiness.status = 'expired';
    cancelledBusiness.auction = { ...(cancelledBusiness.auction || {}), cancelled: false };
    await cancelledBusiness.save();

    return _promoteTopBidder(zoneKey, now, { dryRun: false });
}

/**
 * forceVacate(business, opts)
 * ───────────────────────────
 * Immediately free an active Signature's slot and promote the top bidder right
 * now — no vacancy date, no waiting for the scheduler. Intended for admin use
 * (support removing a business, or testing the promotion path end-to-end).
 *
 * Unlike cancelSignature (which defers to subscriptionEnd), this is instant.
 * It shares _promoteTopBidder so the winner gets the exact same treatment as a
 * normal clean-vacancy promotion.
 *
 * `reasonNote` is recorded on the vacated business for audit.
 * dryRun: compute + return the plan without writing anything or emailing.
 *
 * Returns { ok, vacatedId, promotion, dryRun? } or { ok:false, reason }.
 */
async function forceVacate(business, { dryRun = false, reasonNote = 'admin force-vacate', now = new Date() } = {}) {
    if (!business) return { ok: false, reason: 'Business not found.' };
    if (business.partnership?.tier !== 'signature' || business.status !== 'active') {
        return { ok: false, reason: 'Only an active Signature slot can be force-vacated.' };
    }
    const zoneKey = business.zoneKey;
    if (!zoneKey) return { ok: false, reason: 'Business has no zoneKey.' };

    if (dryRun) {
        const preview = await _promoteTopBidder(zoneKey, now, { dryRun: true });
        return {
            ok: true,
            dryRun: true,
            plan: {
                action:       'forceVacate',
                vacatingId:   String(business._id),
                vacatingName: business.name,
                zoneKey,
                reasonNote,
                promotion:    preview.plan || null,
                promotionReason: preview.reason || null,
            },
        };
    }

    // Free the slot now.
    business.status = 'expired';
    business.auction = {
        ...(business.auction || {}),
        cancelled:       false,
        forceVacatedAt:  now,
        forceVacateNote: reasonNote,
    };
    await business.save();

    const promotion = await _promoteTopBidder(zoneKey, now, { dryRun: false });
    return { ok: true, vacatedId: business._id, promotion };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runAuctionResolution()
 * ───────────────────────
 * The single function a scheduler should call periodically (e.g. hourly or
 * daily). It is self-contained and idempotent — safe to call repeatedly.
 *
 * Each run does three passes:
 *   1. Open defend windows on slots whose renewal is within RESOLVE_LEAD_DAYS
 *      and which have at least one standing bid.
 *   2. Resolve forfeits where a 72-hour defend window has elapsed.
 *   3. Resolve clean vacancies where a cancelled slot's vacancy date has passed.
 *
 * Returns a summary object for logging.
 */
async function runAuctionResolution(arg = {}) {
    // Back-compat: the original signature was runAuctionResolution(now). Accept
    // either a Date (legacy) or an options object { now, dryRun }.
    let now, dryRun;
    if (arg instanceof Date) {
        now = arg; dryRun = false;
    } else {
        now = arg.now || new Date();
        dryRun = !!arg.dryRun;
    }

    const summary = {
        dryRun,
        defendWindowsOpened: 0,
        forfeitsResolved: 0,
        cleanVacancies: 0,
        plans: [],            // populated in dryRun so you can see intended actions
        errors: [],
    };

    // In dryRun mode we SKIP the mutating passes (defend windows + forfeits)
    // because those internal helpers write directly and don't yet support a
    // preview mode. We still fully preview Pass 3 (clean-vacancy promotions),
    // which is the genuinely new and highest-risk path being switched on.
    // A dry run therefore tells you which slots WOULD promote which bidder.

    // ── Pass 1: open defend windows ~7 days before renewal ───────────────────
    if (!dryRun) {
        try {
            const renewalCutoff = new Date(now.getTime() + RESOLVE_LEAD_DAYS * DAY_MS);
            const dueSignatures = await Business.find({
                'partnership.tier':           'signature',
                status:                       'active',
                'partnership.subscriptionEnd': { $lte: renewalCutoff },
            }).select('zoneKey name partnership.subscriptionEnd').lean();
            console.log('[DEBUG Pass 1] renewalCutoff:', renewalCutoff.toISOString());
            console.log('[DEBUG Pass 1] dueSignatures:', dueSignatures.length, dueSignatures.map(b => ({name: b.name, end: b.partnership?.subscriptionEnd})));

            const zonesSeen = new Set();
            for (const sig of dueSignatures) {
                if (!sig.zoneKey || zonesSeen.has(sig.zoneKey)) continue;
                zonesSeen.add(sig.zoneKey);
                const r = await openDefendWindow(sig.zoneKey, now);
                if (r.opened) summary.defendWindowsOpened++;
            }
        } catch (e) {
            summary.errors.push(`defend-window pass: ${e.message}`);
        }
    }

    // ── Pass 2: resolve forfeits where the 72h window has elapsed ─────────────
    if (!dryRun) {
        try {
            const lapsed = await Business.find({
                'auction.mustDefend':     true,
                'auction.defendDeadline': { $lt: now },
            }).select('zoneKey').lean();

            const zonesSeen = new Set();
            for (const b of lapsed) {
                if (!b.zoneKey || zonesSeen.has(b.zoneKey)) continue;
                zonesSeen.add(b.zoneKey);
                const r = await resolveForfeit(b.zoneKey, now);
                if (r.resolved) summary.forfeitsResolved++;
            }
        } catch (e) {
            summary.errors.push(`forfeit pass: ${e.message}`);
        }
    }

    // ── Pass 3: resolve clean vacancies past their vacancy date ───────────────
    try {
        const vacated = await Business.find({
            'auction.cancelled':    true,
            'auction.vacancyDate':  { $lte: now },
        });
        for (const b of vacated) {
            const r = await resolveCleanVacancy(b, now, { dryRun });
            if (r.promoted) summary.cleanVacancies++;
            if (dryRun && r.plan) summary.plans.push(r.plan);
        }
    } catch (e) {
        summary.errors.push(`clean-vacancy pass: ${e.message}`);
    }

    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    // constants
    ZONE_MAX_SLOTS,
    SIGNATURE_FLOOR,
    LOCK_IN_DAYS,
    RESOLVE_LEAD_DAYS,
    DEFEND_WINDOW_HOURS,
    // zone inspection
    getZoneSignatures,
    getReservedSignatures,
    getZoneOccupancy,
    isFullSignatureZone,
    getBidBook,
    getHighBid,
    // bidding
    validateBid,
    placeBid,
    withdrawBid,
    // resolution
    getDefendingIncumbent,
    openDefendWindow,
    submitDefense,
    resolveForfeit,
    // cancellation
    cancelSignature,
    resolveCleanVacancy,
    forceVacate,
    _promoteTopBidder,
    // scheduled entry point
    runAuctionResolution,
};