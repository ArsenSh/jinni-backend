// The CONSTRAINT LEDGER — what the traveler currently wants, as data.
//
// QA §4 (ChatGPT battery, live 2026-09-04): "Armenian near Republic Square" →
// "Something cheaper." → "Walking distance." chained perfectly, then
// "For 4 people tonight at 8." ran at r=15km style=luxury — the 2km walking
// cap and the `cheaper` both evaporated, because every constraint lived only
// in the turn that uttered it. "Actually make it 9." was worse: the query
// degraded to q="restaurant actually make" and even ARMENIAN fell out.
// The spec Jinni failed: "preserve the previous constraints and change only
// what the user changed."
//
// So constraints become a small typed object on the ChatSession, merged by
// CODE from what each message explicitly said — never model memory. Engine
// rules: pure, no express, no DB, no clock reads except through arguments.
//
// Merge discipline:
//  · a delta key replaces only that key ("make it 9" touches targetTime);
//  · a MISSION change resets the ledger — new category wipes everything
//    (ChatGPT §10's trap: constraints must not leak into unrelated asks);
//  · absent prev (new chat) → the delta IS the ledger.
//
// partySize is context for narration only — Jinni holds no reservations and
// the ledger must never pretend it does. targetTime feeds the open-at check
// (isOpenAt at the ASKED hour, not now), closing the "available tonight at
// 8 PM?" gap from the real-time QA in the same stroke.

/** "For 4 people", "table for two", "нас 4", "для 6" → integer or null. */
const PARTY_RES = [
    /\bfor\s+(\d{1,2})\s*(?:people|persons|guests|of us|pax)?\b/i,
    /\b(\d{1,2})\s+(?:people|persons|guests)\b/i,
    // \b is ASCII-only — Cyrillic needs explicit boundaries (repo lesson).
    /(?:^|\s)нас\s+(\d{1,2})(?!\d)/i,
    /(?:^|\s)для\s+(\d{1,2})(?!\d)/i,
];
const PARTY_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6 };
function parsePartySize(message) {
    const m = String(message || '');
    for (const re of PARTY_RES) {
        const hit = re.exec(m);
        if (hit) { const n = Number(hit[1]); if (n >= 1 && n <= 30) return n; }
    }
    const w = /\bfor\s+(two|three|four|five|six)\b/i.exec(m);
    if (w) return PARTY_WORDS[w[1].toLowerCase()];
    return null;
}

/**
 * "tonight at 8", "at 20:00", "8 pm", "actually make it 9" → minutes-of-day
 * or null. PM inference, in order of trust:
 *  1. an explicit marker (pm / tonight / evening / dinner / вечера);
 *  2. the PREVIOUS target ("make it 9" after 20:00 means 21:00, not 09:00);
 *  3. a small bare hour that has already PASSED locally means this evening
 *     ("at 8" asked at 13:00 → 20:00) — nowMinutes is injected, never read
 *     from a clock, so tests stay deterministic.
 */
function parseTargetTime(message, { prevTargetMin = null, nowMinutes = null } = {}) {
    const m = String(message || '');
    const hit = /(?:\bat|\bmake it|\bв|ժամը)\s*(\d{1,2})(?::(\d{2}))?\s*(pm|am|вечера|утра)?\b/i.exec(m)
        || /\b(\d{1,2})(?::(\d{2}))?\s*(pm|am)\b/i.exec(m);
    if (!hit) return null;
    let hour = Number(hit[1]);
    const minute = hit[2] ? Number(hit[2]) : 0;
    if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
    const marker = (hit[3] || '').toLowerCase();
    const evening = /\b(tonight|this evening|dinner|вечером|сегодня вечером|երեկոյան)\b/i.test(m);
    if (hour <= 11) {
        if (marker === 'pm' || marker === 'вечера' || evening) hour += 12;
        else if (marker === 'am' || marker === 'утра') { /* literal */ }
        else if (prevTargetMin != null && prevTargetMin >= 12 * 60) hour += 12;
        else if (nowMinutes != null && hour * 60 + minute < nowMinutes && hour >= 5) hour += 12;
    }
    return hour * 60 + minute;
}

/** Human "21:00" for logs. */
function fmtTargetTime(min) {
    if (min == null) return null;
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const LEDGER_KEYS = ['price', 'radiusCapKm', 'partySize', 'targetTime', 'outOfTown'];

/**
 * @param {object|null} prev   the stored ledger (or null)
 * @param {object}      delta  ONLY what this message explicitly said
 * @param {object}      ctx    { category } — the turn's mission
 * @returns {{ ledger: object, changed: string[], reset: boolean }}
 */
function mergeConstraints(prev, delta = {}, { category = null } = {}) {
    const reset = !prev || (category && prev.category && prev.category !== category);
    const base = reset ? { category } : { ...prev, category: category || prev.category };
    const changed = [];
    for (const k of LEDGER_KEYS) {
        if (delta[k] !== undefined && delta[k] !== null && base[k] !== delta[k]) {
            base[k] = delta[k];
            changed.push(k);
        }
    }
    // lastQuery/lastCore ride along untyped — the caller stamps them after a
    // successful deck so a modifier-only follow-up can reuse the real query.
    if (delta.lastQuery) base.lastQuery = delta.lastQuery;
    if (delta.lastCore !== undefined) base.lastCore = delta.lastCore;
    return { ledger: base, changed, reset: !!(reset && prev) };
}

/** One readable line per turn — the "where did it go" discipline for wants. */
function ledgerLine(ledger, changed = []) {
    if (!ledger) return '[ledger] empty';
    const bits = [ledger.category || '?'];
    if (ledger.price) bits.push(ledger.price);
    if (ledger.radiusCapKm) bits.push(`≤${ledger.radiusCapKm}km`);
    if (ledger.partySize) bits.push(`${ledger.partySize}p`);
    if (ledger.targetTime != null) bits.push(`@${fmtTargetTime(ledger.targetTime)}`);
    if (ledger.outOfTown) bits.push('out-of-town');
    return `[ledger] ${bits.join(' · ')}${changed.length ? ` (changed: ${changed.join(',')})` : ' (carried)'}`;
}

module.exports = { parsePartySize, parseTargetTime, fmtTargetTime, mergeConstraints, ledgerLine };
