/**
 * Itinerary routes — /api/itinerary
 *
 * Two-phase streaming generation (SSE, same `data: {...}\n\n` wire format the
 * chat/quick-action streams use, so the frontend parser is identical):
 *
 *   PHASE 1 (skeleton, one small AI call):
 *     { type:'status', stage:'planning' }
 *     { type:'meta', itineraryId, destination, daysCount, startDate, homeBase }
 *     { type:'skeleton', days:[{ dayNumber, title, slots:[{ slotId, order, time, name, category, note }] }] }
 *
 *   PHASE 2 (enrichment, cache-first via the SAME pipeline quick-action uses):
 *     { type:'slot_enriched', dayNumber, slotId, place:{...} }   ← one per resolved slot
 *     { type:'slot_failed',   dayNumber, slotId }                ← place couldn't be verified
 *     { type:'complete', itinerary:{...full document...} }
 *
 * Edits are split in two tiers:
 *   - Structural (reorder / remove / move / retime / lock / replace-with-picked-card)
 *     → PATCH /:id — plain CRUD, zero AI cost.
 *   - "Suggest something" → the frontend calls the EXISTING /api/ai/quick-action-stream
 *     with excludePlaceIds = itinerary.allPlaceIds(); nothing here duplicates it.
 *   - "Regenerate this day" → POST /:id/regenerate-day-stream (plans around locked slots).
 *
 * Shared code: this file deliberately reuses aiRoutes' battle-tested helpers
 * (getCachedPlaceDetails → PlaceCache-first Google enrichment,
 *  resolveEffectiveLocation, getAllMessages). aiRoutes.js must export them —
 * see INTEGRATION.md, it is a 1-line change at the bottom of that file.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const auth = require('../middleware/auth');
const { usageTracker, estimateTokens } = require('../middleware/usageTracker');
const User = require('../models/User');
const AppConfig = require('../models/AppConfig');
const AiProviderDailyStats = require('../models/AiProviderDailyStats');
const Itinerary = require('../models/Itinerary');
const currencyService = require('../services/currencyService');
// Itinerary completions are logged as quick_action_used so they appear in the
// admin's quick-action chart next to the other actions from the chat.
const Analytics = require('../models/Analytics');
const PlaceFeedback = require('../models/PlaceFeedback');
const SavedPlace = require('../models/SavedPlace');
const PlaceCache = require('../models/PlaceCache');
const Business = require('../models/Business');
const openai = require('../config/openai');
const claudeService = require('../services/claudeService');

// ── Shared helpers exported by aiRoutes (see INTEGRATION.md, step 1) ─────────
// Lazy-required to avoid any require-order surprises at boot: aiRoutes is a
// big module; by the time a request arrives it is guaranteed loaded.
let _aiShared = null;
function aiShared() {
  if (!_aiShared) {
    const aiRoutes = require('./aiRoutes');
    _aiShared = aiRoutes.shared;
    if (!_aiShared) throw new Error('aiRoutes.js does not export .shared — apply the export patch from INTEGRATION.md');
  }
  return _aiShared;
}

/* ══════════════════════════════ utilities ══════════════════════════════ */

// Total stops per day INCLUDING the ~2 meals. Raised from 4/6/8: at the old
// counts a "balanced" day was 4 activities + lunch + dinner, which filled only
// ~5½ of the day's ~11 planned hours — the last sight ended around 14:30 and
// the traveler then sat idle until the 19:00 dinner window. Checked against a
// real time budget in activityCapacity() so a fuller day is never an
// overstuffed one.
const PACE_SLOTS = { relaxed: 6, balanced: 8, packed: 10 };
const MAX_DAYS = 10;
const ENRICH_CONCURRENCY = 3;   // parallel PlaceCache/Google lookups — polite to quota
// Hard geofence for enriched stops. A same-named place in another country can
// win the PlaceCache/Google name match (e.g. a "Seven Seas" in the US matched
// for a Cyprus trip) — anything farther than this from the destination is
// rejected and the slot flips to `failed` so the UI offers a replacement.
const MAX_STOP_KM = Number(process.env.ITINERARY_MAX_STOP_KM) || 60;

/* ── Day scheduling ─────────────────────────────────────────────────────────
 * The model's plan is only a suggestion; enrichment can move a stop's real
 * coordinates, and re-sorting old time labels onto a new order would let a
 * "lunch" restaurant drift to 09:45 (the "hungry all day" bug). So times are
 * recomputed deterministically here:
 *   - activities are ordered with a greedy nearest-neighbor walk from the
 *     home base (or city center) so the 1→N route never doubles back;
 *   - each stop gets a realistic dwell time by category (viewpoint 30 min,
 *     historical ~70, museum 90, meal 75, …) plus travel time between stops
 *     (walking speed in Nearby mode, city driving otherwise);
 *   - restaurants are PINNED to meal windows: when the simulated clock reaches
 *     lunch (12:15–14:00) or dinner (19:00–20:30), the geographically nearest
 *     unplaced restaurant is inserted next — arriving early waits for the
 *     window, so nobody eats lunch at 10:30 or walks hungry until 17:00;
 *   - a cafe, when present, opens the day as breakfast/coffee.
 * Failed/pending slots keep their relative order, appended after, no time.
 */
const DWELL_MIN = {
  restaurants: 75, cafe: 40, historical: 70, museum: 90,
  photo_spots: 30, viewpoint: 30, hidden_gems: 45, shopping: 60,
  events: 90, nature: 60, hotels: 20,
};
const DAY_START_MIN = 9 * 60;                       // 09:00
const DAY_END_MIN   = 21 * 60;                      // 21:00 — the horizon the prompt promises
const LUNCH = { start: 12 * 60 + 15, end: 14 * 60 };        // 12:15–14:00
const DINNER = { start: 19 * 60, end: 20 * 60 + 30 };       // 19:00–20:30
// Longest dead stretch the plan may contain. Waiting an hour before dinner is
// normal travel rhythm (drop bags, freshen up); waiting four is the bug.
const MAX_IDLE_MIN = 60;
// Dinner may slide this early to close a hole, but no earlier — an itinerary
// that eats dinner at 16:00 is a different kind of wrong.
const DINNER_FLOOR = 17 * 60 + 30;                  // 17:30

/* ── Meal geography ─────────────────────────────────────────────────────────
 * On an excursion day the restaurant pool is collected around the TRAVELER's
 * city, not around the excursion — so at 12:15 in Garni the "nearest" unplaced
 * restaurant is 30 km away in Yerevan. The meal-window rule would then drive
 * back to the city to eat and return to Garni afterwards: the exact
 * Garni → Yerevan → Garni bounce that makes a plan look stupid.
 *
 * The rule below is what a real tour operator does: you do not interrupt an
 * excursion to drive back for lunch — you eat locally if there is somewhere,
 * otherwise you eat on the way back. So a meal that would cost more than
 * MEAL_DETOUR_KM of backtracking is DEFERRED while there is still sightseeing
 * nearby; it then lands naturally once the route heads home.
 *
 * Deferral is bounded, because nobody should sightsee until 17:00 unfed:
 * past HUNGER_LIMIT the meal is taken regardless of the detour. That is the
 * "you might be hungry" safeguard, kept but made geography-aware rather than
 * purely clock-driven.
 */
const mealDetourKm = (nearby) => (nearby ? 3 : 10);
const HUNGER_LIMIT = 15 * 60 + 30;                  // 15:30 — eat, detour or not

const AVG_DWELL_MIN = 55;                           // mean of the activity dwell table
const typicalHopMin = (nearby) => (nearby ? 12 : 18);

function dwellOf(slot) { return DWELL_MIN[slot.category] || 45; }
// "Heavy" = a long, attention-demanding indoor sight. ONE definition, used by
// both the scheduler's adjacency guard and the pool picker's per-day cap —
// they previously disagreed (scheduler: historical|museum, picker:
// historical|events), so a museum-heavy day passed the picker's cap and then
// fought the scheduler's spacing rule.
const HEAVY_CATEGORIES = new Set(['historical', 'museum', 'events']);
const isHeavyCategory = (category) => HEAVY_CATEGORIES.has(category);
const isHeavy = (slot) => !!slot && isHeavyCategory(slot.category);

/**
 * When a meal actually starts, given when the traveler arrives.
 *
 * Arriving early used to mean "wait for the window, however long that takes":
 * `if (t < win) t = win`. With the day's activities exhausted by 14:30 that
 * pinned dinner at 19:00 and left a 4½-hour hole — the single biggest
 * complaint about the generated plans. Now an early arrival waits at most
 * MAX_IDLE_MIN and the meal slides earlier, down to `floor`.
 *
 * Lunch passes floor = LUNCH.start, so lunch never moves earlier than its
 * window (nobody eats lunch at 10:30). Dinner passes DINNER_FLOOR.
 */
function mealStart(arriveMin, windowStart, floorMin) {
  if (arriveMin >= windowStart) return arriveMin;          // late → eat on arrival
  return Math.min(windowStart, Math.max(arriveMin + MAX_IDLE_MIN, floorMin));
}

/**
 * How many activity stops actually FIT between the day's start and DAY_END_MIN,
 * once meals and typical travel are paid for. The pool builder used a fixed
 * `pace - 2` (= 4 for balanced) regardless of how long the day was, which is
 * what under-filled every day. The pace setting still caps the result, so
 * "relaxed" stays relaxed — it just no longer produces a dead afternoon.
 */
function activityCapacity({ pace = 'balanced', nearby = false, hasBreakfast = false, startMin = DAY_START_MIN } = {}) {
  const hop = typicalHopMin(nearby);
  const mealMin = DWELL_MIN.restaurants * 2 + (hasBreakfast ? DWELL_MIN.cafe : 0);
  const budget = DAY_END_MIN - startMin - mealMin - hop * 2;   // hops to first stop and home
  const fits = Math.floor(budget / (AVG_DWELL_MIN + hop));
  // PACE_SLOTS counts TOTAL stops, so subtract the meals this day will carry:
  // lunch + dinner always, plus the optional breakfast cafe. Without this a
  // hotel breakfast quietly pushed a "balanced" day to 9 stops.
  const paceCap = (PACE_SLOTS[pace] || PACE_SLOTS.balanced) - 2 - (hasBreakfast ? 1 : 0);
  return Math.max(2, Math.min(fits, paceCap));
}

/**
 * Rough minutes a set of picks will consume (dwell + typical travel + meals).
 * Used by the day-filling pass to answer "does one more stop still fit before
 * the evening?" without running the full scheduler on every candidate.
 */
function projectedDayMinutes(picked, { hasBreakfast = false, nearby = false } = {}) {
  const hop = typicalHopMin(nearby);
  let m = DWELL_MIN.restaurants * 2 + (hasBreakfast ? DWELL_MIN.cafe : 0) + hop;
  for (const p of picked) m += (DWELL_MIN[p._cat || p.category] || 45) + hop;
  return m;
}

function travelMinutes(km, nearby) {
  // Nearby → walking (~4.5 km/h). Discovery → effective city driving
  // (~22 km/h door-to-door) + parking/transition overhead.
  const mins = nearby ? (km / 4.5) * 60 : (km / 22) * 60 + 7;
  return Math.min(120, Math.max(5, Math.round(mins / 5) * 5));
}

const fmtTime = (m) => {
  const r = Math.round(m / 5) * 5;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
};

/* ── Dated-event pinning ─────────────────────────────────────────────────────
 * The scheduler above invents a clock time for every stop and pins only meals,
 * so a dated event (approved jinni-event or saved event, carrying a real
 * eventSchedule) would show at the wrong time and possibly the wrong day. This
 * LAST pass corrects exactly those slots and touches nothing else:
 *   • TIME → the event's real local clock time (in its own timezone);
 *   • DAY  → when the trip has real dates, the slot moves to the day whose
 *            calendar date equals the event's date, and that day is re-sorted
 *            chronologically so the event sits in the right position.
 * Fails safe: recurring/undated events, or dates outside the trip window, are
 * left exactly where the scheduler put them. Isolated and additive — it never
 * feeds back into the geographic scheduler. */
const _tzTime = (date, tz) => {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
  catch { return null; }
};
const _tzISODate = (date, tz) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
  catch { return null; }
};
const _timeToMin = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? (+m[1] * 60 + +m[2]) : Infinity; };
const _datedEvent = (slot) => {
  const es = slot?.place?.eventSchedule;
  if (!es || !es.startDate || es.isRecurring) return null;
  const start = new Date(es.startDate);
  return isNaN(start.getTime()) ? null : { start, tz: es.timezone || 'UTC' };
};

/* ── Cost estimate from validator prices (the price CONSUMER) ─────────────────
 * Stops that resolved to a curated Destination carry a verifiedId; validators
 * may have entered a real price on those. This batch-loads those prices (ONE
 * query), attaches them to the slots, and computes an APPROXIMATE per-person,
 * per-day figure in the user's currency. Trust ladder: only real validator
 * prices count — a stop with no price is simply excluded (coveredStops reports
 * how many were priced), so a brand-new area with no curated prices yields no
 * estimate rather than a fabricated one. Never a hard total; always "~approx".
 * Async + best-effort: any failure leaves costEstimate null and never blocks. */
async function attachPricingAndEstimate(days, displayCurrency = 'USD') {
  try {
    const Destination = require('../models/Destination');
    const idset = new Set();
    for (const day of days) for (const s of (day.slots || []))
      if (s.place && s.status === 'enriched' && s.place.verifiedModel === 'destination' && s.place.verifiedId) idset.add(String(s.place.verifiedId));
    if (idset.size) {
      const rows = await Destination.find({ _id: { $in: [...idset] } }).select('pricing').lean();
      const byId = new Map(rows.map(r => [String(r._id), r.pricing]));
      for (const day of days) for (const s of (day.slots || [])) {
        const p = s.place && s.place.verifiedId ? byId.get(String(s.place.verifiedId)) : null;
        if (p && (p.isFree || Number.isFinite(p.average) || Number.isFinite(p.min))) s.place.pricing = p;
      }
    }
    // Estimate: average of the per-day sums of priced stops, per person.
    const cur = (displayCurrency || 'USD').toUpperCase();
    let totalStops = 0, coveredStops = 0, priceDays = 0, sumPerDay = 0;
    for (const day of days) {
      let dayCost = 0, dayHasPrice = false;
      for (const s of (day.slots || [])) {
        if (!s.place || s.status !== 'enriched') continue;
        totalStops++;
        const p = s.place.pricing;
        if (!p) continue;
        if (p.isFree) { coveredStops++; dayHasPrice = true; continue; }
        const amt = Number.isFinite(p.average) ? p.average : (Number.isFinite(p.min) && Number.isFinite(p.max) ? (p.min + p.max) / 2 : p.min);
        if (!Number.isFinite(amt)) continue;
        let usd = amt; try { usd = currencyService.convertToUSD(amt, p.currency || 'USD'); } catch { /* treat as USD */ }
        dayCost += usd; coveredStops++; dayHasPrice = true;
      }
      if (dayHasPrice) { sumPerDay += dayCost; priceDays++; }
    }
    if (!coveredStops || !priceDays) return null;
    let perDayUsd = sumPerDay / priceDays;
    let perDay = perDayUsd;
    try { perDay = currencyService.convertFromUSD(perDayUsd, cur); } catch { perDay = perDayUsd; }
    return { perPersonPerDay: Math.round(perDay), currency: cur, coveredStops, totalStops };
  } catch (e) { console.warn('[itinerary] cost estimate failed:', e.message); return null; }
}

