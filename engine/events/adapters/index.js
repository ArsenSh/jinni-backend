// Jinni V2 Engine — per-site listing adapters.
//
// THE DEFAULT IS THE GENERIC READER. The structured-data ladder (JSON-LD,
// microdata, RDFa, epoch attributes) reads tomsarkgh, ticket-am, platinumlist
// and ticketmaster.ae with no site-specific code, and every line of that code
// is a line nobody has to maintain when a site redesigns.
//
// An adapter is the escape hatch, and it earns its existence the same way a
// discovered source does: it is written against a REAL page the ladder got
// wrong, never speculatively (Arsen 2026-08-24 — "several codes for each type
// of websites"). Two rules keep the habit honest:
//
//   1. An adapter that returns nothing falls back to the generic path. A stale
//      adapter degrades the answer; it must never be able to delete one.
//   2. Its yield is tracked like any source, so a site redesign shows up as a
//      source reading empty rather than as silence.
//
// Sources may name one explicitly (EventSource.adapter), and a source whose
// host an adapter declares gets it automatically — so a DISCOVERED allevents
// page is parsed properly without anyone configuring anything.

const ADAPTERS = [
    require('./allevents'),
];

const BY_NAME = new Map(ADAPTERS.map(a => [a.name, a]));

/** Adapter names, for the staff UI's picker. */
function listAdapters() {
    return ADAPTERS.map(a => ({ name: a.name, hosts: a.hosts }));
}

/** The adapter for this source: the one it names, else the one that declares
 *  its host, else null (the generic ladder). */
function pickAdapter(url, named = null) {
    if (named && BY_NAME.has(named)) return BY_NAME.get(named);
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
    return ADAPTERS.find(a => (a.hosts || []).some(h => host === h || host.endsWith(`.${h}`))) || null;
}

/** Run one, fail-open. An adapter that throws or returns nothing is simply not
 *  an answer — the caller falls back to the generic reader. */
function runAdapter(adapter, html, ctx = {}) {
    if (!adapter || typeof adapter.extract !== 'function') return [];
    try {
        const rows = adapter.extract(html, ctx) || [];
        return rows.filter(e => e && e.name && e.startDate instanceof Date && !Number.isNaN(e.startDate.getTime()));
    } catch (err) {
        console.warn(`[adapter] ${adapter.name} failed on ${String(ctx.url).slice(0, 80)}: ${err.message}`);
        return [];
    }
}

module.exports = { listAdapters, pickAdapter, runAdapter, ADAPTERS };
