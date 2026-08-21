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
- [x] Characterization tests for matching/events pure functions — 32 passing,
      `__tests__/engineMatching.test.js` (2026-08-21)
- [x] places/matching + events/matching (copied from v1 w/ comments) (2026-08-21)
- [x] utils/safeFetch (SSRF + guarded fetch) + events/{listing,sources,feed,discovery}
      — the full v1 events machinery (aiRoutes ~4434–5270), 23 more tests (2026-08-21).
      NOTE: the INLINE quick-action events stage (feed correct/supply, dedupe order,
      past/horizon filters, AiFoundEvent capture) is NOT yet copied — it lands as
      events/pipeline.js when the v2 quick-action path is built.
- [x] context/contextEngine (open-now/time-of-day; Google periods math incl.
      overnight + week-wrap + 24/7; unknown-never-drops rule; drop-when-closed
      policy table) — 13 tests (2026-08-21). READY to backport under v1's chat
      grounding as the 3 AM fix whenever Arsen wants the v1 patch.
- [x] retrieval core v1 MACHINERY (plain-Mongo decision 2026-08-21): BM25 lexical,
      weighted RRF (query evidence 1.0 vs prior 0.5 — plain RRF ties let the prior
      silently win), in-process cosine vectors, SemanticCache (vector-similarity +
      text fallback, params-bucket isolation), embedder slot (auto-detects optional
      @xenova/transformers → else lexical-only, fail-open), findPlaces orchestration
      with injectable deps — 22 tests (2026-08-21).
- [x] places/canonicalStore — Mongo candidate loader (deps.loadCandidates), 13 tests
      (2026-08-21). v1's findCachedBackfill HARD GATES copied (actions ground truth,
      aiBlocked/explore-hidden suppression, freshness, photo, community hard-hide,
      sub-type + landmark type gates, price-tier mismatch) + v1's prior score; free
      (category-null) queries skip only the category/type gates. Validator tier via
      proximityService (fail-open). Cross-source dedupe registers BOTH identities
      (placeId AND normalized name). /chat-stream-v2 NOW SERVES REAL RETRIEVAL:
      owned-data candidates, hybrid-ranked, honest text list (no narrator, no
      Google tier yet) — logs `[v2] q=… → N/M in Xms`.
- [ ] Business/Destination day-name hours → Google-periods converter (their
      opening hours currently read as UNKNOWN in the context engine).
- [ ] jobs/embedCorpus + PlaceCache `embedding` field (⚠ touches a v1 model
      schema — needs Arsen's sign-off) once an embedder is enabled
      (npm i @xenova/transformers).
- [x] narrator v0 (2026-08-21): DeepSeek provider (reuses config/openai, lazy),
      grounded prompts (may name ONLY retrieved places; chit-chat forbids venue
      names), pseudo-streamed. /chat-stream-v2 now: intent (reused v1 service,
      fail-open) → retrieval → grounded PROSE. 8 tests; suite at 181.
- [ ] narrator: Claude + Ollama providers; TRUE token streaming; tool-use loop
      (the full agentic mode — currently retrieval runs before narration instead)
- [x] v2 cards (2026-08-21): narrator/cards.js maps retrieval candidates to v1's
      EXACT chat-rec payload (field-for-field from processStreamCompletion) and
      v1's contentParts interleaving; canonicalStore candidates now carry image
      (cache → place-image endpoint, validator rows → own images). Cards are
      real by construction — no post-hoc verification pass exists in v2 at all.
      7 tests; suite at 188.
- [x] session history + follow-ups (2026-08-21): session peek w/ ownership 403
      before history reaches any prompt (v1's rule); recentTurns → intent AND
      narration (historyTurns, both prompt builders); activeDestination center
      fallback; already-shown session recs → retrieval excludes ("more hotels"
      brings NEW ones). Message PERSISTENCE was already free — the frontend
      PATCHes /chat-sessions/:id engine-agnostically. 7 tests; suite at 195.
- [x] routes/aiChatV2.js → `/chat-stream-v2` MOUNTED (2026-08-21, Arsen's request —
      the one sanctioned server.js line is now used). Currently an honest scaffold
      reply in v1's SSE dialect; reached only via the admin-only "Chat engine"
      toggle in JinniChat settings (frontend commit 1da6ef8). Grows into the real
      pipeline as canonicalStore + narrator land.
