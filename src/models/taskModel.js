/**
 * Task Model — the durable work queue for the manager + agents pipeline.
 *
 * One document = one smallest unit of work. For Deep Search that is a single
 * (day, term) bucket. The manager CREATES tasks; agents atomically CLAIM them
 * (pull model — the manager never pushes, except force-assign which pre-leases).
 *
 * Lifecycle:  pending → leased → done | failed | dead | canceled | held
 *   pending  : waiting to be claimed
 *   leased   : an agent owns it; valid only until leaseUntil (then reclaimable)
 *   done     : finished successfully
 *   failed   : last attempt failed but still retryable (attempts < maxAttempts)
 *   dead     : retries exhausted → dead-letter (needs manual retry/inspection)
 *   canceled : parent job was stopped/deleted
 *   held     : paused at the task level (not claimable until resumed)
 *
 * Safety: ownership is a time-bounded LEASE with a monotonic `leaseEpoch` FENCE.
 * Every finalizing/renewing write is guarded by (leasedBy === me && leaseEpoch === mine)
 * so a revived "zombie" agent that lost its lease can never corrupt a task.
 */

const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    // Which handler runs this task. Keeps agents generic: agent looks up handlers[type].
    // Deep Search = 'deep-search-bucket'. (Quick Search would add 'quick-search-combo'.)
    type: { type: String, required: true, index: true },

    // Parent job this task belongs to.
    searchId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeepSearch', required: true },

    // Type-specific parameters. For deep-search-bucket: { day, term, accountType }.
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    // Cross-search dedup key, e.g. "deep:2011-01-01:aa". The manager skips creating a task
    // whose key was already finished by ANY search (see bucketLedgerModel).
    globalKey: { type: String, index: true },

    status: {
      type: String,
      enum: ['pending', 'leased', 'done', 'failed', 'dead', 'canceled', 'held'],
      default: 'pending',
      index: true,
    },

    priority: { type: Number, default: 0 }, // higher is claimed first

    // ---- Lease / ownership (invariants I2, I3) ----
    leasedBy: { type: String, default: null }, // agentId currently holding it
    leaseUntil: { type: Date, default: null }, // ownership expires at this server-clock time
    leaseEpoch: { type: Number, default: 0 }, // FENCE: bumped on every (re)claim

    // Set when the manager force-assigns to a specific agent (pre-leased, never pooled).
    assignedByManager: { type: Boolean, default: false },

    // ---- Retry accounting (invariant I6) ----
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastError: {
      message: String,
      code: String, // e.g. 'RATE_LIMIT' | 'HTTP_502' | 'MONGO' | 'NETWORK'
      at: Date,
      agentId: String,
    },

    // ---- Result + progress ----
    result: { type: mongoose.Schema.Types.Mixed }, // { usersFound, usersNew, requests, ... }
    progressAt: { type: Date }, // last forward progress (stuck-task detection)

    claimedAt: Date,
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true } // createdAt / updatedAt
);

// Claim scan: find the next claimable task quickly.
taskSchema.index({ status: 1, type: 1, priority: -1, _id: 1 });
// Reaper scan: find expired leases.
taskSchema.index({ status: 1, leaseUntil: 1 });
// Per-search progress / rollup queries.
taskSchema.index({ searchId: 1, status: 1 });
// Generation idempotency: one task per (search, bucket). Lets the manager re-generate
// safely (upsert) and prevents duplicates under concurrent generation.
taskSchema.index({ searchId: 1, globalKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Task', taskSchema);
