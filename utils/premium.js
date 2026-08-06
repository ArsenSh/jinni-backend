/**
 * Premium term rules — the single definition of "is this account premium?".
 *
 * `isPremium` alone used to mean premium FOREVER: the grant endpoint set the
 * flag and nothing ever cleared it, so one comp (or, before that route was
 * locked down, one console call) bought unlimited quota for life.
 *
 * The term now lives in `User.premiumUntil`:
 *
 *   premiumUntil = <date>  → premium until that moment, then it lapses
 *   premiumUntil = null    → NO EXPIRY
 *
 * Null meaning "no expiry" is deliberate and is the back-compat contract:
 * every account granted premium before this field existed has no date stored,
 * and treating that as "expired" would downgrade all of them the moment this
 * ships. New grants always carry a date (see the grant route), so `null` only
 * ever describes grandfathered or explicitly-lifetime accounts.
 *
 * Enforcement is LAZY — evaluated wherever premium is read, rather than by a
 * scheduled job. There is no cron in this deployment, and a lapsed account
 * nobody touches costs nothing; what matters is that the next request after
 * expiry sees the truth.
 */

/** Is premium currently in force? */
function isPremiumActive(user, now = new Date()) {
  if (!user || !user.isPremium) return false;
  if (!user.premiumUntil) return true;                 // no expiry — see above
  const until = new Date(user.premiumUntil).getTime();
  if (!Number.isFinite(until)) return true;            // unparseable → never punish the user for our bad data
  return until > now.getTime();
}

/** Has a dated term run out? (false for lifetime, and for non-premium.) */
function isPremiumExpired(user, now = new Date()) {
  return !!(user && user.isPremium && user.premiumUntil && !isPremiumActive(user, now));
}

/** Whole days left, or null when there is no expiry / no premium. */
function premiumDaysRemaining(user, now = new Date()) {
  if (!isPremiumActive(user, now) || !user.premiumUntil) return null;
  const ms = new Date(user.premiumUntil).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * End of a term of `days` starting now — or from the current expiry when the
 * account is still active, so renewing EXTENDS a term rather than truncating
 * whatever the user already paid for.
 */
function premiumTermEnd(days, user = null, now = new Date()) {
  const base = (user && isPremiumActive(user, now) && user.premiumUntil)
    ? new Date(user.premiumUntil)
    : now;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

module.exports = { isPremiumActive, isPremiumExpired, premiumDaysRemaining, premiumTermEnd };
