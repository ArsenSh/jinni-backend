// Jinni V2 Engine — personal taste: likes, saves, and cross-session seen history.
//
// THE design rule: taste is a NUDGE, never a hijack. Relevance (lexical/vector/
// proximity/prior fusion) stays in charge of WHAT answers the ask; taste only
// re-shuffles nearby ranks — a liked place climbs a few positions, a place the
// user has been shown many times and never acted on sinks a little. Nothing is
// ever hidden by taste (dislikes are the exception, and they are EXCLUDES,
// handled before ranking — with the direct-ask exception: a place the user
// names right now is never hidden from them).
//
// Deleted-session safety by construction: PlaceFeedback, SavedPlace and
// PlaceView are their own collections keyed by (userId, placeId) — deleting a
// ChatSession deletes conversation text, not these signals. PlaceView carries
// its own 90-day TTL so long-unseen places resurface naturally (v1's policy).
//
// All loads are FAIL-OPEN: a broken signal source costs personalization for
// one turn, never the turn itself.

const { normalizePlaceName, messageNamesPlace } = require('../places/matching');

// v1 parity (aiRoutes buildSeenPenalty): watched (deliberate engagement —
// opened More, tapped Ask AI…) is penalised harder than merely shown, and both
// decay linearly over the 90-day window so old sightings feel fresh again.
const SEEN_WATCHED_MAX = 3.0;
const SEEN_SHOWN_MAX = 1.5;
const SEEN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const VIEW_TTL_MS = SEEN_WINDOW_MS;

// Rank nudges, in positions on the fused order. Liked beats saved (an explicit
// vote beats a bookmark); they stack for a place that is both.
//
// Seen policy = FRESH-FIRST (Arsen's rule, 2026-08-22, after positional
// sinking still replayed decks: "everytime new things will show but if there
// is not new things old things can show"): places the user has seen and not
// acted on move BEHIND every fresh candidate — least-fatigued returning
// first — so identical asks keep discovering until the corpus is exhausted,
// then gracefully replay. Liked/saved places are EXEMPT (their boost stands:
// the user's own picks are never demoted for being familiar), a nearly
// decayed sighting (~90-day window) counts as fresh again, and nothing is
// ever hidden — seen places fill whatever fresh can't. The demand-seat
// guarantee (specific asks like "sushi") still runs after taste.
const LIKED_BOOST = 2.5;
const SAVED_BOOST = 1.5;
const SEEN_PENALTY_MAX = 8.0;   // clamp: watched(3) + repeat-show bonus (cap +5)
const FRESH_AGAIN_BELOW = 0.3;  // decayed penalty under this ⇒ treated as unseen

/**
 * Load the user's complete taste profile in one parallel pass.
 * @returns {{liked: Map<string,string>, disliked: Map<string,string>,
 *            saved: Map<string,string>, seen: Map<string,number>}|null}
 *   Maps are keyed by place identity (Google placeId or stringified verified
 *   _id — whichever the signal was recorded under) → denormalized name (liked/
 *   disliked/saved) or decayed penalty 0..3 (seen). null only if userId absent.
 */
async function loadTaste(userId, deps = {}) {
    if (!userId) return null;
    const PlaceFeedback = deps.PlaceFeedback || require('../../models/PlaceFeedback');
    const SavedPlace = deps.SavedPlace || require('../../models/SavedPlace');
    const PlaceView = deps.PlaceView || require('../../models/PlaceView');
    const now = deps.nowFn ? deps.nowFn() : Date.now();

    const [voteRows, savedRows, viewRows] = await Promise.all([
        PlaceFeedback.find({ userId }).sort({ updatedAt: -1 }).select('placeId vote name').lean()
            .catch(err => { console.warn('[taste] feedback load failed:', err.message); return []; }),
        SavedPlace.find({ userId }).select('verifiedId googlePlaceId name').lean()
            .catch(err => { console.warn('[taste] saved load failed:', err.message); return []; }),
        PlaceView.find({ userId }).select('placeId status shownCount lastShownAt action').lean()
            .catch(err => { console.warn('[taste] views load failed:', err.message); return []; }),
    ]);

    // Latest vote per placeId wins (rows arrive newest-first) — a like→dislike
    // toggle leaves only the current opinion, exactly v1's display collapse.
    const liked = new Map(), disliked = new Map();
    const latestByPlace = new Map();
    for (const r of voteRows) if (r.placeId && !latestByPlace.has(r.placeId)) latestByPlace.set(r.placeId, r);
    for (const [pid, r] of latestByPlace) {
        (r.vote === 'like' ? liked : disliked).set(pid, r.name || '');
    }

    const saved = new Map();
    for (const s of savedRows) {
        if (s.googlePlaceId) saved.set(s.googlePlaceId, s.name || '');
        if (s.verifiedId) saved.set(String(s.verifiedId), s.name || '');
    }

    const seen = new Map();
    for (const v of viewRows) {
        if (!v.placeId) continue;
        const age = now - new Date(v.lastShownAt || now).getTime();
        const freshness = Math.max(0, 1 - age / SEEN_WINDOW_MS);   // 1 = just seen, 0 = old
        const base = v.status === 'watched' ? SEEN_WATCHED_MAX : SEEN_SHOWN_MAX;
        // Repeat shows compound: each extra unacted appearance adds fatigue
        // (+1 per repeat, capped at +5), so identical asks rotate the deck
        // instead of replaying it. Age-decayed like the base — old repetition
        // is forgiven.
        const repeats = Math.min(5, Math.max(0, (v.shownCount || 1) - 1));
        const pen = (base + repeats) * freshness;
        // Context rides along (Arsen: "it should save the context too") —
        // fatigue is judged against the CURRENT ask's category in tasteAdjust.
        if (pen > 0) seen.set(v.placeId, { pen: Math.min(SEEN_PENALTY_MAX, pen), action: v.action || null });
    }

    return { liked, disliked, saved, seen };
}