function pinDatedEvents(days, startDate) {
  if (!Array.isArray(days) || !days.length) return;
  const tripStart = startDate ? new Date(startDate) : null;
  const dayDateStr = (dayNumber) => {
    if (!tripStart || isNaN(tripStart.getTime())) return null;
    const d = new Date(tripStart); d.setUTCDate(d.getUTCDate() + (dayNumber - 1));
    return _tzISODate(d, 'UTC');
  };
  // Pin time, and (when the trip is dated) move each event to its real day.
  for (const day of [...days]) {
    for (const slot of [...day.slots]) {
      const ev = _datedEvent(slot);
      if (!ev) continue;
      const hhmm = _tzTime(ev.start, ev.tz);
      // All-day events (no specific time) are stored at local midnight. Showing
      // "00:00" implies a real midnight start, so leave those WITHOUT a clock
      // time (honest: "this day, time unspecified"); the day pin still applies.
      // A genuinely timed event keeps its real time.
      if (hhmm && hhmm !== '00:00') slot.time = hhmm;              // correct TIME
      else slot.time = null;                                       // all-day → no misleading time
      const evDate = _tzISODate(ev.start, ev.tz);
      const target = evDate ? days.find(d => dayDateStr(d.dayNumber) === evDate) : null;
      if (target && target !== day) {                             // correct DAY
        day.slots = day.slots.filter(s => s !== slot);
        target.slots.push(slot);
      }
    }
  }
  // Re-sort only the days that hold a pinned event, chronologically. Stable in
  // V8, so equal/undated stops keep their scheduled order; null-time slots
  // (failed/pending) sort to the end untouched.
  for (const day of days) {
    if (!day.slots.some(s => _datedEvent(s))) continue;
    day.slots.sort((a, b) => _timeToMin(a.time) - _timeToMin(b.time));
    day.slots.forEach((s, i) => { s.order = i; });
  }
}

function optimizeDayOrder(day, start, nearby = false, startMin = DAY_START_MIN) {
  const enriched = day.slots.filter(s => s.status === 'enriched' && Number.isFinite(s.place?.latitude));
  const rest = day.slots.filter(s => !(s.status === 'enriched' && Number.isFinite(s.place?.latitude)));
  if (enriched.length >= 2) {
    const meals = enriched.filter(s => s.category === 'restaurants');
    const cafes = enriched.filter(s => s.category === 'cafe');
    const acts = enriched.filter(s => s.category !== 'restaurants' && s.category !== 'cafe');

    const nearestFrom = (pool, cur) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = haversineKm(cur.lat, cur.lng, pool[i].place.latitude, pool[i].place.longitude);
        if (d < bestD) { bestD = d; best = i; }
      }
      return pool.splice(best, 1)[0];
    };
    /** Distance to the closest stop in `pool` from `cur`, without taking it. */
    const nearestDistance = (pool, cur) => pool.reduce((best, s) =>
      Math.min(best, haversineKm(cur.lat, cur.lng, s.place.latitude, s.place.longitude)), Infinity);
    /**
     * Would eating now mean driving away from the day's remaining sightseeing?
     * True when the closest restaurant is a real detour AND there is still
     * something to see nearby — i.e. the Garni-lunch-in-Yerevan case. Hunger
     * wins after HUNGER_LIMIT so this can never starve the traveler.
     */
    const mealIsDetour = (clock) => {
      if (!acts.length || clock >= HUNGER_LIMIT) return false;
      const toMeal = nearestDistance(meals, cur);
      const toAct = nearestDistance(acts, cur);
      return toMeal > mealDetourKm(nearby) && toMeal > toAct * 2;
    };

    const seq = [];
    let cur = { lat: start.lat, lng: start.lng };
    let t = startMin;
    let lunchDone = false, dinnerDone = false;

    const place = (slot, windowStart = null, floorMin = null) => {
      const travel = travelMinutes(haversineKm(cur.lat, cur.lng, slot.place.latitude, slot.place.longitude), nearby);
      t += travel;
      // Early → linger until the window, but never idle for hours (see mealStart).
      if (windowStart != null) t = mealStart(t, windowStart, floorMin ?? windowStart);
      slot.time = fmtTime(t);
      t += dwellOf(slot);
      cur = { lat: slot.place.latitude, lng: slot.place.longitude };
      seq.push(slot);
    };

    // Cafe opens the day (breakfast/coffee) when the plan has one.
    if (cafes.length) place(nearestFrom(cafes, cur));

    while (acts.length || meals.length || cafes.length) {
      // Look ahead at the stop that would ACTUALLY be chosen next (the nearest
      // one), not at whichever happens to sit first in the array — the lunch
      // decision below turns on this duration.
      const nextAct = acts.length
        ? acts.reduce((a, b) => (haversineKm(cur.lat, cur.lng, a.place.latitude, a.place.longitude)
            <= haversineKm(cur.lat, cur.lng, b.place.latitude, b.place.longitude) ? a : b))
        : null;
      const lookahead = nextAct ? dwellOf(nextAct) : 45;
      const prev = seq[seq.length - 1];
      const prevIsFood = !!prev && (prev.category === 'restaurants' || prev.category === 'cafe');
      // Food→food guard: when the previous stop was food and an activity can
      // still fit before the lunch window closes, the activity goes first —
      // walking from restaurant to restaurant is never the right plan.
      // Two independent reasons to hold a meal back: the previous stop was
      // already food, or eating now would mean abandoning the excursion to
      // drive back to town (see mealIsDetour).
      const deferLunch = (prevIsFood && acts.length && (t + lookahead <= LUNCH.end - 30)) || mealIsDetour(t);
      if (!lunchDone && meals.length && !deferLunch && (t >= LUNCH.start - 20 || t + lookahead > LUNCH.end)) {
        place(nearestFrom(meals, cur), LUNCH.start, LUNCH.start);
        lunchDone = true;
      } else if (!dinnerDone && meals.length && !(prevIsFood && acts.length) && !mealIsDetour(t) && (t >= DINNER.start - 20 || (!acts.length && !cafes.length))) {
        // Running out of activities early must still respect meal windows —
        // an 11:00 "lunch" is exactly the hungry-afternoon bug this prevents.
        // Dinner, however, may slide EARLIER than 19:00 (down to DINNER_FLOOR)
        // when the day is already done: a 17:45 dinner beats a 4-hour hole.
        place(
          nearestFrom(meals, cur),
          lunchDone ? DINNER.start : LUNCH.start,
          lunchDone ? DINNER_FLOOR : LUNCH.start,
        );
        if (lunchDone) dinnerDone = true; else lunchDone = true;
      } else if (acts.length) {
        // Adjacency guard, two flavours with the same detour rule:
        //   heavy→heavy  — museum after museum (sight fatigue), and
        //   same→same    — two stops of the SAME category back-to-back
        //                  (Northern Avenue then the mall ON Northern Avenue
        //                  is the exact plan this breaks up).
        // If the nearest next stop clashes with the previous one and a
        // non-clashing stop exists, take the nearest non-clashing stop —
        // unless it is a genuine detour (more than 2x the distance, or 3+ km
        // further), in which case geography wins.
        const last = prev;
        let pick = null;
        const clashes = (s) => !!last && s !== last && (
          (isHeavy(last) && isHeavy(s)) ||
          (!!last.category && s.category === last.category)
        );
        if (last && acts.some(clashes) && acts.some(a => !clashes(a))) {
          const dist = (s) => haversineKm(cur.lat, cur.lng, s.place.latitude, s.place.longitude);
          const nearestAny = acts.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
          if (clashes(nearestAny)) {
            const clean = acts.filter(a => !clashes(a));
            const nearestClean = clean.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
            const dAny = dist(nearestAny), dClean = dist(nearestClean);
            if (dClean <= dAny * 2 || dClean - dAny <= 3) {
              pick = nearestClean;
            }
          }
        }
        if (pick) { acts.splice(acts.indexOf(pick), 1); place(pick); }
        else place(nearestFrom(acts, cur));
      } else if (cafes.length) {
        place(nearestFrom(cafes, cur));           // leftover cafe → afternoon break
      } else if (meals.length) {
        place(
          nearestFrom(meals, cur),
          !lunchDone ? LUNCH.start : (!dinnerDone ? DINNER.start : null),
          !lunchDone ? LUNCH.start : (!dinnerDone ? DINNER_FLOOR : null),
        );
        if (!lunchDone) lunchDone = true; else dinnerDone = true;
      }
    }
    // ── Post-pass 1: un-zigzag the activity runs ─────────────────────────
    // Greedy nearest-neighbor crosses its own path on scattered clusters —
    // day 1's city-centre catch-all cluster especially (k-means with
    // farthest-point seeding keeps outer clusters tight but dumps the spread
    // into the one nearest the hotel). Meals stay pinned where their windows
    // put them; every maximal run of non-meal stops between anchors is tiny,
    // so the run's optimal order is found EXACTLY, not heuristically.
    improveActivityRuns(seq, start);

    // ── Post-pass 2: recompute honest times over the improved order ──────
    let rt = startMin, rcur = { lat: start.lat, lng: start.lng }, rMeals = 0;
    for (const slot of seq) {
      rt += travelMinutes(haversineKm(rcur.lat, rcur.lng, slot.place.latitude, slot.place.longitude), nearby);
      if (slot.category === 'restaurants') {
        const win = rMeals === 0 ? LUNCH.start : DINNER.start;
        // Lunch holds its window; dinner may slide earlier rather than leave
        // the traveler idle all afternoon (see mealStart).
        rt = mealStart(rt, win, rMeals === 0 ? LUNCH.start : DINNER_FLOOR);
        rMeals++;
      }
      slot.time = fmtTime(rt);
      rt += dwellOf(slot);
      rcur = { lat: slot.place.latitude, lng: slot.place.longitude };
    }

    day.slots = [...seq, ...rest];
  }
  day.slots.forEach((s, i) => { s.order = i; });
}

/* Recompute times over the CURRENT slot order, without reordering anything.
 * Used after manual structural edits (move up/down, move to another day,
 * remove, add): the user's chosen order is law — only the clock is re-walked.
 * Same physics as optimizeDayOrder's post-pass 2 (travel + dwell, meals
 * linger to their windows), minus the nearest-neighbor reordering, which
 * would silently undo the user's explicit move. Slots without coordinates
 * (pending / failed) keep their position but lose the time label — an honest
 * "unscheduled" beats a stale wrong time. */
function recomputeDayTimes(day, start, nearby = false, startMin = DAY_START_MIN) {
  let t = startMin, cur = { lat: start.lat, lng: start.lng }, meals = 0;
  for (const slot of day.slots) {
    const lat = slot.place?.latitude, lng = slot.place?.longitude;
    if (slot.status !== 'enriched' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      slot.time = null;
      continue;
    }
    t += travelMinutes(haversineKm(cur.lat, cur.lng, lat, lng), nearby);
    if (slot.category === 'restaurants') {
      const win = meals === 0 ? LUNCH.start : DINNER.start;
      t = mealStart(t, win, meals === 0 ? LUNCH.start : DINNER_FLOOR);
      meals++;
    }
    slot.time = fmtTime(t);
    t += dwellOf(slot);
    cur = { lat, lng };
  }
}

/**
 * Exact re-ordering of each maximal run of non-meal stops between fixed
 * anchors (day start, breakfast cafe, meals). Runs are ≤5-6 stops, so all
 * permutations are checked (≤720 — microseconds) against total travel
 * distance, with a penalty for putting two heavy sights (historical/museum)
 * back-to-back so the sight-fatigue rule survives the re-order.
 */
