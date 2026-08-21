// Jinni V2 Engine — Retrieval Core entry point.
// THE one parameterized query every surface converges on (V3 blueprint §9.4).
// NOT yet implemented and NOT mounted anywhere — v1 is untouched by this file.
//
// Contract (frozen 2026-08-21; extend via new optional fields only):
//
// findPlaces({
//   category,        // 'restaurants'|'hotels'|'historical'|'hidden_gems'|'events'|
//                    // 'photo_spots'|'shopping'|'activities'|null (null = free query)
//   subType,         // shopping/activities sub-kind or null
//   query,           // free-text query (chat mode) or null (seeded/quick-action mode)
//   center,          // { lat, lng, city?, country? }
//   mode,            // 'destination' | 'discovery' | 'nearby'
//   radiusKm,
//   preferences,     // { interests, travelStyle, budget } — user's saved prefs
//   timeContext,     // { localISO, timezone, openNowOnly? } — context engine input
//   excludes,        // { names: [], placeIds: [] } — already-shown this session
//   count,           // requested card count
//   tapState,        // 'first' | 'refill'
//   requestId,
// })
//   → { places: [CanonicalPlace], provenance: {...}, degraded: false }
//
// Guarantees: every returned place is REAL (owned corpus / cache / Google-verified);
// never null — an empty result carries degraded/reason instead of throwing.

async function findPlaces(params) {
  throw new Error('[engine/retrieval] not implemented yet — see engine/ENGINE.md build state');
}

module.exports = { findPlaces };
