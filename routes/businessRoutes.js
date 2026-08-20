const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const sharp  = require('sharp');
const auth = require('../middleware/auth');
const BusinessModel = require('../models/Business');
const Business = BusinessModel;
const { ZONE_RADIUS_M, ZONE_GRID_STEP, IMAGE_CONSTRAINTS } = BusinessModel;
const User = require('../models/User');
const emailService = require('../services/emailService');
const openai = require('../config/openai');
const googleService = require('../services/googleService');
const imageStorageService = require('../services/imageStorageService')
const zoneAuction = require('../services/zoneAuction')
const blocklistService = require('../services/blocklistService')

// Offline coordinate -> IANA timezone resolver (no API key, no network). Used
// to stamp event listings with their venue's home timezone so event times are
// stored and shown unambiguously regardless of who registered or who is
// viewing. Shared with staffRoutes (validator-added event destinations) — see
// utils/timezone.js for why it lives there rather than in this file.
const { resolveTimezone } = require('../utils/timezone')

// ── Multer for application image uploads (no auth, memory storage) ────────────
const applyUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMAGE_CONSTRAINTS.maxBytes, files: 8 },
    fileFilter(_req, file, cb) {
        if (!IMAGE_CONSTRAINTS.allowedMimes.includes(file.mimetype)) {return cb(new Error(`Only ${IMAGE_CONSTRAINTS.allowedMimes.join(', ')} files are allowed`))}
        const dangerous = /\.(php\d?|phtml|phar|asp|aspx|jsp|exe|sh|bat|cmd|cgi|pl|py|rb)\./i
        const invalid   = /(\.\.(\/|\\)|[<>{}\[\]|\\^~\`])/
        if (dangerous.test(file.originalname) || invalid.test(file.originalname)) {return cb(new Error('File name contains invalid characters'))}
        cb(null, true)
    },
})

// Rate limiter for the public /apply endpoint — prevents account-creation spam.
// Requires: npm install express-rate-limit
const rateLimit = require('express-rate-limit');
const applyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 5,                      // max 5 applications per IP per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many applications from this IP. Please try again in an hour.' }
});

// Rate limiter for the owner edit route. Defends the resubmit loop: a bad
// actor can edit and re-pend their rejected listing to get back into staff
// review, but only a bounded number of times per hour. Keyed on the
// authenticated user id, falling back to IP for safety.
const editLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    message: { error: 'Too many edits. Please wait before saving again.' }
});

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const ZONE_MAX_SLOTS = 3
const TIER_PRIORITY = { verified: 1, spotlight: 2, signature: 3 }

// Allows staff (validation-only role) and admins.
// Used for the list/approve/reject endpoints that staff need to do their job.
// Owner-or-admin endpoints (edit, zone intelligence) stay admin-only — staff
// don't get edit access, only validation.
function isStaffOrAdmin(user) {
    return !!user && (user.role === 'staff' || user.role === 'admin' || user.isAdmin === true);
}

// Builds a Mongo filter that restricts businesses to a staff member's assigned
// countries/cities. Behaviour:
//   - admin / isAdmin       → returns {} (sees everything)
//   - staff with no scope   → returns null  (caller treats as "empty queue")
//   - staff with scope      → returns { $or: [country match, city match] }
// Country/city match is case-insensitive via regex so admin doesn't have to
// worry about casing when typing assignments.
//
// Async because some auth middlewares put only { id, email } on req.user
// (decoded JWT payload) — in that case we hydrate from DB to read the
// staffAssignment that was set after the JWT was issued.
async function buildStaffScopeFilter(user) {
    if (!user) return null;
    if (user.role === 'admin' || user.isAdmin === true) return {};

    let a = user.staffAssignment;
    // Hydrate if missing — happens when auth middleware uses raw JWT payload.
    if (!a && user.id) {
        try {
            const fresh = await User.findById(user.id).select('role staffAssignment isAdmin').lean();
            if (!fresh) return null;
            if (fresh.role === 'admin' || fresh.isAdmin) return {};
            a = fresh.staffAssignment;
        } catch { return null; }
    }
    a = a || {};

    const countries = (a.countries || []).filter(Boolean);
    const cities    = (a.cities    || []).filter(Boolean);
    if (!countries.length && !cities.length) return null;

    const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ors = [];
    if (countries.length) ors.push({ 'location.country': { $in: countries.map(c => new RegExp(`^${escape(c)}$`, 'i')) } });
    if (cities.length)    ors.push({ 'location.city':    { $in: cities.map(c    => new RegExp(`^${escape(c)}$`, 'i')) } });
    return { $or: ors };
}

// ── Event helpers ─────────────────────────────────────────────────
const INTEREST_TAGS = ['cultural','history','adventure','relaxation','nature','art','nightlife','food&drink','family','romantic','luxury','budget']

// Two events overlap if their date ranges intersect.
// Recurring events are treated as always-on (they overlap with everything).
function eventsOverlap(a, b) {
    if (!a.startDate || !b.startDate) return false
    if (a.isRecurring || b.isRecurring) return true
    const aStart = new Date(a.startDate), aEnd = new Date(a.endDate || a.startDate)
    const bStart = new Date(b.startDate), bEnd = new Date(b.endDate || b.startDate)
    return aStart <= bEnd && bStart <= aEnd
}
// Returns count of shared interest/style tags between two type arrays
function calcInterestOverlap(typeA, typeB) {
    if (!typeA?.length || !typeB?.length) return 0
    const setA = new Set(typeA.filter(t => INTEREST_TAGS.includes(t)))
    return typeB.filter(t => INTEREST_TAGS.includes(t) && setA.has(t)).length
}

// Finds events in the events zone radius that overlap with the given time window.
// Returns each conflicting event enriched with sharedInterests count.
async function getOverlappingEvents(lat, lng, eventSchedule, incomingTypes = []) {
    const radiusM = ZONE_RADIUS_M.events  // 300m
    const GEO_DELTA = (radiusM / 111000) * 1.2  // ~20% wider to catch edge cases
    const candidates = await Business.find({
        isActive: true,
        type: { $elemMatch: { $eq: 'events' } },
        $or: [{ status: 'active' }, { status: 'pending' }],
        'location.coordinates.lat': { $gte: lat - GEO_DELTA, $lte: lat + GEO_DELTA },
        'location.coordinates.lng': { $gte: lng - GEO_DELTA, $lte: lng + GEO_DELTA }
    }).select('name partnership.tier partnership.subscriptionEnd eventSchedule analytics.performanceScore type').lean()
    return candidates.filter(b => eventsOverlap(b.eventSchedule || {}, eventSchedule)).map(b => ({...b, sharedInterests: calcInterestOverlap(incomingTypes, b.type || []), interestMatch: calcInterestOverlap(incomingTypes, b.type || []) > 0}))
}
// Per-category zone radii and grid steps are imported from Business model above.
// This ensures buildZoneKey (model), zone-check (routes), and apply (routes) all use
// identical values and zone keys always match.

// Returns businesses in the same zone OR any of the 8 neighboring cells.
// This handles geocoding drift — two geocoders can place the same address in adjacent
// grid cells, so we search the full 3×3 neighborhood and deduplicate by _id.
//
// `options.occupantsOnly` (default false):
//   - false → includes `pending` businesses. Used for the registration-time
//     PREVIEW (zone-check route), so an applicant is warned about pending
//     competitors that may soon take a slot.
//   - true  → only `active` businesses. Used for actual displacement DECISIONS
//     (the approve route). A `pending` application has not occupied a slot yet,
//     so it must not count toward "zone is full" or be displaced/frozen. If a
//     pending application is later rejected, it should never have caused a freeze.
async function getZoneBusinesses(zoneKey, options = {}) {
    const { occupantsOnly = false } = options
    // Parse the primary cell key: "category:lat:lng"
    const [category, latStr, lngStr] = zoneKey.split(':')
    const lat = parseFloat(latStr)
    const lng = parseFloat(lngStr)
    const step = ZONE_GRID_STEP[category] ?? 0.002  // per-category grid step
    // Build all 9 keys (center + 8 neighbors)
    const keys = []
    for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLng = -1; dLng <= 1; dLng++) {
            const nLat = ((lat + dLat * step)).toFixed(3)
            const nLng = ((lng + dLng * step)).toFixed(3)
            keys.push(`${category}:${nLat}:${nLng}`)
        }
    }
    const statusOr = occupantsOnly
        ? [{ status: 'active' }]
        : [{ status: 'active' }, { status: 'pending' }, { status: { $exists: false } }]
    const results = await Business.find({zoneKey: { $in: keys }, isActive: true, $or: statusOr}).select('name type partnership.tier analytics.performanceScore location.coordinates location.address location.city location.country zoneKey').lean()
    // Deduplicate by _id (a business can only have one zoneKey, so this is a safety net)
    const seen = new Set()
    return results.filter(b => {
        const id = b._id.toString()
        if (seen.has(id)) return false
        seen.add(id)
        return true
    })
}
// Counts active slots by tier in a zone
function countZoneSlots(businesses) {return {total: businesses.length, verified: businesses.filter(b => b.partnership.tier === 'verified').length, spotlight: businesses.filter(b => b.partnership.tier === 'spotlight').length, signature: businesses.filter(b => b.partnership.tier === 'signature').length, remaining: ZONE_MAX_SLOTS - businesses.length}}
// Finds the lowest performing business at a given tier in a zone
function findLowestPerformer(businesses, tier) {
    // Only `active` businesses occupy a slot. Frozen / pending / rejected /
    // expired listings are not in the zone for displacement purposes — they
    // either lost the slot already or never had one. We default to true if a
    // status field is missing (some older docs lack it), but exclude any
    // explicit non-active status. This is defence-in-depth: callers also
    // pre-filter, but a single missed filter upstream would otherwise re-create
    // the "displace the frozen one" bug.
    const filtered = businesses.filter(b =>
        b.partnership.tier === tier &&
        (b.status === undefined || b.status === null || b.status === 'active')
    )
    if (!filtered.length) return null
    return filtered.reduce((lowest, b) => b.analytics.performanceScore < lowest.analytics.performanceScore ? b : lowest)
}
// Builds scoreBreakdown matching Business.js recalcPerformanceScore() exactly.
// weeklyViews fallback: if the array is empty (no cron has run yet), seed the
// last slot with all-time views so new businesses get a non-zero recent score.
function buildScoreBreakdown(a, business) {
    // ── Seed weeklyViews if empty ─────────────────────────────────────────────
    let weeklyViews = a.weeklyViews || []
    if (weeklyViews.length === 0 && (a.views || 0) > 0) {
        // Use total views as a single-week estimate — better than 0.
        weeklyViews = [a.views]
    }

    // 1. Recent Activity (30%) — avg of last 4 weeks, benchmark 100/wk
    const recentWeeks = weeklyViews.slice(-4)
    const recentAvg   = recentWeeks.length
        ? recentWeeks.reduce((s, v) => s + v, 0) / recentWeeks.length
        : 0
    const recentActivity = Math.min((recentAvg / 100) * 100, 100)

    // 2. Engagement Quality (25%) — saves*3, aiAsk*2, moreImages*1, benchmark 300
    const engagementRaw =
        (a.saves      || 0) * 3 +
        (a.aiAsk      || 0) * 2 +
        (a.moreImages || 0) * 1
    const engagement = Math.min((engagementRaw / 300) * 100, 100)

    // 3. Conversion Actions (30%) — all real-world intent clicks, benchmark 150
    const conversionRaw =
        (a.directionClicks   || 0) +
        (a.phoneClicks       || 0) +
        (a.websiteClicks     || 0) +
        (a.searchClicks      || 0) +
        (a.instagramClicks   || 0) +
        (a.facebookClicks    || 0) +
        (a.tripadvisorClicks || 0)
    const conversions = Math.min((conversionRaw / 150) * 100, 100)

    // 4. Profile Completeness (15%) — 5 groups × 20 pts each
    let completeness = 0
    if (business?.description?.short)                            completeness += 20
    if (business?.description?.detailed)                         completeness += 20
    if ((business?.images || []).length >= 3)                    completeness += 20
    if (business?.contact?.phone || business?.contact?.website)  completeness += 20
    if ((business?.description?.highlights || []).length >= 2)   completeness += 20

    return {
        recentActivity: Math.round(recentActivity),
        engagement:     Math.round(engagement),
        conversions:    Math.round(conversions),
        completeness,
    }
}
// Determines what happens when a new business of `incomingTier` tries to enter a zone.
// Returns: { canEnter, displaces, displacedId, waitlisted, blocked, mustUpgradeTo, message }
//
// New model (see plan.txt → "Zone Auction"):
//   - Free slot (<3)                  → enter freely
//   - Full, incoming Verified         → BLOCKED (must apply Spotlight+). Never waitlisted.
//   - Full, incoming Spotlight:
//       · ≥1 Verified present         → displaces lowest Verified
//       · no Verified (Spot+Sig)      → BLOCKED (must upgrade to Signature)
//   - Full, incoming Signature:
//       · ≥1 Verified/Spotlight       → displaces lowest performer among them
//       · all 3 are Signatures        → WAITLISTED → enters the Zone Auction
function resolveZoneEntry(businesses, incomingTier) {
    const slots = countZoneSlots(businesses)
    // Zone has space — enter freely
    if (slots.total < ZONE_MAX_SLOTS) {return { canEnter: true, displaces: false, waitlisted: false, blocked: false, message: null }}
    // Zone is full — check if incoming can displace someone
    if (incomingTier === 'signature') {
        // Signature displaces lowest-tier first: verified > spotlight
        const lowestVerified = findLowestPerformer(businesses, 'verified')
        const lowestSpotlight = findLowestPerformer(businesses, 'spotlight')
        let target = null
        if (lowestVerified && lowestSpotlight) {
            // Both exist — verified is structurally lower, displace it first
            target = lowestVerified
        } else {target = lowestVerified || lowestSpotlight}
        if (target) {
            return {
                canEnter: true,
                displaces: true,
                displacedId: target._id,
                displacedTier: target.partnership.tier,
                displacedName: target.name,
                waitlisted: false,
                blocked: false,
                message: `Zone full — your listing will replace the lowest performing ${target.partnership.tier} listing.`
            }
        }
        // All 3 are Signatures — enters the Zone Auction (the only waitlist case)
        return {canEnter: false, displaces: false, waitlisted: true, blocked: false, message: 'Zone is held by 3 Signature listings. Your application enters the Zone Auction.'}
    }
    if (incomingTier === 'spotlight') {
        // Spotlight can only displace verified
        const lowestVerified = findLowestPerformer(businesses, 'verified')
        if (lowestVerified) {
            return {
                canEnter: true,
                displaces: true,
                displacedId: lowestVerified._id,
                displacedTier: 'verified',
                displacedName: lowestVerified.name,
                waitlisted: false,
                blocked: false,
                message: 'Zone full — your listing will replace the lowest performing free listing.'
            }
        }
        // No verified to displace (zone is Spotlight + Signature) — BLOCKED, must upgrade
        return {canEnter: false, displaces: false, waitlisted: false, blocked: true, mustUpgradeTo: 'signature', message: 'This zone is full of paid listings. Only a Signature listing can enter — please upgrade to Signature.'}
    }
    // Verified — cannot displace anyone and is never waitlisted — BLOCKED
    return {canEnter: false, displaces: false, waitlisted: false, blocked: true, mustUpgradeTo: 'spotlight', message: 'This zone is full. A free Verified listing cannot enter — please apply as Spotlight or Signature.'}
}
// ── Multi-source business verification ───────────────────────────────────────
const GOOGLE_VERIFIABLE = ['restaurants', 'hotels', 'historical', 'hidden_gems', 'souvenirs', 'clothing', 'market', 'jewelry', 'food']

function nameSimilarity(a, b) {
    if (!a || !b) return 0
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
    const na = normalize(a), nb = normalize(b)
    if (na === nb) return 1
    if (na.includes(nb) || nb.includes(na)) return 0.85
    const wa = new Set(na.split(/\s+/)), wb = nb.split(/\s+/)
    const overlap = wb.filter(w => wa.has(w)).length
    return overlap / Math.max(wa.size, wb.length)
}
function distMetersSimple(lat1, lng1, lat2, lng2) {
    const R = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLng = (lng2 - lng1) * Math.PI / 180
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
// Fetch a URL with timeout and return text, null on failure
async function safeFetch(url, timeoutMs = 6000) {
    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const res = await fetch(url, {signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JinniVerify/1.0)' }})
        clearTimeout(timer)
        if (!res.ok) return null
        return await res.text()
    } catch { return null }
}
// Check if business name appears in fetched HTML
function nameInHtml(html, name) {
    if (!html || !name) return false
    const needle = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
    const haystack = html.toLowerCase()
    return haystack.includes(needle) || needle.split(/\s+/).filter(w => w.length > 3).every(w => haystack.includes(w))
}
// ── Website check ────────────────────────────────────────────────
async function checkWebsite(websiteUrl, businessName) {
    if (!websiteUrl?.trim()) return { checked: false }
    try {
        const html = await safeFetch(websiteUrl)
        if (!html) return { checked: true, found: false, note: 'Website unreachable' }
        const found = nameInHtml(html, businessName)
        return {checked: true, found, note: found ? `Business name found on website` : `Business name not found on website — may be a different business`}
    } catch { return { checked: true, found: false, note: 'Website check failed' } }
}
// ── TripAdvisor check ────────────────────────────────────────────
async function checkTripAdvisor(taUrl, businessName) {
    if (!taUrl?.trim()) return { checked: false }
    if (!taUrl.includes('tripadvisor')) return { checked: false }
    try {
        const html = await safeFetch(taUrl)
        if (!html) return { checked: true, found: false, note: 'TripAdvisor page unreachable' }
        const found = nameInHtml(html, businessName)
        return {checked: true, found, note: found ? `Business name confirmed on TripAdvisor` : `TripAdvisor page does not match submitted business name`}
    } catch { return { checked: true, found: false, note: 'TripAdvisor check failed' } }
}
// ── Instagram check ──────────────────────────────────────────────
async function checkInstagram(handle) {
    if (!handle?.trim()) return { checked: false }
    const clean = handle.replace(/^@/, '').trim()
    try {
        const html = await safeFetch(`https://www.instagram.com/${clean}/`, 5000)
        if (!html) return { checked: true, found: false, note: `@${clean} — profile unreachable` }
        const exists = !html.includes('"@type":"ProfilePage"') === false || html.includes('"username"') || html.includes(clean)
        const notFound = html.includes("Sorry, this page") || html.includes("isn't available")
        return {checked: true, found: !notFound, note: notFound ? `@${clean} does not exist on Instagram` : `@${clean} Instagram profile exists` }
    } catch { return { checked: true, found: false, note: 'Instagram check failed' } }
}
// ── Main verification orchestrator ───────────────────────────────
async function runGoogleVerification(businessData, coordinates) {
    const { name, type, location, contact } = businessData
    const mainCategory = type?.find(t => GOOGLE_VERIFIABLE.includes(t))
    const isVerifiable = !!mainCategory && mainCategory !== 'events'
    const sources = []
    const flags = []
    let score = 0
    let googleImages = []
    let googlePlaceId = null, googleName = null, googleAddress = null, googleRating = null
    // ── Source 1: Google Places (40 pts total) ───────────────────
    if (!isVerifiable) {
        sources.push('Category not verified against Google Places — manual review required')
        flags.push('manual_review_required')
        score += 20  // base credit for unverifiable categories
    } else {
        try {
            const searchQuery = `${name} ${location.city} ${location.country || ''}`
            const userLoc = coordinates?.lat ? { lat: coordinates.lat, lng: coordinates.lng } : null
            const places = await googleService.findPlaces(searchQuery, userLoc, 'biz-verify')
            if (!places?.length) {
                sources.push('Not found on Google Places — business may be new or unlisted')
                flags.push('not_found_on_google')
            } else {
                const details = await googleService.getPlaceDetails(places[0].place_id, true, 'biz-verify')
                if (details) {
                    googlePlaceId = details.place_id
                    googleName = details.name
                    googleAddress = details.formatted_address
                    googleRating = details.rating
                    // Name match (15 pts)
                    const nameScore = nameSimilarity(name, details.name)
                    const namePts = Math.round(nameScore * 15)
                    score += namePts
                    if (nameScore >= 0.85) sources.push(`Name matches Google: "${details.name}"`)
                    else { sources.push(`Name mismatch — Google has: "${details.name}"`); flags.push('name_mismatch') }
                    // Location (15 pts)
                    const gCoords = details.geometry?.location
                    if (gCoords?.lat && gCoords?.lng && coordinates?.lat) {
                        const dist = distMetersSimple(coordinates.lat, coordinates.lng, gCoords.lat, gCoords.lng)
                        if (dist <= 100) { score += 15; sources.push(`Location matches Google within ${Math.round(dist)}m`) }
                        else if (dist <= 300) { score += 10; sources.push(`Location close to Google (${Math.round(dist)}m)`) }
                        else if (dist <= 600) { score += 5; sources.push(`Location differs from Google by ${Math.round(dist)}m`); flags.push('location_offset') }
                        else { sources.push(`Location far from Google (${Math.round(dist)}m)`); flags.push('location_mismatch') }
                    } else { score += 8; sources.push('Location coordinates unavailable for comparison') }
                    // Phone (10 pts)
                    const submittedPhone = contact?.phone?.replace(/[^0-9]/g, '')
                    const googlePhone = details.international_phone_number?.replace(/[^0-9]/g, '') || details.formatted_phone_number?.replace(/[^0-9]/g, '')
                    if (submittedPhone && googlePhone) {
                        if (submittedPhone === googlePhone || submittedPhone.endsWith(googlePhone.slice(-8)) || googlePhone.endsWith(submittedPhone.slice(-8))) { score += 10; sources.push('Phone number matches Google') } 
                        else { score += 2; sources.push(`Phone mismatch — submitted: ${contact.phone}, Google: ${details.international_phone_number || details.formatted_phone_number}`); flags.push('phone_mismatch') }
                    } else { score += 5; sources.push('Phone not available for comparison') }
                    // Images
                    const photos = (details.photos || []).slice(0, 8)
                    if (photos.length && googlePlaceId) {
                        try {
                            await imageStorageService.downloadAndStoreImages(googlePlaceId, photos, 8, 'biz-verify')
                            googleImages = photos.map((_, i) => `/api/media/places/${googlePlaceId}/photo/${i}`)
                        } catch (imgErr) {
                            console.warn('Failed to download Google images:', imgErr.message)
                            // Download failed → nothing cached to proxy. Omit rather
                            // than emit a direct Google URL, which would leak the API
                            // key to the client and fail the key's IP restriction.
                            googleImages = []
                        }
                    }
                    if (googleRating) sources.push(`Google rating: ${googleRating}`)
                }
            }
        } catch (err) {
            console.error('Google verification failed:', err.message)
            sources.push('Google verification unavailable')
            flags.push('google_unavailable')
            score += 10
        }
    }
    // ── Source 2: Website check (20 pts) ────────────────────────
    const websiteResult = await checkWebsite(contact?.website, name)
    if (websiteResult.checked) {
        if (websiteResult.found) { score += 20; sources.push(websiteResult.note) }
        else { sources.push(websiteResult.note); if (!websiteResult.found) flags.push('website_name_mismatch') }
    }
    // ── Source 3: TripAdvisor check (20 pts) ────────────────────
    const taResult = await checkTripAdvisor(contact?.socialMedia?.tripadvisor, name)
    if (taResult.checked) {
        if (taResult.found) { score += 20; sources.push(taResult.note) }
        else { sources.push(taResult.note); flags.push('tripadvisor_mismatch') }
    }
    // ── Source 4: Instagram existence (10 pts) ──────────────────
    const igResult = await checkInstagram(contact?.socialMedia?.instagram)
    if (igResult.checked) {
        if (igResult.found) { score += 10; sources.push(igResult.note) }
        else sources.push(igResult.note)
    }
    // ── Source 5: Phone country code sanity (10 pts) ─────────────
    if (contact?.phone) {
        const phone = contact.phone.replace(/[^0-9+]/g, '')
        const countryCodeMap = { 'Armenia': '+374', 'France': '+33', 'Germany': '+49', 'United Kingdom': '+44', 'USA': '+1', 'United States': '+1', 'Russia': '+7', 'UAE': '+971' }
        const expectedPrefix = countryCodeMap[location?.country]
        if (expectedPrefix && phone.startsWith(expectedPrefix.replace('+', ''))) {score += 10; sources.push(`Phone country code matches ${location.country}`)} 
        else if (expectedPrefix) {sources.push(`Phone country code may not match ${location.country}`); flags.push('phone_country_mismatch')} 
        else {score += 5}
    }
    score = Math.min(100, Math.max(0, score))
    // Summary of what was checked
    const checkedSources = [isVerifiable ? 'Google Places' : null, contact?.website ? 'Website' : null, contact?.socialMedia?.tripadvisor ? 'TripAdvisor' : null, contact?.socialMedia?.instagram ? 'Instagram' : null, contact?.phone ? 'Phone' : null].filter(Boolean)
    return {score, notes: sources.join(' | '), flags, googleImages, googlePlaceId, googleName, googleAddress, googleRating, checkedSources}
}
function calcTrend(weeklyArr) {
    if (!weeklyArr || weeklyArr.length < 2) return 0
    const prev = weeklyArr[weeklyArr.length - 2] || 0
    const curr = weeklyArr[weeklyArr.length - 1] || 0
    if (prev === 0) return curr > 0 ? 100 : 0
    return Math.round(((curr - prev) / prev) * 100)
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────
/**
 * GET /api/business
 * Admin — list businesses with filters.
 * Query params: status, tier, city, page, limit
 */
router.get('/', auth, async (req, res) => {
    try {
        const { status = 'pending', tier, city, page = 1, limit = 20 } = req.query
        if (!isStaffOrAdmin(req.user)) return res.status(403).json({ error: 'Staff or admin access required' })

        // ── Apply staff territorial scope ──────────────────────────────
        // Staff sees only businesses in their assigned countries/cities.
        // Admins get an empty filter (sees everything). Unassigned staff
        // gets an empty queue rather than the global pending list.
        const scope = await buildStaffScopeFilter(req.user)

        // Diagnostic log — runs for every staff request, before the early
        // return for null scope, so we can see exactly which branch fired.
        if (req.user.role === 'staff') {
            const a = req.user.staffAssignment || {}
            console.log('[staff-scope]', req.user.email || req.user.id, {
                hadAssignmentOnReqUser: !!req.user.staffAssignment,
                jwtPayloadKeys: Object.keys(req.user || {}),
                resolvedCountries: a.countries,
                resolvedCities: a.cities,
                scopeFilter: scope === null ? 'NULL (treated as no-scope)' : scope,
            })
        }

        if (scope === null) {
            return res.json({
                success: true,
                businesses: [],
                total: 0,
                page: Number(page),
                limit: Number(limit),
                noScope: true
            })
        }

        const filter = { isActive: true, ...scope }
        if (status !== 'all') filter.status = status
        if (tier) filter['partnership.tier'] = tier
        if (city) filter['location.city'] = { $regex: new RegExp(city.trim(), 'i') }

        const total = await Business.countDocuments(filter)
        const docs = await Business.find(filter)
            .select('name type location contact description images uploadedImages pricing openingHours partnership status verification analytics zoneKey waitlist auction owner isActive isHiddenGem createdAt updatedAt eventSchedule')
            .populate('owner', 'name email role')
            .populate('verification.verifiedBy', 'name email role')
            .populate('verification.history.by', 'name email role')
            .sort({ createdAt: -1 })
            .skip((Number(page) - 1) * Number(limit))
            .limit(Number(limit))
            .lean()

        // ── Strip raw image bytes from uploadedImages ─────────────────
        // The `uploadedImages` subdoc carries a Buffer per record (the
        // actual file). The staff drawer only needs metadata (size, dims,
        // mime, storedAt). Returning the buffers would balloon payloads
        // by megabytes per listing for no benefit — staff views the file
        // through the public image URL/route, not from this JSON.
        for (const b of docs) {
            if (Array.isArray(b.uploadedImages)) {
                b.uploadedImages = b.uploadedImages.map(u => ({
                    contentType: u.contentType,
                    width:       u.width,
                    height:      u.height,
                    sizeBytes:   u.sizeBytes,
                    storedAt:    u.storedAt,
                }))
            }
        }

        // ── Priority sort (in-memory) ──────────────────────────────────
        // Bubble businesses in the staff member's priority countries/cities
        // to the top while preserving createdAt order within each group.
        // Done in memory because limit is small (≤20) and an aggregation
        // pipeline for this is overkill.
        const a = req.user.staffAssignment || {}
        const priorityCountries = (a.priorityCountries || []).map(s => s.toLowerCase())
        const priorityCities    = (a.priorityCities    || []).map(s => s.toLowerCase())
        const isPriority = b =>
            priorityCountries.includes((b.location?.country || '').toLowerCase()) ||
            priorityCities.includes((b.location?.city || '').toLowerCase())
        const businesses = priorityCountries.length || priorityCities.length
            ? [...docs].sort((x, y) => Number(isPriority(y)) - Number(isPriority(x)))
            : docs

        res.json({ success: true, businesses, total, page: Number(page), limit: Number(limit) })
    } catch (err) {
        console.error('Business list error:', err)
        res.status(500).json({ error: 'Failed to fetch businesses' })
    }
})

router.get('/zone-check', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
        const { lat, lng, category, tier = 'verified', city } = req.query
        // console.log(`[zone-check] >>> REQUEST RECEIVED lat=${lat} lng=${lng} category=${category} tier=${tier} city=${city}`)
        if (!lat || !lng || !category) {return res.status(400).json({ error: 'lat, lng, and category are required' })}
        const centerLat = parseFloat(lat)
        const centerLng = parseFloat(lng)
        // ── Events: compete by time window within 300m radius ────────────────────────
        // Same 3-slot rule as geographic zones — but "same zone" means same area + overlapping dates.
        if (category === 'events') {
            const { startDate, endDate, isRecurring, interests } = req.query
            // No dates yet — return event mode flag only
            if (!startDate) {
                return res.json({
                    success: true,
                    eventMode: true,
                    timezone: resolveTimezone({ lat: centerLat, lng: centerLng }),
                    slots: { total: 0, remaining: 3, breakdown: { verified: 0, spotlight: 0, signature: 0 } },
                    resolution: { canEnter: true, displaces: false, waitlisted: false },
                    overlappingEvents: [],
                    earliestExpiry: null,
                    message: 'Select your event dates to check slot availability.'
                })
            }
            // Run overlap check
            const incomingTypes = interests ? interests.split(',').filter(Boolean) : []
            const overlapping = await getOverlappingEvents(centerLat, centerLng, { startDate, endDate: endDate || startDate, isRecurring: isRecurring === 'true' }, incomingTypes)
            // Build mock array for resolveZoneEntry — same shape it expects
            const mockForResolution = overlapping.map(e => ({_id: e._id, name: e.name, partnership: { tier: e.partnership?.tier || 'verified' }, analytics: { performanceScore: e.analytics?.performanceScore ?? 50 }}))
            const resolution = resolveZoneEntry(mockForResolution, tier)
            const slots = {
                total:     overlapping.length,
                remaining: Math.max(0, ZONE_MAX_SLOTS - overlapping.length),
                breakdown: {
                    verified:  overlapping.filter(e => e.partnership?.tier === 'verified').length,
                    spotlight: overlapping.filter(e => e.partnership?.tier === 'spotlight').length,
                    signature: overlapping.filter(e => e.partnership?.tier === 'signature').length
                }
            }
            // Earliest expiry for waitlist display — future-dated only, so a
            // lapsed-but-still-active listing can't surface a past date.
            let earliestExpiry = null
            if (resolution.waitlisted) {
                const now = Date.now()
                const earliest = overlapping
                    .filter(e => e.partnership?.subscriptionEnd && new Date(e.partnership.subscriptionEnd).getTime() > now)
                    .sort((a, b) => new Date(a.partnership.subscriptionEnd) - new Date(b.partnership.subscriptionEnd))[0]
                earliestExpiry = earliest?.partnership?.subscriptionEnd ?? null
            }
            return res.json({
                success: true,
                eventMode: true,
                timezone: resolveTimezone({ lat: centerLat, lng: centerLng }),
                slots,
                resolution,
                overlappingEvents: overlapping.map(e => ({
                    name: e.name,
                    tier: e.partnership?.tier,
                    sharedInterests: e.sharedInterests,
                    interestMatch: e.interestMatch,
                    performanceScore: e.analytics?.performanceScore ?? 0
                })),
                earliestExpiry,
                hasConflict: overlapping.length > 0,
                message: overlapping.length === 0 ? 'No events in this area overlap your dates — you\'ll be the first.' : `${overlapping.length} event${overlapping.length > 1 ? 's' : ''} overlap your dates in this area.`
            })
        }
        const zoneRadiusM = ZONE_RADIUS_M[category] ?? 200  // per-category radius
        const zoneKey = Business.buildZoneKey(category, centerLat, centerLng)
        const statusFilter = { $or: [{ status: 'active' }, { status: 'pending' }, { status: { $exists: false } }] }
        // console.log(`[zone-check] lat=${centerLat} lng=${centerLng} category=${category} tier=${tier} radius=${zoneRadiusM}m`)
        // ── Fetch all candidates from the city ───────────────────────────────────────
        // Stored coordinates are unreliable (may come from Google or other geocoders).
        // We fetch by city name, then re-geocode each address via Nominatim — the same
        // geocoder the frontend uses — so distances are consistent.
        const GEO_DELTA = 0.027  // ~3km bounding box as a secondary filter
        // NOTE: the previous version had two `$or` keys in the same object —
        // `...statusFilter` set one and the literal `$or: [<coord>, <city>]`
        // immediately overwrote it. The status filter was silently dropped, so
        // the query matched businesses regardless of status (including
        // `frozen`, `rejected`, `expired`). This produced a zone-check that
        // counted frozen businesses as zone occupants and prompted the
        // onboarding view to offer "displace the frozen one" — wrong.
        // Combining both conditions with `$and` keeps both filters applied.
        const candidates = await Business.find({
            isActive: true,
            type: { $elemMatch: { $eq: category } },
            $and: [
                statusFilter,
                {
                    $or: [
                        {
                            'location.coordinates.lat': { $gte: centerLat - GEO_DELTA, $lte: centerLat + GEO_DELTA },
                            'location.coordinates.lng': { $gte: centerLng - GEO_DELTA, $lte: centerLng + GEO_DELTA }
                        },
                        { 'location.city': { $regex: new RegExp((city || '').trim(), 'i') } }
                    ]
                }
            ]
        }).select('name type partnership.tier analytics.performanceScore location zoneKey status').lean()
        // console.log(`[zone-check] candidates: ${candidates.length}`)
        // ── Re-geocode each candidate via Nominatim ──────────────────────────────────
        function distMeters(lat1, lng1, lat2, lng2) {
            const R = 6371000
            const dLat = (lat2 - lat1) * Math.PI / 180
            const dLng = (lng2 - lng1) * Math.PI / 180
            const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
        }
        async function nominatimGeocode(address, city, country) {
            const q = [address, city, country].filter(Boolean).join(', ')
            const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
            // console.log(`[zone-check] nominatim geocoding: "${q}"`)
            try {
                const r = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'Jinni-ZoneCheck/1.0' } })
                // console.log(`[zone-check] nominatim response status: ${r.status}`)
                const data = await r.json()
                // console.log(`[zone-check] nominatim result count: ${data.length}`)
                if (!data.length) return null
                return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
            } catch (e) { 
                console.error(`[zone-check] nominatim FETCH FAILED:`, e.message)
                return null 
            }
        }
        const geocoded = await Promise.all(candidates.map(async b => ({b, coords: await nominatimGeocode(b.location.address, b.location.city, b.location.country)})))
        // ── Bucket into zone competitors vs city-only map markers ────────────────────
        // ── Use stored coordinates instead of re-geocoding via Nominatim ──
        const zoneBusinesses = []
        const cityBusinesses = []
        for (const b of candidates) {
            const coords = b.location?.coordinates
            if (!coords?.lat || !coords?.lng) {
                // console.log(`[zone-check] no stored coords: ${b.name}`)
                continue
            }
            const dist = distMeters(centerLat, centerLng, coords.lat, coords.lng)
            const tier_b = b.partnership?.tier || 'verified'
            // console.log(`[zone-check] ${b.name}: ${Math.round(dist)}m tier=${tier_b}`)
            const entry = {
                name: b.name,
                tier: tier_b,
                // Nested shapes so the staff drawer (b.partnership?.tier /
                // b.analytics?.performanceScore) renders tier + score instead of
                // showing '—' and 'score 0'.
                partnership: { tier: tier_b },
                analytics: { performanceScore: b.analytics?.performanceScore ?? 0 },
                status: b.status || null,
                lat: coords.lat,
                lng: coords.lng,
                address: b.location.address || '',
                city: b.location.city || '',
                country: b.location.country || '',
                inZone: dist <= zoneRadiusM
            }
            if (dist <= zoneRadiusM) {zoneBusinesses.push({ ...entry, _raw: b })} 
            else {cityBusinesses.push(entry)}
        }
        // console.log(`[zone-check] inZone=${zoneBusinesses.length} cityOnly=${cityBusinesses.length}`)
        zoneBusinesses.forEach(b => console.log(`  [IN ZONE] ${b.name} tier=${b.tier}`))
        // ── Slot count + resolution ──────────────────────────────────────────────────
        const slots = {
            total:     zoneBusinesses.length,
            verified:  zoneBusinesses.filter(b => b.tier === 'verified').length,
            spotlight: zoneBusinesses.filter(b => b.tier === 'spotlight').length,
            signature: zoneBusinesses.filter(b => b.tier === 'signature').length,
            remaining: Math.max(0, ZONE_MAX_SLOTS - zoneBusinesses.length)
        }
        const mockForResolution = zoneBusinesses.map(({ _raw }) => ({_id: _raw._id, name: _raw.name, partnership: { tier: _raw.partnership?.tier || 'verified' }, analytics: { performanceScore: _raw.analytics?.performanceScore ?? 50 }, status: _raw.status}))
        const resolution = resolveZoneEntry(mockForResolution, tier)
        // console.log(`[zone-check] slots=${JSON.stringify(slots)} canEnter=${resolution.canEnter} displaces=${resolution.displaces} waitlisted=${resolution.waitlisted}`)
        // ── Earliest expiry + auction high bid — only when waitlisted ────────────────
        let earliestExpiry = null
        let currentHighBid = null
        if (resolution.waitlisted) {
            // Earliest *future* subscriptionEnd among active Signatures in this
            // zone. The `$gt: now` filter matters because lapsed subscriptions
            // aren't swept to 'expired' (no cron), so without it a past date
            // leaks into the auction panel. Scoped to Signatures since only
            // they hold auction-contested slots.
            const earliest = await Business.findOne(
                {
                    zoneKey,
                    status: 'active',
                    'partnership.tier': 'signature',
                    'partnership.subscriptionEnd': { $gt: new Date() }
                },
                { 'partnership.subscriptionEnd': 1 }
            ).sort({ 'partnership.subscriptionEnd': 1 }).lean()
            earliestExpiry = earliest?.partnership?.subscriptionEnd ?? null
            // Live high bid in this zone's auction, so the form can advise the bidder.
            try { currentHighBid = await zoneAuction.getHighBid(zoneKey) }
            catch (e) { console.warn('[zone-check] getHighBid failed:', e.message) }
        }
        res.json({
            success: true,
            zoneKey,
            zoneRadiusM,
            slots: {
                total: slots.total,
                remaining: slots.remaining,
                breakdown: { verified: slots.verified, spotlight: slots.spotlight, signature: slots.signature }
            },
            resolution,
            businesses: zoneBusinesses.map(({ _raw, ...rest }) => rest),
            cityBusinesses,
            earliestExpiry,
            currentHighBid,
            auctionFloor: zoneAuction.SIGNATURE_FLOOR
        })
    } catch (err) {
        console.error('[zone-check] FATAL ERROR:', err)
        console.error('[zone-check] Stack:', err.stack)
        res.status(500).json({ 
            error: 'Zone check failed',
            detail: err.message,  // TEMP: remove after debugging
            stack: err.stack?.split('\n').slice(0, 5)  // TEMP: remove after debugging
        })
    }
})
/**
 * GET /api/business/zone-intelligence/:id
 * Signature-only. Returns competitive intelligence for the business's zone:
 *   - Zone rank by performanceScore
 *   - Traffic share (% of zone clicks this business captured this week)
 *   - Anonymised competitor score/traffic bands (never exact values)
 *   - Opportunity days — days where zone traffic spikes but this business underperforms
 *   - Map data (coords + radius)
 *   - profileCompleteness — 0–100 score powering the "Boost your score" tip in Opportunity Window
 *   - waitlistCount + earliestExpiry — businesses queued for this zone and when the next slot opens
 *   - eventConflicts — number of overlapping events in zone (events category only)
 */
