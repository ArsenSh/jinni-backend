// WHY a deck came out in that order — run it and watch, instead of guessing.
//
// Arsen 2026-08-26: "work to find actual cause — if we are unable to see how
// backend works normally how will we configure everything perfectly".
//
// The retrieval core takes an injectable deps.loadCandidates precisely so it can
// be exercised without Mongo, without network, without a server. This runs the
// REAL findPlaces over a fixed candidate set and prints what each signal did to
// the order, so a claim like "taste is dominating" gets settled by running it
// rather than by argument.
//
//   node scripts/explainRetrieval.js
//   node scripts/explainRetrieval.js "romantic rooftop dinner"
//
// A fixture, deliberately, not live data: a repeatable pool is what makes the
// comparison mean anything. Swap CANDIDATES for a Mongo read on the server when
// you want to check the real corpus.

const { findPlaces } = require('../engine/retrieval');

// A pool shaped like the live Yerevan one from 2026-08-26: a few things that
// answer a place ask, plus the four the traveler had LIKED — which is what the
// deck actually came back as.
const LIKED_NAMES = ['De Laur Jewelry', 'DIAMOR Diamond Gallery', 'Pnduk - dried fruits and nuts', 'Dalma Garden Mall'];
const LIKED = new Set(LIKED_NAMES);

const CANDIDATES = [
    ['Charles Aznavour Square', 'plaza', 0.4],
    ['Yerevan Park', 'amusement_park', 3.1],
    ['Lavash Restaurant', 'restaurant romantic rooftop', 1.2],
    ['Sherep', 'restaurant seafood', 1.6],
    ['Cascade Complex', 'tourist_attraction landmark', 0.9],
    ['Beatles Pub Yerevan', 'pub bar nightlife', 2.0],
    ['Komitas Museum-Institute', 'museum', 4.4],
    ['De Laur Jewelry', 'jewelry_store', 5.2],
    ['DIAMOR Diamond Gallery', 'jewelry_store', 6.0],
    ['Pnduk - dried fruits and nuts', 'grocery_store food', 2.7],
    ['Dalma Garden Mall', 'shopping_mall', 6.8],
    ['Armenian Genocide Museum', 'museum memorial', 5.9],
].map(([name, types, km], i) => ({
    placeId: `p${i}`,
    name,
    types: types.split(' '),
    text: `${name} ${types} Yerevan`,
    distanceKm: km,
    geometry: { lat: 40.18, lng: 44.51 },
}));
// Array order IS the prior — exactly how canonicalStore hands the pool over.

const idOf = (name) => `p${CANDIDATES.findIndex(c => c.name === name)}`;
const TASTE = {
    liked: new Map(LIKED_NAMES.map(n => [idOf(n), n])),
    disliked: new Map(),
    saved: new Map(),
    seen: new Map(),
};

const loadCandidates = async () => CANDIDATES.map(c => ({ ...c }));

async function run(label, params) {
    const r = await findPlaces({
        center: { lat: 40.18, lng: 44.51 },
        mode: 'discovery', radiusKm: 50, count: 6,
        ...params,
    }, { loadCandidates, embedder: null });
    console.log(`\n${label}`);
    console.log(`  evidence: lex=${r.provenance.lexical}/${r.provenance.candidateCount}`
        + ` top=${r.provenance.lexicalTop ?? 0} share=${r.provenance.lexicalShare ?? 0}`
        + `  taste=${!!r.provenance.taste}`);
    r.places.forEach((p, i) => console.log(`   ${i + 1}. ${LIKED.has(p.name) ? '♥' : ' '} ${p.name}`));
    const liked = r.places.filter(p => LIKED.has(p.name)).length;
    console.log(`  → ${liked}/${r.places.length} of the deck is places they already liked`);
    return liked;
}

(async () => {
    const query = process.argv[2] || 'help acquainted normal girl';
    console.log('='.repeat(68));
    console.log(`ASK: "${query}"     (♥ = a place this traveler already liked)`);
    console.log('='.repeat(68));

    // The live case: no category, and since the 2026-08-26 filter fix the city
    // token no longer manufactures a lexical list — so lex is honestly 0.
    const withTaste = await run('AS SHIPPED — no category, no lexical evidence, taste ON', { query, taste: TASTE });
    const noTaste = await run('SAME ASK — taste OFF', { query });

    console.log('\n' + '-'.repeat(68));
    await run('CONTROL — an ask that HAS evidence ("romantic rooftop restaurant")',
        { query: 'romantic rooftop restaurant', taste: TASTE });

    console.log('\n' + '='.repeat(68));
    console.log(withTaste > noTaste
        ? `VERDICT: taste pulled ${withTaste - noTaste} extra liked place(s) into a deck that had NO\n`
          + '         relevance evidence. With nothing relevant to nudge, the nudge IS the ranking.'
        : 'VERDICT: taste did not change this deck — the cause is elsewhere.');
})();