/**
 * Dislikes → retrieval excludes, honoring the direct-ask exception: a dislike
 * means "stop suggesting this", NOT "refuse to discuss it" — a place the user
 * names in THIS message is never hidden. (Moved here from the route, 2026-08-22.)
 */
function dislikeExcludes(taste, message) {
    const out = { placeIds: [], names: [] };
    if (!taste || !taste.disliked || !taste.disliked.size) return out;
    const msgLower = String(message || '').toLowerCase();
    for (const [pid, name] of taste.disliked) {
        if (name && messageNamesPlace(msgLower, name)) continue;   // direct-ask exception
        out.placeIds.push(pid);
        if (name) out.names.push(name);
    }
    return out;
}

/** Every identity a candidate answers to: ids first, normalized name last. */
function _keysOf(c) {
    return [c.placeId, c.verifiedId && String(c.verifiedId), normalizePlaceName(c.name || '') || null]
        .filter(Boolean);
}

function _matchByKeys(map, keys, byName) {
    for (const k of keys) if (map.has(k)) return true;
    // Name fallback: DB and Google identities for the same place diverge, but
    // the denormalized names agree.
    if (byName && byName.size) {
        const nk = keys[keys.length - 1];
        if (nk && byName.has(nk)) return true;
    }
    return false;
}

/**
 * Reorder a fused ranking by the user's taste — pure, stable, bounded.
 * Annotates matched candidates (_tasteLiked/_tasteSaved) so the narrator can
 * honestly say "you saved this one". Fresh-first partition (see header):
 * [liked/saved/unseen, by boosted fused order] then [seen, least-fatigued
 * first]. Seen-fatigue never applies to a place the user liked or saved
 * (they've seen it BECAUSE they love it).
 */
function tasteAdjust(ordered, taste, { category = null } = {}) {
    if (!taste || !Array.isArray(ordered) || ordered.length < 2) return ordered || [];
    const likedNames = new Set([...(taste.liked?.values() || [])].map(normalizePlaceName).filter(Boolean));
    const savedNames = new Set([...(taste.saved?.values() || [])].map(normalizePlaceName).filter(Boolean));
    const scored = ordered.map((c, i) => {
        const keys = _keysOf(c);
        const isLiked = taste.liked?.size ? _matchByKeys(taste.liked, keys, likedNames) : false;
        const isSaved = taste.saved?.size ? _matchByKeys(taste.saved, keys, savedNames) : false;
        if (isLiked) c._tasteLiked = true;
        if (isSaved) c._tasteSaved = true;
        let score = i;
        if (isLiked) score -= LIKED_BOOST;
        if (isSaved) score -= SAVED_BOOST;
        let pen = 0;
        if (!isLiked && !isSaved && taste.seen?.size) {
            for (const k of keys) {
                const entry = taste.seen.get(k);
                if (entry) {
                    const raw = typeof entry === 'number' ? entry : entry.pen;
                    const act = typeof entry === 'number' ? null : entry.action;
                    // Context-scoped fatigue: seen under THIS category counts
                    // fully; seen under a different one counts half — a place
                    // shown as 'historical' stays mostly fresh for a
                    // 'photo_spots' ask, but doesn't replay instantly either.
                    pen = (act && category && act !== category) ? raw * 0.5 : raw;
                    break;
                }
            }
        }
        const isSeen = pen >= FRESH_AGAIN_BELOW;   // nearly decayed ⇒ fresh again
        return { c, score, i, pen, isSeen };
    });
    const byScore = (a, b) => a.score - b.score || a.i - b.i;      // stable
    const fresh = scored.filter(s => !s.isSeen).sort(byScore);
    // Backfill order: least-fatigued (oldest / fewest shows) returns first.
    const seen = scored.filter(s => s.isSeen).sort((a, b) => a.pen - b.pen || byScore(a, b));
    return [...fresh, ...seen].map(s => s.c);
}

/**
 * Remember what THIS turn showed the user (weak 'shown' signal) — the source
 * feeding cross-session novelty. Best-effort bulk upsert, byte-parity with
 * v1's recordPlaceViews (aiRoutes ~582): refreshes the TTL window, never
 * downgrades a place already promoted to 'watched'. Never blocks the response.
 */
function recordViews(userId, recommendations, action = null, deps = {}) {
    try {
        const PlaceView = deps.PlaceView || require('../../models/PlaceView');
        const ids = [...new Set((recommendations || []).map(r => r && (r.placeId || r.verifiedId)).filter(Boolean))];
        if (!userId || !ids.length) return;
        const now = new Date(), expireAt = new Date(Date.now() + VIEW_TTL_MS);
        const ops = ids.map(placeId => ({
            updateOne: {
                filter: { userId, placeId: String(placeId) },
                update: {
                    $set: { lastShownAt: now, expireAt, ...(action ? { action } : {}) },
                    $inc: { shownCount: 1 },
                    $setOnInsert: { firstSeenAt: now, status: 'shown' },
                },
                upsert: true,
            },
        }));
        PlaceView.bulkWrite(ops, { ordered: false })
            .catch(err => console.warn('[v2][views] recordViews failed:', err.message));
    } catch (e) { console.warn('[v2][views] recordViews error:', e.message); }
}

module.exports = { loadTaste, dislikeExcludes, tasteAdjust, recordViews };
