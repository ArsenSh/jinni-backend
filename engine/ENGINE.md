# Jinni V2 Engine — build zone (started 2026-08-21)

**Blueprint:** `~/Desktop/Claude_for_Jinni/JinniAI-V3-Target-Architecture.md` §9 (code
structure) + §2–3 (system design). Read it before adding anything here.

## Rules of this directory (agreed with Arsen, 2026-08-21)

1. **v1 is FROZEN — never touched by rebuild work.** `routes/aiRoutes.js` and everything
   it uses stay byte-identical; v1 gets critical production fixes only. The old and new
   versions coexist until v2 wins per surface.
2. **COPY logic in, never cut it out of v1.** Modules here are built by copying v1's
   logic (WITH its comments — they are the encoded bug history) into clean modules.
   Temporary duplication is accepted; breaking v1 is not.
3. **Nothing in `engine/` may import Express or touch req/res/SSE.** Pure functions and
   classes only, jest-testable without HTTP. Routes adapt; the engine computes.
4. **The only future edit on v1's side** is one mount line in `server.js` when
   `/chat-stream-v2` is ready — gated to test users; rollback = frontend points back at v1.
5. Every module lands with tests. Characterization cases come from the docs
   (Testbook §B, Events-Handoff assertion lists) before new behavior is added.

## Target structure (build in roughly this order)

```
engine/
  retrieval/     index (findPlaces — THE query) · router · semanticCache ·
                 hybridSearch (BM25+vector→RRF) · rerank · diversify (MMR)
  context/       contextEngine (time/open-now/weather/season) · marketGates
  personalization/  taste · novelty · budgetStyle
  places/        canonicalStore · resolution · matching
  events/        eventService · sources · discovery
  narrator/      index (provider contract) · providers/{claude,deepseek,ollama} ·
                 toolLoop · tools · prompts/
  itinerary/     planner
  missions/      eveningPlan
  hooks/         afterServe (taggers, PlaceView, AiFoundEvent capture, billing)
```

## Build state

- [x] Scaffold + contracts (2026-08-21)
- [ ] Characterization tests for matching/events pure functions (from doc case lists)
- [ ] places/matching (copy of v1's name-normalization family)
- [ ] utils/safeFetch + events/eventService (copy of aiRoutes 4399–5271 + inline stage)
- [ ] context/contextEngine (open-now/time — also backports as the v1 3 AM fix)
- [ ] retrieval core v1 (corpus embeddings + hybrid + RRF + semantic cache)
- [ ] narrator providers + toolLoop
- [ ] routes/aiChatV2.js → `/chat-stream-v2` (test-gated mount)
