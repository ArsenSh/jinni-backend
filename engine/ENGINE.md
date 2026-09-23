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
- [x] OWNED GAZETTEER (2026-09-01, Arsen sign-off): GeoNames (CC BY 4.0)
      seeded into our own Mongo — `models/GeoName.js`, `scripts/seedGazetteer.js`
      (dry-run default, `--apply`, `--countries=AM,GE,AE`, `--alt`),
      `engine/geo/gazetteer.js` (lookupPlace / regionAt / mainCities /
      radiusForPopulation). Both Google geocoding call sites are now
      gazetteer-FIRST with Google as fallback: `destination._geocode` (was a
      Places TEXT SEARCH — the priciest SKU — just to locate a city) and
      `region.resolveRegion` (Geocoding reverse, up to 3×/turn).
      Fixes the COUNTRY-RADIUS BUG: "best places to visit in Armenia" geocoded
      to the country CENTROID (~40.07,45.04, near Lake Sevan, ~47 km from
      Yerevan) and was then capped to 15 km by the named-TOWN rule — a country
      searched as one small circle of countryside, with googleFallback's
      `distanceKm > radiusKm` filter discarding everything Google returned.
      Now: `scaleOf()` carries country/region/town out of resolveDestination,
      the 15 km cap applies to towns ONLY, `remember.singleTown` can no longer
      be set by a country (it used to poison every later refill), and a known
      population sizes the radius (village 5 → Dilijan 10 → Yerevan 20 →
      Dubai 30) instead of a flat 15.
      FAIL-FAST fail-open: an unconnected mongoose BUFFERS 10s before throwing,
      so the gazetteer skips unless `readyState === 1` and races every query
      against a 1.5s deadline — an unseeded deploy behaves exactly as today.
      29 tests (`__tests__/engineGazetteer.test.js`); suite at 737.
      ⚠ RUN ON THE SERVER after deploy (Atlas IP whitelist blocks local):
        node scripts/seedGazetteer.js --apply
      NOT yet done: `radiusForAsk()` as a pure engine function, the
      multi-centre country search over `mainCities()`, `retrieval/diversify`,
      the `_prefFitScore` pure-bonus change, and 2dsphere/$geoNear on
      PlaceCache (kills the unsorted CACHE_SCAN_LIMIT=200 truncation).
- [x] **V3 chat route + conversation controller** (2026-09-14, founder decision — V3 doc §12):
      `routes/aiChatV3.js` (a copy of v2, mounted at /chat-stream-v3, chosen in Settings;
      v2 untouched and default) + `engine/controller/conversationController.js` — ONE
      state-aware Claude Sonnet 5 call (last 10 turns head+tail clipped, the traveler's
      date line, lastLane / lastReply / lastFlights / deck / preferences) returns the v2
      intent object PLUS lane · answers_pending_question · topic_changed · a resolved
      flights object · clarify_question. `engine/controller/laneOverride.js` maps the lane
      onto v2's own branch flags. Fail-open: any controller failure → the v2 classifier,
      no lane. 12 tests. NOTE: the Claude 5 family rejects `temperature` — claudeService
      now omits it when passed null (defaults unchanged for every other caller).
- [x] **V3 IS THE DEFAULT ENGINE (frontend, since 2026-09-19)** — `jinni_chat_engine`
      defaults to `v3`; stored V1/V2 choices are kept. The line above about v2 staying
      default is historical. **v2 is a frozen snapshot of 2026-09-18** — every fix since
      (hotel prices, deck agent, events-deck guard, destination resolution, the 09-23
      refill guard) landed in v3 only, so v2 is NOT an equivalent rollback: rolling back
      to it reverts those fixes. The sanctioned rollbacks are the V1 toggle (production
      v1, untouched) and, for v3's new layers only, `V3_AGENT=false` / the controller's
      own fail-open to the v2 classifier. Settings labels it "V2 · legacy" (2026-09-23).