function improveActivityRuns(seq, start) {
  const pt = (s) => ({ lat: s.place.latitude, lng: s.place.longitude });
  const isAnchor = (s, i) => s.category === 'restaurants' || (i === 0 && s.category === 'cafe');
  let i = 0;
  while (i < seq.length) {
    if (isAnchor(seq[i], i)) { i++; continue; }
    let j = i;
    while (j < seq.length && !isAnchor(seq[j], j)) j++;
    const run = seq.slice(i, j);
    if (run.length >= 2 && run.length <= 6) {
      const from = i === 0 ? { lat: start.lat, lng: start.lng } : pt(seq[i - 1]);
      const to = j < seq.length ? pt(seq[j]) : null;
      const cost = (order) => {
        let c = 0, cur = from;
        for (let x = 0; x < order.length; x++) {
          const p = pt(order[x]);
          c += haversineKm(cur.lat, cur.lng, p.lat, p.lng);
          if (x > 0 && isHeavy(order[x - 1]) && isHeavy(order[x])) c += 2.5;  // fatigue penalty (km-equivalent)
          cur = p;
        }
        if (to) c += haversineKm(cur.lat, cur.lng, to.lat, to.lng);
        return c;
      };
      let best = run, bestC = cost(run);
      const perm = (arr, k) => {
        if (k === arr.length - 1) {
          const c = cost(arr);
          if (c < bestC - 1e-9) { bestC = c; best = [...arr]; }
          return;
        }
        for (let x = k; x < arr.length; x++) {
          [arr[k], arr[x]] = [arr[x], arr[k]];
          perm(arr, k + 1);
          [arr[k], arr[x]] = [arr[x], arr[k]];
        }
      };
      perm([...run], 0);
      for (let x = 0; x < best.length; x++) seq[i + x] = best[x];
    }
    i = j;
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const newSlotId = () => `sl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

// Slot category → quick-action id. Server-side mirror of ItineraryView's
// CATEGORY_TO_ACTION so a slot vote lands in PlaceFeedback under the SAME
// action the replacement-candidates call (quick-action-stream) filters by —
// that filter is what makes a dislike actually hide the place afterwards.
const SLOT_CATEGORY_TO_ACTION = {
  restaurants: 'restaurants', cafe: 'restaurants', hotels: 'hotels',
  hidden_gems: 'hidden_gems', historical: 'historical', museum: 'historical',
  events: 'events', photo_spots: 'photo_spots', viewpoint: 'photo_spots',
  shopping: 'shopping', nature: 'hidden_gems',
};
const slotVoteAction = (category) => SLOT_CATEGORY_TO_ACTION[category] || 'hidden_gems';

/**
 * Names of places this user has EVER disliked (any action). Fed into the
 * skeleton prompt's exclude list so freshly planned itineraries don't
 * resurface a place the user already voted down — whether the vote came from
 * a chat card or an itinerary slot. Best-effort: on failure returns [] and
 * generation proceeds unpersonalized rather than failing.
 */
async function loadDislikedNames(userId, cap = 40) {
  try {
    const rows = await PlaceFeedback.find({ userId, vote: 'dislike' })
      .select('name').sort({ updatedAt: -1 }).limit(cap).lean();
    return [...new Set(rows.map(r => (r.name || '').trim()).filter(Boolean))];
  } catch (err) {
    console.warn('[itinerary] disliked-names load failed:', err.message);
    return [];
  }
}

function sseHeaders(res) {
  // Matches chat-stream / quick-action-stream exactly (text/plain, not
  // text/event-stream) so the existing frontend reader loop works unchanged.
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, Authorization, Content-Type',
    // These streams write their own CORS headers, so the app-level
    // exposedHeaders config cannot be relied on here — name them again or
    // the browser drops the quota values it was just sent.
    'Access-Control-Expose-Headers': 'X-Usage-Tokens-Used, X-Usage-Tokens-Remaining, X-Usage-Places-Viewed, X-Usage-Places-Remaining, X-Usage-Requests-Remaining',
  });
}

function makeSender(req, res) {
  let gone = false;
  req.on('close', () => { gone = true; });
  return {
    isGone: () => gone,
    send(obj) {
      if (gone) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { gone = true; }
    },
    end() { if (!gone) { try { res.end(); } catch (_) {} } },
  };
}

/**
 * Provider-agnostic single completion, mirroring the quick-action branch in
 * aiRoutes (AppConfig toggle: Claude if configured, DeepSeek/OpenAI otherwise).
 * Itineraries can be toggled independently via cfg.aiProviderItinerary; when
 * that key doesn't exist it follows whatever quick-action uses.
 */
async function callModel({ system, prompt, maxTokens, endpoint }) {
  const cfg = await AppConfig.getConfig();
  const provider = cfg.aiProviderItinerary || cfg.aiProviderQuickAction || 'deepseek';
  let text = '';
  if (provider === 'claude') {
    const result = await claudeService.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      model: cfg.claudeModel,
      maxTokens,
      temperature: 0.4,
      cacheSystem: true,
    });
    text = result.text;
  } else {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'deepseek-chat',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: maxTokens,
    });
    text = completion.choices?.[0]?.message?.content || '';
  }
  // Per-provider daily usage — same bookkeeping as quick-action.
  const tokens = Math.ceil(((prompt?.length || 0) + (system?.length || 0) + (text?.length || 0)) / 4);
  AiProviderDailyStats.track(provider, { tokens, queries: 1, searches: 0, endpoint })
    .catch(err => console.error('AiProviderDailyStats error:', err));
  return { text, provider };
}

/**
 * Pull a JSON object out of a model reply that may be wrapped in prose or
 * ```json fences. Models intermittently ignore "JSON only" — never trust the
 * raw string. Returns null when nothing parseable exists (caller retries once
 * with a sterner prompt, then errors out cleanly).
 */
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  // Common model glitch: trailing commas. One conservative repair pass.
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch (_) { return null; }
}

const VALID_CATEGORIES = new Set([
  'restaurants', 'cafe', 'hotels', 'hidden_gems', 'historical',
  'events', 'photo_spots', 'shopping', 'nature', 'museum', 'viewpoint',
]);

/** Coerce whatever the model returned into a clean, bounded day plan. */
function sanitizeSkeleton(raw, daysCount, pace, { lenient = false } = {}) {
  if (!raw || !Array.isArray(raw.days)) return null;
  const maxSlots = PACE_SLOTS[pace] || PACE_SLOTS.balanced;
  const days = [];
  for (let i = 0; i < daysCount; i++) {
    const src = raw.days[i] || {};
    const slots = Array.isArray(src.slots) ? src.slots : [];
    const clean = [];
    for (const s of slots) {
      const name = String(s?.name || '').trim();
      if (!name || name.length > 90) continue;                 // junk guard
      const category = VALID_CATEGORIES.has(s?.category) ? s.category : 'hidden_gems';
      const time = /^\d{1,2}:\d{2}$/.test(String(s?.time || '')) ? String(s.time) : null;
      clean.push({
        slotId: newSlotId(),
        order: clean.length,
        time,
        name,
        category,
        note: String(s?.note || '').slice(0, 200),
        locked: false,
        status: 'pending',
        place: null,
      });
      if (clean.length >= maxSlots) break;
    }
    // A day with nothing in it is a bad plan. On the first attempt that fails
    // the whole batch so the retry can do better — but on the LAST attempt a
    // 10-day trip should not be thrown away because day 7 came back empty, so
    // lenient mode keeps the good days and shrinks the trip to fit.
    if (clean.length === 0) {
      if (!lenient) return null;
      continue;
    }
    days.push({
      dayNumber: days.length + 1,
      title: String(src.title || '').slice(0, 80) || `Day ${days.length + 1}`,
      titleSource: 'ai',
      slots: clean,
    });
  }
  return days.length ? days : null;
}

/* ── Trip-budget derivation (DISTINCT from the per-place preference budget) ───
 * A whole-trip budget → a per-person-per-day spending level → a price tier that
 * shapes suggestions. Deliberately NOT a hard total: we have price LEVELS, not
 * real prices, so we steer toward appropriately-priced places and never promise
 * an exact total. Currency-correct: the total is converted to USD (the tier
 * thresholds' base) via currencyService, so a budget in AMD/EUR/RUB maps the
 * same as one in USD. Returns null when no usable trip budget is set — callers
 * then fall back to the preference budget / style.
 *
 * Thresholds are per-person, per-day, for MEALS + PAID STOPS (lodging excluded
 * — that's a separate line a traveler books themselves). Rough by design and
 * only ever surfaced with "approximately". */
const TRIP_TIER_BANDS = [
  { maxUsdPerDay: 30,  tier: 1, label: 'budget' },
  { maxUsdPerDay: 75,  tier: 2, label: 'moderate' },
  { maxUsdPerDay: 200, tier: 3, label: 'upscale' },
  { maxUsdPerDay: Infinity, tier: 4, label: 'luxury' },
];
function deriveTripBudget(tripBudget, daysCount) {
  const total = Number(tripBudget?.total);
  const people = Math.max(1, Number(tripBudget?.people) || 1);
  const days = Math.max(1, Number(daysCount) || 1);
  if (!Number.isFinite(total) || total <= 0) return null;
  let totalUsd = total;
  try { totalUsd = currencyService.convertToUSD(total, tripBudget?.currency || 'USD'); }
  catch { /* unsupported currency → treat the number as USD (convertToUSD also warns) */ }
  const perPersonPerDayUsd = totalUsd / people / days;
  const band = TRIP_TIER_BANDS.find(b => perPersonPerDayUsd <= b.maxUsdPerDay) || TRIP_TIER_BANDS[TRIP_TIER_BANDS.length - 1];
  return { tier: band.tier, label: band.label, perPersonPerDayUsd: Math.round(perPersonPerDayUsd), people, days };
}

function skeletonPrompt({ destination, daysCount, pace, interests, homeBase, startDate, excludeNames, singleDay, maxKm = MAX_STOP_KM, language = 'en', travelStyle = null, budget = null, tripBudget = null }) {
  const slotsPerDay = PACE_SLOTS[pace] || PACE_SLOTS.balanced;
  // Style + budget, same signals the quick-action already reads from the user
  // record — surfaced to the planner so the FIRST plan matches them too, not
  // just the stops added later via quick-action.
  const styleLine = travelStyle
    ? `Travel style: ${travelStyle}. Prefer ${/lux/i.test(travelStyle) ? 'upscale, premium, well-reviewed' : 'affordable, good-value, well-reviewed'} places for meals and paid stops.`
    : '';
  // Trip budget is DISTINCT from and OVERRIDES the per-place preference budget:
  // a whole-trip total the traveler set for THIS itinerary wins over their
  // general spending band. Falls back to the preference band when no trip
  // budget is set.
  const TIER_WORD = { 1: 'budget/affordable', 2: 'moderately priced', 3: 'upscale', 4: 'luxury/premium' };
  const budgetLine = tripBudget
    ? `Trip budget: about ${tripBudget.perPersonPerDayUsd} USD per person per day (${tripBudget.people} traveler(s), ${tripBudget.days} day(s)) — choose ${TIER_WORD[tripBudget.tier]} places for meals and paid stops, and do NOT include stops clearly pricier than that level.`
    : (budget && Number.isFinite(budget.min) && Number.isFinite(budget.max))
      ? `Budget guidance: choose places whose price level fits roughly ${budget.min}-${budget.max} per person for a meal/ticket — avoid stops clearly above this range.`
      : '';
  const dayWord = singleDay ? '1 day (regenerating one day of a longer trip)' : `${daysCount} day(s)`;
  return [
    `Plan a ${dayWord} travel itinerary for ${destination.name} (around lat ${destination.lat}, lng ${destination.lng}).`,
    startDate ? `The trip starts on ${new Date(startDate).toDateString()}.` : '',
    `Pace: ${pace} — exactly ${Math.max(4, slotsPerDay - 1)}-${slotsPerDay} stops per day, scheduled between 09:00 and 21:00, in a geographically sensible order (minimize back-and-forth).`,
    // Without this the model reliably front-loaded the day: 4-5 stops finishing
    // by mid-afternoon, then dinner, leaving hours of nothing in between.
    `FILL THE WHOLE DAY. The afternoon between lunch and dinner (roughly 14:00-19:00) must contain at least two stops. Never leave more than about an hour unplanned anywhere in the day, and never finish the sightseeing before 17:00.`,
    `MEALS ARE MANDATORY: every single day must include one restaurant for lunch (category "restaurants", around 12:30-13:30) and one restaurant for dinner (category "restaurants", around 19:00-20:00). A cafe for morning coffee is welcome when the pace allows. Never plan a day where the traveler has nothing to eat.`,
    `Balance the day: at most 2 stops of category "historical" or "museum" per day, and never two of them back-to-back — separate heavy sights with food, a viewpoint, a walk, shopping, or a hidden gem.`,
    `Assume realistic visit durations when choosing how much fits in a day: viewpoint/photo spot ~30 min, market/shopping ~45-60 min, historical site ~60-75 min, museum ~90 min, meal ~75 min — plus travel time between stops.`,
    interests?.length ? `Traveler interests: ${interests.join(', ')}. Bias stop selection toward these.` : '',
    styleLine,
    budgetLine,
    homeBase?.name ? `The traveler stays at "${homeBase.name}" (lat ${homeBase.latitude ?? homeBase.lat}, lng ${homeBase.longitude ?? homeBase.lng}). Make the first stop of each day reasonably close to it and let the day naturally loop back toward it; do NOT list the accommodation itself as a stop.` : '',
    excludeNames?.length ? `NEVER include any of these (already used or rejected): ${excludeNames.slice(0, 80).join('; ')}.` : '',
    `Every stop MUST be a real, currently existing, findable-on-Google place located IN ${destination.name} or within roughly ${Math.max(3, Math.min(30, Math.round(maxKm / 2)))} km of it. NEVER suggest a place in another city, region, or country, and never use a brand's branch from elsewhere. Do not invent names. Prefer well-known, verifiable places over obscure guesses. Mix categories through the day (sights, food around meal times, a viewpoint or walk, etc.).`,
    `Write each day's "title" in this language: ${language}. Keep place names as they are.`,
    `Respond with ONLY a JSON object, no prose, no markdown fences, exactly this shape:`,
    `{"days":[{"day":1,"title":"short theme","slots":[{"time":"09:30","name":"Real Place Name","category":"restaurants|cafe|historical|hidden_gems|photo_spots|shopping|events|nature|museum|viewpoint","note":"one short practical tip"}]}]}`,
  ].filter(Boolean).join('\n');
}

const SKELETON_SYSTEM =
  'You are a meticulous local travel planner. You only recommend real places that exist. ' +
  'You reply with a single valid JSON object and absolutely nothing else — no introduction, no explanation, no markdown.';

/**
 * Build the slim, frontend-ready place object from the enrichment result.
 * Field names intentionally mirror createRecommendation() in aiRoutes so
 * RecommendationMap / rec cards can consume itinerary places unchanged.
 */
function buildPlace(enriched) {
  if (!enriched) return null;
  const lat = enriched.geometry?.location?.lat ?? null;
  const lng = enriched.geometry?.location?.lng ?? null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;   // unmappable = useless for an itinerary
  let image = null;
  if (enriched.photos?.[0]) {
    if (enriched.place_id) image = `/api/ai/place-image/${enriched.place_id}/0`;
    else if (typeof enriched.photos[0] === 'string') image = enriched.photos[0];
    else if (enriched.photos[0]?.url) image = enriched.photos[0].url;
  }
  return {
    placeId: enriched.place_id || null,
    name: enriched.name || null,
    image,
    latitude: lat,
    longitude: lng,
    location: enriched.formatted_address || enriched.vicinity || null,
    region: enriched.vicinity || enriched.formatted_address || null,
    website: enriched.website || null,
    phone: enriched.formatted_phone_number || enriched.international_phone_number || null,
    rating: Number.isFinite(enriched.rating) ? enriched.rating : null,
    // Review count and opening hours were both available from the enrichment
    // pipeline and both thrown away here. The count now feeds ratingScore();
    // the hours are persisted so the card can show them (and so closing-time
    // aware scheduling has the data it needs).
    userRatingsTotal: Number.isFinite(enriched.user_ratings_total) ? enriched.user_ratings_total : null,
    openingHours: normalizeHours(enriched.opening_hours),
    description: enriched.description || null,
  };
}

/** Google's opening_hours → the plain weekday_text lines we can store/display.
 *  Tolerates both the classic and the newer `weekdayDescriptions` spelling. */
function normalizeHours(oh) {
  const arr = oh?.weekday_text || oh?.weekdayDescriptions;
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === 'string').slice(0, 7).map(x => x.slice(0, 120));
}

/**
 * Enrich every pending slot of `days` through the shared PlaceCache→Google
 * pipeline with bounded concurrency. Mutates slots in place, calls
 * onSlot(dayNumber, slot) after each resolution (success or failure) so the
 * caller can stream progress and persist incrementally.
 */
async function enrichDays(days, destination, requestId, isGone, onSlot, maxKm = MAX_STOP_KM, seedPlaceIds = []) {
  const { getCachedPlaceDetails, placeBlockedForAction } = aiShared();
  // `seedPlaceIds` pre-blocks venues already used ELSEWHERE in the itinerary
  // (e.g. the other days during a single-day regenerate), so a synonym name
  // that resolves to the same place is failed as a duplicate instead of
  // pinning the same venue on two days.
  const usedPlaceIds = new Set(seedPlaceIds);
  // Pre-seed with already-enriched slots (regeneration keeps locked places).
  for (const d of days) for (const s of d.slots) if (s.place?.placeId) usedPlaceIds.add(s.place.placeId);

  const queue = [];
  for (const d of days) for (const s of d.slots) if (s.status === 'pending') queue.push({ day: d, slot: s });

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      if (isGone()) return;
      const item = queue[cursor++];
      const { day, slot } = item;
      try {
        const enriched = await getCachedPlaceDetails(
          slot.name, false, requestId,
          { lat: destination.lat, lng: destination.lng },
        );
        const place = buildPlace(enriched);
        // ── Staff verdict on this venue ──────────────────────────────────────
        // The planner names places from the model's own memory, so the two
        // streaming routes' suppressions have to be enforced here as well — this
        // path never passes through them. Covers "Block AI", Explore-hidden, and
        // a category a validator has curated the place OUT of (a monastery filed
        // as 'historical' must not be planned into an 'events' slot). One indexed
        // lookup per resolved stop; fails open, so a lookup error can never turn
        // a good trip into a page of failed slots.
        const blockedReason = place && place.placeId
          ? await placeBlockedForAction(place.placeId, slotVoteAction(slot.category))
          : null;
        if (place && blockedReason) {
          // Reuses the existing 'unverified' reason rather than adding an enum
          // value: the UI already offers a replacement for it, and the real
          // cause is staff moderation, which is not the traveler's business.
          console.log(`Itinerary staff gate: rejected "${place.name}" for slot category "${slot.category}" (${blockedReason})`);
          slot.status = 'failed';
          slot.failedReason = 'unverified';
        } else if (place && haversineKm(destination.lat, destination.lng, place.latitude, place.longitude) > maxKm) {
          // Name-match landed on a same-named place far away (different city or
          // country). Reject it — a wrong-country pin is worse than a gap.
          console.log(`Itinerary geofence: rejected "${place.name}" — ${Math.round(haversineKm(destination.lat, destination.lng, place.latitude, place.longitude))}km from ${destination.name}`);
          slot.status = 'failed';
          slot.failedReason = 'out_of_area';
        } else if (place && place.placeId && usedPlaceIds.has(place.placeId)) {
          // Model listed the same venue twice under different phrasings —
          // fail the duplicate so the UI offers a replacement instead of
          // showing the same pin twice. It WAS verified, so say so.
          slot.status = 'failed';
          slot.failedReason = 'duplicate';
        } else if (place) {
          if (place.placeId) usedPlaceIds.add(place.placeId);
          slot.place = place;
          slot.status = 'enriched';
          slot.failedReason = null;
        } else {
          slot.status = 'failed';
          slot.failedReason = 'unverified';
        }
      } catch (err) {
        console.error(`Itinerary enrichment failed for "${slot.name}":`, err.message);
        slot.status = 'failed';
        slot.failedReason = 'unverified';
      }
      try { await onSlot(day.dayNumber, slot); } catch (_) {}
    }
  }
  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
}

/**
 * Token cost of the planning call itself: system + prompt (~400 tokens, and
 * it barely grows with trip length) plus the JSON plan the model writes back,
 * which is roughly one slot per ~25 tokens. Deliberately an estimate of the
 * MODEL call only — the places it produces are billed to the places budget.
 */
const MODEL_CALL_TOKENS = (daysCount) => 600 + 250 * Math.max(1, daysCount);

/**
 * Write ONE day back, without republishing the whole document.
 *
 * Day regeneration holds its document across ~10 seconds of model call plus
 * enrichment. Saving the whole thing at the end pushed a snapshot read before
 * all of that, so any edit the user made meanwhile — on any day — was
 * silently overwritten. A positional $set touches only the day in hand and
 * leaves every other day exactly as the user left it.
 */
async function persistDay(itineraryId, userId, day) {
  const plain = day.toObject ? day.toObject() : day;
  await Itinerary.updateOne(
    { _id: itineraryId, userId, 'days.dayNumber': day.dayNumber },
    {
      $set: {
        'days.$.slots': plain.slots,
        'days.$.title': plain.title,
        'days.$.titleSource': plain.titleSource,
      },
    },
  );
}

/**
 * Top days up from the shared leftover pool, ROUND-ROBIN.
 *
 * Filling each day to capacity in turn let the early days drain the pool, so
 * on a 6-7 day trip the last days were left with only whatever their own
 * cluster held — days 1-5 looked full and days 6-7 came back with three stops.
 * Taking at most one stop per day per round spreads a thin pool evenly, which
 * is what a shortfall should look like: every day slightly lighter, not two
 * days ruined.
 *
 * Returns per-day counts of what it added. Mutates `picked` arrays and
 * `leftovers` in place.
 */
