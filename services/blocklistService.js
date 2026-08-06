// services/blocklistService.js
//
// All blocklist logic in one place so /apply, the admin endpoints, and the
// auto-promote-on-repeat-rejection path share the same normalization rules.
// If normalization ever drifts between writer and reader the whole feature
// silently breaks, so keep it centralized.

const BlockedFingerprint = require('../models/BlockedFingerprint');

// ── Normalizers ──────────────────────────────────────────────────────────────
// Mirror the duplicate-check rules already used in businessRoutes.js so the
// blocklist and the dupe-check agree on what "same phone" means.

function normalizeEmail(email) {
    if (!email) return null;
    return String(email).trim().toLowerCase();
}

// Phones in this codebase are matched on the LAST 8 DIGITS (see /apply at
// the duplicate-fingerprint section). Replicate exactly.
function normalizePhone(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.length < 7) return null; // too short to be a real phone
    return digits.slice(-8);
}

function normalizeNameCity(name, city) {
    if (!name || !city) return null;
    const n = String(name).trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const c = String(city).trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!n || !c) return null;
    return `${n}|${c}`;
}

function normalizeIp(ip) {
    if (!ip) return null;
    // Strip IPv6-mapped IPv4 prefix and any leading/trailing whitespace.
    return String(ip).replace(/^::ffff:/, '').trim() || null;
}

function normalizeUserId(id) {
    if (!id) return null;
    return String(id);
}

// Build the full set of (type, value) pairs to look up for a given
// application or business document. Caller passes whatever it has.
function buildFingerprints({ email, phone, name, city, ip, userId } = {}) {
    const out = [];
    const e = normalizeEmail(email);          if (e)  out.push({ type: 'email',     value: e });
    const p = normalizePhone(phone);          if (p)  out.push({ type: 'phone',     value: p });
    const nc = normalizeNameCity(name, city); if (nc) out.push({ type: 'name+city', value: nc });
    const i = normalizeIp(ip);                if (i)  out.push({ type: 'ip',        value: i });
    const u = normalizeUserId(userId);        if (u)  out.push({ type: 'userId',    value: u });
    return out;
}

// ── Lookup ───────────────────────────────────────────────────────────────────
//
// Returns all active (non-expired) fingerprint hits for a given application.
// Caller decides what to do based on .severity.
async function checkFingerprints(fingerprints) {
    if (!fingerprints?.length) return [];
    const now = new Date();
    return BlockedFingerprint.find({
        $and: [
            { $or: fingerprints },
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }
        ]
    }).lean();
}

// ── Telemetry ────────────────────────────────────────────────────────────────
//
// Bump hitCount + lastHitAt on every match, even watch-level ones. This is
// what tells an admin "this watch-listed phone has been matched 14 times this
// week — time to promote to block."
async function recordHits(hitIds) {
    if (!hitIds?.length) return;
    try {
        await BlockedFingerprint.updateMany(
            { _id: { $in: hitIds } },
            { $inc: { hitCount: 1 }, $set: { lastHitAt: new Date() } }
        );
    } catch (e) {
        // Don't fail the application over a telemetry write.
        console.warn('[blocklist] recordHits failed:', e.message);
    }
}

