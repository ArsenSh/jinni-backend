// services/guideService.js
//
// Guide pages (founder 2026-10-02). Pure helpers first — every input a guide
// types is cleaned here, so routes stay thin and the rules are unit-tested —
// then the two database helpers the routes and the chat share:
//   placeSearch()      — Jinni's own places, for picking (never free text)
//   attachGuidePicks() — "Picked by @handle" on chat cards

const crypto = require('crypto');

const HANDLE_RE = /^[a-z0-9._]{3,30}$/;
// Words the page address may never be: app paths and staff-ish names.
const RESERVED = new Set(['admin', 'staff', 'jinni', 'jinni.travel', 'support', 'help', 'api', 'auth', 'chat', 'explore',
    'business', 'guides', 'guide', 'discover', 'share', 'marketing', 'terms', 'privacy', 'contact', 'onboarding', 'lab',
    'map-selector', 'official', 'team', 'root', 'null', 'undefined']);
const LANGS = new Set(['en', 'hy', 'ru', 'fr', 'es', 'de', 'it', 'zh', 'ar', 'fa', 'ka', 'tr', 'pt', 'ja', 'ko']);
const TYPES = new Set(['licensed', 'creator', 'local']);
const CATEGORIES = ['restaurant', 'hidden_gem', 'photo_spot', 'activity'];

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** "@Ani.Travels " → "ani.travels"; null when it can't be a handle. */
function normalizeHandle(raw) {
    const h = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
    if (!HANDLE_RE.test(h) || h.startsWith('.') || h.endsWith('.') || h.includes('..')) return null;
    if (RESERVED.has(h)) return null;
    return h;
}

/**
 * An Instagram USERNAME as people actually type it: "@Ani.Travels",
 * "ani.travels", or a pasted profile link "https://www.instagram.com/ani.travels/?igsh=…".
 * Instagram's own rules only (1–30 of a–z 0–9 . _), and NO reserved-word check —
 * that list protects page addresses, and a real account named "jinni.travel"
 * must still be enterable (live 2026-10-02: the reserved check made the form say
 * "Enter your Instagram username" for a filled-in field).
 */
function normalizeInstagram(raw) {
    let v = String(raw || '').trim();
    const m = v.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i);
    if (m) v = m[1];
    v = v.replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(v) || v.startsWith('.') || v.endsWith('.') || v.includes('..')) return null;
    return v;
}

/**
 * An Instagram post/reel link → its canonical form, or null. Accepts
 * instagram.com/reel/<code>, /reels/<code>, /p/<code>, /tv/<code>, with or
 * without www, query strings or a trailing slash. Anything else — profiles,
 * stories, other sites — is refused: only a post the guide made can be shown.
 */
