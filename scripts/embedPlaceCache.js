// Backfill semantic embeddings onto PlaceCache (v2 retrieval corpus).
// Arsen sign-off 2026-08-22. Repo convention: DRY-RUN by default, --apply writes.
//
//   node scripts/embedPlaceCache.js            # count + sample, no writes
//   node scripts/embedPlaceCache.js --apply    # embed + write
//
// Embeds the SAME text canonicalStore builds for BM25 (name + kind words +
// interests + city) so lexical and semantic ranking read one document. Only
// docs missing an embedding for the CURRENT model are touched; re-running is
// incremental and safe. Requires @xenova/transformers (in package.json).

require('dotenv').config();
const mongoose = require('mongoose');
const PlaceCache = require('../models/PlaceCache');
const { getEmbedder } = require('../engine/retrieval/embedder');

const APPLY = process.argv.includes('--apply');

function textOf(d) {
    return [d.name, d.primaryType, ...(d.types || []).slice(0, 6), ...(d.interests || []), d.city]
        .filter(Boolean).join(' ');
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const embedder = await getEmbedder();
    if (!embedder) { console.error('No embedder available — is @xenova/transformers installed?'); process.exit(1); }

    const filter = { $or: [{ embedding: { $exists: false } }, { embeddingModel: { $ne: embedder.model } }] };
    const total = await PlaceCache.countDocuments(filter);
    console.log(`[embed] model=${embedder.model} · ${total} doc(s) need embedding · ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);

    const cursor = PlaceCache.find(filter).select('name primaryType types interests city').lean().cursor();
    let done = 0, skipped = 0;
    for await (const d of cursor) {
        const text = textOf(d);
        if (!text.trim()) { skipped++; continue; }
        if (!APPLY) {
            if (done < 5) console.log(`  would embed: "${text.slice(0, 90)}"`);
            done++;
            continue;
        }
        const [vector] = await embedder.embed([text]);
        await PlaceCache.updateOne({ _id: d._id }, { $set: { embedding: vector, embeddingModel: embedder.model } });
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${total}…`);
    }
    console.log(`[embed] ${APPLY ? 'embedded' : 'would embed'} ${done} doc(s), skipped ${skipped} textless.`);
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error('[embed] failed:', err.message); process.exit(1); });
