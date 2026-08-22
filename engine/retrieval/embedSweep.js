// Jinni V2 Engine — embedding sweep: keeps the corpus' vectors current.
//
// Answers Arsen's 2026-08-22 question "if one business will be registered
// will it work with it automatically?" — before this, vectors were written
// ONLY by the manual backfill script, so a business registered on Tuesday
// ranked vector-blind until someone remembered to re-run it. Now server.js
// runs this sweep daily (and shortly after boot): any PlaceCache /
// Destination / Business doc missing an embedding for the current model gets
// one. The embedder is already resident in the API process (it embeds every
// chat query), so a handful of new docs costs milliseconds.
//
// The manual script (scripts/embedPlaceCache.js) uses these same SOURCES —
// one definition of "what text a place embeds", used everywhere.

// Business.description is an object ({short, detailed}); Destination's is a
// string — same normalization canonicalStore applies at query time.
const descText = (desc) => !desc ? null
    : (typeof desc === 'string' ? desc : [desc.short, desc.detailed].filter(Boolean).join(' ') || null);

const SOURCES = [
    {
        name: 'PlaceCache',
        model: () => require('../../models/PlaceCache'),
        select: 'name primaryType types interests city',
        textOf: (d) => [d.name, d.primaryType, ...(d.types || []).slice(0, 6), ...(d.interests || []), d.city]
            .filter(Boolean).join(' '),
    },
    {
        name: 'Destination',
        model: () => require('../../models/Destination'),
        select: 'name type description location.city',
        textOf: (d) => [d.name, ...(Array.isArray(d.type) ? d.type : []), d.location?.city, descText(d.description)]
            .filter(Boolean).join(' ').slice(0, 300),
    },
    {
        name: 'Business',
        model: () => require('../../models/Business'),
        select: 'name type description location.city',
        textOf: (d) => [d.name, ...(Array.isArray(d.type) ? d.type : []), d.location?.city, descText(d.description)]
            .filter(Boolean).join(' ').slice(0, 300),
    },
];

const BATCH_PER_SOURCE = 500;   // a sweep is a top-up, not a migration

/**
 * Embed every doc missing a vector for the current model. Fail-open per
 * source; never throws. @returns {{embedded, skipped, bySource}}
 */
async function sweepMissingEmbeddings(deps = {}) {
    const getEmbedder = deps.getEmbedder || require('./embedder').getEmbedder;
    const embedder = await getEmbedder();
    if (!embedder) return { embedded: 0, skipped: 0, bySource: {}, reason: 'no_embedder' };
    let embedded = 0, skipped = 0;
    const bySource = {};
    for (const src of deps.sources || SOURCES) {
        try {
            const Model = src.model();
            const filter = { $or: [{ embedding: { $exists: false } }, { embeddingModel: { $ne: embedder.model } }] };
            const docs = await Model.find(filter).select(src.select).limit(BATCH_PER_SOURCE).lean();
            let n = 0;
            for (const d of docs) {
                const text = src.textOf(d);
                if (!text || !text.trim()) { skipped++; continue; }
                const [vector] = await embedder.embed([text]);
                await Model.updateOne({ _id: d._id }, { $set: { embedding: vector, embeddingModel: embedder.model } });
                n++;
            }
            embedded += n;
            bySource[src.name] = n;
        } catch (err) {
            console.warn(`[embed] sweep ${src.name} failed:`, err.message);
        }
    }
    return { embedded, skipped, bySource };
}

module.exports = { sweepMissingEmbeddings, SOURCES, descText };