function parseInstagramPost(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (!/^(www\.)?instagram\.com$/i.test(u.hostname) || u.protocol !== 'https:') return null;
    const m = u.pathname.match(/^\/(?:[a-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})\/?$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'p' ? 'p' : (m[1].toLowerCase() === 'tv' ? 'tv' : 'reel');
    return { kind, code: m[2], url: `https://www.instagram.com/${kind}/${m[2]}/`, embedUrl: `https://www.instagram.com/${kind}/${m[2]}/embed` };
}

/** A short code the applicant shows in their Instagram bio, e.g. "jinni-7K3P". */
function makeVerificationCode(rand = crypto.randomBytes) {
    const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';      // no 0/O/1/I — read by eye
    const b = rand(4);
    return 'jinni-' + Array.from(b).map(x => ALPH[x % ALPH.length]).join('');
}

/** Application form → clean fields, or { error }. */
function sanitizeApplication(body = {}) {
    const instagram = normalizeInstagram(body.instagram || body.handle);
    if (!instagram) return { error: 'Enter your Instagram username (letters, digits, dots or underscores, as on your profile).' };
    const handle = normalizeHandle(body.handle || instagram);
    if (!handle) return { error: 'Choose a page address of 3–30 letters, digits, dots or underscores that is not a reserved word.' };
    const displayName = clip(body.displayName, 60);
    if (displayName.length < 2) return { error: 'Enter your name as travelers should see it.' };
    const region = clip(body.region, 80);
    if (region.length < 2) return { error: 'Tell us where you guide (city or region).' };
    if (body.acceptTerms !== true) return { error: 'Please accept the guide terms.' };
    const languages = [...new Set((Array.isArray(body.languages) ? body.languages : []).map(l => String(l).toLowerCase().slice(0, 2)).filter(l => LANGS.has(l)))].slice(0, 8);
    return {
        handle, instagram, displayName, region, languages,
        bio: clip(body.bio, 400),
        guideType: TYPES.has(body.guideType) ? body.guideType : 'local',
    };
}

/** Profile edits a guide may make after applying (handle and Instagram are fixed once approved). */
function sanitizeProfileEdit(body = {}) {
    const out = {};
    if (body.displayName != null) { const v = clip(body.displayName, 60); if (v.length >= 2) out.displayName = v; }
    if (body.region != null) { const v = clip(body.region, 80); if (v.length >= 2) out.region = v; }
    if (body.bio != null) out.bio = clip(body.bio, 400);
    if (Array.isArray(body.languages)) out.languages = [...new Set(body.languages.map(l => String(l).toLowerCase().slice(0, 2)).filter(l => LANGS.has(l)))].slice(0, 8);
    if (body.guideType != null && TYPES.has(body.guideType)) out.guideType = body.guideType;
    return out;
}

/** Pick form → clean fields, or { error }. The place itself is checked by the route. */
function sanitizePick(body = {}) {
    if (!CATEGORIES.includes(body.category)) return { error: 'Choose what kind of place this is.' };
    const placeId = clip(body.placeId, 200);
    if (!placeId) return { error: 'Choose the place from Jinni search.' };
    let reelUrl = null;
    if (body.reelUrl) {
        const p = parseInstagramPost(body.reelUrl);
        if (!p) return { error: 'That is not an Instagram post or reel link (it should look like instagram.com/reel/…).' };
        reelUrl = p.url;
    }
    let tour = null;
    if (body.category === 'activity' && body.tour && typeof body.tour === 'object') {
        const t = body.tour;
        const title = clip(t.title, 80);
        if (title) {
            const num = (v, max) => (v === '' || v == null || !Number.isFinite(+v) || +v < 0 ? null : Math.min(max, +v));
            tour = {
                title,
                durationHours: num(t.durationHours, 240),
                price: num(t.price, 1e7),
                currency: /^[A-Za-z]{3}$/.test(String(t.currency || '')) ? String(t.currency).toUpperCase() : null,
                languages: [...new Set((Array.isArray(t.languages) ? t.languages : []).map(l => String(l).toLowerCase().slice(0, 2)).filter(l => LANGS.has(l)))].slice(0, 8),
                contact: clip(t.contact, 160),
            };
            if (!tour.contact) return { error: 'Add how travelers can book your tour (WhatsApp, Telegram, phone or website).' };
        }
    }
    return { placeId, category: body.category, note: clip(body.note, 280), reelUrl, tour };
}

/** What the public page may show about a guide — never the user id, code or staff notes. */
function publicGuide(g) {
    if (!g) return null;
    return {
        handle: g.handle, displayName: g.displayName, instagram: g.instagram, bio: g.bio || '',
        region: g.region, languages: g.languages || [], guideType: g.guideType || 'local',
    };
}

// ── Database helpers ─────────────────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Places a guide can pick: Jinni's own stored places, matched by name. Hidden,
 * quarantined (name-ask pending) and closed places are left out. Returns a
 * compact row the dashboard can show with its photo.
 */
// ── Pickable places + their category rules (founder 2026-10-02) ─────────────
// A pick points at one of two stores:
//   • PlaceCache — placeId = the Google place id
//   • Destination (staff-added) — placeId = 'dest:<Destination _id>'
// Category rules: when Jinni's team has set a place's categories (a validator
// edited PlaceCache.actions → actionsCurated; every Destination is staff-typed)
// the guide chooses only among those. Otherwise the guide's view is welcome,
// with one hard rule: 'restaurant' only for places that serve food or drink.
// A guide's category lives on their pick only — it never edits Jinni's data.
const CAT_ACTION = { restaurant: 'restaurants', hidden_gem: 'hidden_gems', photo_spot: 'photo_spots', activity: 'activities' };
// Landmark-type categories under which a place is also a fair photo spot.
const SCENIC = new Set(['photo_spots', 'historical', 'history', 'cultural', 'nature', 'art', 'adventure', 'romantic']);
const FOOD_RE = /restaurant|cafe|coffee|bar\b|bakery|food|meal_|pub|wine|tea_house|diner|pizz|steak|brewery|ice_cream|dessert|bistro|tavern/;
const DEST_PREFIX = 'dest:';
// Founder scope: hotels, flights and events are Jinni's own partner bookings — never guide picks.
const LODGING_RE = /lodging|hotel|hostel|motel|resort|guest_house|bed_and_breakfast|campground|rv_park/;
const isOutOfScope = (place = {}) => {
    const actions = Array.isArray(place.actions) ? place.actions : [];
    const types = Array.isArray(place.types) ? place.types : [];
    const food = actions.includes('restaurants') || types.some(t => FOOD_RE.test(t));
    const pickable = actions.some(a => Object.values(CAT_ACTION).includes(a) || SCENIC.has(a));
    // A place whose only identity is lodging / an event (a hotel's restaurant is still a restaurant).
    if (!food && !pickable && (actions.includes('hotels') || actions.includes('events'))) return true;
    if (!food && !pickable && types.some(t => LODGING_RE.test(t))) return true;
    if (place.isEvent) return true;
    return false;
};
const isDestRef = (id) => typeof id === 'string' && id.startsWith(DEST_PREFIX) && /^[a-f0-9]{24}$/i.test(id.slice(DEST_PREFIX.length));

/**
 * place: { actions: string[], curated: boolean, types: string[] }
 * → { curated, allowed: guide categories the guide may choose, suggested, teamCategories }
 */
function categoryRules(place = {}) {
    const actions = Array.isArray(place.actions) ? place.actions.map(String) : [];
    const types = Array.isArray(place.types) ? place.types.map(String) : [];
    const direct = CATEGORIES.filter(c => actions.includes(CAT_ACTION[c]));
    const scenic = actions.some(a => SCENIC.has(a));
    const servesFood = actions.includes('restaurants') || types.some(t => FOOD_RE.test(t));
    let allowed;
    if (isOutOfScope(place)) {
        allowed = [];
    } else if (place.curated) {
        allowed = CATEGORIES.filter(c => direct.includes(c) || (c === 'photo_spot' && scenic));
    } else {
        // Unknown types (legacy rows) stay lenient; known non-food types can't be restaurants.
        allowed = CATEGORIES.filter(c => c !== 'restaurant' || servesFood || (!types.length && !actions.length));
    }
    const suggested = direct.find(c => allowed.includes(c))
        || (servesFood && allowed.includes('restaurant') ? 'restaurant' : null)
        || (scenic && allowed.includes('photo_spot') ? 'photo_spot' : null);
    return { curated: !!place.curated, allowed, suggested: suggested || null, teamCategories: actions, outOfScope: isOutOfScope(place) };
}

/** Staff hint: a category Jinni's own data doesn't back (only for uncurated places with data). */
function categoryMismatch(category, place = {}) {
    const actions = Array.isArray(place.actions) ? place.actions : [];
    if (!actions.length) return false;
    if (actions.includes(CAT_ACTION[category])) return false;
    if (category === 'photo_spot' && actions.some(a => SCENIC.has(a))) return false;
    if (category === 'restaurant' && (place.types || []).some(t => FOOD_RE.test(t))) return false;
    return true;
}

const destImage = (d) => {
    const img = Array.isArray(d.images) ? d.images.find(i => typeof i === 'string' && (/^https:\/\//.test(i) || i.startsWith('/'))) : null;
    return img || null;
};
const fromPlaceCache = (r) => ({
    placeId: r.placeId, name: r.name, source: 'place',
    address: r.details?.formatted_address || [r.city, r.country].filter(Boolean).join(', ') || null,
    image: r.imagesStored ? `/api/ai/place-image/${r.placeId}/0` : null,
    lat: r.details?.geometry?.location?.lat ?? null, lng: r.details?.geometry?.location?.lng ?? null,
    rating: r.rating ?? null,
    _rules: { actions: r.actions || [], curated: !!r.actionsCurated, types: r.types || [] },
});
const fromDestination = (d) => ({
    placeId: DEST_PREFIX + String(d._id), name: d.name, source: 'destination',
    address: d.location?.address || [d.location?.city, d.location?.country].filter(Boolean).join(', ') || null,
    image: destImage(d),
    lat: d.location?.coordinates?.lat ?? null, lng: d.location?.coordinates?.lng ?? null,
    rating: d.rating ?? null,
    _rules: {
        actions: [...new Set([...(Array.isArray(d.type) ? d.type : []), ...(d.isHiddenGem ? ['hidden_gems'] : [])])],
        curated: true, types: [],
        // A staff event (dated) is an event, whatever else it is tagged.
        isEvent: Array.isArray(d.type) && d.type.includes('events') && !!d.eventSchedule?.startDate,
    },
});
const PC_FIELDS = 'placeId name details.formatted_address details.geometry.location city country imagesStored actions actionsCurated types rating business_status';
const DEST_FIELDS = 'name location type images isHiddenGem eventSchedule.startDate';

/** placeIds (Google ids and 'dest:' refs) → Map(placeId → normalized place). Hidden places are absent. */
async function loadPickPlaces(ids, deps = {}) {
    const PlaceCache = deps.PlaceCache || require('../models/PlaceCache');
    const Destination = deps.Destination || require('../models/Destination');
    const all = [...new Set((ids || []).filter(Boolean).map(String))];
    const destIds = all.filter(isDestRef).map(id => id.slice(DEST_PREFIX.length));
    const placeIds = all.filter(id => !id.startsWith(DEST_PREFIX));
    const [pcs, dests] = await Promise.all([
        placeIds.length ? PlaceCache.find({ placeId: { $in: placeIds }, 'explore.status': { $ne: 'hidden' } }).select(PC_FIELDS).lean() : [],
        // Same visibility as chat: an inactive (deleted) Destination is not shown.
        destIds.length ? Destination.find({ _id: { $in: destIds }, isActive: { $ne: false } }).select(DEST_FIELDS).lean() : [],
    ]);
    const out = new Map();
    for (const r of pcs) out.set(r.placeId, fromPlaceCache(r));
    for (const d of dests) out.set(DEST_PREFIX + String(d._id), fromDestination(d));
    return out;
}

/** What the guide's search shows: the place plus which categories they may choose. */
const forGuide = (p) => {
    const { _rules, ...rest } = p;
    return { ...rest, categories: categoryRules(_rules) };
};

async function placeSearch(q, { limit = 12 } = {}, deps = {}) {
    const PlaceCache = deps.PlaceCache || require('../models/PlaceCache');
    const Destination = deps.Destination || require('../models/Destination');
    const term = clip(q, 60);
    if (term.length < 2) return [];
    const re = { $regex: escapeRe(term), $options: 'i' };
    const [dests, rows] = await Promise.all([
        Destination.find({ name: re, isActive: { $ne: false } }).select(DEST_FIELDS).limit(6).lean(),
        PlaceCache.find({
            name: re,
            'explore.status': { $ne: 'hidden' },
            nameAskPending: { $ne: true },
            aiBlocked: { $ne: true },
            business_status: { $ne: 'CLOSED_PERMANENTLY' },
        }).select(PC_FIELDS).limit(limit).lean(),
    ]);
    const destPlaces = dests.map(fromDestination);
    // A cache row is the SAME place as a staff Destination only when the name
    // matches AND it is within ~300 m (same-named places in two cities both stay).
    const near = (a, b) => a.lat != null && b.lat != null && Math.abs(a.lat - b.lat) < 0.003 && Math.abs(a.lng - b.lng) < 0.004;
    const dup = (p) => destPlaces.some(d => d.name.toLowerCase().trim() === String(p.name).toLowerCase().trim() && near(d, p));
    return [...destPlaces, ...rows.map(fromPlaceCache).filter(p => !dup(p))]
        .map(forGuide)
        .filter(p => !p.categories.outOfScope)          // hotels / events never appear
        .slice(0, limit);
}

/**
 * Chat cards whose place an ACTIVE guide picked get `guidePicks`
 * ([{ handle, displayName, note, reelUrl, category }], at most two per card).
 * One query per deck; fails open — a database hiccup never costs the reply.
 */
async function attachGuidePicks(recommendations, deps = {}) {
    try {
        // A card's pick key: its Google place id, or 'dest:<id>' for a staff Destination card.
        const keyOf = (r) => (r && (r.placeId || (r._verifiedModel === 'destination' && r.verifiedId ? DEST_PREFIX + r.verifiedId : null))) || null;
        const ids = [...new Set((recommendations || []).map(keyOf).filter(Boolean))];
        if (!ids.length) return recommendations;
        const GuidePick = deps.GuidePick || require('../models/GuidePick');
        const Guide = deps.Guide || require('../models/Guide');
        const picks = await GuidePick.find({ placeId: { $in: ids } }).select('guide placeId note reelUrl category').lean();
        if (!picks.length) return recommendations;
        const guides = await Guide.find({ _id: { $in: [...new Set(picks.map(p => String(p.guide)))] }, status: 'active' })
            .select('handle displayName').lean();
        const byId = new Map(guides.map(g => [String(g._id), g]));
        for (const rec of recommendations) {
            const key = keyOf(rec);
            if (!key) continue;
            const mine = picks.filter(p => p.placeId === key && byId.has(String(p.guide))).slice(0, 2);
            if (mine.length) {
                rec.guidePicks = mine.map(p => ({
                    handle: byId.get(String(p.guide)).handle, displayName: byId.get(String(p.guide)).displayName,
                    note: p.note || '', reelUrl: p.reelUrl || null, category: p.category,
                }));
            }
        }
    } catch (err) {
        console.warn('[guides] attachGuidePicks failed (cards served without badges):', err.message);
    }
    return recommendations;
}

/**
 * Account deleted → the guide page and every pick go with it (privacy: a
 * deleted person must not stay public). Best-effort, never blocks deletion.
 */
async function deleteGuideForUser(userId, deps = {}) {
    try {
        const Guide = deps.Guide || require('../models/Guide');
        const GuidePick = deps.GuidePick || require('../models/GuidePick');
        const g = await Guide.findOne({ user: userId }).select('_id handle').lean();
        if (!g) return 0;
        await GuidePick.deleteMany({ guide: g._id });
        await Guide.deleteOne({ _id: g._id });
        console.log(`[guides] account deleted → removed guide page @${g.handle} and its picks`);
        return 1;
    } catch (err) {
        console.warn('[guides] deleteGuideForUser failed (account deletion continues):', err.message);
        return 0;
    }
}

module.exports = {
    deleteGuideForUser, normalizeHandle, normalizeInstagram, parseInstagramPost, makeVerificationCode, sanitizeApplication, sanitizeProfileEdit, sanitizePick,
    publicGuide, placeSearch, attachGuidePicks, CATEGORIES, RESERVED,
    categoryRules, categoryMismatch, loadPickPlaces, forGuide, isDestRef, CAT_ACTION,
};