function fillDaysRoundRobin(pickedPerDay, leftovers, opts) {
  const { actsPerDay, seed, maxKm, dayBudgetMin, capacityOpts, isHeavy } = opts;
  const added = new Array(pickedPerDay.length).fill(0);
  for (let round = 0; round < actsPerDay; round++) {
    let progressed = false;
    // Neediest day first within the round, so a genuinely thin day wins the
    // closest leftover when two days want the same one.
    const order = pickedPerDay
      .map((picked, i) => ({ picked, i }))
      .sort((a, b) => a.picked.length - b.picked.length);
    for (const { picked, i } of order) {
      if (picked.length >= actsPerDay || !leftovers.length) continue;
      const core = picked.length ? centroidOf(picked) : seed;
      const heavyFull = picked.filter(x => isHeavy(x._cat)).length >= 2;
      const eligible = leftovers.filter(l =>
        (!heavyFull || !isHeavy(l._cat)) && distTo(core, l) <= maxKm);
      if (!eligible.length) continue;
      const next = eligible.reduce((a, b) => (distTo(core, a) - placeScore(a) * 0.3)
        <= (distTo(core, b) - placeScore(b) * 0.3) ? a : b);
      if (projectedDayMinutes([...picked, next], capacityOpts) > dayBudgetMin) continue;
      picked.push(next);
      leftovers.splice(leftovers.indexOf(next), 1);
      added[i]++;
      progressed = true;
    }
    if (!progressed) break;
  }
  return added;
}

/** Usage-limit gate shared by both streaming endpoints. Returns true when the
 *  request may proceed; otherwise it has already written the 429/error. */
async function passUsageGate(req, res, estText, placesCount, { daysCount = 1 } = {}) {
  try {
    // Defence in depth. The middleware now fails closed, so this should be
    // unreachable — but "no quota record" must never again be read as "no
    // limits apply", which is precisely how the fail-open bug served
    // unlimited AI during a Mongo blip.
    if (!req.userLimit) {
      res.status(503).json({ success: false, error: 'usage_tracking_unavailable', message: 'Service temporarily unavailable. Please try again.' });
      return false;
    }
    // ── Two bugs lived in these two lines ────────────────────────────────
    // 1. ARGUMENT ORDER. The signature is (tokens, places, queries), so
    //    passing `placesCount` third billed it as QUERIES — a counter with no
    //    limit attached — while `placesToAdd` stayed hardcoded at 0. Itinerary
    //    generation therefore never charged the daily places budget at all,
    //    and it inflated totalQueriesMade (which corrupts avgTokensPerQuery,
    //    and through it the "requests remaining" figure shown to users).
    // 2. Enrichment was billed as 400 TOKENS PER PLACE against the token
    //    budget. That is what a place costs, not what it costs in tokens, and
    //    it made the token limit — not the place limit — the binding
    //    constraint: a 4-day trip cost 12,800 "tokens" and was refused
    //    outright. Places are now charged as places; tokens cover only the
    //    model call they actually pay for.
    const estimated = estimateTokens(estText) + MODEL_CALL_TOKENS(daysCount);
    const usage = await req.userLimit.checkAndUpdateUsage(estimated, placesCount, 1);
    res.set('X-Usage-Tokens-Used', usage.dailyTokensUsed?.toString() || '0');
    res.set('X-Usage-Tokens-Remaining', usage.dailyTokensRemaining?.toString() || '10000');
    res.set('X-Usage-Places-Viewed', usage.dailyPlacesViewed?.toString() || '0');
    res.set('X-Usage-Places-Remaining', usage.dailyPlacesRemaining?.toString() || '100');
    // Parity with aiRoutes — the client shows requests, not raw tokens.
    res.set('X-Usage-Requests-Remaining', usage.estimatedRequestsRemaining?.toString() || '0');
    if (usage.onCooldown) {
      res.status(429).json({ type: 'cooldown', message: 'Daily limit reached', cooldownUntil: usage.cooldownUntil, reason: 'daily_limit_exceeded' });
      return false;
    }
    return true;
  } catch (limitError) {
    res.status(429).json({ type: 'cooldown', message: limitError.message, cooldownUntil: req.userLimit?.cooldownUntil });
    return false;
  }
}

/* ═══════════════════════ POST /generate-stream ═══════════════════════ */

/* Human destination label. Reverse-geocode sometimes yields a junk city
 * ("Unknown location") — never let that become the trip's title. */
function destLabel(eff) {
  const clean = (s) => (s && !/unknown/i.test(String(s)) ? String(s).trim() : null);
  const city = clean(eff.city);
  const country = clean(eff.country);
  if (city) return country ? `${city}, ${country}` : city;
  return clean(eff.name) || country || 'Your trip area';
}

router.post('/generate-stream', auth, usageTracker, async (req, res) => {
  const requestId = `itin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const {
      daysCount: rawDays = 3,
      startDate = null,
      destination = null,          // { name, lat, lng } — optional, falls back to effective location
      pace: rawPace = 'balanced',
      interests = [],
      homeBase = null,             // { placeId, name, lat, lng } | null
      nearbyMode = false,          // Nearby → compact plan within the user's nearby radius
      language: bodyLang = null,
      tripBudget = null,           // DISTINCT whole-trip budget { total, currency, people } — budget-style travelers only
    } = req.body || {};

    const daysCount = Math.min(Math.max(parseInt(rawDays, 10) || 3, 1), MAX_DAYS);
    const pace = ['relaxed', 'balanced', 'packed'].includes(rawPace) ? rawPace : 'balanced';

    const user = await User.findById(req.user.id).select('preferences settings');
    const userLanguage = bodyLang || user?.settings?.language || 'en';
    const { resolveEffectiveLocation, getAllMessages } = aiShared();
    const messages = getAllMessages(userLanguage);

    // Destination: explicit body wins; otherwise the same effective-location
    // resolution every other AI endpoint uses (settings destination / detect).
    let dest = null;
    let radiusKm = MAX_STOP_KM;
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      dest = { name: String(destination.name || '').trim() || 'your destination', lat: destination.lat, lng: destination.lng };
    } else {
      const eff = await resolveEffectiveLocation(user, destination, messages);
      if (!eff || eff.error === 'location_required') {
        return res.status(400).json({
          success: false, error: 'location_required',
          message: messages.location_required,
          userMessage: messages.location_set_destination,
          action: 'configure_location',
        });
      }
      dest = { name: destLabel(eff), lat: eff.lat, lng: eff.lng };
      // Nearby → compact, walkable plan inside the user's nearby radius
      // (settings, default 5 km). Discovery → the wider of the geofence cap
      // and the user's discovery radius, whichever is smaller.
      radiusKm = nearbyMode
        ? Math.max(3, eff.nearbyRadius || 5)
        : Math.min(MAX_STOP_KM, eff.discoveryRadius || MAX_STOP_KM);
    }

    const approxPlaces = (PACE_SLOTS[pace] || PACE_SLOTS.balanced) * daysCount;
    if (!(await passUsageGate(req, res, `itinerary ${dest.name} ${daysCount}d`, approxPlaces, { daysCount }))) return;

    // ── Home base: resolve coordinates when the client only knows a name ──
    // Saved-place snapshots in JinniChat carry no lat/lng, so `homeBase` may
    // arrive as just { name, placeId }. Resolve it through the same
    // PlaceCache-first pipeline; if it can't be verified, drop it silently —
    // a home base is a nice-to-have anchor, never a blocker.
    let resolvedHomeBase = null;
    if (homeBase?.name) {
      if (Number.isFinite(homeBase.lat) && Number.isFinite(homeBase.lng)) {
        resolvedHomeBase = { placeId: homeBase.placeId || null, name: homeBase.name, latitude: homeBase.lat, longitude: homeBase.lng };
      } else {
        try {
          const { getCachedPlaceDetails } = aiShared();
          const enriched = await getCachedPlaceDetails(
            homeBase.placeId || homeBase.name, false, requestId,
            { lat: dest.lat, lng: dest.lng },
            homeBase.placeId || null,
          );
          const lat = enriched?.geometry?.location?.lat, lng = enriched?.geometry?.location?.lng;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            resolvedHomeBase = { placeId: enriched.place_id || homeBase.placeId || null, name: enriched.name || homeBase.name, latitude: lat, longitude: lng };
          }
        } catch (e) { console.warn('homeBase resolution failed, continuing without it:', e.message); }
      }
    }

    // Persist the shell first so a crash mid-stream still leaves a resumable doc.
    const doc = await Itinerary.create({
      userId: req.user.id,
      destination: dest,
      startDate: startDate ? new Date(startDate) : null,
      daysCount, pace,
      interests: Array.isArray(interests) ? interests.slice(0, 10).map(String) : [],
      nearbyMode: !!nearbyMode,
      radiusKm,
      // Whole-trip budget (distinct from the preference budget). Stored so a day
      // regeneration reuses the same budget without re-asking.
      ...(tripBudget && Number(tripBudget.total) > 0 ? { tripBudget: {
        total: Number(tripBudget.total),
        currency: String(tripBudget.currency || 'USD').toUpperCase().slice(0, 3),
        people: Math.max(1, parseInt(tripBudget.people, 10) || 1),
      } } : {}),
      homeBase: resolvedHomeBase,
      days: [],
      status: 'generating',
      language: userLanguage,
      title: `${dest.name} — ${daysCount} ${daysCount === 1 ? 'day' : 'days'}`,
    });

    sseHeaders(res);
    const sse = makeSender(req, res);
    sse.send({ type: 'status', stage: 'planning' });
    sse.send({
      type: 'meta',
      itineraryId: doc._id.toString(),
      destination: dest, daysCount, startDate: doc.startDate, pace,
      homeBase: doc.homeBase, title: doc.title,
      // Nearby → the map draws a real walking route; Discovery → vector lines.
      nearbyMode: !!nearbyMode,
    });

    // ── PHASE 1: skeleton ────────────────────────────────────────────────
    // Places the user has disliked anywhere (chat cards or itinerary slots)
    // are told to the planner up front so they don't come back in a new trip.
    const dislikedNames = await loadDislikedNames(req.user.id);
    let days = null;
    for (let attempt = 0; attempt < 2 && !days; attempt++) {
      const prompt = skeletonPrompt({ destination: dest, daysCount, pace, interests, homeBase: doc.homeBase, startDate: doc.startDate, excludeNames: dislikedNames, maxKm: radiusKm, language: userLanguage, travelStyle: user?.preferences?.travelStyle || null, budget: user?.preferences?.budget || null, tripBudget: deriveTripBudget(doc.tripBudget, daysCount) })
        + (attempt ? '\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.' : '');
      const { text } = await callModel({ system: SKELETON_SYSTEM, prompt, maxTokens: 260 * daysCount * (PACE_SLOTS[pace] || 8) / 4 + 600, endpoint: 'itinerary' });
      // Last attempt → accept a partial plan rather than failing the whole trip.
      days = sanitizeSkeleton(extractJson(text), daysCount, pace, { lenient: attempt === 1 });
    }
    // A lenient parse may have dropped empty days — keep the document honest.
    if (days && days.length !== daysCount) doc.daysCount = days.length;
    if (!days) {
      doc.status = 'failed'; await doc.save().catch(() => {});
      sse.send({ type: 'error', message: messages.connection_error || 'Could not plan the trip. Please try again.' });
      return sse.end();
    }

    doc.days = days;
    await doc.save();
    sse.send({
      type: 'skeleton',
      days: days.map(d => ({
        dayNumber: d.dayNumber, title: d.title,
        slots: d.slots.map(({ slotId, order, time, name, category, note }) => ({ slotId, order, time, name, category, note })),
      })),
    });

    // ── PHASE 2: enrichment (cache-first, streamed as it lands) ─────────
    sse.send({ type: 'status', stage: 'enriching' });
    let dirty = 0;
    await enrichDays(doc.days, dest, requestId, sse.isGone, async (dayNumber, slot) => {
      if (slot.status === 'enriched') sse.send({ type: 'slot_enriched', dayNumber, slotId: slot.slotId, place: slot.place });
      else sse.send({ type: 'slot_failed', dayNumber, slotId: slot.slotId, reason: slot.failedReason });
      // Persist every few slots — cheap insurance against mid-stream crashes
      // without hammering Mongo once per place.
      doc.markModified('days');
      if (++dirty % 4 === 0) await doc.save().catch(() => {});
    }, radiusKm);

    // Route optimization: greedy nearest-neighbor per day from the home base
    // (or city center), so the drawn 1→N path never doubles back.
    const startPoint = doc.homeBase && Number.isFinite(doc.homeBase.latitude)
      ? { lat: doc.homeBase.latitude, lng: doc.homeBase.longitude }
      : { lat: dest.lat, lng: dest.lng };
    for (const day of doc.days) optimizeDayOrder(day, startPoint, doc.nearbyMode);
    pinDatedEvents(doc.days, doc.startDate);   // dated events → real day + time
    // Approximate per-day cost from validator prices of curated stops.
    doc.costEstimate = await attachPricingAndEstimate(doc.days, user?.settings?.currency || 'USD');

    doc.status = 'ready';
    doc.markModified('days');
    doc.markModified('costEstimate');
    await doc.save();
    // Itinerary is one of the chat's quick actions, but unlike the other seven
    // it runs through its own route and was never recorded — so it showed as
    // zero usage in the admin panel no matter how much it was used. Logged
    // with the same shape as the others (aiRoutes' quick_action_used) so it
    // sits alongside them in the same chart rather than needing its own.
    // Fire-and-forget: analytics must never fail a completed itinerary.
    Analytics.create({
      type: 'quick_action_used',
      userId: req.user?._id || req.user?.id,
      metadata: {
        sessionId: 'itinerary_stream',
        action: 'itinerary',
        subType: null,
        value: doc.days?.length || 0,      // days planned
        count: doc.days?.length || 0,
        hasLocation: !!(dest?.lat && dest?.lng)
      }
    }).catch(err => console.warn('[itinerary] analytics log failed:', err.message));

    sse.send({ type: 'complete', itinerary: doc.toObject() });
    sse.end();
  } catch (error) {
    console.error(`[${requestId}] itinerary generation failed:`, error);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'itinerary_failed', message: 'Failed to generate itinerary' });
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to generate itinerary' })}\n\n`); res.end(); } catch (_) {}
  }
});

/* ═══════════════ POST /:id/regenerate-day-stream ═══════════════ */

