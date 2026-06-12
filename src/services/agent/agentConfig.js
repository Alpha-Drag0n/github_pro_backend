/**
 * Shared tunables for the manager + agents system.
 * Centralized so the manager (reaper / generation) and agents agree on timing.
 */
module.exports = {
  LEASE_TTL_MS: 90_000, // how long a claim/renew owns a task
  HEARTBEAT_MS: 15_000, // agent heartbeat + lease-renew interval
  DEAD_AGENT_MS: 45_000, // 3 × heartbeat → agent considered dead
  MAX_ATTEMPTS: 5, // task retries before dead-letter
  TOKEN_ROTATION_CYCLES: 3, // per GitHub call: rotate through all tokens up to 3× then fail
  FORCE_ASSIGN_GRACE_MS: 60_000, // pre-lease window for a force-assigned task to be picked up
  REAPER_INTERVAL_MS: 10_000, // manager reaper cadence
  ROLLUP_INTERVAL_MS: 5_000, // manager parent-progress rollup cadence
  CLAIM_IDLE_BACKOFF_MS: 3_000, // agent backoff when the queue is empty (+ jitter)
  MAX_TASK_MS: 20 * 60_000, // per-task watchdog (abort a single task after 20 min)
};