router.get('/zone-intelligence/:id', auth, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id).lean()
        if (!business) return res.status(404).json({ error: 'Business not found' })

        // ── Auth: owner or admin only ────────────────────────────────
        const requesterId = req.user.id || req.user._id?.toString()
        if (business.owner?.toString() !== requesterId && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }

        // ── Signature gate ───────────────────────────────────────────
        if (business.partnership?.tier !== 'signature') {
            return res.status(403).json({ error: 'Zone Intelligence is a Signature-only feature' })
        }

        if (!business.zoneKey) {
            return res.status(404).json({ error: 'No zone assigned yet — listing may still be pending' })
        }

        // ── Fetch active zone competitors (real slot holders only) ───
        const zoneBusinesses = await getZoneBusinesses(business.zoneKey, { occupantsOnly: true })
        const zoneActive = zoneBusinesses.filter(b =>
            b._id.toString() !== req.params.id
        )

        // ── Zone rank: rank by performanceScore descending ───────────
        const allInZone = [...zoneActive, {
            _id: business._id,
            partnership: { tier: business.partnership.tier },
            analytics: { performanceScore: business.analytics?.performanceScore ?? 0 }
        }].sort((a, b) => (b.analytics?.performanceScore ?? 0) - (a.analytics?.performanceScore ?? 0))

        const rank = allInZone.findIndex(b => b._id.toString() === req.params.id) + 1
        const totalInZone = allInZone.length

        // ── Traffic share this week ──────────────────────────────────
        // Use weeklyClicks[-1] as this-week proxy.
        // Sum across all zone businesses; compute % share for this business.
        const myClicks = (business.analytics?.weeklyClicks || []).slice(-1)[0] ?? 0
        const totalZoneClicks = zoneActive.reduce((sum, b) => {
            const c = (b.analytics?.weeklyClicks || []).slice(-1)[0] ?? 0
            return sum + c
        }, myClicks)
        const trafficShare = totalZoneClicks > 0
            ? Math.round((myClicks / totalZoneClicks) * 100)
            : (totalInZone > 0 ? Math.round(100 / totalInZone) : 100)

        // Week-over-week delta
        const myClicksPrev   = (business.analytics?.weeklyClicks || []).slice(-2, -1)[0] ?? myClicks
        const zoneClicksPrev = zoneActive.reduce((sum, b) => {
            const c = (b.analytics?.weeklyClicks || []).slice(-2, -1)[0] ?? 0
            return sum + c
        }, myClicksPrev)
        const sharePrev = zoneClicksPrev > 0
            ? Math.round((myClicksPrev / zoneClicksPrev) * 100)
            : trafficShare
        const trafficShareDelta = trafficShare - sharePrev

        // ── Competitor profiles (anonymised) ─────────────────────────
        // Return score/traffic as a ±10 band so exact values are never exposed.
        // Include address+city so the frontend map can geocode them.
        const competitors = zoneActive.map(comp => {
            const score = comp.analytics?.performanceScore ?? 50
            // Fuzz score into a band (±8, clamped 0–100, never exact)
            const lo = Math.max(0,   score - 8)
            const hi = Math.min(100, score + 8)

            // Competitor traffic share — fuzz similarly
            const compClicks = (comp.analytics?.weeklyClicks || []).slice(-1)[0] ?? 0
            const compShare  = totalZoneClicks > 0
                ? Math.round((compClicks / totalZoneClicks) * 100)
                : Math.round(100 / totalInZone)
            const shareLo = Math.max(0,   compShare - 5)
            const shareHi = Math.min(100, compShare + 5)

            // Interest overlap with THIS business.
            // Both numerator (intersection size) and denominator (union size) must be
            // symmetric so that "X/Y interests shared" matches when the same pair is
            // viewed from either side's dashboard. Previously the denominator was
            // compInterests.length, which made the ratio depend on the viewer.
            const myInterests   = new Set((business.type || []).filter(t => INTEREST_TAGS.includes(t)))
            const compInterests = (comp.type || []).filter(t => INTEREST_TAGS.includes(t))
            const interestOverlap = compInterests.filter(t => myInterests.has(t)).length
            const interestUnion   = new Set([...myInterests, ...compInterests]).size

            return {
                name:               comp.name || '',
                tier:               comp.partnership?.tier || 'verified',
                scoreRange:         [lo, hi],
                trafficShareRange:  [shareLo, shareHi],
                interestOverlap,
                totalInterests:     interestUnion,
                lat:                comp.location?.coordinates?.lat  ?? null,
                lng:                comp.location?.coordinates?.lng  ?? null,
                city:               comp.location?.city    || '',
                country:            comp.location?.country || '',
            }
        })

        // Count signatures in zone (excluding self) — used by frontend for displacement warning
        const signatureCount = zoneActive.filter(b => b.partnership?.tier === 'signature').length

        // ── Displacement risk derivation ──────────────────────────────
        // A Signature is only at real displacement risk when:
        //   (a) the zone is full of Signatures (signatureCount + 1 >= 3), AND
        //   (b) this business is the LOWEST-scoring Signature in the zone.
        // The competitor scoreRange exposed to the client is fuzzed by ±8, so the
        // client can't reliably compute "am I last among Signatures?" itself.
        // We compute it here against raw scores and ship a single boolean.
        const myScoreRaw = business.analytics?.performanceScore ?? 0
        const allSignatures = [
            ...zoneActive.filter(b => b.partnership?.tier === 'signature'),
            { _id: business._id, analytics: { performanceScore: myScoreRaw } }
        ].sort((a, b) => (b.analytics?.performanceScore ?? 0) - (a.analytics?.performanceScore ?? 0))

        const signatureRank = allSignatures.findIndex(b => b._id.toString() === req.params.id) + 1
        const totalSignatures = allSignatures.length
        // Only the bottom Signature in a 3-Signature zone is genuinely displaceable.
        // In a non-full or mixed-tier zone, even the lowest Signature is safe — a new
        // Signature would displace the lowest Verified/Spotlight first (see resolveZoneEntry).
        const isLowestSignature = totalSignatures >= 3 && signatureRank === totalSignatures

        // ── Opportunity days ─────────────────────────────────────────
        // Identifies weeks where zone traffic was elevated but this business
        // captured less than its fair share — actionable gaps the owner can target.
        //
        // Data strategy:
        //   Primary:  weeklyClicks  (direct intent signal)
        //   Fallback: weeklyViews   (used when clicks are all-zero — common for new listings)
        //
        // The fallback matters because a new Signature may have weeks of view data
        // before it accumulates any clicks, and we still want to surface patterns.
        //
        // Threshold:
        //   Normal (≥4 weeks of data): idx > 110 — zone must be 10%+ above average
        //   Sparse  (<4 weeks of data): idx > 100 — any above-average week qualifies,
        //     since we don't have enough history to establish a meaningful baseline.
        //
        // Note: weeklyClicks/weeklyViews store weekly totals, not daily breakdowns.
        // We map each week → the calendar day of the week it ended (most recent = this week).
        // This is an approximation; per-day storage would make this exact.

        const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
        const fairShare = totalInZone > 0 ? Math.round(100 / totalInZone) : 100

        // Choose the best available signal: clicks first, fall back to views if clicks are all zero
        function pickSignal(analyticsObj) {
            const clicks = (analyticsObj?.weeklyClicks || []).slice(-8)
            const hasClickData = clicks.some(v => v > 0)
            if (hasClickData) return clicks
            const views = (analyticsObj?.weeklyViews || []).slice(-8)
            return views
        }

        const myWeekly   = pickSignal(business.analytics)
        const zoneWeekly = myWeekly.map((_, i) => {
            return zoneActive.reduce((sum, b) => {
                const compWeekly = pickSignal(b.analytics)
                return sum + (compWeekly[i] ?? 0)
            }, myWeekly[i] ?? 0)
        })

        // Weeks with any non-zero data
        const nonZeroWeeks = zoneWeekly.filter(v => v > 0).length
        // Softer threshold when data history is thin (fewer than 4 populated weeks)
        const idxThreshold = nonZeroWeeks >= 4 ? 110 : 100

        const avgZone = zoneWeekly.reduce((s, v) => s + v, 0) / Math.max(zoneWeekly.length, 1)
        const opportunityDays = []

        myWeekly.forEach((myW, i) => {
            const zoneW = zoneWeekly[i] ?? 0
            if (zoneW === 0) return
            const idx   = Math.round((zoneW / Math.max(avgZone, 1)) * 100)
            const share = Math.round((myW / zoneW) * 100)
            // Map week index → calendar day label (week 0 = oldest, last = most recent)
            const weekAgo = myWeekly.length - 1 - i
            const date = new Date(); date.setDate(date.getDate() - weekAgo * 7)
            const dayName = DAY_NAMES[date.getDay()]
            if (idx > idxThreshold && share < fairShare) {
                // Deduplicate by day name — keep highest-traffic occurrence
                const existing = opportunityDays.find(d => d.day === dayName)
                if (!existing || idx > existing.zoneTrafficIndex) {
                    if (existing) opportunityDays.splice(opportunityDays.indexOf(existing), 1)
                    opportunityDays.push({ day: dayName, zoneTrafficIndex: idx, yourSharePct: share })
                }
            }
        })
        // Sort by zone traffic index descending, cap at 3
        opportunityDays.sort((a, b) => b.zoneTrafficIndex - a.zoneTrafficIndex)
        opportunityDays.splice(3)

        // ── Map data ─────────────────────────────────────────────────
        const coords = business.location?.coordinates?.lat
            ? { lat: business.location.coordinates.lat, lng: business.location.coordinates.lng }
            : null

        const mainCat = business.type?.find(t => Object.keys(ZONE_RADIUS_M).includes(t)) || 'restaurants'

        // ── Profile completeness ──────────────────────────────────────
        // Re-use the same 5-pillar logic from buildScoreBreakdown so the
        // "Complete your listing" tip in the Opportunity Window reflects the
        // real completeness score the business owner can act on.
        const profileCompleteness = buildScoreBreakdown(business.analytics || {}, business).completeness

        // ── Zone Auction queue ────────────────────────────────────────
        // Count businesses bidding for this zone (the Zone Auction bid book)
        // and surface the current high bid so the owner sees the threat level.
        const bidBook = await zoneAuction.getBidBook(business.zoneKey)
        const waitlistCount  = bidBook.length
        const currentHighBid = bidBook.length ? (bidBook[0].auction?.maxBid ?? null) : null
        // Earliest renewal among the sitting Signatures — when the next slot is
        // contested. Future-dated only: lapsed-but-unsweb subscriptions must not
        // surface a past date here (no cron expires them).
        const zoneSigs = await zoneAuction.getZoneSignatures(business.zoneKey)
        const _nowMs = Date.now()
        const earliestExpiry = zoneSigs.length
            ? zoneSigs
                .map(b => b.partnership?.subscriptionEnd)
                .filter(d => d && new Date(d).getTime() > _nowMs)
                .sort((a, b) => new Date(a) - new Date(b))[0]
                ?.toISOString?.().split('T')[0] ?? null
            : null

        // ── Event conflicts ───────────────────────────────────────────
        // Only meaningful for event-category businesses. Reuses the same
        // getOverlappingEvents() helper that the zone-check endpoint calls,
        // so conflict detection is consistent across the whole system.
        let eventConflicts = 0
        if (mainCat === 'events' && business.eventSchedule?.startDate && coords) {
            try {
                const overlapping = await getOverlappingEvents(
                    coords.lat,
                    coords.lng,
                    business.eventSchedule,
                    business.type || []
                )
                // Exclude self in case the business appears in the geo-search results
                eventConflicts = overlapping.filter(
                    b => b._id?.toString() !== req.params.id
                ).length
            } catch (err) {
                console.error('[zone-intelligence] eventConflicts query failed:', err.message)
                // Non-fatal — eventConflicts stays 0
            }
        }

        res.json({
            rank,
            totalInZone,
            trafficShare,
            trafficShareDelta,
            yourScore:         business.analytics?.performanceScore ?? 0,
            competitors,
            signatureCount,
            signatureRank,
            totalSignatures,
            isLowestSignature,
            opportunityDays,
            zoneCategory:      mainCat,
            zoneCity:          business.location?.city || '',
            coords,
            zoneRadiusM:       ZONE_RADIUS_M[mainCat] ?? 300,
            profileCompleteness,
            waitlistCount,
            currentHighBid,
            earliestExpiry,
            eventConflicts,
        })
    } catch (err) {
        console.error('[zone-intelligence] error:', err)
        res.status(500).json({ error: 'Failed to load zone intelligence' })
    }
})