router.post('/:id/regenerate-day-stream', auth, usageTracker, async (req, res) => {
  const requestId = `itin-regen-${Date.now()}`;
  try {
    const { dayNumber } = req.body || {};
    const doc = await Itinerary.findOne({ _id: req.params.id, userId: req.user.id });
    if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
    const day = doc.days.find(d => d.dayNumber === Number(dayNumber));
    if (!day) return res.status(400).json({ success: false, error: 'bad_day' });
    // Preferences for parity with initial generation (style/budget) — the trip
    // budget itself lives on the doc.
    const regenUser = await User.findById(req.user.id).select('preferences');

    if (!(await passUsageGate(req, res, `regen ${doc.destination.name}`, PACE_SLOTS[doc.pace] || PACE_SLOTS.balanced, { daysCount: 1 }))) return;

    // Everything already in the itinerary — every other day AND this day's
    // already-shown places — is off the menu, so a regenerated day gives fresh
    // stops rather than reshuffling the same ones. Locked "keep this stop"
    // slots survive untouched (see `keep`) and are additionally fed to the
    // model below as anchors to plan around.
    const keep = day.slots.filter(s => s.locked);
    // Also plan around every place the user has disliked — a regenerated day
    // must not "fix" itself by bringing back something they voted down.
    const excludeNames = [...new Set([...doc.allNames(), ...(await loadDislikedNames(req.user.id))])];

    sseHeaders(res);
    const sse = makeSender(req, res);
    sse.send({ type: 'status', stage: 'planning' });

    let planned = null;
    for (let attempt = 0; attempt < 2 && !planned; attempt++) {
      const prompt = skeletonPrompt({
        destination: doc.destination, daysCount: 1, pace: doc.pace, interests: doc.interests,
        homeBase: doc.homeBase, startDate: null, excludeNames, singleDay: true,
        maxKm: doc.radiusKm || MAX_STOP_KM,
        language: doc.language || 'en',
        travelStyle: regenUser?.preferences?.travelStyle || null,
        budget: regenUser?.preferences?.budget || null,
        tripBudget: deriveTripBudget(doc.tripBudget, doc.daysCount),
      }) + (keep.length ? `\nThe traveler is KEEPING these stops on this day — plan the rest of the day around them, do not repeat them: ${keep.map(s => s.place?.name || s.name).join('; ')}.` : '')
        + (attempt ? '\nReply with ONLY the JSON object.' : '');
      const { text } = await callModel({ system: SKELETON_SYSTEM, prompt, maxTokens: 900, endpoint: 'itinerary_regen' });
      planned = sanitizeSkeleton(extractJson(text), 1, doc.pace);
    }
    if (!planned) { sse.send({ type: 'error', message: 'Could not regenerate this day.' }); return sse.end(); }

    // Merge: locked slots stay (keeping their enrichment), new plan fills the rest.
    const maxSlots = PACE_SLOTS[doc.pace] || PACE_SLOTS.balanced;
    const fresh = planned[0].slots.slice(0, Math.max(1, maxSlots - keep.length));
    day.title = planned[0].title || day.title;
    if (planned[0].title) day.titleSource = 'ai';
    day.slots = [...keep, ...fresh].map((s, i) => ({ ...(s.toObject ? s.toObject() : s), order: i }));
    doc.markModified('days');
    await persistDay(doc._id, req.user.id, day);

    sse.send({
      type: 'skeleton',
      days: [{
        dayNumber: day.dayNumber, title: day.title,
        slots: day.slots.map(({ slotId, order, time, name, category, note, locked, status, place }) =>
          ({ slotId, order, time, name, category, note, locked, status, place: status === 'enriched' ? place : null })),
      }],
    });

    sse.send({ type: 'status', stage: 'enriching' });
    const regenRadius = doc.radiusKm || MAX_STOP_KM;
    // Block every placeId used on OTHER days so a regenerated stop can't
    // duplicate a venue that already appears elsewhere in the trip (name
    // exclusion alone can miss a differently-worded synonym).
    const otherDayPlaceIds = [];
    for (const d of doc.days) if (d.dayNumber !== day.dayNumber)
      for (const s of d.slots) if (s.place?.placeId) otherDayPlaceIds.push(s.place.placeId);
    await enrichDays([day], doc.destination, requestId, sse.isGone, async (dn, slot) => {
      if (slot.status === 'enriched') sse.send({ type: 'slot_enriched', dayNumber: dn, slotId: slot.slotId, place: slot.place });
      else sse.send({ type: 'slot_failed', dayNumber: dn, slotId: slot.slotId, reason: slot.failedReason });
    }, regenRadius, otherDayPlaceIds);

    const regenStart = doc.homeBase && Number.isFinite(doc.homeBase.latitude)
      ? { lat: doc.homeBase.latitude, lng: doc.homeBase.longitude }
      : { lat: doc.destination.lat, lng: doc.destination.lng };
    optimizeDayOrder(day, regenStart, doc.nearbyMode);
    pinDatedEvents([day], null);   // time-pin any dated event in the regenerated day (single day → no cross-day move)

    // Write back ONLY this day. Saving the whole document here republished a
    // snapshot read ~10 seconds ago, silently erasing anything the user edited
    // on another day while the regeneration ran. The re-read afterwards is
    // what the client is told about, so 'complete' reflects reality rather
    // than our stale copy.
    await persistDay(doc._id, req.user.id, day);
    const finalDoc = await Itinerary.findOne({ _id: doc._id, userId: req.user.id }).lean();
    sse.send({ type: 'complete', itinerary: finalDoc || doc.toObject() });
    sse.end();
  } catch (error) {
    console.error(`[${requestId}] day regeneration failed:`, error);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'regen_failed' });
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to regenerate day' })}\n\n`); res.end(); } catch (_) {}
  }
});

/* ═══════════════ POST /build-from-pool (no AI at all) ═══════════════ */
/*
 * Pool-based composition. The FRONTEND collects candidate places by calling
 * the existing /api/ai/quick-action-stream once per category (so ranking,
 * partner tiers, community feedback and PlaceCache all apply, and that
 * endpoint stays untouched), then posts the pool here. This endpoint is pure
 * algorithm — zero model calls, zero Google calls (pool places arrive
 * enriched):
 *
 *   1. validate + geofence the pool (never trust client coordinates blindly)
 *   2. k-means-cluster the ACTIVITY places into one geographic cluster per
 *      day, so each day stays in a coherent area of the city
 *   3. order clusters starting from the hotel (day 1 = nearest area)
 *   4. per day: pick top-scored activities (partner tier + rating), heavy
 *      sights capped at 2; assign lunch (nearest the day's centre) and dinner
 *      (best on the way back to the hotel); optional breakfast cafe near the
 *      hotel when the hotel doesn't serve breakfast
 *   5. run the same optimizeDayOrder scheduler for realistic times
 *
 * Places are NOT charged against the daily quota here — every pool place was
 * already counted by the quick-action calls that fetched it.
 */

const TIER_SCORE = { signature: 3, spotlight: 2, verified: 1 };
const POOL_ACTIONS = ['restaurants', 'historical', 'hidden_gems', 'photo_spots', 'shopping', 'events'];
const BREAKFASTY = /caf[e\u00e9]|coffee|bakery|patisserie|brunch|breakfast|konditorei|boulangerie/i;

function poolPlace(raw) {
  const lat = Number(raw?.latitude), lng = Number(raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !raw?.name) return null;
  return {
    placeId: raw.placeId || null,
    // DB identity — verified Business/Destination recs carry verifiedId +
    // _verifiedModel and usually NO Google placeId. Dropping these here made
    // every pool-built verified stop unsaveable (no identity → no ribbon).
    // slotFrom() only strips _tier/_cat, so these flow into PlaceSchema.
    verifiedId: raw.verifiedId ? String(raw.verifiedId) : null,
    verifiedModel: raw.verifiedModel || raw._verifiedModel || null,
    partnerTier: raw.partnerTier || null,
    name: String(raw.name).slice(0, 120),
    image: typeof raw.image === 'string' ? raw.image.slice(0, 500) : null,
    latitude: lat, longitude: lng,
    location: raw.location || raw.address || null,
    region: raw.region || null,
    website: raw.website || null,
    phone: raw.phone || null,
    rating: Number.isFinite(raw.rating) ? raw.rating : null,
    // Opportunistic — rec cards may or may not carry these yet. Absent count
    // makes ratingScore() fall back to the neutral prior (see there).
    userRatingsTotal: Number.isFinite(raw.userRatingsTotal) ? raw.userRatingsTotal
      : (Number.isFinite(raw.user_ratings_total) ? raw.user_ratings_total : null),
    openingHours: Array.isArray(raw.openingHours) ? raw.openingHours.slice(0, 7) : normalizeHours(raw.opening_hours),
    description: raw.description || null,
    // Dated events keep their schedule so pinDatedEvents can place them on the
    // real day + time. Only DB sources (Destinations, saved events) ever carry
    // this; Google-resolved places don't, and stay flexible.
    eventSchedule: (raw.eventSchedule && raw.eventSchedule.startDate) ? raw.eventSchedule : null,
    _tier: TIER_SCORE[raw.partnerTier] || 0,
  };
}

/**
 * Rating confidence. A raw `rating` sort ranked a 4.9 from 3 reviews above a
 * 4.6 from 8,000 — which is how tourist-trap-adjacent nobodies kept beating
 * the places people actually travel for. A Bayesian average pulls thin ratings
 * toward the prior, so review COUNT earns its weight without hard-filtering
 * small venues out (a genuinely great 200-review restaurant still wins).
 *
 * Degrades safely: when the pipeline has no review count the term is 0 and the
 * score is exactly the prior, i.e. neutral — never worse than the old sort.
 */
const RATING_PRIOR = 4.0;
const RATING_CONFIDENCE = 50;         // reviews at which the raw rating dominates
function ratingScore(p) {
  const r = Number.isFinite(p?.rating) ? p.rating : RATING_PRIOR;
  const n = Number.isFinite(p?.userRatingsTotal) && p.userRatingsTotal > 0 ? p.userRatingsTotal : 0;
  return (n * r + RATING_CONFIDENCE * RATING_PRIOR) / (n + RATING_CONFIDENCE);
}

const placeScore = (p) => p._tier * 2 + ratingScore(p);

/* ── Partner-tier trust boundary ────────────────────────────────────────────
 * `partnerTier` is a COMMERCIAL signal that decides whether a stop wears a
 * "Jinni's Signature" badge — and it used to be copied straight out of the
 * request body, both here and in the PATCH ops. A crafted addSlot body or a
 * doctored pool could therefore mint a badge on any place, and that badge is
 * visible to everyone on the public share page.
 *
 * Tiers are now re-read from the Business document instead. One batched query
 * per request, not one per place. Anything that cannot be verified is stored
 * as a plain place rather than being rejected — an unbadged real stop is the
 * right failure mode, a fake badge is not.
 */
async function trustedTierMap(verifiedIds) {
  const ids = [...new Set(verifiedIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  try {
    const rows = await Business.find({ _id: { $in: ids } }).select('partnership.tier').lean();
    return new Map(rows.map(b => [String(b._id), b.partnership?.tier || null]));
  } catch (err) {
    console.warn('[itinerary] partner-tier verification failed, dropping tiers:', err.message);
    return new Map();
  }
}

/** Overwrite a place's client-supplied identity with what the DB actually says. */
function applyTrustedTier(place, tierMap) {
  if (!place) return place;
  const vid = place.verifiedId ? String(place.verifiedId) : null;
  if (!vid) {
    place.verifiedId = null; place.verifiedModel = null; place.partnerTier = null;
    return place;
  }
  // Destinations are public sites, never paying partners — they keep their
  // identity (so they stay saveable) but can never carry a tier.
  if (place.verifiedModel === 'destination') { place.partnerTier = null; return place; }
  if (!tierMap.has(vid)) {
    // Claims to be a business we cannot find — drop the claim entirely.
    place.verifiedId = null; place.verifiedModel = null; place.partnerTier = null;
    return place;
  }
  place.verifiedModel = 'business';
  place.partnerTier = tierMap.get(vid);
  return place;
}
const distTo = (a, b) => haversineKm(a.latitude ?? a.lat, a.longitude ?? a.lng, b.latitude ?? b.lat, b.longitude ?? b.lng);

/** k-means over activity places (k = days) with farthest-point seeding and a
 *  rebalance pass so no day ends up empty. */
function clusterByDay(places, k, seedPoint) {
  if (k <= 1 || places.length <= k) {
    const sorted = [...places].sort((a, b) => distTo(seedPoint, a) - distTo(seedPoint, b));
    const out = Array.from({ length: k }, () => []);
    sorted.forEach((p, i) => out[i % k].push(p));
    return out;
  }
  const centroids = [[...places].sort((a, b) => distTo(seedPoint, a) - distTo(seedPoint, b))[0]]
    .map(p => ({ latitude: p.latitude, longitude: p.longitude }));
  while (centroids.length < k) {
    let far = places[0], farD = -1;
    for (const p of places) {
      const d = Math.min(...centroids.map(c => distTo(c, p)));
      if (d > farD) { farD = d; far = p; }
    }
    centroids.push({ latitude: far.latitude, longitude: far.longitude });
  }
  let clusters = [];
  for (let iter = 0; iter < 10; iter++) {
    clusters = Array.from({ length: k }, () => []);
    for (const p of places) {
      let best = 0, bestD = Infinity;
      centroids.forEach((c, i) => { const d = distTo(c, p); if (d < bestD) { bestD = d; best = i; } });
      clusters[best].push(p);
    }
    centroids.forEach((c, i) => {
      if (clusters[i].length) {
        c.latitude = clusters[i].reduce((s, p) => s + p.latitude, 0) / clusters[i].length;
        c.longitude = clusters[i].reduce((s, p) => s + p.longitude, 0) / clusters[i].length;
      }
    });
  }
  for (let guard = 0; guard < k * 2; guard++) {
    const emptyI = clusters.findIndex(c => c.length === 0);
    if (emptyI === -1) break;
    const fullest = clusters.reduce((a, b) => (a.length >= b.length ? a : b));
    if (fullest.length <= 1) break;
    const c = centroidOf(fullest);
    fullest.sort((a, b) => distTo(c, a) - distTo(c, b));
    clusters[emptyI].push(fullest.pop());
  }
  return clusters;
}

const centroidOf = (arr) => ({
  latitude: arr.reduce((s, p) => s + p.latitude, 0) / arr.length,
  longitude: arr.reduce((s, p) => s + p.longitude, 0) / arr.length,
});

/** Localized theme words for the algorithmic day-title fallback. Keyed by
 *  2-letter language; unknown languages fall back to English. Deliberately a
 *  tiny local dictionary (not getAllMessages) so the fallback has zero
 *  dependencies and works even when the i18n bundle lacks these keys. */
const DAY_THEME_WORDS = {
  en: { restaurants: 'food', cafe: 'coffee', historical: 'history', museum: 'museums', nature: 'nature', viewpoint: 'viewpoints', photo_spots: 'photo spots', shopping: 'shopping', events: 'events', hidden_gems: 'hidden gems' },
  ru: { restaurants: 'еда', cafe: 'кофе', historical: 'история', museum: 'музеи', nature: 'природа', viewpoint: 'смотровые', photo_spots: 'фотоместа', shopping: 'шопинг', events: 'события', hidden_gems: 'скрытые жемчужины' },
  hy: { restaurants: 'ուտեստներ', cafe: 'սուրճ', historical: 'պատմություն', museum: 'թանգարաններ', nature: 'բնություն', viewpoint: 'տեսարաններ', photo_spots: 'ֆոտոկետեր', shopping: 'գնումներ', events: 'միջոցառումներ', hidden_gems: 'թաքնված գոհարներ' },
  el: { restaurants: 'φαγητό', cafe: 'καφές', historical: 'ιστορία', museum: 'μουσεία', nature: 'φύση', viewpoint: 'θέες', photo_spots: 'σημεία φωτογράφισης', shopping: 'ψώνια', events: 'εκδηλώσεις', hidden_gems: 'κρυμμένα διαμάντια' },
  de: { restaurants: 'Essen', cafe: 'Kaffee', historical: 'Geschichte', museum: 'Museen', nature: 'Natur', viewpoint: 'Aussichten', photo_spots: 'Fotospots', shopping: 'Shopping', events: 'Events', hidden_gems: 'Geheimtipps' },
  fr: { restaurants: 'gastronomie', cafe: 'café', historical: 'histoire', museum: 'musées', nature: 'nature', viewpoint: 'panoramas', photo_spots: 'spots photo', shopping: 'shopping', events: 'événements', hidden_gems: 'perles cachées' },
  es: { restaurants: 'gastronomía', cafe: 'café', historical: 'historia', museum: 'museos', nature: 'naturaleza', viewpoint: 'miradores', photo_spots: 'sitios para fotos', shopping: 'compras', events: 'eventos', hidden_gems: 'joyas ocultas' },
  it: { restaurants: 'cucina', cafe: 'caffè', historical: 'storia', museum: 'musei', nature: 'natura', viewpoint: 'panorami', photo_spots: 'punti foto', shopping: 'shopping', events: 'eventi', hidden_gems: 'gemme nascoste' },
};

/** Language-neutral-ish day title from what the day visits: the one or two
 *  most-frequent region names ("Kato Paphos & Old Town"), enriched with the
 *  day's dominant category theme when we have words for the trip language
 *  ("Kato Paphos — food & history"). The LLM paths write nicer themed titles;
 *  this is the instant, zero-cost fallback for pool builds and for refreshing
 *  auto titles after edits. Falls back to the theme alone when regions are
 *  missing or address-length, and to '' when there's nothing to say (the UI
 *  hides an empty title rather than showing a bare "Day N"). */
function dayTitle(slots, lang) {
  const counts = new Map();
  for (const s of slots) {
    const region = String(s.place?.region || '').trim();
    if (!region || region.length > 32) continue;
    counts.set(region, (counts.get(region) || 0) + 1);
  }
  const area = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]).join(' & ');

  const words = DAY_THEME_WORDS[String(lang || 'en').slice(0, 2).toLowerCase()] || DAY_THEME_WORDS.en;
  const themeCounts = new Map();
  for (const s of slots) {
    const w = words[s.category];
    if (w) themeCounts.set(w, (themeCounts.get(w) || 0) + 1);
  }
  const theme = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]).join(' & ');

  const title = area && theme ? `${area} — ${theme}` : (area || theme);
  return title.slice(0, 60);
}

