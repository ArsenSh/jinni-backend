#!/usr/bin/env node
/**
 * Corpus density audit — the validator worklist generator (2026-08-31).
 *
 * Purpose: data density is the pre-launch priority (users arrive Sept 1).
 * Descriptions now reach BOTH retrieval and narration, and pricing in any
 * currency feeds the budget filter — so every field filled via the validator
 * pays off immediately. This script shows WHERE the gaps are, per city, so
 * validation time goes to the right places instead of guesses.
 *
 * READ-ONLY: no writes, no Google calls, no model calls. Safe to run anytime.
 *
 * Run ON THE SERVER (Atlas IP whitelist blocks local, same as embedPlaceCache):
 *   node scripts/corpusAudit.js                     # Yerevan Dilijan Gyumri
 *   node scripts/corpusAudit.js Yerevan Sevan       # any city list
 *
 * Output: console summary + corpus-audit-YYYY-MM-DD.md next to the repo root
 * (the worklist: what to describe, what to price, what to curate next).
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Destination = require('../models/Destination');
const Business = require('../models/Business');
const PlaceCache = require('../models/PlaceCache');

const DEFAULT_CITIES = ['Yerevan', 'Dilijan', 'Gyumri'];

/** Case/diacritic-loose name key so "Cafe #2" ≡ "Café  2". */
const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9Ѐ-ӿ԰-֏]+/g, '');

/** Pricing filled = figures exist. isFree defaults to true on untouched docs,
 *  so bare isFree proves nothing — only min/max/average distinguish "entered"
 *  from "never opened the form". */
const pricingEntered = (p) => !!(p && (p.min != null || p.max != null || p.average != null));

async function auditCity(city) {
    const cityRe = new RegExp(`^${city}$`, 'i');
    const out = { city, dest: {}, biz: {}, cache: {} };

    // ── Destinations (validator-curated — the moat rows) ──
    const dests = await Destination.find({ 'location.city': cityRe })
        .select('name category description images pricing').lean();
    out.dest.total = dests.length;
    out.dest.byCategory = {};
    for (const d of dests) out.dest.byCategory[d.category || '?'] = (out.dest.byCategory[d.category || '?'] || 0) + 1;
    out.dest.noDescription = dests.filter(d => !String(d.description || '').trim())
        .map(d => ({ name: d.name, category: d.category }));
    out.dest.noPricing = dests.filter(d => !pricingEntered(d.pricing))
        .map(d => ({ name: d.name, category: d.category }));
    out.dest.fewImages = dests.filter(d => (d.images || []).length < 3)
        .map(d => ({ name: d.name, n: (d.images || []).length }));

    // ── Businesses ──
    const bizs = await Business.find({ 'location.city': cityRe })
        .select('name status description pricing').lean();
    out.biz.total = bizs.length;
    out.biz.byStatus = {};
    for (const b of bizs) out.biz.byStatus[b.status || '?'] = (out.biz.byStatus[b.status || '?'] || 0) + 1;
    out.biz.noDescription = bizs.filter(b => !String(b.description?.short || '').trim())
        .map(b => ({ name: b.name, status: b.status }));
    out.biz.noPricing = bizs.filter(b => !pricingEntered(b.pricing))
        .map(b => ({ name: b.name, status: b.status }));

    // ── PlaceCache: what chat already warmed but nobody curated ──
    // These are the "request lots of places, then validate" candidates: real,
    // rated, photographed — one description away from becoming moat data.
    const curatedKeys = new Set(dests.map(d => nameKey(d.name)));
    const cached = await PlaceCache.find({
        city: cityRe,
        $or: [{ 'explore.status': { $exists: false } }, { 'explore.status': 'visible' }],
    }).select('name rating types categories imagesStored').lean();
    out.cache.total = cached.length;
    const uncurated = cached.filter(p => !curatedKeys.has(nameKey(p.name)));
    out.cache.uncurated = uncurated.length;
    out.cache.topUncurated = uncurated
        .filter(p => (p.rating || 0) >= 4)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 20)
        .map(p => ({
            name: p.name, rating: p.rating || null,
            type: (p.categories && p.categories[0]) || (p.types || [])[0] || '?',
            img: p.imagesStored ? 'img✓' : 'img✗',
        }));
    return out;
}

function renderMd(results) {
    const L = [];
    L.push(`# Corpus audit — ${new Date().toISOString().slice(0, 10)}`);
    L.push('');
    L.push('Worklist for validator time, highest leverage first: (1) describe curated');
    L.push('Destinations with no description; (2) enter pricing where figures are missing');
    L.push('(any currency — the filter converts); (3) curate the top uncurated PlaceCache');
    L.push('rows (already rated + photographed by the warming path).');
    for (const r of results) {
        L.push('', `## ${r.city}`, '');
        L.push(`**Destinations:** ${r.dest.total} total — ${Object.entries(r.dest.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`);
        L.push(`- No description (${r.dest.noDescription.length}): ${r.dest.noDescription.map(d => `${d.name} [${d.category}]`).join('; ') || '—'}`);
        L.push(`- No pricing figures (${r.dest.noPricing.length}): ${r.dest.noPricing.map(d => d.name).join('; ') || '—'}`);
        L.push(`- Fewer than 3 images (${r.dest.fewImages.length}): ${r.dest.fewImages.map(d => `${d.name} (${d.n})`).join('; ') || '—'}`);
        L.push('');
        L.push(`**Businesses:** ${r.biz.total} total — ${Object.entries(r.biz.byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`);
        L.push(`- No short description (${r.biz.noDescription.length}): ${r.biz.noDescription.map(b => b.name).join('; ') || '—'}`);
        L.push(`- No pricing figures (${r.biz.noPricing.length}): ${r.biz.noPricing.map(b => b.name).join('; ') || '—'}`);
        L.push('');
        L.push(`**PlaceCache:** ${r.cache.total} visible cached, ${r.cache.uncurated} with no curated Destination twin.`);
        L.push(`Top uncurated (rating ≥4) — the "validate next" list:`);
        for (const p of r.cache.topUncurated) L.push(`- ${p.name} · ${p.rating ?? '?'}★ · ${p.type} · ${p.img}`);
        if (!r.cache.topUncurated.length) L.push('- —');
    }
    return L.join('\n') + '\n';
}

(async () => {
    const cities = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const targets = cities.length ? cities : DEFAULT_CITIES;
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    try {
        const results = [];
        for (const city of targets) {
            const r = await auditCity(city);
            results.push(r);
            console.log(`[audit] ${city}: dest=${r.dest.total} (no-desc ${r.dest.noDescription.length}, no-price ${r.dest.noPricing.length}) `
                + `biz=${r.biz.total} cache=${r.cache.total} (uncurated ${r.cache.uncurated}, top picks ${r.cache.topUncurated.length})`);
        }
        const file = `corpus-audit-${new Date().toISOString().slice(0, 10)}.md`;
        fs.writeFileSync(file, renderMd(results));
        console.log(`[audit] worklist written → ${file}`);
    } finally {
        await mongoose.disconnect();
    }
})().catch((err) => { console.error('[audit] failed:', err.message); process.exit(1); });