- [x] **AUDIT FIXES (2026-09-23, Arsen: "do all")** — from a full backend/frontend/docs
      audit plus live session 6ab3a61e (a 12-person cottage near Yeghegnadzor; luxury
      saved in Settings; Nearby toggled on before "more"):
      · `routes/aiChatV3.js` refill guard — a refill of a deck built around a
        session/saved destination no longer re-centres on GPS when the Nearby toggle is
        on; THIS turn runs as discovery, `meta.modeSwitched='discovery'`,
        `meta.refillKeptCentre=true`, toggle follows (the 120-km jump to Yerevan).
      · `engine/places/canonicalStore.js` soft style gate — Google's tier guess stops
        being a hard drop when the gated owned pool is thinner than the asked count:
        dropped rows return at the TAIL of the prior order, marked `_styleSoft`; the
        validator's verdict (suppress set) stays hard; `params.softStyleGate=false`
        restores the old behaviour. 3 tests.
      · `services/emailService.js` transport adapter — `MAIL_FROM` (domain address) +
        `RESEND_API_KEY` → Resend over plain HTTPS (no SDK: resend@6 needs Node ≥ 22.12
        and the server's Node is unpinned); else `MAIL_FROM` + `SENDGRID_API_KEY` →
        SendGrid; else the Gmail SMTP path unchanged. Reply-to = opts.replyTo or
        `SUPPORT_EMAIL`. Verification codes from jinniopenai@gmail.com were landing in
        spam; the stored SendGrid key answered 401 (contact form had been failing).
        `routes/contact.js` now rides the same transport (+ HTML escaping of the
        visitor's fields). Coolify TODO (Arsen, Resend account created 2026-09-23):
        verify jinni.travel in Resend (DNS on Cloudflare, records DNS-only), then set
        `RESEND_API_KEY=re_…` and `MAIL_FROM=noreply@jinni.travel`. 4 tests.
      · `routes/businessRoutes.js` — the applicant-URL verifier's own bare `fetch` (SSRF:
        no scheme/private-IP/redirect checks) now goes through
        `engine/utils/safeFetch._fetchListingHtml`; failures are logged.
      · `package.json` jest `testPathIgnorePatterns` excludes `.claude/` — `npm test` was
        running 74 stale worktree copies and reporting their timeouts. Suite: 47/1225.
      · frontend `JinniChat.vue formatTextSegment` escapes `& < "` before building markup
        (model prose/venue names reached v-html unescaped; JinniShare already sanitised).
      Still OPEN from the audit: rate limiters keyed on unverified `CF-Connecting-IP`
      (`server.js:314`, `authRoutes.js:26`); stack traces returned at `aiRoutes.js:7667`
      and `businessRoutes.js:827`; 175 swallowed catches (two fail-open gates in
      canonicalStore ~510/~969); no proof `seedGazetteer`/`embedPlaceCache --apply` ran;
      the agent never calls `hotel_prices` even when prices are asked (session 6ab3a61e
      turn 2 answered "call the hotel" with liteAPI one call away).
- [x] **BOOKING PARTNER AS A SOURCE + GROUP OCCUPANCY** (2026-09-23, founder:
      "can it search from booking initially too? … it will give more results than
      google", after live session 6ab3c2ed):
      · `engine/travel/hotels.js` — `occupanciesFor(party)` sizes rooms from the
        constraint ledger's partySize (12 people ⇒ 6 rooms; the odd traveler gets a
        single; capped at 12 rooms). It reaches the min-rates call AND the whitelabel
        booking link, so a quoted price covers the whole group and a hotel that cannot
        take them returns NO rate — the capacity answer the narrator previously had to
        ask the traveler for. `areaHotels()` is new: the partner's inventory around a
        centre as a SOURCE (photo, address, stars, 0–10 guest score, live price, Book
        link), not just a price sticker on Google's results.
      · `engine/places/canonicalStore.js` — PARTNER INVENTORY TIER, hotels only, runs
        before the Google fallback so partner coverage can spare a paid Text Search.
        ADDITIVE by construction: owned/cache rows keep their identity (placeId ⇒
        saveable, stored images, hours) and only INHERIT the price + Book link, matched
        by the SAME strict rule as the price matcher (distinctive tokens + 1.5 km);
        a hotel only the partner sells joins at the TAIL (the prior is positional).
        An unbookable partner row joins only while the deck is short and is marked
        `_partnerUnpriced` — never given a number. Fail-open on any partner error.
      · **A partner-only card has NO placeId and therefore cannot be saved yet** —
        inventing a Google id would poison PlaceCache and the saves collection. Known
        and deliberate; the save button is simply disabled (`getRecRef` returns null).
      · Scales never mix: the partner scores out of TEN, Google out of five, so the
        guest score is carried as `_guestRating` and always rendered with its scale
        ("8.6/10"), never as `rating`. Cards, the narrator fact line and the deck
        agent's summary all carry it, plus stars and the live price.
      · A group price is rendered as "from X / night for N rooms" (new i18n key
        `chat.hotel.from_per_night_group`, added to ALL SIX locales; parity 805/805) —
        "from X / night" would be read as the price of one room.
      · `routes/aiChatV3.js` — a refill that EXHAUSTED the area widens ONCE (under half
        the asked count, no explicit radius / walking ask / corridor, non-events), and
        the narrator is TOLD (`_radiusWidened`) so the reply says it looked further
        instead of presenting other towns as if they had been in range. Live session
        6ab3c2ed answered "Other ones? Give lots of results" with ONE card and the line
        "it's the only stay I can show you" — true at 10 km, false at 30.
      11 new tests; suite 47 suites / 1234 tests green.
      ⚠ Partner coverage in small towns is the remaining limit, not a bug: around
      Yeghegnadzor the partner priced ONE hotel. `[canonicalStore] partner tier:
      index=N priced=M` now logs the real numbers per turn — read them before
      concluding anything about coverage.