const DAY_TITLES_SYSTEM =
  'You are a travel copywriter. You reply with a single valid JSON object and absolutely nothing else — no introduction, no explanation, no markdown.';

/** One batched model call → an evocative short title per day, in the trip's
 *  language. Returns an array aligned with `days`, or null on any failure —
 *  callers keep their algorithmic fallback titles in that case. */
async function generateDayTitles(days, destinationName, language) {
  try {
    const lines = days.map(d =>
      `Day ${d.dayNumber}: ` + d.slots
        .map(s => `${s.place?.name || s.name} (${s.category}${s.place?.region ? ', ' + s.place.region : ''})`)
        .join('; '));
    const prompt = [
      `A traveler has this itinerary for ${destinationName}:`,
      ...lines,
      `Write one short, evocative title per day (3-5 words, max 40 characters, no day numbers, no quotes, no trailing punctuation) capturing that day's theme or area.`,
      `Write the titles in this language: ${language}.`,
      `Respond with ONLY a JSON object, exactly this shape: {"titles":["...","..."]} with exactly ${days.length} entries in day order.`,
    ].join('\n');
    const { text } = await callModel({ system: DAY_TITLES_SYSTEM, prompt, maxTokens: 60 + days.length * 40, endpoint: 'itinerary_day_titles' });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed?.titles)) return null;
    const titles = parsed.titles.map(t => String(t || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 60));
    return titles.some(Boolean) ? titles : null;
  } catch (err) {
    console.error('generateDayTitles failed (fallback titles kept):', err.message);
    return null;
  }
}

function slotFrom(place, category) {
  const { _tier, _cat, ...clean } = place;
  return {
    slotId: newSlotId(), order: 0, time: null,
    name: place.name, category, note: '', locked: false,
    status: 'enriched', place: clean,
  };
}

router.post('/build-from-pool', auth, usageTracker, async (req, res) => {
  const requestId = `itin-pool-${Date.now()}`;
  try {
    const {
      daysCount: rawDays = 3,
      pool = {},
      homeBase = null,           // { name, placeId, lat, lng } — lat/lng present when picked from suggestions
      hotelBreakfast = false,
      nearbyMode = false,
      pace: rawPace = 'balanced',
      language: bodyLang = null,
      tripBudget = null,          // whole-trip budget (distinct from preference budget)
    } = req.body || {};
    const daysCount = Math.min(Math.max(parseInt(rawDays, 10) || 3, 1), MAX_DAYS);
    // Pool builds used to hardcode 'balanced' and ignore the caller entirely,
    // so a traveler could never ask for a fuller (or lighter) day on this path.
    const pace = ['relaxed', 'balanced', 'packed'].includes(rawPace) ? rawPace : 'balanced';

    const user = await User.findById(req.user.id).select('preferences settings');
    const userLanguage = bodyLang || user?.settings?.language || 'en';
    const { resolveEffectiveLocation, getAllMessages, getCachedPlaceDetails } = aiShared();
    const messages = getAllMessages(userLanguage);

    const eff = await resolveEffectiveLocation(user, null, messages);
    if (!eff || eff.error === 'location_required') {
      return res.status(400).json({ success: false, error: 'location_required', message: messages.location_required, userMessage: messages.location_set_destination, action: 'configure_location' });
    }
    const dest = { name: destLabel(eff), lat: eff.lat, lng: eff.lng };
    const radiusKm = nearbyMode ? Math.max(3, eff.nearbyRadius || 5) : Math.min(MAX_STOP_KM, eff.discoveryRadius || MAX_STOP_KM);

    // Small flat charge only — the pool's places were already counted by the
    // quick-action calls that fetched them; never bill them twice.
    if (!(await passUsageGate(req, res, `itinerary pool ${dest.name}`, 0))) return;

    // ── 1. validate + geofence + dedupe the pool ──
    const seenIds = new Set();
    const byAction = {};
    for (const action of POOL_ACTIONS) {
      byAction[action] = (Array.isArray(pool[action]) ? pool[action] : [])
        .slice(0, 15)
        .map(poolPlace)
        .filter(Boolean)
        .filter(p => haversineKm(dest.lat, dest.lng, p.latitude, p.longitude) <= radiusKm)
        .filter(p => { const k = p.placeId || p.name.toLowerCase(); if (seenIds.has(k)) return false; seenIds.add(k); return true; });
    }
    // Re-derive every partner tier from the database before anything is scored
    // or stored — the pool is client-supplied (see trustedTierMap).
    const poolTiers = await trustedTierMap(
      POOL_ACTIONS.flatMap(a => byAction[a].map(p => p.verifiedId)));
    for (const a of POOL_ACTIONS) {
      for (const p of byAction[a]) {
        applyTrustedTier(p, poolTiers);
        p._tier = TIER_SCORE[p.partnerTier] || 0;    // rescore on the verified tier
      }
    }

    const restaurants = byAction.restaurants;
    const activities = POOL_ACTIONS.filter(a => a !== 'restaurants').flatMap(a => byAction[a].map(p => ({ ...p, _cat: a })));

    // Thin pool → tell the client to fall back to the LLM-skeleton path
    // (small towns are exactly where the model's local knowledge wins).
    if (activities.length < daysCount * 2 || restaurants.length < daysCount) {
      return res.status(200).json({ success: false, error: 'pool_too_small' });
    }

    // ── home base: resolve name-only hotels through the cache pipeline ──
    let resolvedHomeBase = null;
    if (homeBase?.name) {
      if (Number.isFinite(homeBase.lat) && Number.isFinite(homeBase.lng)) {
        resolvedHomeBase = { placeId: homeBase.placeId || null, name: homeBase.name, latitude: homeBase.lat, longitude: homeBase.lng };
      } else {
        try {
          const enriched = await getCachedPlaceDetails(homeBase.placeId || homeBase.name, false, requestId, { lat: dest.lat, lng: dest.lng }, homeBase.placeId || null);
          const lat = enriched?.geometry?.location?.lat, lng = enriched?.geometry?.location?.lng;
          if (Number.isFinite(lat) && Number.isFinite(lng)) resolvedHomeBase = { placeId: enriched.place_id || null, name: enriched.name || homeBase.name, latitude: lat, longitude: lng };
        } catch (e) { console.warn('pool homeBase resolution failed:', e.message); }
      }
    }
    const startPoint = resolvedHomeBase
      ? { lat: resolvedHomeBase.latitude, lng: resolvedHomeBase.longitude }
      : { lat: dest.lat, lng: dest.lng };

    // ── 2-3. cluster into day areas; day 1 = area nearest the hotel ──
    // How many activities actually fit in the day, rather than a fixed count.
    // The old `PACE_SLOTS.balanced - 2` (= 4) is what produced the dead
    // afternoon: 4 stops + lunch were done by ~14:30, dinner sat at 19:00.
    const hasBreakfast = !!(resolvedHomeBase && !hotelBreakfast);
    const startMinForDay = (resolvedHomeBase && hotelBreakfast) ? 9 * 60 + 30 : 9 * 60;
    const capacityOpts = { pace, nearby: !!nearbyMode, hasBreakfast, startMin: startMinForDay };
    const actsPerDay = activityCapacity(capacityOpts);
    const dayBudgetMin = DAY_END_MIN - startMinForDay;
    const seed = { latitude: startPoint.lat, longitude: startPoint.lng };

    // Excursion thresholds — shared by the pool-entry gate below and the
    // per-day quorum pass (4c).
    const EXC_OUT_KM    = nearbyMode ? 6 : 12;
    const EXC_QUORUM_KM = nearbyMode ? 3 : 6;

    // ── Pool-entry gate: a far place needs a BUDDY to even enter clustering.
    // The farthest-point k-means seeding otherwise hands every lone far pool
    // outlier its own centroid — i.e. its own day — which the thin-day top-up
    // then pads with one city stop, producing the recurring "one city stop +
    // one mountain 40 km away" day. Closing the hole at the source: beyond
    // EXC_OUT_KM of the seed, a place stays only if another pool place sits
    // within EXC_QUORUM_KM of it (a real excursion pair). Lone ones are cut
    // BEFORE clustering — not kept as leftovers, where a top-up would just
    // smuggle them back in.
    const gated = activities.filter(a =>
      distTo(seed, a) <= EXC_OUT_KM ||
      activities.some(b => b !== a && distTo(a, b) <= EXC_QUORUM_KM));
    if (gated.length < activities.length) {
      console.log(`[pool-build] excursion gate dropped ${activities.length - gated.length} lone far place(s)`);
    }
    if (gated.length < daysCount * 2) {
      // Gate left too little to compose from — same honest fallback as a
      // thin pool: the LLM-skeleton path handles sparse geographies better.
      return res.status(200).json({ success: false, error: 'pool_too_small' });
    }

    const clusters = clusterByDay(gated, daysCount, seed)
      .filter(c => c.length)
      .sort((a, b) => distTo(seed, centroidOf(a)) - distTo(seed, centroidOf(b)));
    while (clusters.length < daysCount) clusters.push([]);

    // ── 4. per-day selection + meals ──
    const usedRestaurants = new Set();
    const takeRestaurant = (near, filterFn = null) => {
      const cand = restaurants
        .filter(r => !usedRestaurants.has(r.placeId || r.name))
        .filter(r => !filterFn || filterFn(r));
      if (!cand.length) return null;
      const pick = cand.sort((a, b) =>
        (distTo(near, a) - placeScore(a) * 0.3) - (distTo(near, b) - placeScore(b) * 0.3))[0];
      usedRestaurants.add(pick.placeId || pick.name);
      return pick;
    };
    // One shared definition with the scheduler's adjacency guard (see
    // HEAVY_CATEGORIES) — the two used to disagree about museums and events.
    const isHeavyCat = isHeavyCategory;

    // Pick per cluster, keeping global leftovers for the thin-day top-up.
    //
    // COMPACTNESS-AWARE pick: score leads, but every pick after the first
    // pays a distance penalty from the day's emerging centroid. Why: the
    // k-means seeding makes peripheral clusters tight but leaves the CENTER
    // cluster (always sorted into day 1, nearest the hotel) as a wide
    // downtown catchment — and a pure score sort there happily selects
    // top-rated places from opposite edges of it, which the nearest-neighbor
    // scheduler then connects into the classic zigzag "day 1 route". The
    // penalty (1.2 score-points per km against a 3.5-11 score range) keeps
    // day 1 as compact as the outer days while barely changing tight
    // clusters, where distances — and so penalties — are small; a signature
    // partner (+6) can still justify a real detour.
    const leftovers = [];
    const pickedPerDay = clusters.slice(0, daysCount).map((cluster) => {
      const picked = [];
      const pool = [...cluster];
      while (picked.length < actsPerDay && pool.length) {
        const heavyFull = picked.filter(x => isHeavyCat(x._cat)).length >= 2;
        const ref = picked.length ? centroidOf(picked) : null;
        let bestI = -1, bestV = -Infinity;
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i];
          if (heavyFull && isHeavyCat(p._cat)) continue;
          const v = placeScore(p) - (ref ? distTo(ref, p) * 1.2 : 0);
          if (v > bestV) { bestV = v; bestI = i; }
        }
        if (bestI === -1) break;               // only heavy left, heavy is full
        picked.push(pool.splice(bestI, 1)[0]);
      }
      leftovers.push(...pool);                  // skipped + overflow, as before
      return picked;
    });
    // Thin-day top-up: a day needs ≥2 activities so breakfast, lunch and
    // dinner never end up back-to-back — walking from restaurant to
    // restaurant is exactly the plan this prevents. Nearest leftovers first,
    // so the borrowed stop stays plausible for the day's area.
    const MIN_ACTS = 2;
    for (const picked of pickedPerDay) {
      while (picked.length < MIN_ACTS && leftovers.length) {
        const ref = picked.length ? centroidOf(picked) : seed;
        leftovers.sort((a, b) => distTo(ref, a) - distTo(ref, b));
        picked.push(leftovers.shift());
      }
    }

    // ── 4c. Excursion quorum — no lone far outliers ─────────────────────────
    // The professional tour-planning rule: a satellite town must EARN the
    // drive. Two-plus far stops near each other form a legitimate half-day
    // excursion (the nearest-neighbor scheduler naturally runs them
    // back-to-back); a single stop 30-50 km out fails the cost/benefit test —
    // "4 places in Yerevan + 1 in Tsaghkadzor" is exactly the plan this
    // removes. Mechanism per day:
    //   1. find the day's CORE by trimmed centroid (recompute the centroid on
    //      in-range stops so one far outlier can't drag the center toward
    //      itself and hide);
    //   2. stops beyond OUTLIER_KM of the core are excursion candidates;
    //   3. candidates with a buddy within QUORUM_KM stay (real excursion);
    //      lone ones are swapped for the nearest in-range leftover when one
    //      exists, otherwise dropped (the dropped stop returns to leftovers,
    //      where a day whose core is actually near it may still adopt it).
    const OUTLIER_KM = EXC_OUT_KM;
    const QUORUM_KM  = EXC_QUORUM_KM;
    for (const picked of pickedPerDay) {
      if (picked.length < 2) continue;
      // 1. the day's core. Three-plus stops → trimmed centroid (two passes
      //    are enough for day-sized sets). TWO stops → the centroid is just
      //    their midpoint and both look like outliers of it, so anchor on the
      //    SEED (hotel/city centre) instead — the earlier < 3 guard skipped
      //    2-stop days entirely, which is exactly where the lone-mountain
      //    days lived (MIN_ACTS floors them at 2).
      let core;
      if (picked.length === 2) {
        core = seed;
      } else {
        let inliers = picked;
        for (let pass = 0; pass < 2; pass++) {
          const c = centroidOf(inliers);
          const next = picked.filter(p => distTo(c, p) <= OUTLIER_KM);
          if (next.length >= 2) inliers = next;
        }
        core = centroidOf(inliers);
      }
      const outliers = picked.filter(p => distTo(core, p) > OUTLIER_KM);
      if (!outliers.length) continue;
      for (const o of outliers) {
        // 2-3. quorum: a buddy outlier nearby makes it a real excursion
        const hasBuddy = outliers.some(x => x !== o && distTo(x, o) <= QUORUM_KM);
        if (hasBuddy) continue;
        picked.splice(picked.indexOf(o), 1);
        leftovers.push(o);
        // Swap in the nearest IN-RANGE leftover, respecting the heavy cap.
        // (The just-dropped outlier can't re-qualify — it is out of range by
        // definition, so no swap loop is possible.)
        const heavyFull = picked.filter(x => isHeavyCat(x._cat)).length >= 2;
        leftovers.sort((a, b) => distTo(core, a) - distTo(core, b));
        const subI = leftovers.findIndex(l =>
          distTo(core, l) <= OUTLIER_KM && (!heavyFull || !isHeavyCat(l._cat)));
        if (subI !== -1) picked.push(leftovers.splice(subI, 1)[0]);
      }
    }

    // ── 4d. Fill the day ────────────────────────────────────────────────────
    // Even after the cluster picks and the quorum pass, a day often still had
    // hours of nothing between lunch and dinner while dozens of perfectly good
    // pool places sat unused in `leftovers` — the pool routinely collects ~2x
    // what the old fixed count consumed. Keep pulling the nearest leftover
    // into any day that still has room in its time budget, so the afternoon is
    // actually planned instead of merely ending early.
    //
    // Guards: the pace cap still applies (a "relaxed" day stays relaxed), the
    // heavy-sight cap still applies, and a leftover further than the excursion
    // radius from the day's core is never dragged in — filling the day must
    // not undo the compactness the clustering just bought.
    const filled = fillDaysRoundRobin(pickedPerDay, leftovers, {
      actsPerDay, seed, maxKm: EXC_OUT_KM, dayBudgetMin, capacityOpts, isHeavy: isHeavyCat,
    });
    // Never let a short trip look like a full one silently — if the pool ran
    // out, say which days it cost.
    const totalAdded = filled.reduce((a, b) => a + b, 0);
    const thinDays = pickedPerDay.filter(p => p.length < actsPerDay).length;
    if (totalAdded || thinDays) {
      console.log(`[pool-build] fill: +${totalAdded} stop(s); ${thinDays} day(s) still under capacity (pool exhausted)`);
    }

    /* ── 4e. Excursion food gap → ask the client for a second pass ──────────
     * The restaurant pool is collected around the TRAVELER, so an excursion
     * day (Garni, Tsaghkadzor, …) has no local food in it at all — the
     * scheduler's detour rule then correctly defers the meal to the drive
     * home, but the traveler still spends a whole day out with nowhere to eat.
     * The real fix is to go and look for restaurants near the excursion, and
     * only the client can do that: quick-action-stream owns ranking, partner
     * tiers, community feedback and the place cache, and this endpoint is
     * deliberately free of Google calls.
     *
     * So it reports the gap and lets the client fill it — the same shape as
     * the existing `pool_too_small` handshake. Clustering runs on ACTIVITIES
     * only, so adding restaurants cannot change the clusters: the second pass
     * is guaranteed to compose the same days, just with somewhere to eat.
     *
     * `foodPass: true` on the retry stops this from ever looping: if the area
     * genuinely has no restaurants, the build proceeds and the detour rule
     * handles it.
     */
    if (!req.body?.foodPass) {
      const needFood = [];
      for (let i = 0; i < pickedPerDay.length; i++) {
        const picked = pickedPerDay[i];
        if (!picked.length) continue;
        const core = centroidOf(picked);
        if (distTo(seed, core) <= EXC_OUT_KM) continue;              // day stays in town
        const localFood = restaurants.some(r => distTo(core, r) <= mealDetourKm(!!nearbyMode));
        if (localFood) continue;                                      // already covered
        needFood.push({
          dayNumber: i + 1,
          lat: core.latitude, lng: core.longitude,
          radiusKm: Math.max(mealDetourKm(!!nearbyMode), 5),
        });
      }
      if (needFood.length) {
        console.log(`[pool-build] food gap on ${needFood.length} excursion day(s) — requesting a second pass`);
        return res.status(200).json({ success: false, error: 'food_gap', needFood });
      }
    }

    const days = pickedPerDay.map((picked, i) => {
      const center = picked.length ? centroidOf(picked) : seed;
      const slots = picked.map(p => slotFrom(p, p._cat));

      // Breakfast near the hotel — only when there IS a hotel and it doesn't
      // serve breakfast (leaving a hotel unfed is the exact bug this solves).
      if (resolvedHomeBase && !hotelBreakfast) {
        const hotelPt = { latitude: resolvedHomeBase.latitude, longitude: resolvedHomeBase.longitude };
        const b = takeRestaurant(hotelPt, r => BREAKFASTY.test(r.name)) || takeRestaurant(hotelPt);
        if (b) slots.push(slotFrom(b, 'cafe'));   // 'cafe' → the scheduler opens the day with it
      }
      // Lunch. On an excursion day (core far from town) the restaurant pool is
      // all back in the city, so "nearest to the day's centre" still means a
      // 30 km drive each way. Prefer a genuinely local place; when there is
      // none, deliberately pick the one closest to the ROUTE HOME instead of
      // the one closest to the excursion — the scheduler's detour rule will
      // then serve it on the way back rather than mid-excursion.
      const excursionDay = distTo(seed, center) > EXC_OUT_KM;
      const localLunch = takeRestaurant(center, r => distTo(center, r) <= mealDetourKm(!!nearbyMode));
      const lunch = localLunch || takeRestaurant(excursionDay ? seed : center);
      if (lunch) slots.push(slotFrom(lunch, 'restaurants'));
      // Dinner: minimize (distance from the day's area) + (distance to the
      // hotel, weighted) — a good last stop sits on the way home.
      const home = resolvedHomeBase ? { latitude: resolvedHomeBase.latitude, longitude: resolvedHomeBase.longitude } : center;
      const dCand = restaurants.filter(r => !usedRestaurants.has(r.placeId || r.name));
      if (dCand.length) {
        // On an excursion day the traveler ends up back in town, so the day's
        // far centre is the wrong thing to optimize against — weight the
        // journey home instead, and dinner lands where they actually are.
        const anchor = excursionDay ? home : center;
        const homeWeight = excursionDay ? 1.4 : 0.7;
        const pick = dCand.sort((a, b) =>
          (distTo(anchor, a) + distTo(home, a) * homeWeight - placeScore(a) * 0.3) -
          (distTo(anchor, b) + distTo(home, b) * homeWeight - placeScore(b) * 0.3))[0];
        usedRestaurants.add(pick.placeId || pick.name);
        slots.push(slotFrom(pick, 'restaurants'));
      }
      return { dayNumber: i + 1, title: dayTitle(slots, userLanguage), titleSource: 'auto', slots };
    });

    // ── 5. schedule (order + honest times), then persist ──
    for (const day of days) optimizeDayOrder(day, startPoint, !!nearbyMode, startMinForDay);
    pinDatedEvents(days, null);   // saved/pool events → real clock time (pool builds carry no trip dates, so time-only)
    const poolCostEstimate = await attachPricingAndEstimate(days, user?.settings?.currency || 'USD');

    // ── 5b. nicer day titles — one batched model call in the trip language.
    //  Hard 3s budget: on timeout/failure the algorithmic titles above ship,
    //  so the build never hangs and days are never blank.
    try {
      const titles = await Promise.race([
        generateDayTitles(days, dest.name, userLanguage),
        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
      ]);
      if (titles) {
        days.forEach((d, i) => {
          if (titles[i]) { d.title = titles[i]; d.titleSource = 'ai'; }
        });
      }
    } catch (_) { /* fallback titles already in place */ }

    const doc = await Itinerary.create({
      userId: req.user.id,
      destination: dest,
      startDate: null,
      daysCount,
      pace,
      interests: [],
      nearbyMode: !!nearbyMode,
      radiusKm,
      // Persist the whole-trip budget so a later day-regeneration (which uses
      // the skeleton planner) plans to the same budget. The pool places
      // themselves already respect the user's per-place preference budget from
      // the quick-actions that gathered them.
      ...(tripBudget && Number(tripBudget.total) > 0 ? { tripBudget: {
        total: Number(tripBudget.total),
        currency: String(tripBudget.currency || 'USD').toUpperCase().slice(0, 3),
        people: Math.max(1, parseInt(tripBudget.people, 10) || 1),
      } } : {}),
      ...(poolCostEstimate ? { costEstimate: poolCostEstimate } : {}),
      homeBase: resolvedHomeBase,
      days,
      status: 'ready',
      language: userLanguage,
      title: `${dest.name} \u2014 ${daysCount} ${daysCount === 1 ? 'day' : 'days'}`,
    });

    return res.json({ success: true, itinerary: doc.toObject() });
  } catch (error) {
    console.error(`[${requestId}] pool build failed:`, error);
    return res.status(500).json({ success: false, error: 'pool_build_failed' });
  }
});

