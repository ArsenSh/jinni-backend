// Jinni V2 Engine — place-name normalization & similarity (pure functions).
// COPIED from routes/aiRoutes.js (v1, lines ~3870–3951) per the copy-not-cut rule
// (engine/ENGINE.md) — v1 keeps its own inline copies untouched. The comments are
// the encoded bug history; they travel with the code.

// Normalize a place name for cross-source matching (AI output ↔ Google
// prefetch shortlist ↔ dedup). Lowercase, strip punctuation, collapse
// whitespace. Unicode-aware so non-Latin names match.
// Number words fold to digits so "Seven Visions" ≡ "7 Visions" — the battery
// row-9 slip where one hotel shipped as two cards. Symmetric (both spellings
// normalize to the digit form), English-only on purpose: digit-vs-word
// aliases in the wild are Latin-script marketing names.
const _NUM_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
const _NUM_WORDS_RE = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g;

// Generic place-TYPE words fold plural→singular so "Seven Visions Hotels" ≡
// "7 Visions Hotel" (live 2026-08-31: the numeral fold above matched, but the
// trailing s kept the curated doc and its Google cache twin as TWO cards in
// one hotel deck). Type words only, never distinctive names — "Republica
// Hotel" and "Republica Suites" are genuinely different Yerevan hotels and
// must stay distinct.
const _TYPE_PLURALS = { hotels: 'hotel', resorts: 'resort', suites: 'suite', apartments: 'apartment', restaurants: 'restaurant', cafes: 'cafe', bars: 'bar', gardens: 'garden', inns: 'inn', lodges: 'lodge', hostels: 'hostel', guesthouses: 'guesthouse', taverns: 'tavern', grills: 'grill', clubs: 'club', lounges: 'lounge', houses: 'house' };
const _TYPE_PLURALS_RE = new RegExp(`\\b(${Object.keys(_TYPE_PLURALS).join('|')})\\b`, 'g');

const normalizePlaceName = (s) => (s || '')
    .toLowerCase()
    .trim()
    // Fold diacritics before stripping punctuation: decompose to base letter +
    // combining mark, then drop the marks. Without this, "Shene" and "Shéné" are
    // different words and the name guard rejects a CORRECT venue — which is what
    // happened to a real Yerevan open-air venue, and would happen to any accented
    // French, Turkish or transliterated Armenian name. Latin-script only by
    // construction: Armenian and Cyrillic letters carry no combining marks here,
    // so they pass through untouched.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(_NUM_WORDS_RE, (w) => _NUM_WORDS[w])
    .replace(_TYPE_PLURALS_RE, (w) => _TYPE_PLURALS[w]);

// ── Name-similarity guard ─────────────────────────────────────────────────────
// The model proposes a NAME; Google's text search returns its closest real match
// regardless of how close that match actually is, so a hallucinated name
// ("Liqstum Hotel") gets rescued with an unrelated real place ("The Lichk
// Lodge"). namesPlausiblyMatch() compares the requested name to the resolved one
// and is used to drop these rescues.
//
// SCRIPT SAFEGUARD: Google often returns a place's native-script name
// (e.g. "Զանգեզուր" for a query "Zangezur Cafe"). A naive Latin token compare
// would wrongly drop those, so when the two names are written in DIFFERENT
// scripts we SKIP the check entirely (treat as a match) and rely on the type +
// radius filters instead. The guard only ever fires when both names share a
// script and still have nothing in common.
const _GENERIC_PLACE_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'at', 'in', 'on', 'by', 'de', 'la', 'le',
    'hotel', 'hotels', 'restaurant', 'cafe', 'café', 'bar', 'pub', 'resort', 'lodge', 'inn', 'house', 'tavern',
    'garden', 'gardens', 'grill', 'kitchen', 'bistro', 'lounge', 'club', 'spa', 'suites', 'guesthouse', 'hostel',
    'company', 'co', 'place', 'yerevan', 'armenia']);
const _scriptOf = (s) => {
    if (/[԰-֏]/.test(s)) return 'armenian';
    if (/[Ѐ-ӿ]/.test(s)) return 'cyrillic';
    if (/[Ͱ-Ͽ]/.test(s)) return 'greek';
    if (/[a-z]/i.test(s)) return 'latin';
    return 'other';
};
const _sigTokens = (s) => normalizePlaceName(s).split(' ').filter(t => t.length >= 3 && !_GENERIC_PLACE_WORDS.has(t));
const _lev = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[m][n];
};
const _tokensSimilar = (x, y) => x === y
    || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)))
    || (x.length >= 5 && y.length >= 5 && _lev(x, y) <= 1);

// "Did THIS message name this place?" — used by the dislike direct-ask
// exception. The old check was strict substring (msg.includes(fullName)),
// which fails whenever the user's wording differs from the stored/resolved
// name: user types "paphos gardens hotel", the vote was stored as "Paphos
// Gardens Holiday Resort" → no substring hit → treated as NOT asked → the
// place the user explicitly asked about got suppressed. Token rule: every
// DISTINCTIVE word of the place name (generic hotel-words excluded) must
// appear in the message; the old substring check is kept as a fallback.
const GENERIC_PLACE_WORDS = new Set(['hotel', 'hotels', 'resort', 'resorts', 'holiday', 'suites', 'apartments', 'apartment', 'inn', 'guesthouse', 'hostel', 'restaurant', 'cafe', 'bar', 'spa', 'beach', 'luxury', 'collection', 'grand', 'royal', 'the', 'by', 'and', 'of', 'a', 'an']);
// `excludeTokens` (optional Set of lowercase words): tokens that must NOT
// count as evidence the message names this place — the caller passes the
// GEOGRAPHIC names the intent extracted. Without it, a card like "Cafe #2
// Dilijan" reduces to the single token "dilijan" (cafe = generic, #2 = short)
// and swallows ANY message that mentions the city: "suggest 6 hotels, all in
// Dilijan" was answered by the shown-card question path instead of a deck
// (live 2026-08-30). Typing the full card name verbatim still matches —
// that is a genuine reference regardless of what it contains.
function messageNamesPlace(msgLower, placeName, excludeTokens = null) {
    if (!msgLower || !placeName) return false;
    const nameLower = String(placeName).toLowerCase();
    if (msgLower.includes(nameLower)) return true;                    // old behavior still counts
    const sig = nameLower.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !GENERIC_PLACE_WORDS.has(w)
            && !(excludeTokens && excludeTokens.has(w)));
    return sig.length > 0 && sig.every(w => msgLower.includes(w));
}

function namesPlausiblyMatch(requested, resolved) {
    if (!requested || !resolved) return true;            // nothing to compare → keep
    if (_scriptOf(requested) !== _scriptOf(resolved)) return true; // cross-script → skip (keep)
    const a = _sigTokens(requested), b = _sigTokens(resolved);
    if (!a.length || !b.length) return true;             // only generic words → can't judge → keep
    return a.some(x => b.some(y => _tokensSimilar(x, y)));
}

module.exports = { normalizePlaceName, namesPlausiblyMatch, messageNamesPlace, _sigTokens, _scriptOf };
