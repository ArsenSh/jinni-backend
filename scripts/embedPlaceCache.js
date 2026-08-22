// Backfill semantic embeddings onto the v2 retrieval corpus — ALL THREE
// place collections (extended 2026-08-22, battery fix #3: the original run
// covered PlaceCache only, so curated Destinations/Businesses — Sirelis,
// Mamma Mia — carried no vector and systematically LOST to cache rows under
// semantic ranking; curated data must be advantaged, not invisible).
// Arsen sign-off 2026-08-22. Repo convention: DRY-RUN by default, --apply writes.
//
//   node scripts/embedPlaceCache.js            # count + sample, no writes
//   node scripts/embedPlaceCache.js --apply    # embed + write
//
// Embeds the SAME text canonicalStore builds for BM25 per source, so lexical
// and semantic ranking read one document. Only docs missing an embedding for
// the CURRENT model are touched — re-running is incremental and safe.
// Requires @xenova/transformers (in package.json).

require('dotenv').config();
const mongoose = require('mongoose');
const { getEmbedder } = require('../engine/retrieval/embedder');
// ONE definition of "what text a place embeds" — shared with the daily
// in-server sweep (engine/retrieval/embedSweep.js), so new registrations
// and this manual backfill can never drift apart.
const { SOURCES } = require('../engine/retrieval/embedSweep');

const APPLY = process.argv.includes('--apply');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const embedder = await getEmbedder();
    if (!embedder) { console.error('No embedder available — is @xenova/transformers installed?'); process.exit(1); }
    console.log(`[embed] model=${embedder.model} · ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);

    for (const src of SOURCES) {
        const Model = src.model();
        const filter = { $or: [{ embedding: { $exists: false } }, { embeddingModel: { $ne: embedder.model } }] };
        const total = await Model.countDocuments(filter);
        console.log(`[embed] ${src.name}: ${total} doc(s) need embedding`);
        const cursor = Model.find(filter).select(src.select).lean().cursor();
        let done = 0, skipped = 0;
        for await (const d of cursor) {
            const text = src.textOf(d);
            if (!text || !text.trim()) { skipped++; continue; }
            if (!APPLY) {
                if (done < 3) console.log(`  would embed: "${text.slice(0, 90)}"`);
                done++;
                continue;
            }
            const [vector] = await embedder.embed([text]);
            await Model.updateOne({ _id: d._id }, { $set: { embedding: vector, embeddingModel: embedder.model } });
            done++;
            if (done % 100 === 0) console.log(`  ${src.name} ${done}/${total}…`);
        }
        console.log(`[embed] ${src.name}: ${APPLY ? 'embedded' : 'would embed'} ${done}, skipped ${skipped} textless.`);
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error('[embed] failed:', err.message); process.exit(1); });
