/**
 * Shared tunables for the manager + agents system.
 * Centralized so the manager (reaper / generation) and agents agree on timing.
 */

/**
 * Token-rotation retry plan for ONE GitHub call (a profile fetch or a single search page),
 * given how many active tokens exist (N):
 *   maxRotations — total token-error retries before giving up on the call.
 *   perToken     — attempts on a token before it is cooled down and rotated out.
 *
 *   N | maxRotations | perToken
 *   1 |      3       |    3        (one token → no point rotating; just a few tries)
 *   2 |      6       |    3
 *   3 |      6       |    2
 *   4 |      8       |    2
 *   5 |     10       |    2
 *  ≥5 |     10 (cap) |    2        (beyond this it's systemic — capping avoids waste)
 *
 * Rule: N≤2 → 3·N retries (3 per token); N≥3 → min(2·N, 10) retries (2 per token).
 */
function rotationPlan(tokenCount) {
  const n = Math.max(1, tokenCount || 1);
  const maxRotations = n <= 2 ? 3 * n : Math.min(2 * n, 10);
  const perToken = n <= 2 ? 3 : 2;
  return { maxRotations, perToken };
}

module.exports = {
  LEASE_TTL_MS: 90_000, // how long a claim/renew owns a task
  HEARTBEAT_MS: 15_000, // agent heartbeat + lease-renew interval
  DEAD_AGENT_MS: 45_000, // 3 × heartbeat → agent considered dead
  MAX_ATTEMPTS: 5, // task retries before dead-letter
  rotationPlan, // per-call token-error retry plan → { maxRotations, perToken }
  FORCE_ASSIGN_GRACE_MS: 60_000, // pre-lease window for a force-assigned task to be picked up
  REAPER_INTERVAL_MS: 10_000, // manager reaper cadence
  ROLLUP_INTERVAL_MS: 5_000, // manager parent-progress rollup cadence
  CLAIM_IDLE_BACKOFF_MS: 3_000, // agent backoff when the queue is empty (+ jitter)
  MAX_TASK_MS: 20 * 60_000, // per-task watchdog (abort a single task after 20 min)
};
