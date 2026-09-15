// Jinni engine — per-request capture of the engine's own console lines.
//
// WHY (founder 2026-09-16): "when the app is in production it may not behave
// correctly; I want to track from the admin page how each user used it and
// what they saw, and give that to you." Every diagnostic the engine prints —
// "[v3] controller … lane=deck", "[retrieval] 28 candidate(s) → 3 served",
// "[canonicalStore] closed business row(s) dropped" — already exists; it only
// goes to the console. This keeps those lines for the duration of ONE request
// and hands them to the turn log, so the admin Sessions tab can show the
// engine's reasoning next to what the traveler typed and saw.
//
// Mechanics: AsyncLocalStorage carries a buffer through every await of a
// request; console.log/warn/error are wrapped ONCE to append to the active
// buffer (and still print). No request → no buffer → nothing changes. Capped
// so a runaway loop can never grow a turn record without bound.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const MAX_LINES = 120;
const MAX_LINE = 500;

function fmt(args) {
    return args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

let installed = false;
function install() {
    if (installed) return;
    installed = true;
    for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            const buf = als.getStore();
            if (buf && buf.length < MAX_LINES) {
                const line = fmt(args).replace(/\s+/g, ' ').trim();
                if (line) buf.push(`${new Date().toISOString().slice(11, 23)} ${line.slice(0, MAX_LINE)}`);
            }
            orig(...args);
        };
    }
}

/** Express middleware: every request runs inside its own buffer. */
function middleware(req, res, next) {
    install();
    als.run([], () => next());
}

/** The lines captured so far for the current request (a copy). */
function capture() {
    const buf = als.getStore();
    return Array.isArray(buf) ? buf.slice() : [];
}

/** Run fn inside a fresh buffer — for tests and background jobs. */
function runWithLog(fn) {
    install();
    return als.run([], fn);
}

module.exports = { middleware, capture, runWithLog, install, MAX_LINES };