// ── Flagging on reject ───────────────────────────────────────────────────────
//
// Called from approve/reject endpoints when the moderator wants to "also flag
// this fingerprint for future submissions." Upserts a 'watch' entry per type;
// already-present entries get a new evidence row appended.
//
// types: subset of ['email','phone','name+city','ip','userId']
// values come from the rejected Business document.
//
// promote (default false): when false, severity is only applied on INSERT
//   ($setOnInsert) — an existing entry keeps whatever severity it already had,
//   so a routine watch-flag never silently downgrades an existing block.
//   When true (used by HARD/permanent rejection), severity is force-applied
//   via $set so an existing 'watch' is promoted up to the requested level
//   (typically 'block').
async function flagFromBusiness({
    business, rejectedByUserId, reason, types = ['email', 'phone'], severity = 'watch', promote = false
}) {
    if (!business) return [];

    const ip = business.verification?.applyIp || null;
    const fp = buildFingerprints({
        email:  business.contact?.email,
        phone:  business.contact?.phone,
        name:   business.name,
        city:   business.location?.city,
        ip,
        userId: business.owner
    }).filter(f => types.includes(f.type));

    const evidence = {
        businessId:      business._id,
        rejectedAt:      new Date(),
        rejectionReason: reason || 'Flagged on rejection'
    };

    const results = [];
    for (const { type, value } of fp) {
        try {
            // Build the update. severity goes in $setOnInsert by default; when
            // promoting it moves to $set so existing rows are lifted too. The
            // two can't both carry `severity` (Mongo rejects conflicting paths),
            // hence the conditional.
            const setOnInsert = { type, value, createdBy: rejectedByUserId || null,
                                  reason: reason || 'Flagged on rejection' };
            const update = { $push: { evidence } };
            if (promote) {
                update.$set = { severity };
            } else {
                setOnInsert.severity = severity;
            }
            update.$setOnInsert = setOnInsert;

            const doc = await BlockedFingerprint.findOneAndUpdate(
                { type, value },
                update,
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            results.push(doc);
        } catch (e) {
            console.warn(`[blocklist] flagFromBusiness ${type}=${value} failed:`, e.message);
        }
    }
    return results;
}

// ── Lift a hard rejection's block entries ────────────────────────────────────
//
// Called when an admin downgrades a permanent (hard) rejection back to soft.
// For each fingerprint derived from the business we find its blocklist entry,
// remove the evidence rows that point at THIS business, and:
//   • if no evidence from any OTHER business remains, demote the entry from
//     'block' back to 'watch' (we keep the row as a watch trail rather than
//     deleting it outright — a downgrade is "give them another chance," not
//     "this never happened"). If the entry has no evidence at all left, it is
//     deleted so we don't leave an orphaned watch with no justification.
//   • if other businesses still justify the block, the severity is left as-is
//     and only this business's evidence is pulled.
//
// Returns a short summary array describing what changed, for the audit note.
async function liftHardRejectBlocks(business) {
    if (!business) return [];

    const ip = business.verification?.applyIp || null;
    const fp = buildFingerprints({
        email:  business.contact?.email,
        phone:  business.contact?.phone,
        name:   business.name,
        city:   business.location?.city,
        ip,
        userId: business.owner
    });

    const bizId = String(business._id);
    const summary = [];

    for (const { type, value } of fp) {
        try {
            const entry = await BlockedFingerprint.findOne({ type, value });
            if (!entry) continue;

            const before = (entry.evidence || []).length;
            const remaining = (entry.evidence || [])
                .filter(e => String(e.businessId) !== bizId);

            // Only THIS business justified the entry → drop it entirely.
            if (remaining.length === 0) {
                await BlockedFingerprint.deleteOne({ _id: entry._id });
                summary.push(`${type} removed`);
                continue;
            }

            // Other businesses still reference it. Pull this business's evidence;
            // demote to 'watch' only if it was a block AND nothing else keeps it
            // at block level. We can't easily know other rejections' intent, so
            // we conservatively keep severity but drop our evidence — the admin
            // can manually demote from the blocklist screen if desired.
            entry.evidence = remaining;
            await entry.save();
            summary.push(`${type} evidence pruned (${before - remaining.length} removed, ${remaining.length} kept)`);
        } catch (e) {
            console.warn(`[blocklist] liftHardRejectBlocks ${type}=${value} failed:`, e.message);
        }
    }
    return summary;
}

// ── Auto-promote on repeat rejection ─────────────────────────────────────────
//
// Looks at the rejected business's email/phone and checks how many OTHER
// rejected listings share the same fingerprint. At/above the threshold,
// auto-creates a 'watch' entry; at the higher threshold, severity is 'block'.
//
// Returns array of entries created or modified.
const AUTO_WATCH_THRESHOLD = 3;   // N+ rejections sharing this fingerprint → watch
const AUTO_BLOCK_THRESHOLD = 6;   // 2× → promote watch to block (admin can downgrade later)

async function autoFlagFromRejection(business) {
    if (!business) return [];
    const Business = require('../models/Business');

    const phone = normalizePhone(business.contact?.phone);
    const email = normalizeEmail(business.contact?.email);
    const probes = [];

    if (phone) probes.push({ type: 'phone', value: phone, mongo: { 'contact.phone': { $regex: new RegExp(phone) } } });
    if (email) probes.push({ type: 'email', value: email, mongo: { 'contact.email': email } });

    const results = [];
    for (const { type, value, mongo } of probes) {
        const count = await Business.countDocuments({
            ...mongo,
            status: 'rejected'
        });

        if (count >= AUTO_WATCH_THRESHOLD) {
            const targetSeverity = count >= AUTO_BLOCK_THRESHOLD ? 'block' : 'watch';
            try {
                const doc = await BlockedFingerprint.findOneAndUpdate(
                    { type, value },
                    {
                        $setOnInsert: {
                            type, value, severity: targetSeverity,
                            createdBy: null,
                            reason: `Auto-flagged: ${count} rejected listings share this ${type}`
                        },
                        // If already exists at lower severity and we now cross the higher
                        // threshold, promote it.
                        ...(targetSeverity === 'block' ? { $set: { severity: 'block' } } : {}),
                        $push: {
                            evidence: {
                                businessId:      business._id,
                                rejectedAt:      new Date(),
                                rejectionReason: business.verification?.staffNotes || 'Auto-flag from repeat rejection'
                            }
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                results.push(doc);
            } catch (e) {
                console.warn(`[blocklist] autoFlag ${type}=${value} failed:`, e.message);
            }
        }
    }
    return results;
}

module.exports = {
    normalizeEmail,
    normalizePhone,
    normalizeNameCity,
    normalizeIp,
    normalizeUserId,
    buildFingerprints,
    checkFingerprints,
    recordHits,
    flagFromBusiness,
    liftHardRejectBlocks,
    autoFlagFromRejection,
    AUTO_WATCH_THRESHOLD,
    AUTO_BLOCK_THRESHOLD
};