// Jinni V2 Engine — short booking links for fares.
//
// WHY: the fare feed's booking URLs are ~400 characters with underscores in
// them. Copied verbatim by the narrator they (a) ate the reply's token budget
// — four fares, and the answer stopped mid-URL — and (b) were mangled by the
// chat's `_x_` → <em> rule (live 2026-09-13). The narrator now gets
// `${API_PUBLIC_URL}/go/f/<id>`; GET /go/f/:id redirects to the real URL.
//
// HONESTY: when the link store is unavailable the REAL url is returned, not
// nothing — a long link still opens the booking page; a missing one does not.

const crypto = require('crypto');

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://api.jinni.travel').replace(/\/$/, '');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^[A-Za-z0-9]{8}$/;

function shortId() {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
    return s;
}

/** The default store: the FlightLink collection, only while Mongo is up. */
const mongoStore = {
    async save(id, url) {
        const mongoose = require('mongoose');
        if (mongoose.connection?.readyState !== 1) return false;
        const FlightLink = require('../../models/FlightLink');
        await FlightLink.create({ _id: id, url });
        return true;
    },
    async load(id) {
        const mongoose = require('mongoose');
        if (mongoose.connection?.readyState !== 1) return null;
        const FlightLink = require('../../models/FlightLink');
        const row = await FlightLink.findById(id).lean();
        return row?.url || null;
    },
};

/** Real booking URL → short redirect URL. Falls back to the real URL. */
async function shortenBookUrl(url, deps = {}) {
    if (!url || !/^https?:\/\//i.test(String(url))) return url || null;
    const store = deps.store || mongoStore;
    const base = deps.publicUrl || API_PUBLIC_URL;
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = shortId();
        try {
            if (await store.save(id, url)) return `${base}/go/f/${id}`;
            return url;                                   // store not available — honest long link
        } catch (err) {
            if (err?.code !== 11000) return url;          // anything but an id collision → long link
        }
    }
    return url;
}

/** Short id → real URL, or null when unknown/expired/malformed. */
async function resolveBookUrl(id, deps = {}) {
    if (!ID_RE.test(String(id || ''))) return null;
    const store = deps.store || mongoStore;
    try { return await store.load(id); } catch { return null; }
}

module.exports = { shortenBookUrl, resolveBookUrl, shortId, ID_RE, API_PUBLIC_URL };
