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
- [x] Business/Destination day-name hours → Google-periods converter —
      scheduleToPeriods in contextEngine.js, wired in dbDocToCandidate
      (canonicalStore ~224), overnight + 24/7 + closed-day covered by
      engineContext tests. (Checkbox was stale until 2026-08-31 — the code
      shipped earlier; validator-entered hours DO feed open-now.)
- [x] EMBEDDINGS (2026-08-22, Arsen sign-off): @xenova/transformers installed
      (all-MiniLM-L6-v2, 384-dim, verified locally); PlaceCache gains
      embedding/embeddingModel (additive, script-written only);
      scripts/embedPlaceCache.js backfills incrementally (dry-run default).
      ⚠ RUN ON THE SERVER after deploy (Atlas IP whitelist blocks local):
        node scripts/embedPlaceCache.js --apply
      After that, semantic retrieval + vector semantic-cache go LIVE
      automatically (embedder auto-detects; candidates already map d.embedding;
      log shows vec=true). First server run downloads the model (~25 MB).
      TODO later: embed new cache rows at write time (job or serve-hook).
- [x] narrator v0 (2026-08-21): DeepSeek provider (reuses config/openai, lazy),
      grounded prompts (may name ONLY retrieved places; chit-chat forbids venue
      names), pseudo-streamed. /chat-stream-v2 now: intent (reused v1 service,
      fail-open) → retrieval → grounded PROSE. 8 tests; suite at 181.
- [x] TRUE token streaming (2026-08-21): deepseek.streamText (SSE parsing with
      v1's chunk-boundary lesson, pure _sseDeltas), narrator realStream flag,
      DelimitedSplitter — grounded turns stream prose LIVE while the <<<CARDS>>>
      JSON tail (blurb per EVERY card + question) stays private; degradation
      ladder: no tail → fact-line cards → one-shot JSON → plain prose. Streamed
      usage is chars/4 ESTIMATED (config/openai doesn't forward stream_options —
      a v1 file; note for the billing pass). Parallel AppConfig+User loads.
      11 tests; suite at 219.
- [x] TOOL LOOP v0 (2026-08-21): runToolLoop (capped 4 iterations; final round
      tool-less so the model must answer; errors become tool results, never
      crashes) + get_place_details tool over v1's shared getCachedPlaceDetails
      (lazy — session-first identity via shownPlaces so "phone of Nairi" hits
      the exact card shown). deepseek.completeWithTools uses its OWN axios call
      (config/openai doesn't forward `tools`; v1 stays byte-identical). Route:
      detail-question branch fires when a travel turn names a session-shown
      place. Round-61 honesty structural in the prompt (inward to More, never
      Google). 9 tests; suite at 228.
- [x] GOOGLE FALLBACK TIER (2026-08-21): canonicalStore.googleFallback — fires
      ONLY when the owned corpus is thin, ONLY through coverageService gates,
      bounded to one Text Search + ≤needed detail resolves via v1's shared
      resolver (caches + stores images = the standard warming path; a cold city
      pays once, then answers from owned data). Owned rows always win dedupe.
      V2 is now viable in cold markets. 5 tests; suite at 233.
- [ ] narrator: Claude + Ollama providers; search_places as a loop tool
      (full agentic retrieval — today the pipeline still pre-retrieves)
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
- [x] polish round (2026-08-21): structured narration (intro + per-card blurbs +
      follow-up question in ONE call, JSON w/ prose fallback); cards carry
      narrator blurbs + full street addresses; user preferences flow into
      retrieval (style/tier parity with v1); frontend derives isChatRecommendation
      at complete (large-card style). Suite at 202.
- [x] radius + query tuning (2026-08-21): retrieval/tuning.js — category-aware
      radius (dining/shopping/activities cap at 15 km in discovery; the 37.7 km
      Tsaghkadzor fix) + query enrichment (intent's lossy searchQuery + the raw
      message's distinctive tokens: "romantic"/"girlfriend" survive into BM25,
      ready for embeddings); proximity-aware RRF list (weight 0.5) in findPlaces
      — near places climb, no hard cutoff. Suite at 208.
- [x] routes/aiChatV2.js → `/chat-stream-v2` MOUNTED (2026-08-21, Arsen's request —
      the one sanctioned server.js line is now used). Currently an honest scaffold
      reply in v1's SSE dialect; reached only via the admin-only "Chat engine"
      toggle in JinniChat settings (frontend commit 1da6ef8). Grows into the real
      pipeline as canonicalStore + narrator land.
