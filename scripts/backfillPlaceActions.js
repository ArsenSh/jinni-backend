// Backfill PlaceCache.actions — the tag that decides whether an owned place
// can answer a categorised ask. Repo convention: DRY-RUN by default.
//
//   node scripts/backfillPlaceActions.js                 # counts + samples, no writes
//   node scripts/backfillPlaceActions.js --apply
//   node scripts/backfillPlaceActions.js --apply --limit=5000
//
// ⚠ RUN THIS ON THE SERVER — the Atlas IP whitelist blocks local connections
//   (the same lesson scripts/embedPlaceCache.js and seedGazetteer.js record).
//
// WHY (founder, 2026-09-03: "i guess it worked google search this time also,
// even near khor virap i remember it may have 3 placecached places"):
// buildCacheQuery gates a categorised ask on `actions`. v1 has always written
// that array; v2 never did, in the two weeks it has been the default engine.
// aiChatV2 now tags what it serves — but only from now on, and a row can only
// be tagged once it is SHOWN, which on a category ask requires being found,
// which requires the tag. Chicken and egg: without this backfill the rows v2
// already bought stay invisible to v2, and it keeps re-buying them from Google.
//
// The tag is DERIVED, never guessed: googleService.placeMatchesActionType is
// the same gate the cache tier, the prefetch and the paid fallback all use, so
// a backfilled row is admitted on exactly the asks it would have been admitted
// on had it been tagged when it was first shown.
//
// Deliberately conservative:
//  · a row with NO types is skipped. The gate is lenient by design (unknown →
//    true), so testing it would tag such a row with EVERY category.
//  · `actionsCurated` rows are never touched — staff outrank inference.
//  · rows that already carry actions are left alone; this fills gaps, it does
//    not re-open settled questions.
//  · 'events' is excluded: an event is time-bound and lives in its own store,
//    and inferring it from a venue's types would resurrect expired listings.

require('dotenv').config();
const mongoose = require('mongoose');

const ARG = (k, dflt = null) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : dflt;
};
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(ARG('limit', '0')) || 0;
const BATCH = 1000;

// Every category a chat turn can gate on, minus 'general' (never gates) and
// 'events' (see above). Shopping is asked per sub-type because the gate is
// lenient when the sub-type is unknown.
const ACTIONS = ['restaurants', 'hotels', 'historical', 'hidden_gems', 'photo_spots', 'activities'];
const SHOPPING_SUBTYPES = ['souvenirs', 'clothing', 'market', 'mall', 'jewelry', 'food'];

/**
 * The actions a row's Google types make it eligible for. Pure; exported for
 * tests. `matches` is placeMatchesActionType, injected so the unit tests do
 * not need googleService.
 *
 * @returns {string[]} possibly empty — empty means "leave this row alone"
 */
function actionsForRow({ types = [], primaryType = null } = {}, matches) {
    const known = [primaryType, ...(Array.isArray(types) ? types : [])].filter(Boolean);
    if (!known.length) return [];                  // unknown types → the gate is lenient → skip
    const out = ACTIONS.filter(a => matches(a, null, types, primaryType));
    if (SHOPPING_SUBTYPES.some(st => matches('shopping', st, types, primaryType))) out.push('shopping');
    return out;
}

async function main() {
    console.log(`[actions] ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}${LIMIT ? ` · limit=${LIMIT}` : ''}`);
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

    const PlaceCache = require('../models/PlaceCache');
    const { placeMatchesActionType } = require('../services/googleService');

    const query = {
        actionsCurated: { $ne: true },
        $or: [{ actions: { $exists: false } }, { actions: { $size: 0 } }],
    };
    const total = await PlaceCache.countDocuments(query);
    console.log(`[actions] ${total} untagged row(s)`);

    const cursor = PlaceCache.find(query)
        .select('placeId name types primaryType')
        .limit(LIMIT || 0)
        .lean()
        .cursor();

    const tally = {};
    const samples = [];
    let scanned = 0, skipped = 0, written = 0;
    let ops = [];

    const flush = async () => {
        if (!ops.length) return;
        if (APPLY) await PlaceCache.bulkWrite(ops, { ordered: false });
        written += ops.length;
        ops = [];
        console.log(`  ${written}/${total}…`);
    };

    for await (const row of cursor) {
        scanned++;
        const actions = actionsForRow(row, placeMatchesActionType);
        if (!actions.length) { skipped++; continue; }
        for (const a of actions) tally[a] = (tally[a] || 0) + 1;
        if (samples.length < 8) {
            samples.push(`${row.name} [${row.primaryType || (row.types || [])[0] || '?'}] → ${actions.join(',')}`);
        }
        ops.push({
            updateOne: {
                filter: { placeId: row.placeId },
                update: { $addToSet: { actions: { $each: actions } } },
            },
        });
        if (ops.length >= BATCH) await flush();
    }
    await flush();

    console.log(`[actions] scanned ${scanned}, tagged ${written}, skipped ${skipped} (no usable types)`);
    console.log(`[actions] tags: ${JSON.stringify(tally)}`);
    for (const s of samples) console.log(`  e.g. ${s}`);
    if (!APPLY) console.log('[actions] dry run — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => { console.error('[actions] failed:', err.message); process.exit(1); });
}

module.exports = { actionsForRow };
