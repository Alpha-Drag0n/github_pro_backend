/**
 * Token rate limiter - a SHARED, self-imposed central limiter so any number of
 * agents can safely share a small pool of tokens (the user has few tokens).
 *
 * GitHub has two independent rate buckets that deep search hits:
 *   - search : ~30 requests / minute   (the /search/users endpoint)
 *   - core   : 5000 requests / hour     (profile / repos / readme)
 * We track a conservative budget per token per bucket. `acquire()` atomically
 * "spends" one unit from an available token (resetting the fixed window when it
 * has elapsed). If nothing is available the caller waits and retries.
 *
 * GitHub's x-ratelimit-* headers (which DO exist) are used only to reconcile the
 * local budget after a call - the local limiter is the primary control because a
 * single agent's headers don't reflect other agents' usage in real time.
 */

const Token = require('../../models/tokenModel');

const WINDOW_MS = { search: 60_000, core: 3_600_000 };

/**
 * Atomically claim one request unit from an available token for `resource`.
 * @param {'search'|'core'} resource
 * @param {Array} [excludeIds] token _ids to skip (already tried this rotation → distinct picks)
 * @returns {Promise<{ _id, token, name } | null>} token doc (budget already decremented) or null
 */
async function acquire(resource = 'search', excludeIds = []) {
  const path = `budget.${resource}`;
  const windowMs = WINDOW_MS[resource] || WINDOW_MS.search;

  const usable = {
    disabled: { $ne: true },
    ...(excludeIds && excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
    $and: [
      { $or: [{ cooldownUntil: null }, { cooldownUntil: { $lte: new Date() } }] },
      {
        $or: [
          { [`${path}.remaining`]: { $gt: 0 } }, // budget left in current window
          { [`${path}.resetAt`]: null }, // never used
          { [`${path}.resetAt`]: { $lte: new Date() } }, // window elapsed → refills
        ],
      },
    ],
  };

  // Pipeline update: refill if the window elapsed, then spend one. All expressions
  // read the PRE-update document, so resetAt/remaining are consistent.
  const windowElapsed = {
    $or: [{ $eq: [`$${path}.resetAt`, null] }, { $lte: [`$${path}.resetAt`, '$$NOW'] }],
  };

  const token = await Token.findOneAndUpdate(
    usable,
    [
      {
        $set: {
          [`${path}.resetAt`]: {
            $cond: [windowElapsed, { $add: ['$$NOW', windowMs] }, `$${path}.resetAt`],
          },
          [`${path}.remaining`]: {
            $subtract: [
              { $cond: [windowElapsed, `$${path}.limit`, `$${path}.remaining`] },
              1,
            ],
          },
          lastUsed: '$$NOW',
        },
      },
    ],
    { sort: { priority: -1, [`${path}.remaining`]: -1 }, returnDocument: 'after' }
  );

  return token; // null when every token is exhausted/cooling/disabled
}

/**
 * Reconcile a token's budget from GitHub response headers (best-effort).
 * MONOTONIC: `remaining` can only move DOWN (toward exhaustion) and `resetAt` only
 * FORWARD. This is essential - the header reflects one agent's view and is normally
 * higher than our conservative local count; a blind $set would re-inflate the budget
 * and let the shared fleet overspend (violating the central-limiter invariant).
 */
async function reconcile(tokenId, resource, headers = {}) {
  try {
    const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
    const resetSec = parseInt(headers['x-ratelimit-reset'], 10);
    if (Number.isNaN(remaining)) return;
    const path = `budget.${resource}`;
    const resetDate = Number.isNaN(resetSec) ? null : new Date(resetSec * 1000);

    await Token.updateOne({ _id: tokenId }, [
      {
        $set: {
          [`${path}.remaining`]: {
            $min: [{ $ifNull: [`$${path}.remaining`, remaining] }, remaining],
          },
          ...(resetDate
            ? {
                [`${path}.resetAt`]: {
                  $max: [{ $ifNull: [`$${path}.resetAt`, resetDate] }, resetDate],
                },
              }
            : {}),
        },
      },
    ]);
  } catch {
    /* best-effort */
  }
}

/**
 * Record a token error.
 * @param {*} tokenId
 * @param {'auth'|'abuse'|'rate'} kind
 * @param {number} [retryAfterMs] - for abuse/secondary limits (from retry-after header)
 */
async function reportError(tokenId, kind, retryAfterMs = 0) {
  const set = { lastChecked: new Date() };
  const inc = { consecutiveErrors: 1, errorCount: 1 };
  if (kind === 'auth') {
    set.disabled = true; // 401 / revoked → quarantine
  } else if (kind === 'abuse') {
    set.cooldownUntil = new Date(Date.now() + (retryAfterMs || 60_000));
  } else if (kind === 'rate') {
    set.cooldownUntil = new Date(Date.now() + (retryAfterMs || 30_000));
  }
  try {
    await Token.updateOne({ _id: tokenId }, { $set: set, $inc: inc });
  } catch {
    /* best-effort */
  }
}

/** Clear the error streak after a successful call. */
async function reportSuccess(tokenId) {
  try {
    await Token.updateOne(
      { _id: tokenId },
      { $set: { consecutiveErrors: 0 }, $inc: { successCount: 1, usageCount: 1 } }
    );
  } catch {
    /* best-effort */
  }
}

/** Earliest time any token's `resource` window resets (for back-off messaging). */
async function earliestReset(resource = 'search') {
  const t = await Token.findOne({ disabled: { $ne: true } })
    .sort({ [`budget.${resource}.resetAt`]: 1 })
    .select(`budget.${resource}.resetAt`);
  return t?.budget?.[resource]?.resetAt || null;
}

module.exports = { acquire, reconcile, reportError, reportSuccess, earliestReset };