/* ═══════════════════════ CRUD (no AI cost) ═══════════════════════ */

router.get('/', auth, async (req, res) => {
  const list = await Itinerary.find({ userId: req.user.id })
    .sort({ updatedAt: -1 }).limit(20)
    .select('title destination daysCount startDate status updatedAt').lean();
  res.json({ success: true, itineraries: list });
});

router.get('/:id', auth, async (req, res) => {
  // Owner-scoped by default. Admins may READ any itinerary — the admin chat
  // transcript viewer restores itineraries by id — but this exception is
  // read-only: PATCH/DELETE below keep the strict userId filter.
  const isAdmin = req.user?.isAdmin === true || req.user?.role === 'admin';
  const query = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId: req.user.id };
  const doc = await Itinerary.findOne(query).lean();
  if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
  // A server restart mid-generation can strand status:'generating'. Anything
  // older than 3 minutes is definitely not still streaming — downgrade so the
  // UI shows what exists instead of an infinite spinner.
  if (doc.status === 'generating' && Date.now() - new Date(doc.updatedAt).getTime() > 3 * 60 * 1000) {
    doc.status = 'ready';
    Itinerary.updateOne({ _id: doc._id }, { status: 'ready' }).catch(() => {});
  }
  res.json({ success: true, itinerary: doc });
});

router.delete('/:id', auth, async (req, res) => {
  await Itinerary.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ success: true });
});

/* ── Saved places → add-stop candidates ────────────────────────────────────── */

// snapshot.type / snapshot.category (display strings like "Restaurant",
// "Hidden Gem") → an itinerary slot category. Keyword match, VALID_CATEGORIES-
// guarded; anything unrecognisable lands as 'hidden_gems'.
const SNAPSHOT_CATEGORY_RULES = [
  [/restaurant|food|dining|taverna|grill|steak|pizz|sushi|meze/i, 'restaurants'],
  [/caf\u00e9|cafe|coffee|bakery|brunch|dessert/i, 'cafe'],
  [/museum|gallery/i, 'museum'],
  [/histor|monaster|church|cathedral|castle|fortress|temple|mosque|ruin|heritage|archaeolog/i, 'historical'],
  [/event|concert|festival|show|nightlife/i, 'events'],
  [/photo|view|panoram|lookout|sunset/i, 'photo_spots'],
  [/shop|market|bazaar|mall|boutique|souvenir|jewel/i, 'shopping'],
  [/nature|park|garden|beach|waterfall|lake|trail|hik|forest/i, 'nature'],
];
function snapshotToCategory(snap) {
  const hay = `${snap?.type || ''} ${snap?.category || ''}`;
  for (const [re, cat] of SNAPSHOT_CATEGORY_RULES) {
    if (re.test(hay) && VALID_CATEGORIES.has(cat)) return cat;
  }
  return 'hidden_gems';
}

/**
 * GET /:id/saved-candidates — the user's saved places, made itinerary-ready
 * for THIS trip. Feeds the "From saved" option of the add-stop chooser.
 *
 * Pipeline per save (bounded concurrency, one bad save never sinks the list):
 *   1. Skip anything already on the trip (placeId or name match).
 *   2. Coordinates: snapshot.latitude/longitude when present (newer saves —
 *      JinniChat now writes them at save-time); otherwise resolve through the
 *      SAME PlaceCache-first pipeline enrichment uses (getCachedPlaceDetails,
 *      keyed by googlePlaceId when available). Usually free: the place was
 *      cached when its card was first shown.
 *   3. Geofence to the trip: farther than the itinerary radius → dropped
 *      (a caf\u00e9 saved in another country is noise here, not a candidate).
 *   4. Emit a quick-action-rec–shaped object + `suggestedCategory`, so the
 *      frontend's existing rich candidate cards and the addSlot PATCH op
 *      consume it with zero changes.
 */