/**
 * POST /api/business/apply
 * Full business registration flow:
 * 1. Run AI pre-verification
 * 2. Geocode is assumed done on frontend — coords expected in body
 * 3. Build zone key and resolve zone entry
 * 4. Save business with appropriate status
 * 5. If displaces someone — freeze them and notify
 * 6. Queue for staff review
 */
const conditionalUpload = (req, res, next) => {
    if (req.is('multipart/form-data')) {return applyUpload.array('images', 8)(req, res, next)}
    next()
}
router.post('/apply', applyLimiter, conditionalUpload, async (req, res) => {
    // console.log('[apply] content-type:', req.headers['content-type'])
    // console.log('[apply] body:', JSON.stringify(req.body))
    // console.log('[apply] body.name:', req.body?.name)
    try {
        // When files are present the Vue sends payload as JSON in req.body.data,
        // otherwise it's a plain JSON body. Support both transparently.
        const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body
        const {
            tier = 'verified',
            name,
            type,
            description,
            location,
            contact,
            pricing,
            images,
            isHiddenGem,
            coordinates,   // { lat, lng } — geocoded on frontend from Nominatim
            eventSchedule, // { startDate, endDate, isRecurring } — events only
            openingHours,  // { is24Hours, days:[{day,closed,open,close}] } — spotlight/signature
            bidAmount      // $/month — Signature applying into a full 3-Signature zone (Zone Auction)
        } = bodyData
        // ── 1. Basic validation ──────────────────────────────────
        if (!name || !type?.length || !location?.city || !location?.address) {return res.status(400).json({ error: 'Missing required fields' })}
        // 'historical' stays accepted server-side for existing rows/back-compat,
        // but the onboarding UI no longer offers it. Shop sub-types are primary
        // categories here (no 'shopping' umbrella, no self-serve 'mall').
        const mainCategories = ['restaurants', 'hotels', 'events', 'historical', 'hidden_gems', 'souvenirs', 'clothing', 'market', 'jewelry', 'food']
        const mainCategory = type.find(t => mainCategories.includes(t))
        if (!mainCategory) {return res.status(400).json({ error: 'A main business category is required' })}
        // ── Server-side tier enforcement ────────────────────────────────────
        // The tier value comes from the client — we must enforce all tier-specific
        // limits here regardless of what the frontend sent, to prevent spoofing.
        // TEMPORARY: subscriptions are not configured yet — paid tiers cannot be
        // purchased, so reject them outright. Remove when payments go live
        // (also flip PAID_TIERS_LOCKED in BusinessOnboarding.vue).
        if (tier !== 'verified') {
            return res.status(400).json({ error: 'Paid subscriptions are under work — only the free Verified tier is available right now' })
        }
        // Hidden Gem only allowed for signature
        if (isHiddenGem && tier !== 'signature') {return res.status(400).json({ error: 'Hidden Gem status requires Signature tier' })}
        // Strip hidden_gems from type array if not signature
        if (tier !== 'signature' && Array.isArray(type)) {
            const idx = type.indexOf('hidden_gems')
            if (idx !== -1) type.splice(idx, 1)
        }
        // Highlights — signature only, max 5
        if (description?.highlights?.length) {
            if (tier !== 'signature') description.highlights = []
            else description.highlights = description.highlights.slice(0, 5)
        }
        // Description length limits
        if (description?.short && tier === 'spotlight' && description.short.length > 300) {
            description.short    = description.short.slice(0, 300)
            description.detailed = description.detailed?.slice(0, 300)
        }
        // Social media — signature only
        if (tier !== 'signature' && contact?.socialMedia) {contact.socialMedia = {}}
        // Images — verified gets none from user, spotlight max 8 URLs (no files), signature max 8
        if (tier === 'verified') {
            // images will be overwritten by AI Google images below — safe
        }
        // Opening hours — spotlight + signature only
        if (tier === 'verified' && openingHours !== undefined) {
            // Ignore any opening hours sent for verified tier
        }
        // Events require a start date
        const isEvent = mainCategory === 'events'
        if (isEvent && !eventSchedule?.startDate) {return res.status(400).json({ error: 'Events require a start date' })}
        // ── Duplicate fingerprint check ─────────────────────────
        // Blocks same business re-registering via name+city or phone.
        // Catches resubmissions across ALL statuses (not just active) so a
        // rejected listing can't be quietly re-created from scratch — the
        // owner is funneled into edit-and-resubmit via their dashboard.
        const normalizedName    = name.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
        const normalizedAddress = location.address?.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
        const normalizedPhone   = contact?.phone?.trim().replace(/[^0-9]/g, '')
        const existingBusiness = await Business.findOne({
            $or: [
                // Same name + city
                {
                    name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                    'location.city': { $regex: new RegExp(location.city.trim(), 'i') }
                },
                // Same phone — catches same owner re-registering under a different name
                ...(normalizedPhone ? [{
                    'contact.phone': { $regex: new RegExp(normalizedPhone.slice(-8)) }
                }] : [])
            ]
        })
        if (existingBusiness) {
            // If THIS applicant is the same owner AND their previous listing
            // is rejected, they should be editing it on their dashboard, not
            // submitting a new application. Send a clear redirect signal so
            // the frontend can route them there.
            const sameOwnerEmail =
                existingBusiness.contact?.email?.toLowerCase() ===
                (contact?.email?.trim().toLowerCase() || '')
            if (sameOwnerEmail && existingBusiness.status === 'rejected') {
                return res.status(409).json({
                    error: 'You already have a rejected listing for this business. Please edit it from your dashboard instead of submitting a new application.',
                    existingBusinessId: existingBusiness._id,
                    redirect: '/business/dashboard'
                })
            }
            const reason = existingBusiness.name.toLowerCase() === normalizedName
                ? 'A business with this name already exists in this city'
                : 'A business registered with this phone number already exists'
            return res.status(400).json({ error: reason })
        }

        // ── Blocklist check ─────────────────────────────────────
        // Looks up email / phone / name+city / IP fingerprints. A 'block'
        // severity hit returns 403 with a deliberately generic message — we
        // never tell the applicant which field matched, otherwise they have
        // an evasion roadmap. 'watch' hits are allowed through but recorded
        // on the business document so staff sees a banner in the queue.
        const applyIp = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip
        const blocklistFingerprints = blocklistService.buildFingerprints({
            email: contact?.email,
            phone: contact?.phone,
            name,
            city: location.city,
            ip: applyIp
            // userId is not yet known — owner account is created below
        })
        const blocklistHits = await blocklistService.checkFingerprints(blocklistFingerprints)
        if (blocklistHits.some(h => h.severity === 'block')) {
            await blocklistService.recordHits(blocklistHits.map(h => h._id))
            return res.status(403).json({
                error: 'Application cannot be processed. Please contact support if you believe this is a mistake.'
            })
        }
        if (blocklistHits.length) {
            await blocklistService.recordHits(blocklistHits.map(h => h._id))
        }
        // ── Account creation ─────────────────────────────────────────────
        const contactEmail = contact?.email?.trim()
        const contactPhone = contact?.phone?.trim()
        const accountEmail = contactEmail || `${contactPhone.replace(/[^0-9]/g, '')}@business.jinni.app`
        let owner = await User.findOne({ email: accountEmail.toLowerCase() })
        let setupToken = null
        if (!owner) {
            // Generate a cryptographically secure setup token.
            // The account gets a random placeholder password — it can never be used
            // to log in because the owner must click the setup link to set their own.
            setupToken = crypto.randomBytes(32).toString('hex')
            const placeholderPassword = crypto.randomBytes(32).toString('hex') // never emailed
            owner = new User({
                email: accountEmail.toLowerCase(),
                password: placeholderPassword,        // hashed by pre('save') hook
                name: name.trim(),
                onboardingCompleted: true,
                passwordSetupToken:  setupToken,
                passwordSetupExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
            })
            await owner.save()
        } else {
            // Existing User — issue a fresh setup token so this applicant still
            // receives a password-setup link. Without this, anyone whose email
            // was already in the User collection (re-applications, prior
            // Jinni traveller accounts upgrading to a business, etc.) would
            // silently get no email at all and have no way to access the
            // dashboard for the business they just applied with.
            //
            // We always rotate the token so a leaked old token can't be reused,
            // and we DO NOT touch the existing password — the user can still
            // log in normally with whatever they had. The setup link is an
            // additional way in, scoped to a 24-hour window.
            setupToken = crypto.randomBytes(32).toString('hex')
            owner.passwordSetupToken  = setupToken
            owner.passwordSetupExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000)
            await owner.save()
        }
        // ── 2. Google Verification ───────────────────────────────
        const aiResult = await runGoogleVerification({ name, type, description, location, contact }, coordinates)
        // Use Google images for Verified tier (they can't upload their own)
        // For paid tiers, Google images are a fallback if none were submitted
        const finalImages = (tier === 'verified' || !images?.length) ? aiResult.googleImages : images
        // ── 3. Zone / time-overlap resolution ───────────────────
        let zoneKey = null
        let zoneResolution = { canEnter: true, displaces: false, waitlisted: false }
        if (isEvent) {
            // Events use the same 3-slot rule as geographic zones.
            // "Same zone" = same 300m area + overlapping time window.
            if (coordinates?.lat && coordinates?.lng && eventSchedule?.startDate) {
                const overlapping = await getOverlappingEvents(coordinates.lat, coordinates.lng,  {startDate: eventSchedule.startDate, endDate: eventSchedule.endDate, isRecurring: eventSchedule.isRecurring},  type || [])
                // Build mock array in the shape resolveZoneEntry expects
                const mockForResolution = overlapping.map(e => ({ _id: e._id, name: e.name, partnership: { tier: e.partnership?.tier || 'verified' }, analytics: { performanceScore: e.analytics?.performanceScore ?? 50 }}))
                zoneResolution = {
                    ...resolveZoneEntry(mockForResolution, tier),
                    // Preserve interest overlap data for staff notes
                    conflictingEvents: overlapping.map(e => ({name: e.name, tier: e.partnership?.tier, sharedInterests: e.sharedInterests, interestMatch: e.interestMatch, subscriptionEnd: e.partnership?.subscriptionEnd}))
                }
                // Use a pseudo zoneKey for events so waitlist targetZoneKey is set
                // Format: "events:lat:lng" using event-category grid step
                zoneKey = Business.buildZoneKey('events', coordinates.lat, coordinates.lng)
            }
        } else if (coordinates?.lat && coordinates?.lng) {
            zoneKey = Business.buildZoneKey(mainCategory, coordinates.lat, coordinates.lng)
            // Apply-time check is a non-binding GATE/PREVIEW: it includes `pending`
            // competitors on purpose, so a new applicant isn't waved in when a
            // slot is already contested. The applicant itself is not saved yet,
            // so it cannot contaminate its own count. The BINDING displacement
            // decision is re-run at approval time with { occupantsOnly: true }
            // and with the applicant excluded — see the /:id/approve route.
            const zoneBusinesses = await getZoneBusinesses(zoneKey)
            zoneResolution = resolveZoneEntry(zoneBusinesses, tier)
        }
        // ── 3b. Full-zone gating (Zone Auction model) ────────────
        // A Verified/Spotlight that cannot enter a full zone is BLOCKED outright —
        // no business document is created. The owner is told to upgrade their tier.
        if (zoneResolution.blocked) {
            return res.status(409).json({
                error: zoneResolution.message,
                blocked: true,
                mustUpgradeTo: zoneResolution.mustUpgradeTo || null
            })
        }
        // A Signature entering a full 3-Signature zone joins the Zone Auction and
        // must submit a max bid above the $49 floor. Reject early if it's missing
        // or invalid so the frontend can prompt for a proper bid.
        if (zoneResolution.waitlisted && zoneKey) {
            const bidCheck = await zoneAuction.validateBid(zoneKey, Number(bidAmount))
            if (!bidCheck.ok) {
                return res.status(400).json({
                    error: bidCheck.reason,
                    requiresBid: true,
                    floor: bidCheck.floor,
                    currentHighBid: bidCheck.currentHigh
                })
            }
        }
        // ── 4. Determine initial status ──────────────────────────
        // All businesses start as 'pending' regardless of zone result
        // Zone entry is resolved after staff approval
        const initialStatus = 'pending'
        // ── 5. Build priority score ──────────────────────────────
        const priorityScore = TIER_PRIORITY[tier] || 1
        const monthlyFee = { verified: 0, spotlight: 29, signature: 49 }[tier] || 0
        const now = new Date()
        const subscriptionEnd = new Date(now)
        subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1)
        // ── 6. Save business ─────────────────────────────────────
        const business = new Business({
            name: name.trim(),
            type,
            isHiddenGem: isHiddenGem && tier === 'signature',
            location: {
                city: location.city?.trim(),
                region: location.region?.trim(),
                country: location.country?.trim(),
                address: location.address?.trim(),
                coordinates: coordinates || {},
                geoPoint: coordinates ? {type: 'Point', coordinates: [coordinates.lng, coordinates.lat]} : undefined
            },
            contact: {
                email: contact?.email?.trim(),
                phone: contact?.phone?.trim(),
                website: contact?.website?.trim(),
                socialMedia: {
                    instagram:   contact?.socialMedia?.instagram?.trim()   || '',
                    facebook:    contact?.socialMedia?.facebook?.trim()    || '',
                    tripadvisor: contact?.socialMedia?.tripadvisor?.trim() || '',
                    booking:     contact?.socialMedia?.booking?.trim()     || ''
                }
            },
            description: {
                short:    description?.short?.trim()    || '',
                detailed: description?.detailed?.trim() || '',
                highlights: Array.isArray(description?.highlights) ? description.highlights : []
            },
            images: finalImages || [],
            // Normalize pricing field names: the onboarding form sends
            // priceMin / priceMax / averagePrice / free, but the schema uses
            // min / max / average / isFree. Without this remap, Mongoose drops
            // the unknown fields silently and price data submitted by the
            // owner (e.g. an $20 average) is lost on the way in.
            pricing: pricing ? {
                currency: pricing.currency || 'USD',
                isFree:   pricing.isFree   ?? pricing.free   ?? false,
                min:      pricing.min      ?? pricing.priceMin     ?? null,
                max:      pricing.max      ?? pricing.priceMax     ?? null,
                average:  pricing.average  ?? pricing.averagePrice ?? null,
            } : undefined,
            openingHours: (tier === 'spotlight' || tier === 'signature') && openingHours
                ? {
                    is24Hours: !!openingHours.is24Hours,
                    days: Array.isArray(openingHours.days) ? openingHours.days.filter(d => d.day).map(d => ({day: d.day, closed: !!d.closed, open: d.closed ? null : (d.open  || null), close: d.closed ? null : (d.close || null),})) : []
                  }
                : undefined,
            partnership: {tier, priorityScore, monthlyFee, subscriptionStart: now, subscriptionEnd},
            status: initialStatus,
            verification: {
                aiScore: aiResult.score,
                aiNotes: [
                    aiResult.checkedSources?.length ? `Checked: ${aiResult.checkedSources.join(', ')}` : null,
                    aiResult.notes,
                    aiResult.googlePlaceId ? `Google Place ID: ${aiResult.googlePlaceId}` : null,
                    aiResult.googleAddress ? `Google Address: ${aiResult.googleAddress}` : null,
                    aiResult.flags?.length ? `Flags: ${aiResult.flags.join(', ')}` : null
                ].filter(Boolean).join(' | '),
                staffApproved: false,
                // ── Abuse-prevention fields ──────────────────────────────────────────
                // applyIp: snapshot of the IP the application came from. Stays on the
                //   doc forever so a future rejection can fingerprint by IP.
                // watchFlags: blocklist hits at apply-time (severity:'watch'). Surfaced
                //   to staff in the validation queue. Cleared on approval.
                // rejectedEditCount: incremented each time the owner edits a rejected
                //   listing back to pending. At threshold we auto-flag the owner.
                applyIp,
                watchFlags: blocklistHits.length ? blocklistHits.map(h => ({
                    type:     h.type,
                    severity: h.severity,
                    reason:   h.reason || '',
                    hitCount: (h.hitCount || 0) + 1
                })) : [],
                rejectedEditCount: 0
            },
            zoneKey,
            waitlist: { isWaiting: false },
            eventSchedule: isEvent ? {
                startDate: eventSchedule.startDate ? new Date(eventSchedule.startDate) : undefined,
                endDate:   eventSchedule.endDate   ? new Date(eventSchedule.endDate)   : undefined,
                isRecurring: !!eventSchedule.isRecurring,
                // The venue's home timezone. Prefer the value the client derived
                // from the address (it knows the exact pin); otherwise derive it
                // here from the geocoded coordinates. This is what makes a stored
                // instant unambiguous — "20:00" only means something paired with
                // a timezone.
                timezone: eventSchedule.timezone || resolveTimezone(coordinates)
            } : undefined,
            owner: owner._id
        })
        await business.save()
        // ── Store uploaded image binaries (Signature tier) ───────
        // req.files arrives from applyUpload.array('images', 8).
        // Each file is validated for dimensions via sharp, then stored
        // as binary in uploadedImages — same pattern as ImageStorageService.
        // This runs after business.save() so we have the business._id.
        // Non-blocking for the response — errors are logged, not thrown.
        const FORMAT_TO_MIME = { jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', avif:'image/avif' }
        let imagesHadWarning = false
        if (tier === 'signature' && req.files?.length) {
            const uploadedEntries = []
            for (const file of req.files) {
                try {
                    const meta = await sharp(file.buffer).metadata()
                    const verifiedMime = FORMAT_TO_MIME[meta.format]
                    if (!verifiedMime || !IMAGE_CONSTRAINTS.allowedMimes.includes(verifiedMime)) {
                        console.warn(`Skipping uploaded file — unrecognised format: ${meta.format}`)
                        imagesHadWarning = true
                        continue
                    }
                    if (meta.width < IMAGE_CONSTRAINTS.minWidth || meta.height < IMAGE_CONSTRAINTS.minHeight) {
                        console.warn(`Skipping uploaded file — too small: ${meta.width}x${meta.height}`)
                        imagesHadWarning = true
                        continue
                    }
                    if (meta.width > IMAGE_CONSTRAINTS.maxWidth || meta.height > IMAGE_CONSTRAINTS.maxHeight) {
                        console.warn(`Skipping uploaded file — too large: ${meta.width}x${meta.height}`)
                        imagesHadWarning = true
                        continue
                    }
                    uploadedEntries.push({
                        imageData:   file.buffer,
                        contentType: verifiedMime,
                        width:       meta.width,
                        height:      meta.height,
                        sizeBytes:   file.buffer.length,
                        storedAt:    new Date(),
                    })
                } catch (err) {
                    console.warn('Image validation failed during apply:', err.message)
                    imagesHadWarning = true
                }
            }
            if (uploadedEntries.length) {
                business.uploadedImages = uploadedEntries
                // Add serve URLs to images[] so the listing has image references immediately
                // Merge typed URLs (already in business.images) with new serve URLs for uploaded files
                business.images = [...( business.images || []), ...uploadedEntries.map((_, i) => `/api/media/business/${business._id}/image/${i}`)]
                await business.save()
                // console.log(`Stored ${uploadedEntries.length} uploaded images for business ${business._id}`)
            }
        }
        // ── Link business to owner account ───────────────────────
        await User.findByIdAndUpdate(owner._id, { businessId: business._id })
        // ── 7. Store zone resolution for staff to act on ─────────
        if (zoneResolution.displaces) {
            const interestNotes = isEvent && zoneResolution.conflictingEvents ? zoneResolution.conflictingEvents.filter(e => e.name === zoneResolution.displacedName && e.sharedInterests > 0).map(e => `${e.sharedInterests} shared interest${e.sharedInterests > 1 ? 's' : ''}`).join(', ') : ''
            const noteExtra = interestNotes ? ` [${interestNotes} with incoming event]` : ''
            business.verification.staffNotes = `Zone entry: will displace ${zoneResolution.displacedName} (${zoneResolution.displacedTier}) — lowest performer in zone.${noteExtra}`
            await business.save()
        }
        if (isEvent && !zoneResolution.displaces && !zoneResolution.waitlisted && zoneResolution.conflictingEvents?.length) {
            // Overlapping events exist but no displacement needed — flag for awareness
            const conflictLines = zoneResolution.conflictingEvents.map(e => {
                const interestNote = e.sharedInterests > 0 ? ` [${e.sharedInterests} shared interest${e.sharedInterests > 1 ? 's' : ''} — HIGH conflict]` : ''
                return `${e.name} (${e.tier})${interestNote}`
            })
            business.verification.staffNotes = `Event time overlap with: ${conflictLines.join(', ')}. Slot available — review before activating.`
            await business.save()
        }
        if (zoneResolution.waitlisted) {
            // Full 3-Signature zone — register this application into the Zone Auction.
            // placeBid records the bid on business.auction.* and sets status 'waitlisted'.
            // bidAmount was already validated above (3b).
            try {
                await zoneAuction.placeBid(business, zoneKey, Number(bidAmount))
            } catch (bidErr) {
                console.error('[apply] placeBid failed:', bidErr.message)
                // Non-fatal: the business is saved; staff can see it needs a bid.
            }
        }
        // ── 8. Notify staff ──────────────────────────────────────
        try { await emailService.sendBusinessApplicationEmail?.({businessName: name, tier, aiScore: aiResult.score, aiNotes: aiResult.notes, city: location.city, zoneNote: zoneResolution.message || 'Zone has available slots'})} 
        catch (emailErr) { console.error('Staff notification email failed:', emailErr) }
        // ── 8b. Send setup link to business owner ────────────────────────
        // setupToken is always set above (fresh user OR token rotated on
        // existing user), so the only remaining gate is whether we have a real
        // email address. Phone-only applicants get a placeholder accountEmail
        // (`<digits>@business.jinni.app`) which is NOT a real inbox — we skip
        // emailing it because the message would just bounce.
        let setupEmailDelivered = false
        if (contactEmail && setupToken) {
            try {
                const setupUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth?setup=${setupToken}`
                await emailService.sendBusinessSetupEmail(contactEmail, name.trim(), name.trim(), setupUrl)
                setupEmailDelivered = true
            } catch (emailErr) {
                // Surface the full error in logs so SMTP / auth / rate-limit
                // failures are diagnosable. Previously this was a console.warn
                // with only `.message`, which hid the actual Nodemailer error
                // (code, response, command). Non-blocking: the token is
                // stored in DB, owner can request a new one later, and the
                // response below tells the caller it didn't go out.
                console.error('Setup email failed:', emailErr)
            }
        }
        // ── 8c. Auction-bidder confirmation (immediate, at apply time) ──
        // sendBusinessWaitlistedEmail is also fired in /:id/approve once
        // staff verify the application — but that can be hours/days away
        // and the only earlier email a fresh applicant sees is the generic
        // password-setup link, which says nothing about auctions. Send an
        // immediate confirmation so the bidder knows their bid was registered
        // and what the live high bid is. Best-effort; non-blocking.
        if (zoneResolution.waitlisted && contactEmail && tier === 'signature') {
            try {
                const highBid = await zoneAuction.getHighBid(zoneKey)
                // Earliest *future* subscriptionEnd among the sitting Signatures —
                // tells the applicant when the next slot's defend-window could
                // open. We filter `$gt: now` because there is no cron/sweep that
                // expires lapsed subscriptions: a Signature whose subscriptionEnd
                // is already in the past stays status:'active' and still holds its
                // slot. Without this filter the query returns that stale past
                // date and the email shows "slot may open around <date in the
                // past>". If every sitting subscription is already lapsed (or
                // none have a date set), earliestExpiry stays null and the email
                // falls back to its generic "we'll notify you" line.
                const earliestSig = await Business.findOne(
                    {
                        zoneKey,
                        status: 'active',
                        'partnership.tier': 'signature',
                        'partnership.subscriptionEnd': { $gt: new Date() }
                    },
                    { 'partnership.subscriptionEnd': 1 }
                ).sort({ 'partnership.subscriptionEnd': 1 }).lean()
                const earliestExpiry = earliestSig?.partnership?.subscriptionEnd ?? null

                await emailService.sendBusinessWaitlistedEmail?.(
                    contactEmail,
                    name.trim(),
                    tier,
                    { earliestExpiry, currentHighBid: highBid }
                )
            } catch (emailErr) {
                console.error('Auction-bidder apply-time email failed:', emailErr)
            }
        }
        // ── 9. Respond ───────────────────────────────────────────
        res.status(201).json({
            success: true,
            businessId: business._id,
            status: business.status,
            tier,
            aiScore: aiResult.score,
            aiFlags: aiResult.flags || [],
            zone: {key: zoneKey, resolution: zoneResolution},
            // Signal whether the setup email actually reached the SMTP server.
            // Frontend can show a "we couldn't email you — contact support" note
            // when this is false but contactEmail was provided, so users aren't
            // left wondering why nothing arrived.
            setupEmailDelivered: contactEmail ? setupEmailDelivered : null,
            message: zoneResolution.waitlisted ? 'Application received. Your zone is full — your application has entered the Zone Auction.' : imagesHadWarning ? 'Application received. Some images could not be processed — staff will review. Our team will verify your listing shortly.' : 'Application received. Our team will review and verify your listing shortly.'
        })
    } catch (err) {
        console.error('Business apply error:', err)
        res.status(500).json({ error: 'Registration failed. Please try again.' })
    }
})
/**
 * POST /api/business/:id/approve
 * Staff approves a pending business.
 * Executes zone displacement if needed, activates the listing, notifies owner.
 * Protected — staff only (extend auth middleware with role check as needed)
 */
router.post('/:id/approve', auth, async (req, res) => {
    try {
        if (!isStaffOrAdmin(req.user)) return res.status(403).json({ error: 'Staff or admin access required' })
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.status !== 'pending' && business.status !== 'waitlisted') return res.status(400).json({ error: 'Business is not pending or waitlisted' })

        // ── Guard: reject approval of already-past events ─────────────────
        // If an event's end-time has already passed by the time staff reviews
        // it, flipping to 'active' is meaningless — lazy-expire would
        // immediately turn around and mark it 'expired' on the next fetch,
        // and travelers would never see it. We flip it to 'expired' directly
        // and return a 400 so staff can see what happened and ask the owner
        // to reschedule.
        //
        // This intentionally short-circuits BEFORE zone resolution: there's
        // no point displacing a competitor for a slot the new listing
        // immediately vacates.
        if (business.isEventExpired()) {
            business.status = 'expired'
            business.verification.history = business.verification.history || []
            business.verification.history.push({
                action: 'reset',
                by:     req.user.id || req.user._id,
                byRole: isStaffOrAdmin(req.user) && req.user.role === 'admin' ? 'admin' : 'staff',
                notes:  'Could not approve: event end-date already passed. Owner must reschedule.',
                at:     new Date()
            })
            await business.save()
            return res.status(400).json({
                error: 'event_already_ended',
                message: 'This event\'s end-date has already passed. The listing has been moved to "expired" — the owner needs to reschedule it before it can be approved.'
            })
        }

        const { staffNotes } = req.body
        // An auction winner reserved into 'pending' (zoneAuction promotion)
        // ALREADY holds its slot — the won price/tier/lock are on the document
        // and awaitingApprovalSince marks the reservation. It must NOT be re-run
        // through zone resolution: its tier is 'signature' in a full Signature
        // zone, so resolveZoneEntry would flag it `waitlisted` and bounce it back
        // into the bid book, undoing the win. Skip straight to activation.
        const isAuctionWinnerAwaitingApproval =
            !!(business.auction && business.auction.awaitingApprovalSince)

        // Re-run zone resolution at time of approval (slots may have changed)
        let displaced = null
        if (business.zoneKey && !isAuctionWinnerAwaitingApproval) {
            // Count only ACTIVE occupants for the displacement decision — a
            // `pending` application has not taken a slot. And exclude THIS
            // business itself: it is the challenger entering the zone, not a
            // sitting occupant. Counting it would inflate the zone by one and
            // make a zone with a genuinely free slot look full.
            const zoneBusinesses = (await getZoneBusinesses(business.zoneKey, { occupantsOnly: true }))
                .filter(b => String(b._id) !== String(business._id))
            const resolution = resolveZoneEntry(zoneBusinesses, business.partnership.tier)
            if (resolution.displaces && resolution.displacedId) {
                // Freeze the displaced business
                displaced = await Business.findById(resolution.displacedId)
                if (displaced) {
                    displaced.status = 'frozen'
                    await displaced.save()
                    // Notify displaced owner
                    try {
                        await emailService.sendDisplacementNotification?.({
                            businessName: displaced.name,
                            email: displaced.contact.email,
                            displacedBy: business.name,
                            incomingTier: business.partnership.tier,
                            performanceScore: displaced.analytics.performanceScore
                        })
                    } catch (e) { console.warn('Displacement email failed:', e.message) }
                }
            }
            if (resolution.waitlisted) {
                // Zone is still a full 3-Signature zone. The business stays a
                // confirmed bidder in the Zone Auction — it is NOT activated here.
                // Its auction.* fields were set at apply time; staff approval just
                // records that it passed verification. The auction resolution job
                // (zoneAuction.runAuctionResolution) decides if/when it wins a slot.
                business.status = 'waitlisted'
                business.verification.staffApproved = true
                business.verification.staffNotes = staffNotes || ''
                business.verification.verifiedAt = new Date()
                business.verification.verifiedBy = req.user.id
                business.verification.verifiedAction = 'approved'
                business.verification.history = business.verification.history || []
                business.verification.history.push({
                    action: 'approved',
                    by:     req.user.id,
                    byRole: req.user.role || (req.user.isAdmin ? 'admin' : 'staff'),
                    notes:  `Approved → Zone Auction bidder (zone full of Signatures).${staffNotes ? ' ' + staffNotes : ''}`,
                    at:     new Date()
                })
                await business.save()
                // Notify owner they're a confirmed bidder in the auction
                if (business.contact?.email) {
                    try {
                        const highBid = await zoneAuction.getHighBid(business.zoneKey)
                        // Earliest *future* subscription end among sitting
                        // Signatures — see /apply for the full rationale. The
                        // `$gt: now` filter prevents lapsed-but-still-active
                        // subscriptions from surfacing a past date in the email.
                        const earliestSig = await Business.findOne(
                            {
                                zoneKey: business.zoneKey,
                                status: 'active',
                                'partnership.tier': 'signature',
                                'partnership.subscriptionEnd': { $gt: new Date() }
                            },
                            { 'partnership.subscriptionEnd': 1 }
                        ).sort({ 'partnership.subscriptionEnd': 1 }).lean()
                        const earliestExpiry = earliestSig?.partnership?.subscriptionEnd ?? null

                        await emailService.sendBusinessWaitlistedEmail?.(
                            business.contact.email,
                            business.name,
                            business.partnership.tier,
                            { earliestExpiry, currentHighBid: highBid }
                        )
                    } catch (e) { console.error('Auction-bidder email failed:', e) }
                }
                return res.json({success: true, status: 'waitlisted', message: 'Business approved — confirmed as a bidder in the Zone Auction.'})
            }
        }
        // Activate the business
        business.status = 'active'
        // If this was an auction winner reserved into 'pending' awaiting review,
        // clear the reservation marker now that it's live. The won price / tier /
        // lock were already written at promotion time (zoneAuction), so activation
        // only needs to flip status + verification + drop this flag.
        if (business.auction && business.auction.awaitingApprovalSince) {
            business.auction.awaitingApprovalSince = null
        }
        // Clear watchFlags — they were a signal to staff during review; once
        // staff has decided to approve, those flags have been consumed.
        if (business.verification?.watchFlags?.length) {
            business.verification.watchFlags = []
        }
        // A listing being approved is no longer rejected — clear any stale
        // rejection-kind markers so the owner dashboard / admin views are clean.
        business.verification.rejectionKind  = null
        business.verification.hardRejectedAt = null
        business.verification.staffApproved = true
        business.verification.staffNotes = staffNotes || ''
        business.verification.verifiedAt = new Date()
        business.verification.verifiedBy = req.user.id
        business.verification.verifiedAction = 'approved'
        business.verification.history = business.verification.history || []
        business.verification.history.push({
            action: 'approved',
            by:     req.user.id,
            byRole: req.user.role || (req.user.isAdmin ? 'admin' : 'staff'),
            notes:  staffNotes || '',
            at:     new Date()
        })
        await business.save()
        // Notify existing businesses in zone if a new higher-tier entered
        if (business.zoneKey) {
            const remainingZone = await getZoneBusinesses(business.zoneKey)
            const lowerTierInZone = remainingZone.filter(b => TIER_PRIORITY[b.partnership.tier] < TIER_PRIORITY[business.partnership.tier])
            for (const lower of lowerTierInZone) {
                try {
                    await emailService.sendZoneWarningEmail?.({
                        businessName: lower.name,
                        email: lower.contact?.email,
                        newEntrantName: business.name,
                        newEntrantTier: business.partnership.tier,
                        yourTier: lower.partnership.tier
                    })
                } catch (e) { console.warn('Zone warning email failed:', e.message) }
            }
        }
        res.json({
            success: true,
            status: 'active',
            displaced: displaced ? { id: displaced._id, name: displaced.name } : null,
            message: 'Business approved and activated'
        })
        // Non-blocking — notify owner their listing is live
        if (business.contact?.email) {
            emailService.sendBusinessApprovedEmail(
                business.contact.email,
                business.name,
                business.partnership.tier
            ).catch(e => console.warn('Approval email failed:', e.message))
        }
    } catch (err) {
        console.error('Approve error:', err)
        res.status(500).json({ error: 'Approval failed' })
    }
})
/**
 * POST /api/business/:id/reject
 * Staff (or admin) rejects a pending business with a reason.
 *
 * Body:
 *   reason            — required, surfaced to the owner so they know what to fix.
 *   permanent         — optional boolean. false / omitted = SOFT reject: owner
 *                       may edit + resubmit (→ pending). true = HARD/permanent
 *                       reject: owner can NOT edit or resubmit, and every
 *                       fingerprint (email, phone, name+city, ip, userId) is
 *                       pushed to the blocklist at 'block' severity. Both staff
 *                       and admin may permanently reject. An admin can later
 *                       downgrade a hard reject back to soft.
 *   flagFingerprints  — optional boolean (SOFT only). If true, also add this
 *                       owner's fingerprints to the blocklist at 'watch'.
 *   flagTypes         — optional array, subset of ['email','phone','ip'].
 *                       Only relevant when flagFingerprints is true (SOFT).
 */
router.post('/:id/reject', auth, async (req, res) => {
    try {
        if (!isStaffOrAdmin(req.user)) {
            return res.status(403).json({ error: 'Staff or admin access required' })
        }
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })

        const { reason, flagFingerprints, flagTypes, permanent } = req.body
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ error: 'A reason is required when rejecting.' })
        }
        const isHard = permanent === true || permanent === 'true'

        business.status   = 'rejected'
        business.isActive = false   // parity with admin reject — downstream queries that filter on isActive must agree

        // Pull out of bid book so a rejected business can't still win a slot.
        if (business.auction && (business.auction.isBidding || business.auction.awaitingApprovalSince)) {
            business.auction.isBidding = false
            business.auction.awaitingApprovalSince = null
        }

        business.verification                  = business.verification || {}
        business.verification.staffNotes       = reason
        business.verification.staffApproved    = false
        business.verification.verifiedAt       = new Date()
        business.verification.verifiedBy       = req.user.id
        business.verification.verifiedAction   = 'rejected'
        business.verification.rejectionKind    = isHard ? 'hard' : 'soft'
        business.verification.hardRejectedAt   = isHard ? new Date() : null
        business.verification.history          = business.verification.history || []
        business.verification.history.push({
            action: 'rejected',
            by:     req.user.id,
            byRole: req.user.role || (req.user.isAdmin ? 'admin' : 'staff'),
            notes:  isHard ? `[PERMANENT] ${reason}` : reason,
            at:     new Date()
        })

        await business.save()

        // ── Blocklist hooks ──────────────────────────────────────────────
        if (isHard) {
            // Permanent reject → block ALL fingerprints so the same actor can't
            // re-apply under any of them. promote:true lifts any existing
            // 'watch' entry up to 'block'.
            try {
                await blocklistService.flagFromBusiness({
                    business,
                    rejectedByUserId: req.user.id,
                    reason,
                    types: ['email', 'phone', 'name+city', 'ip', 'userId'],
                    severity: 'block',
                    promote: true
                })
            } catch (e) { console.warn('Hard-reject blocklist failed:', e.message) }

            // ── Disable the owner's login ─────────────────────────────────
            // A permanent reject locks the actor out entirely, not just their
            // listing. The auth middleware + login route already refuse any
            // account with isActive:false (with a clear "account closed"
            // message), so flipping this flag is all that's needed.
            // Safety rail: never auto-deactivate an admin/staff account (e.g.
            // someone testing with their own listing) — that would be a
            // self-lockout footgun. Disabling those stays a manual decision.
            if (business.owner) {
                try {
                    const owner = await User.findById(business.owner).select('role isAdmin')
                    const privileged = owner && (owner.role === 'admin' || owner.role === 'staff' || owner.isAdmin === true)
                    if (owner && !privileged) {
                        await User.findByIdAndUpdate(owner._id, { $set: { isActive: false } })
                    }
                } catch (e) { console.warn('Owner deactivation on hard reject failed:', e.message) }
            }
        } else {
            // (a) Auto-flag: if N+ rejected listings share the same phone/email,
            //     create or promote a fingerprint entry.
            try { await blocklistService.autoFlagFromRejection(business) }
            catch (e) { console.warn('Auto-flag on rejection failed:', e.message) }

            // (b) Manual flag: moderator explicitly asked to add this fingerprint
            //     to the watchlist.
            if (flagFingerprints) {
                try {
                    await blocklistService.flagFromBusiness({
                        business,
                        rejectedByUserId: req.user.id,
                        reason,
                        types: Array.isArray(flagTypes) && flagTypes.length
                            ? flagTypes
                            : ['email', 'phone'],
                        severity: 'watch'
                    })
                } catch (e) { console.warn('Manual flag on rejection failed:', e.message) }
            }
        }

        // ── Email the owner ──────────────────────────────────────────────
        if (business.contact?.email) {
            try {
                await emailService.sendRejectionEmail(
                    business.contact.email,
                    business.name,
                    reason,
                    business._id,           // deep-link to the edit tab (soft only)
                    { permanent: isHard }   // permanent → neutral copy, no resubmit CTA
                )
            } catch (e) { console.warn('Rejection email failed:', e.message) }
        }

        res.json({ success: true, status: 'rejected', rejectionKind: isHard ? 'hard' : 'soft' })
    } catch (err) {
        console.error('Reject error:', err)
        res.status(500).json({ error: 'Rejection failed' })
    }
})

// ─────────────────────────────────────────────────────────────────
// EXISTING ROUTES (preserved + updated)
// ─────────────────────────────────────────────────────────────────
/**
 * GET /api/business/:id
 * Public — fetch a single business listing
 */
router.get('/:id', async (req, res) => {
    try {
        // We can't use .lean() up front because we may need to call .save()
        // when lazy-expiring an event. Fetch as a full document, expire if
        // needed, then convert to a plain object for the response.
        // NOTE: we intentionally do NOT strip verification.staffNotes in the
        // query any more. The OWNER needs to see the reviewer's rejection note
        // so they know what to fix. We strip it (and other moderation internals)
        // for non-owners further down, once ownership is determined.
        const doc = await Business.findById(req.params.id).select('-waitlist')
        if (!doc) return res.status(404).json({ error: 'Business not found' })

        // ── Lazy expiry: flip non-recurring events past their end-time ──
        // Eligible source statuses: pending, active, waitlisted.
        //
        //   - active / waitlisted: the listing was discoverable; once the
        //     event ended it should stop being so.
        //   - pending: staff hadn't reviewed yet and the date already passed.
        //     Keeping it in 'pending' is worse than expiring it — staff would
        //     just reject it anyway ("event already happened"), and the owner
        //     sees an honest signal that they need to reschedule before staff
        //     will look at it. Expiring it also removes a dead row from the
        //     staff queue automatically.
        //
        // Statuses left alone:
        //   - rejected: already a terminal review outcome; preserve audit trail.
        //   - frozen: tier-displacement state; date-passing doesn't change
        //     the displacement story.
        //   - expired: already there.
        const EXPIRABLE_FROM = new Set(['active', 'waitlisted', 'pending'])
        if (doc.isEventExpired() && EXPIRABLE_FROM.has(doc.status)) {
            doc.status = 'expired'
            // Non-blocking save — don't make the GET pay for it.
            doc.save().catch(err => console.warn('[lazy-expire] save failed:', err.message))
        }

        const business = doc.toObject()

        // Check if the requester is the authenticated owner.
        // The JWTs this app issues carry the id as `userId` (see
        // authController.login / Google callback / setup-password). Some older
        // tokens / other middlewares use `id`, so accept either — exactly like
        // the auth middleware does. Reading only `decoded.id` here was the bug
        // that made isOwner always false, which stripped the rejection note
        // (verification.staffNotes) from the owner's own dashboard fetch.
        const token = req.headers.authorization?.split(' ')[1]
        let isOwner = false
        if (token && business.owner) {
            try {
                const jwt = require('jsonwebtoken')
                const decoded = jwt.verify(token, process.env.JWT_SECRET)
                const uid = decoded.userId || decoded.id
                isOwner = !!uid && String(uid) === business.owner.toString()
            } catch {}
        }
        // Always remove owner field from response
        delete business.owner

        // ── Verification visibility ──────────────────────────────────────
        // Abuse-detection internals are never exposed to any client through
        // this public route. The owner may see the moderation note (the reason
        // their listing was rejected) and its rejectionKind so the dashboard
        // can show "fix & resubmit" vs "permanently declined". The public sees
        // none of the moderation trail.
        if (business.verification) {
            delete business.verification.applyIp
            delete business.verification.watchFlags
            if (!isOwner) {
                delete business.verification.staffNotes
                delete business.verification.history
                delete business.verification.verifiedBy
                delete business.verification.rejectedEditCount
            }
        }

        // Strip email unless the owner has opted in OR it's the owner fetching their own listing
        if (!isOwner && !business.contact?.showEmail) {
            if (business.contact) delete business.contact.email
        }
        res.json(business)
    } catch (err) {res.status(500).json({ error: 'Failed to fetch business' })}
})
/**
 * PUT /api/business/:id
 * Owner updates their listing (Spotlight and Signature only)
 */
router.put('/:id', auth, editLimiter, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        // Only owner can edit
        if (business.owner?.toString() !== req.user.id) {return res.status(403).json({ error: 'Not authorized' })}

        // ── Hard-reject guard ────────────────────────────────────────────
        // A permanently (hard) rejected listing cannot be edited or resubmitted.
        // The owner must contact support; only an admin can downgrade it back to
        // a soft rejection. We check this BEFORE any field mutation so a bad
        // actor can't slip an edit through.
        if (business.status === 'rejected' && business.verification?.rejectionKind === 'hard') {
            return res.status(403).json({
                error: 'This listing has been permanently declined and can no longer be edited or resubmitted. If you believe this is a mistake, please contact support.',
                permanent: true
            })
        }

        const tier        = business.partnership.tier
        const wasRejected = business.status === 'rejected'

        // ── Edit-permission gate ────────────────────────────────────────────
        // Default rule: Verified can't edit. Exception: a REJECTED Verified
        // listing may edit a limited set of fields — these are the only fields
        // a Verified is allowed to have anyway. That's what makes "fix and
        // resubmit" possible for free-tier owners.
        const VERIFIED_REJECTED_WHITELIST = new Set([
            'name', 'description',
            'location',        // address / city / region / country / coordinates
            'contact',         // phone / email / website (NOT socialMedia)
            'type',            // category only — interests/styles are paid-tier
            'eventSchedule'    // events can fix their date
        ])
        if (tier === 'verified') {
            if (!wasRejected) {
                return res.status(403).json({ error: 'Upgrade to Spotlight or Signature to edit your listing' })
            }
            // Restrict req.body to the whitelist so the field-by-field logic
            // below can't accidentally apply paid-tier-only fields.
            for (const key of Object.keys(req.body || {})) {
                if (!VERIFIED_REJECTED_WHITELIST.has(key)) {
                    delete req.body[key]
                }
            }
            // Defensively strip paid-tier-only sub-fields too.
            if (req.body.contact?.socialMedia)     delete req.body.contact.socialMedia
            if (req.body.description?.highlights)  delete req.body.description.highlights
        }

        // ── Snapshot for re-pend detection ───────────────────────────────
        // We need to know two things post-save:
        //   1. Was this listing already expired before we touched it? Per the
        //      product decision, any edit to an expired event returns it to
        //      'pending' so staff re-reviews the rescheduled or amended listing.
        //   2. Did the eventSchedule actually change? Editing the schedule of a
        //      still-active event also returns it to 'pending' — staff
        //      originally approved a specific time window, so moving that
        //      window warrants re-review (and protects against an owner
        //      quietly sliding into a contested slot). Pure typo fixes on
        //      non-schedule fields leave an active listing alone.
        //   3. Was the listing rejected? Any edit by the owner returns it to
        //      'pending' so staff sees the updated information.
        const wasExpired = business.status === 'expired'
        const prevSchedule = business.eventSchedule
            ? {
                startDate: business.eventSchedule.startDate ? new Date(business.eventSchedule.startDate).getTime() : null,
                endDate:   business.eventSchedule.endDate   ? new Date(business.eventSchedule.endDate).getTime()   : null,
                isRecurring: !!business.eventSchedule.isRecurring,
                timezone:  business.eventSchedule.timezone || null
              }
            : null

        // ── Name ──────────────────────────────────────────────────
        if (req.body.name !== undefined) {
            business.name = req.body.name.trim().slice(0, 60) || business.name
        }

        // ── Type (interests + styles tags) ────────────────────────
        // Only re-merge if type is explicitly sent; preserve primary categories
        if (Array.isArray(req.body.type)) {
            const PRIMARY_CATS = new Set(['restaurants','hotels','events','historical','hidden_gems'])
            const existingPrimary = (business.type || []).filter(t => PRIMARY_CATS.has(t))
            const incomingNonPrimary = req.body.type.filter(t => !PRIMARY_CATS.has(t))
            // Enforce tag limits per tier
            const INTEREST_KEYS = new Set(['cultural','history','adventure','relaxation','nature','art','nightlife','food&drink'])
            const STYLE_KEYS = new Set(['family','romantic','luxury','budget'])
            const maxTags = tier === 'signature' ? 3 : 2
            const interests = incomingNonPrimary.filter(t => INTEREST_KEYS.has(t)).slice(0, maxTags)
            const styles    = incomingNonPrimary.filter(t => STYLE_KEYS.has(t)).slice(0, maxTags)
            business.type = [...existingPrimary, ...interests, ...styles]
        }

        // ── Description ───────────────────────────────────────────
        if (req.body.description !== undefined) {
            const d = req.body.description
            if (d.short !== undefined) business.description.short = String(d.short || '').slice(0, tier === 'signature' ? 600 : 300)
            if (d.detailed !== undefined) business.description.detailed = tier === 'signature' ? String(d.detailed || '').slice(0, 600) : ''
            if (Array.isArray(d.highlights)) {
                const limit = tier === 'signature' ? 5 : 0
                business.description.highlights = tier === 'signature' ? d.highlights.filter(Boolean).slice(0, limit) : []
            }
        }

        // ── Contact (never overwrite email via this route) ────────
        if (req.body.contact !== undefined) {
            const { email: _ignored, ...safeContact } = req.body.contact
            if (safeContact.phone   !== undefined) business.contact.phone   = safeContact.phone?.trim() || ''
            if (safeContact.website !== undefined) business.contact.website = safeContact.website?.trim() || ''
            // Social media — Signature only
            if (tier === 'signature' && safeContact.socialMedia) {
                business.contact.socialMedia = {
                    instagram:   String(safeContact.socialMedia.instagram   || '').trim(),
                    facebook:    String(safeContact.socialMedia.facebook    || '').trim(),
                    tripadvisor: String(safeContact.socialMedia.tripadvisor || '').trim(),
                    booking:     String(safeContact.socialMedia.booking     || '').trim()
                }
            }
        }

        // ── showEmail toggle (any tier) ───────────────────────────
        if (typeof req.body.showEmail === 'boolean') {
            business.contact.showEmail = req.body.showEmail
        }

        // ── Pricing ───────────────────────────────────────────────
        if (req.body.pricing !== undefined) {
            business.pricing = {
                isFree:   !!req.body.pricing.isFree,
                min:      req.body.pricing.isFree ? null : (req.body.pricing.min ?? null),
                max:      req.body.pricing.isFree ? null : (req.body.pricing.max ?? null),
                currency: String(req.body.pricing.currency || 'USD').slice(0, 3).toUpperCase(),
                average:  req.body.pricing.average ?? null
            }
        }
        if (req.body.priceRange !== undefined) {
            business.priceRange = req.body.priceRange || undefined
        }

        // ── Images ────────────────────────────────────────────────
        if (Array.isArray(req.body.images)) {
            business.images = req.body.images.filter(Boolean).slice(0, 8)
        }

        // ── Opening hours (Spotlight + Signature) ─────────────────
        if (req.body.openingHours !== undefined) {
            const oh = req.body.openingHours
            business.openingHours = {
                is24Hours: !!oh.is24Hours,
                days: Array.isArray(oh.days) ? oh.days.filter(d => d.day).map(d => ({
                    day:   d.day,
                    closed: !!d.closed,
                    open:  d.closed ? null : (d.open  || null),
                    close: d.closed ? null : (d.close || null)
                })) : []
            }
        }

        // ── Event schedule (events category only) ─────────────────
        // Owners of event listings can change start/end date, optional times,
        // and toggle weekly recurrence. We accept this field only when the
        // listing's primary category is 'events' — otherwise it's silently
        // ignored, which prevents accidentally writing eventSchedule onto a
        // restaurant/hotel listing if the client misbehaves.
        //
        // NOTE: We intentionally do NOT re-run the time-overlap zone check on
        // edits. The geographic zone check isn't re-run on other field edits
        // either, and forcing one here would be surprising for owners doing
        // small tweaks (e.g. fixing a typo'd end time). If we later want to
        // enforce conflict-aware edits — e.g. so an owner can't slide their
        // one-time event into a slot now held by 3 paid listings — call
        // getOverlappingEvents() here using business.location.coordinates and
        // either reject the change or set business.waitlist.* fields. See
        // line ~1148 in the /apply route for the resolution pattern.
        if (req.body.eventSchedule !== undefined) {
            const isEventListing = (business.type || []).includes('events')
            if (isEventListing) {
                const es = req.body.eventSchedule || {}
                business.eventSchedule = {
                    startDate: es.startDate ? new Date(es.startDate) : undefined,
                    endDate:   es.endDate   ? new Date(es.endDate)   : undefined,
                    isRecurring: !!es.isRecurring,
                    // Timezone: trust the client's value when supplied (it knows
                    // the venue pin), otherwise keep whatever was already stored,
                    // and only as a last resort re-derive from the venue's
                    // coordinates. Never silently drop it — a missing timezone
                    // would make every stored instant ambiguous again.
                    timezone: es.timezone
                        || business.eventSchedule?.timezone
                        || resolveTimezone(business.location?.coordinates)
                }
            }
        }

        // ── Re-pend on owner edits ──────────────────────────────────────────
        // Triggers, evaluated post-update so we compare against what's about
        // to be saved (not the pre-edit state):
        //   (a) Listing was 'rejected' before this PUT — owner is fixing and
        //       resubmitting, so it returns to 'pending' for re-review.
        //   (b) Listing was 'expired' before this PUT — any edit to an expired
        //       event returns it to 'pending'.
        //   (c) eventSchedule materially changed on an event listing — staff
        //       approved a specific time-slot; moving it warrants re-review.
        //
        // When we re-pend we also clear the verification approval bits so the
        // staff UI doesn't render the listing as still-approved while it sits
        // in the pending queue. The audit history captures who/when/why.
        const isEventListing = (business.type || []).includes('events')
        let scheduleChanged = false
        if (isEventListing && req.body.eventSchedule !== undefined) {
            const next = business.eventSchedule
                ? {
                    startDate: next_get(business.eventSchedule.startDate),
                    endDate:   next_get(business.eventSchedule.endDate),
                    isRecurring: !!business.eventSchedule.isRecurring,
                    timezone:  business.eventSchedule.timezone || null
                  }
                : null
            scheduleChanged = !shallowEqualSchedule(prevSchedule, next)
        }
        const shouldRepend =
            wasRejected ||
            (isEventListing && (wasExpired || scheduleChanged))

        if (shouldRepend) {
            business.status   = 'pending'
            business.isActive = false   // pending listings don't occupy slots

            // Reset approval flags so this looks like a fresh-for-review entry.
            // We deliberately keep aiScore / aiNotes — the AI checks were run
            // at apply-time and are still informative for the staff reviewer.
            business.verification.staffApproved = false
            business.verification.verifiedAt   = undefined
            business.verification.verifiedBy   = null
            business.verification.verifiedAction = null
            // No longer rejected — clear the rejection-kind marker. (A hard
            // reject never reaches this point; it's refused at the top of PUT.)
            business.verification.rejectionKind  = null
            business.verification.hardRejectedAt = null

            // Defensively clear bid-book state — a rejected Signature whose
            // admin-reject path didn't clean up auction.isBidding shouldn't
            // sneak back in via edit.
            if (business.auction?.isBidding) {
                business.auction.isBidding = false
                business.auction.awaitingApprovalSince = null
            }

            const note = wasRejected
                ? 'Owner edited a rejected listing — returned to pending for re-review.'
                : wasExpired
                    ? 'Owner edited an expired event — returned to pending for re-review.'
                    : 'Owner changed eventSchedule — returned to pending for re-review.'
            business.verification.history = business.verification.history || []
            business.verification.history.push({
                action: 'reset',
                by:     req.user.id || req.user._id,
                byRole: 'owner',
                notes:  note,
                at:     new Date()
            })

            // ── Abuse counter for rejected→edit loops ─────────────────────
            // Only counts the rejected→pending transition (not expired→pending).
            if (wasRejected) {
                business.verification.rejectedEditCount =
                    (business.verification.rejectedEditCount || 0) + 1

                const REPEAT_EDIT_THRESHOLD = 5
                if (business.verification.rejectedEditCount >= REPEAT_EDIT_THRESHOLD) {
                    // Owner has rejected-and-edited 5 times. Auto-flag (watch)
                    // and surface the pattern to staff via watchFlags.
                    try {
                        await blocklistService.flagFromBusiness({
                            business,
                            rejectedByUserId: null, // system-generated
                            reason: `Owner edited a rejected listing ${business.verification.rejectedEditCount} times — possible abuse loop.`,
                            types: ['email', 'phone', 'userId'],
                            severity: 'watch'
                        })
                        business.verification.watchFlags = [
                            ...(business.verification.watchFlags || []),
                            {
                                type: 'repeat-edit',
                                severity: 'watch',
                                reason: `${business.verification.rejectedEditCount} rejected→edit cycles`,
                                hitCount: business.verification.rejectedEditCount
                            }
                        ]
                    } catch (e) {
                        console.warn('Repeat-edit auto-flag failed:', e.message)
                    }
                }
            }
        }

        await business.save()
        res.json({ success: true, business })
    } catch (err) {res.status(500).json({ error: 'Update failed' })}
})

// Helpers for the re-pend block above — kept module-scoped (declared after
// the route so they hoist) so the route reads top-down without inline noise.
function next_get(v) { return v ? new Date(v).getTime() : null }
function shallowEqualSchedule(a, b) {
    if (!a && !b) return true
    if (!a || !b) return false
    // timezone is part of the schedule's identity — changing it moves the
    // absolute instant, so a tz change counts as a material edit and re-pends.
    return a.startDate === b.startDate && a.endDate === b.endDate
        && a.isRecurring === b.isRecurring && a.timezone === b.timezone
}

/**
 * GET /api/business/:id/analytics
 * Returns analytics data — scope depends on tier.
 * Recalculates and persists performanceScore on every fetch so the DB stays
 * in sync without a dedicated cron job.
 */
router.get('/:id/analytics', auth, async (req, res) => {
    try {
        // Do NOT use .lean() — we need the Mongoose document to call recalcPerformanceScore()
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        const requesterId = req.user.id || req.user._id?.toString()
        if (business.owner?.toString() !== requesterId && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }
        const tier = business.partnership.tier
        const a = business.analytics

        // ── Seed weeklyViews if empty (no cron has run yet) ──────────────────
        // Use all-time views as a one-slot estimate so recent activity isn't
        // always 0 for new businesses.
        if ((!a.weeklyViews || a.weeklyViews.length === 0) && (a.views || 0) > 0) {
            business.analytics.weeklyViews = [a.views]
        }

        // ── Recalculate and persist performance score ────────────────────────
        // This keeps the stored score accurate for zone-displacement logic
        // without requiring a separate scheduled job.
        if (tier !== 'verified') {
            business.recalcPerformanceScore()
            // Non-blocking save — analytics fetch should still be fast
            business.save().catch(err => console.warn('[analytics] score save failed:', err.message))
        }

        if (tier === 'verified') {
            // Free tier
            return res.json({
                tier,
                teaser: true,
                views: a.views,
                message: `${a.views} users saw your listing. Upgrade to Spotlight to see full analytics.`
            })
        }
        if (tier === 'spotlight') {
            return res.json({
                tier,
                teaser: false,
                views:       a.views,
                saves:       a.saves,
                clicks:      a.clicks,
                likes:       a.likes      ?? 0,
                dislikes:    a.dislikes   ?? 0,
                shares:      a.shares     ?? 0,
                aiAsk:       a.aiAsk      ?? 0,
                moreImages:  a.moreImages ?? 0,
                // Conversion clicks — needed for scoreBreakdown Pillar 3
                directionClicks:   a.directionClicks   ?? 0,
                phoneClicks:       a.phoneClicks       ?? 0,
                websiteClicks:     a.websiteClicks     ?? 0,
                searchClicks:      a.searchClicks      ?? 0,
                instagramClicks:   a.instagramClicks   ?? 0,
                facebookClicks:    a.facebookClicks    ?? 0,
                tripadvisorClicks: a.tripadvisorClicks ?? 0,
                viewsTrend:       calcTrend(a.weeklyViews),
                savesTrend:       0,
                clicksTrend:      calcTrend(a.weeklyClicks),
                conversionsTrend: 0,
                likesTrend:       0,
                dislikesTrend:    0,
                sharesTrend:      0,
                weeklyViews:  a.weeklyViews,
                weeklyClicks: a.weeklyClicks,
                performanceScore: a.performanceScore,
                scoreBreakdown: buildScoreBreakdown(a, business),
            })
        }
        let estimatedRevenue = 0;
        if (tier === 'signature') {
            const conversionSum =
                (a.directionClicks   || 0) +
                (a.phoneClicks       || 0) +
                (a.websiteClicks     || 0) +
                (a.searchClicks      || 0) +
                (a.instagramClicks   || 0) +
                (a.facebookClicks    || 0) +
                (a.tripadvisorClicks || 0);

            let avgSpend = 0;

            if (business.pricing?.isFree) {
                avgSpend = 0;
            } else if (business.pricing?.average && business.pricing.average > 0) {
                avgSpend = business.pricing.average;
            } else if (business.pricing?.min != null && business.pricing?.max != null) {
                // Use midpoint of min/max range
                avgSpend = (business.pricing.min + business.pricing.max) / 2;
            } else {
                // No pricing info – fallback to $20 as a conservative estimate
                avgSpend = 20;
            }

            estimatedRevenue = Math.round(conversionSum * avgSpend);
        
            // Signature: full analytics
            return res.json({
                tier,
                teaser: false,
                views:       a.views,
                saves:       a.saves,
                clicks:      a.clicks,
                conversions: a.conversions,
                likes:       a.likes      ?? 0,
                dislikes:    a.dislikes   ?? 0,
                shares:      a.shares     ?? 0,
                aiAsk:       a.aiAsk      ?? 0,
                moreImages:  a.moreImages ?? 0,
                crossInteractions: a.crossInteractions,
                // Conversion actions (4 real buttons in JinniChat)
                directionClicks:   a.directionClicks   ?? 0,
                phoneClicks:       a.phoneClicks       ?? 0,
                websiteClicks:     a.websiteClicks     ?? 0,
                searchClicks:      a.searchClicks      ?? 0,
                // Social link clicks (Signature info modal)
                instagramClicks:   a.instagramClicks   ?? 0,
                facebookClicks:    a.facebookClicks    ?? 0,
                tripadvisorClicks: a.tripadvisorClicks ?? 0,
                viewsTrend:       calcTrend(a.weeklyViews),
                savesTrend:       0,
                clicksTrend:      calcTrend(a.weeklyClicks),
                conversionsTrend: 0,
                likesTrend:       0,
                dislikesTrend:    0,
                sharesTrend:      0,
                weeklyViews:  a.weeklyViews,
                weeklyClicks: a.weeklyClicks,
                performanceScore: a.performanceScore,
                revenue: { total: estimatedRevenue },
                scoreBreakdown: buildScoreBreakdown(a, business),
            })
        }
    } catch (err) {res.status(500).json({ error: 'Failed to fetch analytics' })}
})

/**
 * POST /api/business/:id/track
 * Public — increments an analytics counter for a business.
 * Called by the Jinni frontend whenever a user interaction occurs.
 *
 * Body: { event: string, sessionBusinessIds?: string[] }
 *
 * Allowed events (map to DB fields):
 *   view, click, save, share, like, dislike,
 *   aiAsk, moreImages,
 *   directionClicks, phoneClicks, websiteClicks, searchClicks,
 *   instagramClicks, facebookClicks, tripadvisorClicks
 *
 * crossInteractions: incremented when the caller passes sessionBusinessIds
 *   containing other active business IDs in the same session — meaning the
 *   user interacted with multiple businesses. Each other business in the
 *   list gets its crossInteractions counter bumped by 1.
 *
 * Revenue estimation (Signature only, triggered on conversion events):
 *   Est. revenue = conversions × avgSpend
 *   avgSpend defaults to business.pricing.average if set, else $30 (USD).
 *   Recomputed every time a conversion event is tracked.
 */
const TRACKABLE_EVENTS = new Set([
    'view', 'click', 'save', 'share', 'like', 'dislike',
    'aiAsk', 'moreImages',
    'directionClicks', 'phoneClicks', 'websiteClicks', 'searchClicks',
    'instagramClicks', 'facebookClicks', 'tripadvisorClicks',
])
// Events that count as a "conversion" for revenue estimation
const CONVERSION_EVENTS = new Set([
    'directionClicks', 'phoneClicks', 'websiteClicks',
    'instagramClicks', 'facebookClicks', 'tripadvisorClicks',
])
// DB field names that map directly from event name (most are identical)
const EVENT_TO_FIELD = {
    view:              'views',
    click:             'clicks',
    save:              'saves',
    share:             'shares',
    like:              'likes',
    dislike:           'dislikes',
    aiAsk:             'aiAsk',
    moreImages:        'moreImages',
    directionClicks:   'directionClicks',
    phoneClicks:       'phoneClicks',
    websiteClicks:     'websiteClicks',
    searchClicks:      'searchClicks',
    instagramClicks:   'instagramClicks',
    facebookClicks:    'facebookClicks',
    tripadvisorClicks: 'tripadvisorClicks',
}

router.post('/:id/track', async (req, res) => {
    try {
        const { event, sessionBusinessIds } = req.body
        if (!event || !TRACKABLE_EVENTS.has(event)) {
            return res.status(400).json({ error: `Unknown event. Must be one of: ${[...TRACKABLE_EVENTS].join(', ')}` })
        }
        const field = EVENT_TO_FIELD[event]
        const inc = { [`analytics.${field}`]: 1 }

        // For conversion events, also bump analytics.conversions
        if (CONVERSION_EVENTS.has(event)) {
            inc['analytics.conversions'] = 1
        }

        // Increment the primary field
        const business = await Business.findByIdAndUpdate(
            req.params.id,
            { $inc: inc },
            { new: true, select: 'partnership.tier analytics.conversions analytics.revenue pricing.average' }
        )
        if (!business) return res.status(404).json({ error: 'Business not found' })

        // ── Revenue estimation (Signature only) ────────────────────────────
        // Recalculate on every conversion event so the figure stays current.
        // Formula: conversions × avgSpend (from pricing.average, or $30 default)
        if (CONVERSION_EVENTS.has(event) && business.partnership?.tier === 'signature') {
            try {
                // conversions was just incremented, so we need to add 1 to the pre‑increment value
                const newConversions = (business.analytics.conversions || 0) + 1;
                const avgSpend = business.pricing?.average && business.pricing.average > 0 ? business.pricing.average : 30;
                const estimatedRevenue = Math.round(newConversions * avgSpend);
                await Business.findByIdAndUpdate(req.params.id, { $set: { 'analytics.revenue': estimatedRevenue } });
            } catch (err) {
                console.error('[track] revenue update failed:', err.message);
                // Do not fail the whole tracking request
            }
        }

        // ── Cross-business interactions ─────────────────────────────────────
        // When a user has interacted with other businesses in the same session,
        // increment crossInteractions on each of those other businesses by 1.
        // console.log('[track] Received sessionBusinessIds:', sessionBusinessIds);
        if (Array.isArray(sessionBusinessIds) && sessionBusinessIds.length) {
            const otherId = req.params.id
            const validOthers = sessionBusinessIds.filter(id => id && id !== otherId).slice(0, 10)  // safety cap
            // console.log('[track] Other businesses in session:', validOthers);
            if (validOthers.length) {await Business.updateMany({ _id: { $in: validOthers }, status: 'active' }, { $inc: { 'analytics.crossInteractions': 1 } })}
            // console.log(`[track] Incremented crossInteractions for ${result.modifiedCount} businesses`);
        }

        res.json({ success: true })
    } catch (err) {
        console.error('[track] error:', err)
        res.status(500).json({ error: 'Tracking failed' })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// ZONE AUCTION ENDPOINTS
// See plan.txt → "Zone Auction" and services/zoneAuction.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/business/:id/auction/bid
 * Owner places or updates their max bid for a full-Signature zone.
 * Body: { bidAmount }  — $/month, must be above the $49 floor.
 */
router.post('/:id/auction/bid', auth, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.owner?.toString() !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }
        if (business.partnership?.tier !== 'signature') {
            return res.status(400).json({ error: 'Only Signature listings can bid in a Zone Auction.' })
        }
        const zoneKey = business.auction?.targetZoneKey || business.zoneKey
        if (!zoneKey) return res.status(400).json({ error: 'No zone assigned for this listing.' })

        const amount = Number(req.body.bidAmount)
        const result = await zoneAuction.placeBid(business, zoneKey, amount)
        if (!result.ok) return res.status(400).json({ error: result.reason })

        return res.json({
            success: true,
            position: result.position,
            currentHighBid: result.currentHigh,
            message: `Bid placed. You are position ${result.position} in the auction.`
        })
    } catch (err) {
        console.error('[auction/bid] error:', err)
        res.status(500).json({ error: 'Could not place bid.' })
    }
})

/**
 * POST /api/business/:id/auction/defend
 * The lowest-performing incumbent Signature responds to an open defend window.
 * Body: { defenseAmount } — must be STRICTLY greater than the bid to beat.
 */
router.post('/:id/auction/defend', auth, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.owner?.toString() !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }
        const amount = Number(req.body.defenseAmount)
        const result = await zoneAuction.submitDefense(business, amount)
        if (!result.ok) return res.status(400).json({ error: result.reason })

        return res.json({
            success: true,
            kept: result.kept,
            lockedPrice: result.lockedPrice,
            lockUntil: result.lockUntil,
            message: `Slot defended. Locked at $${result.lockedPrice}/month until ${result.lockUntil.toISOString().slice(0, 10)}.`
        })
    } catch (err) {
        console.error('[auction/defend] error:', err)
        res.status(500).json({ error: 'Could not submit defense.' })
    }
})

/**
 * POST /api/business/:id/auction/cancel
 * An active Signature cancels its subscription. The slot becomes a known
 * future vacancy; the highest bidder takes it freely when the vacancy date
 * passes (handled by zoneAuction.runAuctionResolution).
 */
router.post('/:id/auction/cancel', auth, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.owner?.toString() !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }
        const result = await zoneAuction.cancelSignature(business)
        if (!result.ok) return res.status(400).json({ error: result.reason })

        return res.json({
            success: true,
            vacancyDate: result.vacancyDate,
            message: `Subscription cancelled. Your slot stays active until ${new Date(result.vacancyDate).toISOString().slice(0, 10)}.`
        })
    } catch (err) {
        console.error('[auction/cancel] error:', err)
        res.status(500).json({ error: 'Could not cancel subscription.' })
    }
})

/**
 * GET /api/business/:id/auction/status
 * Returns the live auction state for a listing's zone: high bid, bid book
 * size, and (if this listing is defending) its defend window details.
 */
router.get('/:id/auction/status', auth, async (req, res) => {
    try {
        const business = await Business.findById(req.params.id).lean()
        if (!business) return res.status(404).json({ error: 'Business not found' })
        if (business.owner?.toString() !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Not authorized' })
        }
        const zoneKey = business.auction?.targetZoneKey || business.zoneKey
        const [highBid, book] = await Promise.all([
            zoneAuction.getHighBid(zoneKey),
            zoneAuction.getBidBook(zoneKey)
        ])
        return res.json({
            success: true,
            zoneKey,
            currentHighBid: highBid,
            biddersInBook: book.length,
            floor: zoneAuction.SIGNATURE_FLOOR,
            myAuction: business.auction || null
        })
    } catch (err) {
        console.error('[auction/status] error:', err)
        res.status(500).json({ error: 'Could not load auction status.' })
    }
})

/**
 * POST /api/business/:id/auction/force-vacate   (ADMIN ONLY)
 * Immediately free an active Signature's slot and promote the top bidder right
 * now — bypassing the normal "wait until subscriptionEnd / vacancy date" flow.
 *
 * Use for support actions (removing a business) or to test the promotion path
 * end-to-end without manipulating dates.
 *
 * Safety: pass ?dryRun=true (or { dryRun:true } in the body) to PREVIEW what
 * would happen — who gets promoted, at what price — without writing anything.
 *
 * Body/query:
 *   dryRun: boolean (default false)
 *   reason: optional audit note
 */
router.post('/:id/auction/force-vacate', auth, async (req, res) => {
    try {
        // Admin-only — this is destructive (it removes an active listing).
        const isAdmin = req.user?.role === 'admin' || req.user?.isAdmin === true
        if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })

        const business = await Business.findById(req.params.id)
        if (!business) return res.status(404).json({ error: 'Business not found' })

        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true
        const reasonNote = (req.body?.reason || req.query.reason || 'admin force-vacate').toString().slice(0, 200)

        const result = await zoneAuction.forceVacate(business, { dryRun, reasonNote })
        if (!result.ok) return res.status(400).json({ error: result.reason })

        return res.json({
            success: true,
            dryRun: !!result.dryRun,
            ...(result.dryRun
                ? { plan: result.plan, message: 'Dry run — no changes were made. Review `plan` then re-run without dryRun to apply.' }
                : { vacatedId: result.vacatedId, promotion: result.promotion,
                    message: result.promotion?.promoted
                        ? `Slot vacated and promoted bidder ${result.promotion.winnerId} at $${result.promotion.price}/mo.`
                        : `Slot vacated. No bidder to promote (${result.promotion?.reason || 'empty bid book'}).` })
        })
    } catch (err) {
        console.error('[auction/force-vacate] error:', err)
        res.status(500).json({ error: 'Could not force-vacate slot.' })
    }
})

/**
 * POST /api/business/auction/run-resolution   (ADMIN ONLY)
 * Manually trigger a full auction-resolution pass (the same thing the scheduler
 * runs). Handy for testing and for forcing an out-of-cycle resolution.
 *
 * Pass ?dryRun=true to preview clean-vacancy promotions without writing.
 */
router.post('/auction/run-resolution', auth, async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'admin' || req.user?.isAdmin === true
        if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true
        const summary = await zoneAuction.runAuctionResolution({ dryRun })
        return res.json({ success: true, summary })
    } catch (err) {
        console.error('[auction/run-resolution] error:', err)
        res.status(500).json({ error: 'Could not run auction resolution.' })
    }
})

module.exports = router;