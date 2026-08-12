/**
 * purgeEventTags.js — drain the 'events' tag out of the places cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * `PlaceCache.actions` records the quick-action categories a place has been
 * SHOWN under, and the backfill treats that as "belongs to". For restaurants or
 * historical sites the inference is sound. For events it is not: what gets shown
 * under an event is its VENUE. So a wrong resolution (an event name matching a
 * rooftop lounge) — or simply a concert at a real hall — permanently tagged that
 * venue 'events', and every later Events tap backfilled it as an undated "Event"
 * card. Yerevan ended up with a zoo, a park, an opera house and a lounge all
 * classified as events.
 *
 * The runtime tagger no longer writes 'events' (see aiRoutes.js), so no NEW
 * places are being poisoned. This script cleans up the ones already tagged.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   • Removes ONLY the string 'events' from `actions`. Every other category on
 *     the same document is preserved, so a restaurant that was also shown under
 *     'events' stays a restaurant.
 *   • Skips `actionsCurated: true` documents entirely — if a validator put
 *     'events' there by hand, that is a human decision and this script does not
 *     overrule it.
 *   • Writes nothing else: no deletions, no photo or counter changes.
 *
 * USAGE
 *   node scripts/purgeEventTags.js            # dry run (default) — report only
 *   node scripts/purgeEventTags.js --apply    # perform the update
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlaceCache = require('../models/PlaceCache');

const APPLY = process.argv.includes('--apply');

(async () => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('No MONGODB_URI / MONGO_URI in the environment — aborting.');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

    const filter = { actions: 'events', actionsCurated: { $ne: true } };
    const affected = await PlaceCache.countDocuments(filter);
    console.log(`Cached places tagged 'events' (excluding validator-curated): ${affected}`);

    if (!affected) {
        console.log('Nothing to clean.');
        await mongoose.disconnect();
        return;
    }

    // Show a sample so the operator can sanity-check before applying.
    const sample = await PlaceCache.find(filter).select('name actions').limit(15).lean();
    console.log('\nSample of what will be changed:');
    for (const p of sample) {
        const after = (p.actions || []).filter(a => a !== 'events');
        console.log(`  • ${p.name}: [${(p.actions || []).join(', ')}] → [${after.join(', ') || '(none)'}]`);
    }

    if (!APPLY) {
        console.log('\nDry run complete — re-run with --apply to write these changes.');
        await mongoose.disconnect();
        return;
    }

    const res = await PlaceCache.updateMany(filter, { $pull: { actions: 'events' } });
    console.log(`\nDone. Documents modified: ${res.modifiedCount ?? res.nModified ?? 0}`);
    // A place left with no categories simply stops appearing on Explore rails and
    // in backfill — it is not deleted, and re-tags naturally the next time it is
    // genuinely shown under a real category.
    const orphaned = await PlaceCache.countDocuments({ actions: { $size: 0 } });
    console.log(`Places now with no categories at all: ${orphaned} (kept; they re-tag on next genuine serve)`);

    await mongoose.disconnect();
})().catch(err => {
    console.error('purgeEventTags failed:', err);
    process.exit(1);
});