router.get('/:id/saved-candidates', auth, usageTracker, async (req, res) => {
  try {
    const doc = await Itinerary.findOne({ _id: req.params.id, userId: req.user.id }).lean();
    if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
    const dest = doc.destination;
    if (!dest || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)) {
      return res.json({ success: true, candidates: [] });
    }
    const maxKm = Number.isFinite(doc.radiusKm) && doc.radiusKm > 0 ? doc.radiusKm : MAX_STOP_KM;

    // Everything already on the trip is excluded up front.
    const usedPlaceIds = new Set();
    const usedNames = new Set();
    for (const d of doc.days || []) for (const s of d.slots || []) {
      if (s.place?.placeId) usedPlaceIds.add(s.place.placeId);
      const n = (s.place?.name || s.name || '').toLowerCase().trim();
      if (n) usedNames.add(n);
    }

    const saves = await SavedPlace.find({ userId: req.user.id })
      .sort({ savedAt: -1 }).limit(100).lean();
    const queue = saves.filter(s => {
      if (s.googlePlaceId && usedPlaceIds.has(s.googlePlaceId)) return false;
      const n = (s.snapshot?.name || '').toLowerCase().trim();
      return n && !usedNames.has(n);
    });

    const requestId = `saved-cand-${req.params.id}`;
    const { getCachedPlaceDetails } = aiShared();
    const out = [];
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const s = queue[cursor++];
        const snap = s.snapshot || {};
        try {
          let place = null;
          if (Number.isFinite(snap.latitude) && Number.isFinite(snap.longitude)) {
            // Fast path — the snapshot carries coordinates.
            place = {
              placeId: s.googlePlaceId || null,
              // DB identity — a saved VERIFIED place has googlePlaceId=null,
              // so without these the candidate has no saveable identity at
              // all and the ribbon is hidden the moment it's added.
              verifiedId: s.verifiedId ? String(s.verifiedId) : null,
              verifiedModel: s.verifiedModel || null,
              partnerTier: snap.partnerTier || null,
              name: snap.name, image: snap.image || null,
              latitude: snap.latitude, longitude: snap.longitude,
              location: snap.address || snap.location || null,
              region: snap.location || null,
              website: snap.website || null, phone: null,
              rating: Number.isFinite(snap.rating) ? snap.rating : null,
              description: snap.description || null,
            };
          } else {
            // Legacy snapshot — PlaceCache-first resolution, Google only on miss.
            const enriched = await getCachedPlaceDetails(
              s.googlePlaceId || snap.name, false, requestId,
              { lat: dest.lat, lng: dest.lng },
              s.googlePlaceId || null,
            );
            place = buildPlace(enriched);
            if (place) {
              // DB identity — same reason as the fast path above.
              place.verifiedId = s.verifiedId ? String(s.verifiedId) : null;
              place.verifiedModel = s.verifiedModel || null;
              place.partnerTier = snap.partnerTier || null;
              // Keep the save's own copy where Google gave nothing back.
              place.description = place.description || snap.description || null;
              place.image = place.image || snap.image || null;
              if (!Number.isFinite(place.rating) && Number.isFinite(snap.rating)) place.rating = snap.rating;
            }
          }
          if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
          if (place.placeId && usedPlaceIds.has(place.placeId)) continue;

          const distanceKm = haversineKm(dest.lat, dest.lng, place.latitude, place.longitude);
          if (distanceKm > maxKm) continue;   // saved in another city → not this trip

          out.push({
            ...place,
            // A saved EVENT keeps its schedule (SavedPlace stores it) so the
            // itinerary can pin it to its real day + time, not a made-up one.
            eventSchedule: (snap.eventSchedule && snap.eventSchedule.startDate) ? snap.eventSchedule : (place.eventSchedule || null),
            id: `saved-${s._id}`,
            savedPlaceId: String(s._id),
            distanceKm: Math.round(distanceKm * 10) / 10,
            distance: distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`,
            suggestedCategory: snapshotToCategory(snap),
          });
        } catch (e) { console.warn(`saved-candidate skipped ("${snap.name}"):`, e.message); }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));

    // This route resolves up to 100 saved places through the same
    // PlaceCache-first Google pipeline as enrichment, and used to do it with
    // no usage gate at all — a completely unmetered place-lookup path. Charge
    // AFTER the fact (unlike the streaming routes, which pre-authorize),
    // because the count is only known once the geofence has run. Never fails
    // the request: the user already owns these saves, so the worst outcome of
    // a breach is that the NEXT call is refused.
    if (req.userLimit && out.length) {
      try {
        await req.userLimit.checkAndUpdateUsage(0, out.length, 1);
      } catch (limitErr) {
        console.warn('[itinerary] saved-candidates usage charge refused:', limitErr.message);
      }
    }

    out.sort((a, b) => a.distanceKm - b.distanceKm);
    res.json({ success: true, candidates: out.slice(0, 24) });
  } catch (error) {
    console.error('saved-candidates failed:', error);
    res.status(500).json({ success: false, error: 'saved_candidates_failed' });
  }
});

/**
 * PATCH /:id — structural edits. Body: { op, ...args }.
 * Ops:
 *   removeSlot   { dayNumber, slotId }
 *   moveSlot     { dayNumber, slotId, direction: -1|1 }            (reorder within a day)
 *   moveSlotToDay{ dayNumber, slotId, toDay }                      (appends to target day)
 *   updateSlot   { dayNumber, slotId, time?, note? }
 *   toggleLock   { dayNumber, slotId }
 *   replaceSlot  { dayNumber, slotId, place, name?, category? }    (place = a quick-action rec card)
 *   addSlot      { dayNumber, place, time?, category? }            (insert a picked rec as a new stop)
 *   setHomeBase  { homeBase: {placeId,name,lat,lng} | null }
 *   rename       { title }
 *   renameDay    { dayNumber, title }   — empty title reverts to auto
 */
router.patch('/:id', auth, async (req, res) => {
  try {
    const doc = await Itinerary.findOne({ _id: req.params.id, userId: req.user.id });
    if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
    const { op } = req.body || {};

    const findDay = (n) => doc.days.find(d => d.dayNumber === Number(n));
    const findSlot = (day, slotId) => day?.slots.find(s => s.slotId === slotId);
    const reindex = (day) => day.slots.forEach((s, i) => { s.order = i; });
    // Days whose CONTENT changed — after the switch, any of these still on an
    // 'auto' title gets it recomputed so titles never go stale. 'ai' titles
    // hold until day regeneration; 'user' titles are never touched.
    const retitle = new Set();

    // Partner tiers on incoming rec cards are re-read from the DB, never
    // trusted as sent (see trustedTierMap). Resolved once up front so the ops
    // below stay synchronous.
    const opTiers = await trustedTierMap([req.body?.place?.verifiedId, req.body?.place?._verifiedId]);

    // A rec card from quick-action-stream → our PlaceSchema shape.
    const recToPlace = (r) => applyTrustedTier({
      placeId: r.placeId || null,
      // DB identity — verified recs carry verifiedId + _verifiedModel (the
      // rec-card spelling); saved-candidate recs carry verifiedModel. Copy
      // both through or the save ribbon dies on verified stops.
      verifiedId: r.verifiedId ? String(r.verifiedId) : null,
      verifiedModel: r.verifiedModel || r._verifiedModel || null,
      partnerTier: r.partnerTier || null,
      name: r.name || null, image: r.image || null,
      latitude: r.latitude ?? null, longitude: r.longitude ?? null,
      location: r.location || null, region: r.region || null,
      website: r.website || null, phone: r.phone || null,
      rating: Number.isFinite(r.rating) ? r.rating : null,
      description: r.description || null,
    }, opTiers);

    // ── Time integrity after structural edits ────────────────────────────
    // moveSlot / moveSlotToDay used to splice the array and carry the slot's
    // OLD time label with it — a 09:30 stop moved after an 18:00 stop still
    // said 09:30, and neither day's schedule was recalculated. Times belong
    // to the schedule, not to the slot: every day touched by a structural
    // edit gets its clock re-walked (in the user's chosen order) before save.
    // Read AFTER the switch, not before: setHomeBase moves this very anchor,
    // and a value captured up front would re-walk every clock from the old one.
    const dayStartPoint = () =>
      (doc.homeBase && Number.isFinite(doc.homeBase.latitude) && Number.isFinite(doc.homeBase.longitude))
        ? { lat: doc.homeBase.latitude, lng: doc.homeBase.longitude }
        : { lat: doc.destination.lat, lng: doc.destination.lng };
    const touchedDays = new Set();

    switch (op) {
      case 'removeSlot': {
        const day = findDay(req.body.dayNumber);
        if (!day) return res.status(400).json({ success: false, error: 'bad_day' });
        day.slots = day.slots.filter(s => s.slotId !== req.body.slotId);
        reindex(day);
        touchedDays.add(day);
        retitle.add(day);
        break;
      }
      case 'moveSlot': {
        const day = findDay(req.body.dayNumber);
        const idx = day ? day.slots.findIndex(s => s.slotId === req.body.slotId) : -1;
        const to = idx + (Number(req.body.direction) === -1 ? -1 : 1);
        if (idx === -1 || to < 0 || to >= day.slots.length) return res.status(400).json({ success: false, error: 'bad_move' });
        const [s] = day.slots.splice(idx, 1);
        day.slots.splice(to, 0, s);
        reindex(day);
        touchedDays.add(day);
        break;
      }
      case 'moveSlotToDay': {
        const from = findDay(req.body.dayNumber);
        const idx = from ? from.slots.findIndex(s => s.slotId === req.body.slotId) : -1;
        if (idx === -1) return res.status(400).json({ success: false, error: 'bad_move' });
        let to = findDay(req.body.toDay);
        // "+ New day": moving to exactly one past the last existing day CREATES
        // it (hard cap 10 — the UI's DAY_COLORS palette depth). The trip grows
        // organically: "too much for 2 days" spills into a 3rd. daysCount is
        // bumped so the date-range label extends with it.
        if (!to) {
          const maxDay = doc.days.reduce((m, d) => Math.max(m, d.dayNumber), 0);
          if (Number(req.body.toDay) === maxDay + 1 && maxDay < 10) {
            doc.days.push({ dayNumber: maxDay + 1, title: '', slots: [] });
            to = findDay(maxDay + 1);   // re-find: push() stores a subdoc COPY
            doc.daysCount = Math.max(doc.daysCount || 0, maxDay + 1);
          }
        }
        if (!to) return res.status(400).json({ success: false, error: 'bad_move' });
        const [s] = from.slots.splice(idx, 1);
        to.slots.push(s);
        reindex(from); reindex(to);
        touchedDays.add(from); touchedDays.add(to);
        retitle.add(from); retitle.add(to);
        break;
      }
      case 'updateSlot': {
        const slot = findSlot(findDay(req.body.dayNumber), req.body.slotId);
        if (!slot) return res.status(400).json({ success: false, error: 'bad_slot' });
        if (req.body.time !== undefined) slot.time = /^\d{1,2}:\d{2}$/.test(String(req.body.time || '')) ? String(req.body.time) : null;
        if (req.body.note !== undefined) slot.note = String(req.body.note || '').slice(0, 200);
        break;
      }
      case 'toggleLock': {
        const slot = findSlot(findDay(req.body.dayNumber), req.body.slotId);
        if (!slot) return res.status(400).json({ success: false, error: 'bad_slot' });
        slot.locked = !slot.locked;
        break;
      }
      case 'replaceSlot': {
        const day = findDay(req.body.dayNumber);
        const slot = findSlot(day, req.body.slotId);
        if (!slot || !req.body.place) return res.status(400).json({ success: false, error: 'bad_replace' });
        retitle.add(day);
        slot.place = recToPlace(req.body.place);
        slot.name = req.body.place.name || slot.name;
        if (req.body.category && VALID_CATEGORIES.has(req.body.category)) slot.category = req.body.category;
        slot.status = 'enriched';
        slot.locked = true;   // an explicit user pick is a kept pick
        // Times belong to the schedule, not to the slot (see the note above) —
        // and this was the one structural op that skipped the re-walk, so a
        // stop swapped for one across town kept the old stop's clock.
        touchedDays.add(day);
        break;
      }
      case 'addSlot': {
        const day = findDay(req.body.dayNumber);
        if (!day || !req.body.place) return res.status(400).json({ success: false, error: 'bad_add' });
        day.slots.push({
          slotId: newSlotId(), order: day.slots.length,
          time: /^\d{1,2}:\d{2}$/.test(String(req.body.time || '')) ? String(req.body.time) : null,
          name: req.body.place.name || 'Stop',
          category: VALID_CATEGORIES.has(req.body.category) ? req.body.category : 'hidden_gems',
          note: '', locked: true, status: 'enriched', place: recToPlace(req.body.place),
        });
        // No explicit time from the client → schedule it honestly (appended
        // stop gets a slot after the day's last time instead of "no time").
        // An explicit time is a user choice — leave the whole day untouched.
        if (!/^\d{1,2}:\d{2}$/.test(String(req.body.time || ''))) touchedDays.add(day);
        retitle.add(day);
        break;
      }
      case 'setHomeBase': {
        // The documented body uses {lat,lng}; PlaceSchema stores
        // {latitude,longitude}. Assigning the raw body let Mongoose strip the
        // coordinates in strict mode, leaving a name-only anchor — so day
        // scheduling silently fell back to the city centre. Map explicitly.
        const hb = req.body.homeBase;
        if (!hb?.name) {
          doc.homeBase = null;
        } else {
          const lat = Number(hb.latitude ?? hb.lat);
          const lng = Number(hb.longitude ?? hb.lng);
          doc.homeBase = {
            placeId: hb.placeId || null,
            name: String(hb.name).slice(0, 120),
            latitude: Number.isFinite(lat) ? lat : null,
            longitude: Number.isFinite(lng) ? lng : null,
          };
        }
        // The anchor moved, so every day's route and clock changes with it.
        for (const d of doc.days) touchedDays.add(d);
        break;
      }
      case 'rename': {
        doc.title = String(req.body.title || '').slice(0, 120) || doc.title;
        break;
      }
      case 'renameDay': {
        const day = findDay(req.body.dayNumber);
        if (!day) return res.status(400).json({ success: false, error: 'bad_day' });
        const t = String(req.body.title || '').trim().slice(0, 60);
        if (t) {
          day.title = t;
          day.titleSource = 'user';        // hands off from now on
        } else {
          // Cleared → hand the title back to the machine immediately.
          day.titleSource = 'auto';
          day.title = dayTitle(day.slots, doc.language);
        }
        break;
      }
      default:
        return res.status(400).json({ success: false, error: 'unknown_op' });
    }

    // ── Self-cleaning days ───────────────────────────────────────────────
    // Days are created by moving a stop into them ("+ Day N") but there is no
    // delete-day UI — instead, TRAILING empty days evaporate after every edit.
    // Move the last stop out of a spilled-over day and the day disappears with
    // it; daysCount (and so the header date range) shrinks back too. Only
    // trailing days are pruned: an emptied day in the MIDDLE must stay, since
    // renumbering would silently shift every later day's date and colour.
    while (doc.days.length > 1 && doc.days[doc.days.length - 1].slots.length === 0) {
      doc.days.pop();
    }
    doc.daysCount = Math.max(1, doc.days.reduce((m, d) => Math.max(m, d.dayNumber), 1));

    // Re-walk the clock over every day a structural edit touched. Note: a
    // trailing day pruned by the self-clean above may sit in touchedDays as a
    // detached subdoc — recomputing it is a harmless no-op (empty slots).
    const anchor = dayStartPoint();
    for (const d of touchedDays) recomputeDayTimes(d, anchor, !!doc.nearbyMode);

    // Refresh machine-written titles on content-changed days (pruned trailing
    // days may sit in the set as detached subdocs — harmless no-ops).
    for (const d of retitle) {
      if (!d || d.titleSource === 'user' || d.titleSource === 'ai') continue;
      d.title = dayTitle(d.slots, doc.language);
    }

    doc.markModified('days');
    await doc.save();
    res.json({ success: true, itinerary: doc.toObject() });
  } catch (error) {
    // Someone else wrote this itinerary between our read and our save (another
    // tab, or a day regeneration finishing). Say so instead of pretending the
    // edit landed — the client re-reads and replays.
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, error: 'conflict' });
    }
    console.error('Itinerary PATCH failed:', error);
    res.status(500).json({ success: false, error: 'patch_failed' });
  }
});

// ── POST /:id/slot-feedback ──────────────────────────────────────────────────
// Like/dislike a single itinerary stop. Mirrors aiRoutes' /feedback semantics
// for rec cards, adapted to slots (which live in the Itinerary doc, not in a
// ChatSession message):
//
//   Body: { dayNumber, slotId, feedback: 'like' | 'dislike' | null }
//
//   1. slot.feedback is the source of truth; same-value calls are no-ops so
//      counters can't be spam-inflated from multiple tabs.
//   2. Community counters: slots are enriched from PlaceCache/Google, so the
//      delta lands on PlaceCache.likes/dislikes (slots carry no verifiedId).
//   3. Per-user vote: upserted into PlaceFeedback keyed by the Google placeId
//      and the slot's category mapped to its quick-action. That row is what
//      quick-action-stream and findCachedBackfill already read — so a dislike
//      here immediately hides the place from "find replacement" candidates,
//      backfill, and (via loadDislikedNames above) future itinerary skeletons.
//
// Slots without a Google placeId (failed / never enriched) can still store a
// vote on the slot itself, but there is no place record to count or hide —
// the frontend only shows the buttons on enriched slots anyway.
router.post('/:id/slot-feedback', auth, async (req, res) => {
  try {
    const { dayNumber, slotId, feedback } = req.body || {};
    if (feedback !== null && !['like', 'dislike'].includes(feedback)) {
      return res.status(400).json({ success: false, error: 'feedback must be "like", "dislike", or null' });
    }
    const doc = await Itinerary.findOne({ _id: req.params.id, userId: req.user.id });
    if (!doc) return res.status(404).json({ success: false, error: 'not_found' });

    const day = doc.days.find(d => d.dayNumber === Number(dayNumber));
    const slot = day?.slots.find(s => s.slotId === slotId);
    if (!slot) return res.status(400).json({ success: false, error: 'bad_slot' });

    const previous = slot.feedback ?? null;
    if (previous === feedback) return res.json({ success: true, noop: true });

    // 1. Persist on the slot. A vote is a tiny, order-independent write, so a
    //    concurrent edit elsewhere in the document should not lose it —
    //    re-read and re-apply once rather than surfacing a conflict.
    slot.feedback = feedback;
    doc.markModified('days');
    try {
      await doc.save();
    } catch (err) {
      if (err?.name !== 'VersionError') throw err;
      const fresh = await Itinerary.findOne({ _id: req.params.id, userId: req.user.id });
      const freshSlot = fresh?.days.find(d => d.dayNumber === Number(dayNumber))?.slots.find(s => s.slotId === slotId);
      if (!freshSlot) return res.status(409).json({ success: false, error: 'conflict' });
      freshSlot.feedback = feedback;
      fresh.markModified('days');
      await fresh.save();
    }

    const placeId = slot.place?.placeId || null;

    // 2. Community counters (PlaceCache) — delta so switching sides is exact.
    if (placeId) {
      const likesDelta    = (feedback === 'like' ? 1 : 0) - (previous === 'like' ? 1 : 0);
      const dislikesDelta = (feedback === 'dislike' ? 1 : 0) - (previous === 'dislike' ? 1 : 0);
      if (likesDelta !== 0 || dislikesDelta !== 0) {
        const inc = {};
        if (likesDelta !== 0)    inc.likes    = likesDelta;
        if (dislikesDelta !== 0) inc.dislikes = dislikesDelta;
        await PlaceCache.findOneAndUpdate({ placeId }, { $inc: inc }).catch(() => {});
      }

      // 3. Per-user current vote (PlaceFeedback) — the personalization hook.
      const action = slotVoteAction(slot.category);
      const name = slot.place?.name || slot.name || '';
      try {
        if (feedback === 'like' || feedback === 'dislike') {
          await PlaceFeedback.updateOne(
            { userId: req.user.id, placeId, action },
            { $set: { vote: feedback, name }, $setOnInsert: { userId: req.user.id, placeId, action } },
            { upsert: true }
          );
        } else { // vote cleared
          await PlaceFeedback.deleteOne({ userId: req.user.id, placeId, action });
        }
      } catch (pfErr) {
        if (pfErr.code !== 11000) console.warn('[itinerary] PlaceFeedback sync failed:', pfErr.message);
      }
    }

    res.json({ success: true, feedback });
  } catch (error) {
    console.error('Itinerary slot-feedback failed:', error);
    res.status(500).json({ success: false, error: 'feedback_failed' });
  }
});

module.exports = router;

// ── Test surface ────────────────────────────────────────────────────────────
// The scheduling and composition helpers above are pure, deterministic and do
// no I/O — which makes them the highest-value thing in this file to test, and
// they were previously unreachable from a test. Exported here (same pattern as
// aiRoutes' `.shared`) rather than moved, to keep this change reviewable; the
// natural follow-up is to lift them into services/itinerarySchedule.js.
module.exports.__testables = {
  PACE_SLOTS, DWELL_MIN, DAY_START_MIN, DAY_END_MIN, LUNCH, DINNER,
  MAX_IDLE_MIN, DINNER_FLOOR, HEAVY_CATEGORIES, HUNGER_LIMIT, mealDetourKm,
  mealStart, activityCapacity, projectedDayMinutes, isHeavyCategory,
  optimizeDayOrder, recomputeDayTimes, improveActivityRuns,
  haversineKm, travelMinutes, dwellOf, ratingScore, placeScore,
  sanitizeSkeleton, extractJson, clusterByDay, normalizeHours,
  fillDaysRoundRobin, centroidOf, distTo,
};