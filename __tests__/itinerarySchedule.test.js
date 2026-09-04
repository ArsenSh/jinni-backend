/**
 * Scheduling + composition tests for itineraryRoutes.
 *
 * These cover the pure, deterministic core: the day scheduler, the meal-window
 * rules, day capacity, rating confidence and skeleton sanitation. Every case
 * below corresponds to a real reported behaviour — most importantly the
 * "5 stops done by 14:30, dinner at 19:00" dead-afternoon bug, which is what
 * the `no dead afternoon` block guards against.
 */

const {
  DWELL_MIN, DAY_START_MIN, LUNCH, DINNER, MAX_IDLE_MIN, DINNER_FLOOR,
  PACE_SLOTS, HUNGER_LIMIT, mealStart, activityCapacity, projectedDayMinutes,
  isHeavyCategory, optimizeDayOrder, recomputeDayTimes,
  haversineKm, ratingScore, sanitizeSkeleton, extractJson, normalizeHours,
  fillDaysRoundRobin, centroidOf, distTo, decoratePhotoSpots,
} = require('../routes/itineraryRoutes').__testables;

/* ── helpers ─────────────────────────────────────────────────────────────── */

let seq = 0;
const stop = (category, latitude, longitude) => ({
  slotId: `s${++seq}`, category, status: 'enriched', order: 0, locked: false,
  place: { latitude, longitude, name: `${category}-${seq}` },
});

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Every stretch between one stop ending and the next beginning. This INCLUDES
 *  travel, which is not idle time — hence TRAVEL_ALLOWANCE below. */
function idleGaps(day) {
  const gaps = [];
  let prevEnd = null;
  for (const s of day.slots) {
    if (!s.time) continue;
    const t = toMin(s.time);
    if (prevEnd !== null) gaps.push(t - prevEnd);
    prevEnd = t + (DWELL_MIN[s.category] || 45);
  }
  return gaps;
}
const TRAVEL_ALLOWANCE = 30;                    // generous city hop
const ACCEPTABLE_GAP = MAX_IDLE_MIN + TRAVEL_ALLOWANCE;

const dinnerTime = (day) => {
  const meals = day.slots.filter(s => s.category === 'restaurants' && s.time)
    .map(s => toMin(s.time)).sort((a, b) => a - b);
  return meals[meals.length - 1];
};

/** A realistic compact city-centre day: hotel + N stops a few hundred m apart. */
const HOTEL = { lat: 40.1792, lng: 44.4991 };
const centreDay = (categories) => ({
  slots: categories.map((c, i) => stop(
    c,
    40.1750 + (i % 4) * 0.0035,
    44.5090 + (i % 3) * 0.0040,
  )),
});

/* ── mealStart: the fix at the heart of the gap bug ───────────────────────── */

describe('mealStart', () => {
  test('arriving after the window opens eats immediately', () => {
    expect(mealStart(DINNER.start + 40, DINNER.start, DINNER_FLOOR)).toBe(DINNER.start + 40);
  });

  test('a short early arrival waits for the window', () => {
    expect(mealStart(DINNER.start - 30, DINNER.start, DINNER_FLOOR)).toBe(DINNER.start);
  });

  test('a long early arrival slides dinner earlier instead of idling', () => {
    const arrive = 14 * 60 + 40;                       // 14:40 — the reported case
    const t = mealStart(arrive, DINNER.start, DINNER_FLOOR);
    expect(t).toBeLessThan(DINNER.start);              // no longer pinned to 19:00
    expect(t).toBe(DINNER_FLOOR);                      // pulled as early as allowed
  });

  test('a moderate early arrival waits only MAX_IDLE_MIN', () => {
    // Above the floor, the idle cap governs: arrive 18:00 → eat 19:00 is a
    // 60-minute wait, which is normal travel rhythm rather than a hole.
    const arrive = 18 * 60;
    expect(mealStart(arrive, DINNER.start, DINNER_FLOOR) - arrive).toBeLessThanOrEqual(MAX_IDLE_MIN);
  });

  test('dinner never slides below the floor', () => {
    expect(mealStart(10 * 60, DINNER.start, DINNER_FLOOR)).toBeGreaterThanOrEqual(DINNER_FLOOR);
  });

  test('lunch keeps its window and is never moved earlier', () => {
    expect(mealStart(10 * 60 + 30, LUNCH.start, LUNCH.start)).toBe(LUNCH.start);
    expect(mealStart(11 * 60 + 55, LUNCH.start, LUNCH.start)).toBe(LUNCH.start);
  });
});

