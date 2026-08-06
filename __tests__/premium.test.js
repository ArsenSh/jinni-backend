/**
 * Premium term rules.
 *
 * The contract that matters most here is the back-compat one: an account
 * granted premium BEFORE `premiumUntil` existed has no date stored, and must
 * keep its premium rather than being silently downgraded on deploy.
 */

const {
  isPremiumActive, isPremiumExpired, premiumDaysRemaining, premiumTermEnd,
} = require('../utils/premium');

const NOW = new Date('2026-08-06T12:00:00.000Z');
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const free        = { isPremium: false, premiumUntil: null };
const lifetime    = { isPremium: true,  premiumUntil: null };
const active      = { isPremium: true,  premiumUntil: days(30) };
const lapsed      = { isPremium: true,  premiumUntil: days(-1) };
const lapsedToday = { isPremium: true,  premiumUntil: new Date(NOW.getTime() - 1000) };

describe('isPremiumActive', () => {
  test('a free account is never premium', () => {
    expect(isPremiumActive(free, NOW)).toBe(false);
  });

  test('a dated term inside its window is active', () => {
    expect(isPremiumActive(active, NOW)).toBe(true);
  });

  test('a lapsed term is not active', () => {
    expect(isPremiumActive(lapsed, NOW)).toBe(false);
    expect(isPremiumActive(lapsedToday, NOW)).toBe(false);
  });

  test('BACK-COMPAT: no expiry date means premium, not expired', () => {
    // Accounts granted before premiumUntil existed carry null. Treating that
    // as expired would downgrade every existing premium user on deploy.
    expect(isPremiumActive(lifetime, NOW)).toBe(true);
  });

  test('unparseable dates do not punish the user', () => {
    expect(isPremiumActive({ isPremium: true, premiumUntil: 'not-a-date' }, NOW)).toBe(true);
  });

  test('missing or malformed input is not premium', () => {
    expect(isPremiumActive(null, NOW)).toBe(false);
    expect(isPremiumActive(undefined, NOW)).toBe(false);
    expect(isPremiumActive({}, NOW)).toBe(false);
  });

  test('the boundary is exclusive — the expiry instant is already over', () => {
    expect(isPremiumActive({ isPremium: true, premiumUntil: NOW }, NOW)).toBe(false);
    expect(isPremiumActive({ isPremium: true, premiumUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
  });
});

describe('isPremiumExpired', () => {
  test('true only for a premium account whose dated term ran out', () => {
    expect(isPremiumExpired(lapsed, NOW)).toBe(true);
  });

  test('false for lifetime, active and free accounts', () => {
    expect(isPremiumExpired(lifetime, NOW)).toBe(false);   // must never auto-downgrade
    expect(isPremiumExpired(active, NOW)).toBe(false);
    expect(isPremiumExpired(free, NOW)).toBe(false);
  });
});

describe('premiumDaysRemaining', () => {
  test('counts whole days left', () => {
    expect(premiumDaysRemaining(active, NOW)).toBe(30);
  });

  test('null when there is no term to count', () => {
    expect(premiumDaysRemaining(lifetime, NOW)).toBeNull();
    expect(premiumDaysRemaining(free, NOW)).toBeNull();
    expect(premiumDaysRemaining(lapsed, NOW)).toBeNull();
  });

  test('a partial final day still counts as a day, never negative', () => {
    const almost = { isPremium: true, premiumUntil: new Date(NOW.getTime() + 60 * 1000) };
    expect(premiumDaysRemaining(almost, NOW)).toBe(1);
  });
});

describe('premiumTermEnd', () => {
  test('a new grant runs from now', () => {
    expect(premiumTermEnd(30, free, NOW).toISOString()).toBe(days(30).toISOString());
  });

  test('renewing an ACTIVE account extends rather than truncates', () => {
    // 30 days left + a 30-day renewal = 60 days, not 30. Truncating here
    // would quietly delete time the user already paid for.
    expect(premiumTermEnd(30, active, NOW).toISOString()).toBe(days(60).toISOString());
  });

  test('renewing a LAPSED account restarts from now', () => {
    expect(premiumTermEnd(30, lapsed, NOW).toISOString()).toBe(days(30).toISOString());
  });

  test('renewing a lifetime account still produces a dated term', () => {
    // premiumUntil is null, so there is nothing to extend from — start now.
    expect(premiumTermEnd(30, lifetime, NOW).toISOString()).toBe(days(30).toISOString());
  });
});
