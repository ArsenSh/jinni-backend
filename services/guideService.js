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
    const handle = normalizeHandle(body.handle || body.instagram);
    if (!handle) return { error: 'Choose a page name of 3–30 letters, digits, dots or underscores.' };
    const instagram = normalizeHandle(body.instagram || body.handle);
    if (!instagram) return { error: 'Enter your Instagram username.' };
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
async function placeSearch(q, { limit = 12 } = {}, deps = {}) {
    const PlaceCache = deps.PlaceCache || require('../models/PlaceCache');
    const term = clip(q, 60);
    if (term.length < 2) return [];
    const rows = await PlaceCache.find({
        name: { $regex: escapeRe(term), $options: 'i' },
        'explore.status': { $ne: 'hidden' },
        nameAskPending: { $ne: true },
        aiBlocked: { $ne: true },
    }).select('placeId name details.formatted_address city country imagesStored actions').limit(limit).lean();
    return rows.map(r => ({
        placeId: r.placeId, name: r.name,
        address: r.details?.formatted_address || [r.city, r.country].filter(Boolean).join(', ') || null,
        image: r.imagesStored ? `/api/ai/place-image/${r.placeId}/0` : null,
    }));
}

/**
 * Chat cards whose place an ACTIVE guide picked get `guidePicks`
 * ([{ handle, displayName, note, reelUrl, category }], at most two per card).
 * One query per deck; fails open — a database hiccup never costs the reply.
 */
async function attachGuidePicks(recommendations, deps = {}) {
    try {
        const ids = [...new Set((recommendations || []).map(r => r && r.placeId).filter(Boolean))];
        if (!ids.length) return recommendations;
        const GuidePick = deps.GuidePick || require('../models/GuidePick');
        const Guide = deps.Guide || require('../models/Guide');
        const picks = await GuidePick.find({ placeId: { $in: ids } }).select('guide placeId note reelUrl category').lean();
        if (!picks.length) return recommendations;
        const guides = await Guide.find({ _id: { $in: [...new Set(picks.map(p => String(p.guide)))] }, status: 'active' })
            .select('handle displayName').lean();
        const byId = new Map(guides.map(g => [String(g._id), g]));
        for (const rec of recommendations) {
            if (!rec || !rec.placeId) continue;
            const mine = picks.filter(p => p.placeId === rec.placeId && byId.has(String(p.guide))).slice(0, 2);
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

module.exports = {
    normalizeHandle, parseInstagramPost, makeVerificationCode, sanitizeApplication, sanitizeProfileEdit, sanitizePick,
    publicGuide, placeSearch, attachGuidePicks, CATEGORIES, RESERVED,
};