/* ── the regression this whole change exists for ──────────────────────────── */

describe('optimizeDayOrder — no dead afternoon', () => {
  test('the reported thin day no longer pins dinner to 19:00', () => {
    // Exactly the shape that produced "5 stops ending 14:30, dinner at 19:00".
    // Four activities genuinely cannot fill a day — the composition layer
    // (activityCapacity + the fill pass) is what prevents days this thin. What
    // the SCHEDULER must guarantee is that it stops making the hole worse.
    const day = centreDay([
      'historical', 'hidden_gems', 'photo_spots', 'shopping',
      'restaurants', 'restaurants',
    ]);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    expect(dinnerTime(day)).toBe(DINNER_FLOOR);              // 17:30, was 19:00
    expect(Math.max(...idleGaps(day))).toBeLessThan(3 * 60); // was 4h30
  });

  test('a day filled to the balanced capacity has no hole at all', () => {
    // This is the shape the pool builder now produces: activityCapacity()
    // activities plus two meals, instead of the old fixed four.
    const acts = ['historical', 'museum', 'hidden_gems', 'photo_spots', 'shopping', 'nature']
      .slice(0, activityCapacity({ pace: 'balanced' }));
    const day = centreDay([...acts, 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    expect(Math.max(...idleGaps(day))).toBeLessThanOrEqual(ACCEPTABLE_GAP);
    expect(dinnerTime(day)).toBeGreaterThanOrEqual(DINNER_FLOOR);
  });

  test('lunch still lands inside its window', () => {
    const day = centreDay(['historical', 'hidden_gems', 'photo_spots', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const meals = day.slots.filter(s => s.category === 'restaurants' && s.time)
      .map(s => toMin(s.time)).sort((a, b) => a - b);
    expect(meals[0]).toBeGreaterThanOrEqual(LUNCH.start);
    expect(meals[0]).toBeLessThanOrEqual(LUNCH.end);
  });

  test('dinner still lands in the evening, not the afternoon', () => {
    const day = centreDay(['historical', 'hidden_gems', 'photo_spots', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const meals = day.slots.filter(s => s.category === 'restaurants' && s.time)
      .map(s => toMin(s.time)).sort((a, b) => a - b);
    expect(meals[1]).toBeGreaterThanOrEqual(DINNER_FLOOR);
  });

  test('times are non-decreasing across the scheduled day', () => {
    const day = centreDay(['museum', 'historical', 'hidden_gems', 'shopping', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const times = day.slots.filter(s => s.time).map(s => toMin(s.time));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  });

  test('order indexes are contiguous from zero', () => {
    const day = centreDay(['historical', 'hidden_gems', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    expect(day.slots.map(s => s.order)).toEqual(day.slots.map((_, i) => i));
  });

  test('unenriched slots keep their place but carry no time', () => {
    const day = centreDay(['historical', 'hidden_gems', 'restaurants', 'restaurants']);
    day.slots.push({ slotId: 'failed-1', category: 'museum', status: 'failed', place: null, order: 99 });
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const failed = day.slots.find(s => s.slotId === 'failed-1');
    expect(failed).toBeDefined();
    expect(failed.time).toBeFalsy();
  });

  test('meals are never served within two hours of each other', () => {
    // The real rule is about the CLOCK, not the list: on a thin day lunch and
    // dinner can end up adjacent in sequence, which is fine as long as hours
    // separate them. Walking straight from one restaurant to another is not.
    const day = centreDay(['historical', 'hidden_gems', 'photo_spots', 'cafe', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const foodTimes = day.slots
      .filter(s => s.time && (s.category === 'restaurants' || s.category === 'cafe'))
      .map(s => toMin(s.time)).sort((a, b) => a - b);
    for (let i = 1; i < foodTimes.length; i++) {
      expect(foodTimes[i] - foodTimes[i - 1]).toBeGreaterThanOrEqual(120);
    }
  });
});

/* ── excursion days: no driving back to town just to eat ─────────────────── */

describe('optimizeDayOrder — excursion meal geography', () => {
  const YEREVAN = { lat: 40.1792, lng: 44.4991 };
  const named = (category, latitude, longitude, name) => ({
    slotId: `x${++seq}`, category, status: 'enriched', order: 0,
    place: { latitude, longitude, name },
  });
  // Garni/Geghard sit ~21-27 km east of Yerevan; the restaurant pool is
  // collected around the traveler's city, so every restaurant is back in town.
  const excursionDay = () => ({ slots: [
    named('historical',  40.1122, 44.7300, 'Garni Temple'),
    named('historical',  40.1406, 44.8181, 'Geghard Monastery'),
    named('photo_spots', 40.1180, 44.7350, 'Symphony of Stones'),
    named('restaurants', 40.1830, 44.5150, 'City Restaurant A'),
    named('restaurants', 40.1760, 44.5100, 'City Restaurant B'),
  ] });
  const isFar = (s) => haversineKm(YEREVAN.lat, YEREVAN.lng, s.place.latitude, s.place.longitude) > 12;

  /** How many times the route crosses between town and the excursion area. */
  const crossings = (day) => {
    let n = 0, was = null;
    for (const s of day.slots.filter(x => x.time)) {
      const far = isFar(s);
      if (was !== null && far !== was) n++;
      was = far;
    }
    return n;
  };

  test('the day is a single out-and-back, not a bounce', () => {
    const day = excursionDay();
    optimizeDayOrder(day, YEREVAN, false, DAY_START_MIN);
    expect(crossings(day)).toBeLessThanOrEqual(1);           // was 3
  });

  test('all excursion stops are visited before returning to town', () => {
    const day = excursionDay();
    optimizeDayOrder(day, YEREVAN, false, DAY_START_MIN);
    const scheduled = day.slots.filter(s => s.time);
    const lastFar = scheduled.map(isFar).lastIndexOf(true);
    const firstNear = scheduled.map(isFar).indexOf(false);
    expect(lastFar).toBeLessThan(firstNear);
  });

  test('the traveler is still fed, just later', () => {
    const day = excursionDay();
    optimizeDayOrder(day, YEREVAN, false, DAY_START_MIN);
    const meals = day.slots.filter(s => s.category === 'restaurants' && s.time);
    expect(meals).toHaveLength(2);
    const first = toMin(meals.map(m => m.time).sort()[0]);
    expect(first).toBeLessThanOrEqual(HUNGER_LIMIT + 90);    // no all-day fast
  });

  test('a local restaurant near the excursion IS used mid-trip', () => {
    // The rule defers a DETOUR, not every meal — somewhere to eat on site
    // must still be scheduled at a normal hour.
    const day = excursionDay();
    day.slots.push(named('restaurants', 40.1150, 44.7320, 'Garni Tavern'));
    optimizeDayOrder(day, YEREVAN, false, DAY_START_MIN);
    const tavern = day.slots.find(s => s.place.name === 'Garni Tavern');
    expect(tavern.time).toBeTruthy();
    expect(toMin(tavern.time)).toBeLessThanOrEqual(LUNCH.end + 60);
  });

  test('a compact city day is unaffected by the detour rule', () => {
    const day = centreDay(['historical', 'hidden_gems', 'photo_spots', 'shopping', 'restaurants', 'restaurants']);
    optimizeDayOrder(day, HOTEL, false, DAY_START_MIN);
    const meals = day.slots.filter(s => s.category === 'restaurants' && s.time)
      .map(s => toMin(s.time)).sort((a, b) => a - b);
    expect(meals[0]).toBeGreaterThanOrEqual(LUNCH.start);
    expect(meals[0]).toBeLessThanOrEqual(LUNCH.end);          // lunch still on time
  });
});

/* ── recomputeDayTimes: the manual-edit path ─────────────────────────────── */

describe('recomputeDayTimes', () => {
  test('respects the given order and pulls dinner earlier rather than pinning it', () => {
    const day = centreDay(['historical', 'hidden_gems', 'restaurants', 'restaurants']);
    const before = day.slots.map(s => s.slotId);
    recomputeDayTimes(day, HOTEL, false, DAY_START_MIN);
    expect(day.slots.map(s => s.slotId)).toEqual(before);      // order untouched
    expect(dinnerTime(day)).toBe(DINNER_FLOOR);                // not 19:00
  });

  test('a manually-ordered full day has no hole', () => {
    const day = centreDay(['historical', 'hidden_gems', 'photo_spots', 'restaurants',
      'shopping', 'nature', 'museum', 'restaurants']);
    recomputeDayTimes(day, HOTEL, false, DAY_START_MIN);
    expect(Math.max(...idleGaps(day))).toBeLessThanOrEqual(ACCEPTABLE_GAP);
  });

  test('slots without coordinates lose their time rather than keep a stale one', () => {
    const day = centreDay(['historical', 'restaurants']);
    day.slots[0].status = 'pending';
    day.slots[0].time = '09:30';
    recomputeDayTimes(day, HOTEL, false, DAY_START_MIN);
    expect(day.slots[0].time).toBeNull();
  });
});

/* ── capacity: why the day was under-filled ──────────────────────────────── */

describe('activityCapacity', () => {
  test('a balanced day plans more than the old fixed four activities', () => {
    expect(activityCapacity({ pace: 'balanced' })).toBeGreaterThan(4);
  });

  test('pace is still honoured', () => {
    expect(activityCapacity({ pace: 'relaxed' })).toBeLessThan(activityCapacity({ pace: 'balanced' }));
    expect(activityCapacity({ pace: 'balanced' })).toBeLessThanOrEqual(activityCapacity({ pace: 'packed' }));
  });

  test('a breakfast stop costs one activity slot, not a bonus stop', () => {
    expect(activityCapacity({ pace: 'balanced', hasBreakfast: true }))
      .toBe(activityCapacity({ pace: 'balanced', hasBreakfast: false }) - 1);
  });

  test('a later start plans no more than an early one', () => {
    expect(activityCapacity({ pace: 'packed', startMin: 11 * 60 }))
      .toBeLessThanOrEqual(activityCapacity({ pace: 'packed', startMin: DAY_START_MIN }));
  });

  test('never returns a day with fewer than two activities', () => {
    expect(activityCapacity({ pace: 'relaxed', startMin: 19 * 60 })).toBeGreaterThanOrEqual(2);
  });

  test('the planned day actually fits in the available hours', () => {
    for (const pace of ['relaxed', 'balanced', 'packed']) {
      const n = activityCapacity({ pace });
      const picks = Array.from({ length: n }, () => ({ _cat: 'hidden_gems' }));
      expect(projectedDayMinutes(picks, {})).toBeLessThanOrEqual(21 * 60 - DAY_START_MIN);
    }
  });
});

/* ── day filling: why days 6 and 7 came back short ───────────────────────── */

describe('fillDaysRoundRobin', () => {
  const ACTS = activityCapacity({ pace: 'balanced' });
  const opts = () => ({
    actsPerDay: ACTS,
    seed: { latitude: 40.17, longitude: 44.50 },
    maxKm: 12,
    dayBudgetMin: 21 * 60 - DAY_START_MIN,
    capacityOpts: {},
    isHeavy: isHeavyCategory,
  });
  // One tight cluster per day; sizes mimic what k-means with farthest-point
  // seeding actually produces — rich near the hotel, sparse at the edges.
  const split = (sizes) => {
    const clusters = sizes.map((n, ci) => Array.from({ length: n }, (_, k) => ({
      _cat: 'hidden_gems',
      latitude: 40.17 + ci * 0.004 + k * 0.0003,
      longitude: 44.50 + ci * 0.004,
    })));
    return {
      picked: clusters.map(c => c.slice(0, ACTS)),
      leftovers: clusters.flatMap(c => c.slice(ACTS)),
    };
  };

  /** The old behaviour, kept here as the reference to beat: fill each day to
   *  capacity in turn, so the early days drain the shared pool. */
  const fillDayOrder = (picked, leftovers, o) => {
    for (const p of picked) {
      while (p.length < o.actsPerDay && leftovers.length) {
        const core = p.length ? centroidOf(p) : o.seed;
        let bi = -1, bv = Infinity;
        leftovers.forEach((l, i) => { const d = distTo(core, l); if (d < bv) { bv = d; bi = i; } });
        if (bi === -1 || bv > o.maxKm) break;
        p.push(leftovers.splice(bi, 1)[0]);
      }
    }
  };

  test('a thin pool is shared across days instead of starving the last ones', () => {
    // The reported shape: a week-long trip whose pool cannot fill every day.
    // A thin pool CANNOT be conjured into full days — what matters is that the
    // shortfall lands evenly rather than entirely on days 6 and 7.
    const sizes = [8, 7, 6, 4, 3, 1, 1];

    const a = split(sizes);
    fillDayOrder(a.picked, a.leftovers, opts());
    const before = a.picked.map(p => p.length);

    const b = split(sizes);
    fillDaysRoundRobin(b.picked, b.leftovers, opts());
    const after = b.picked.map(p => p.length);

    // Same total — this redistributes, it does not invent places.
    expect(after.reduce((x, y) => x + y, 0)).toBe(before.reduce((x, y) => x + y, 0));
    // The worst day is better off, and the trip is more even overall.
    expect(Math.min(...after)).toBeGreaterThan(Math.min(...before));
    expect(Math.max(...after) - Math.min(...after))
      .toBeLessThan(Math.max(...before) - Math.min(...before));
  });

  test('no day is topped up while a thinner day is passed over', () => {
    const { picked, leftovers } = split([9, 8, 7, 3, 2, 1, 1]);
    const added = fillDaysRoundRobin(picked, leftovers, opts());
    const counts = picked.map(p => p.length);
    added.forEach((n, i) => {
      if (!n) return;
      // Any day that received a stop must not have finished fuller than a day
      // still short of capacity by more than the one stop it just took.
      counts.forEach((c, j) => {
        if (c < ACTS) expect(counts[i]).toBeLessThanOrEqual(c + 1);
      });
    });
  });

  test('every day is filled to capacity when the pool allows it', () => {
    const { picked, leftovers } = split([12, 12, 12, 12, 12, 12, 12]);
    fillDaysRoundRobin(picked, leftovers, opts());
    for (const p of picked) expect(p.length).toBe(ACTS);
  });

  test('never exceeds the day capacity', () => {
    const { picked, leftovers } = split([30, 2, 2]);
    fillDaysRoundRobin(picked, leftovers, opts());
    for (const p of picked) expect(p.length).toBeLessThanOrEqual(ACTS);
  });

  test('reports what it added per day', () => {
    const { picked, leftovers } = split([12, 1, 1]);
    const added = fillDaysRoundRobin(picked, leftovers, opts());
    expect(added).toHaveLength(3);
    expect(added.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  test('respects the heavy-sight cap while filling', () => {
    const days = [[], []];
    const heavy = Array.from({ length: 12 }, (_, k) => ({
      _cat: 'historical', latitude: 40.17 + k * 0.0003, longitude: 44.50,
    }));
    fillDaysRoundRobin(days, heavy, opts());
    for (const p of days) {
      expect(p.filter(x => isHeavyCategory(x._cat)).length).toBeLessThanOrEqual(2);
    }
  });

  test('an empty leftover pool is a no-op, not a crash', () => {
    const { picked } = split([2, 2]);
    expect(() => fillDaysRoundRobin(picked, [], opts())).not.toThrow();
  });
});

/* ── quality signals ─────────────────────────────────────────────────────── */

describe('ratingScore', () => {
  test('a well-reviewed 4.6 outranks a 4.9 with three reviews', () => {
    expect(ratingScore({ rating: 4.6, userRatingsTotal: 8000 }))
      .toBeGreaterThan(ratingScore({ rating: 4.9, userRatingsTotal: 3 }));
  });

  test('with equal review counts the better rating still wins', () => {
    expect(ratingScore({ rating: 4.8, userRatingsTotal: 500 }))
      .toBeGreaterThan(ratingScore({ rating: 4.2, userRatingsTotal: 500 }));
  });

  test('a missing review count is neutral, not a penalty', () => {
    expect(ratingScore({ rating: 4.6 })).toBe(ratingScore({ rating: 4.6, userRatingsTotal: 0 }));
  });

  test('a missing rating falls back to the prior', () => {
    expect(ratingScore({})).toBeCloseTo(4.0, 5);
  });
});

describe('isHeavyCategory', () => {
  test('scheduler and picker agree on what counts as heavy', () => {
    for (const c of ['historical', 'museum', 'events']) expect(isHeavyCategory(c)).toBe(true);
    for (const c of ['restaurants', 'cafe', 'photo_spots', 'shopping', 'nature']) {
      expect(isHeavyCategory(c)).toBe(false);
    }
  });
});

/* ── model-output handling ───────────────────────────────────────────────── */

describe('sanitizeSkeleton', () => {
  const dayOf = (n) => ({ title: `Day ${n}`, slots: [{ name: `Place ${n}`, category: 'historical', time: '09:30' }] });

  test('strict mode rejects a plan with an empty day so the retry can do better', () => {
    expect(sanitizeSkeleton({ days: [dayOf(1), { title: 'x', slots: [] }, dayOf(3)] }, 3, 'balanced')).toBeNull();
  });

  test('lenient mode keeps the good days instead of losing the whole trip', () => {
    const days = sanitizeSkeleton({ days: [dayOf(1), { title: 'x', slots: [] }, dayOf(3)] }, 3, 'balanced', { lenient: true });
    expect(days).toHaveLength(2);
    expect(days.map(d => d.dayNumber)).toEqual([1, 2]);      // renumbered, no hole
  });

  test('lenient mode still returns null when nothing is usable', () => {
    expect(sanitizeSkeleton({ days: [{ slots: [] }] }, 1, 'balanced', { lenient: true })).toBeNull();
  });

  test('caps each day at the pace budget', () => {
    const many = { days: [{ title: 'a', slots: Array.from({ length: 40 }, (_, i) => ({ name: `P${i}`, category: 'historical' })) }] };
    expect(sanitizeSkeleton(many, 1, 'balanced')[0].slots).toHaveLength(PACE_SLOTS.balanced);
  });

  test('drops junk names and coerces unknown categories', () => {
    const raw = { days: [{ title: 'a', slots: [
      { name: '', category: 'historical' },
      { name: 'x'.repeat(200), category: 'historical' },
      { name: 'Good Place', category: 'not_a_category', time: 'nonsense' },
    ] }] };
    const days = sanitizeSkeleton(raw, 1, 'balanced');
    expect(days[0].slots).toHaveLength(1);
    expect(days[0].slots[0].category).toBe('hidden_gems');
    expect(days[0].slots[0].time).toBeNull();
  });
});

describe('extractJson', () => {
  test('unwraps a fenced reply', () => {
    expect(extractJson('```json\n{"days":[]}\n```')).toEqual({ days: [] });
  });
  test('survives surrounding prose', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });
  test('repairs a trailing comma', () => {
    expect(extractJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });
  test('returns null on unparseable input', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('normalizeHours', () => {
  test('reads both Google spellings', () => {
    expect(normalizeHours({ weekday_text: ['Monday: 9:00 AM – 6:00 PM'] })).toHaveLength(1);
    expect(normalizeHours({ weekdayDescriptions: ['Monday: 9:00 AM – 6:00 PM'] })).toHaveLength(1);
  });
  test('is empty and safe when absent', () => {
    expect(normalizeHours(null)).toEqual([]);
    expect(normalizeHours({})).toEqual([]);
  });
  test('never stores more than a week', () => {
    expect(normalizeHours({ weekday_text: Array(20).fill('Monday: 9-6') })).toHaveLength(7);
  });
});

describe('haversineKm', () => {
  test('is zero for the same point', () => {
    expect(haversineKm(40.1776, 44.5126, 40.1776, 44.5126)).toBeCloseTo(0, 6);
  });
  test('matches a known straight-line distance (Yerevan → Gyumri ≈ 87 km)', () => {
    // Straight line, not the ~120 km by road — the geofence reasons in
    // great-circle distance, so that is what this must measure.
    const d = haversineKm(40.1792, 44.4991, 40.7894, 43.8475);
    expect(d).toBeGreaterThan(85);
    expect(d).toBeLessThan(92);
  });
});

/* ── photo-spot decoration (founder 2026-09-04) ──────────────────────────
 * Photo spots must never anchor a day: they are attached to the composed
 * route only where the detour is genuinely on the way, and never at the
 * cost of pushing a meal later. */
describe('decoratePhotoSpots', () => {
  const start = { lat: 40.1776, lng: 44.5126 };            // Yerevan centre
  // A compact, already-ordered day: cafe → sight → lunch → sight → dinner.
  const makeDay = () => {
    const day = { dayNumber: 1, slots: [
      stop('cafe',        40.1780, 44.5130),
      stop('historical',  40.1850, 44.5200),
      stop('restaurants', 40.1860, 44.5210),
      stop('museum',      40.1900, 44.5300),
      stop('restaurants', 40.1910, 44.5310),
    ]};
    recomputeDayTimes(day, start);
    return day;
  };
  const spot = (latitude, longitude) => ({
    name: `photo-${++seq}`, latitude, longitude, rating: 4.5,
  });

  test('attaches an on-route spot between its neighbours', () => {
    const day = makeDay();
    // Right between the historical sight and the museum — ~zero detour.
    const n = decoratePhotoSpots([day], [spot(40.1875, 44.5250)], { start });
    expect(n).toBe(1);
    const cats = day.slots.map(s => s.category);
    expect(cats).toEqual(['cafe', 'historical', 'restaurants', 'photo_spots', 'museum', 'restaurants']);
    expect(day.slots[3].time).toBeTruthy();                // it got a real time
  });

  test('refuses a far spot outright', () => {
    const day = makeDay();
    // ~40 km away (Sevan direction): would previously have been a valid stop.
    const n = decoratePhotoSpots([day], [spot(40.55, 44.95)], { start });
    expect(n).toBe(0);
    expect(day.slots.length).toBe(5);
  });

  test('never pushes a meal later', () => {
    const day = makeDay();
    const mealsBefore = day.slots.filter(s => s.category === 'restaurants').map(s => s.time);
    decoratePhotoSpots([day], [spot(40.1875, 44.5250), spot(40.1820, 44.5170)], { start });
    const mealsAfter = day.slots.filter(s => s.category === 'restaurants').map(s => s.time);
    mealsBefore.forEach((t, i) => expect(mealsAfter[i] <= t || !t).toBeTruthy());
  });

  test('caps decoration per day', () => {
    const day = makeDay();
    const spots = [
      spot(40.1875, 44.5250), spot(40.1820, 44.5170), spot(40.1855, 44.5205),
    ];
    const n = decoratePhotoSpots([day], spots, { start, maxPerDay: 2 });
    expect(n).toBeLessThanOrEqual(2);
  });
});
