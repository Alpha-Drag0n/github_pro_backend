/**
 * Task queue — the heart of the manager + agents pipeline.
 *
 * Manager side: generateTasksForSearch / reaper / rollup / control (pause/resume/
 * cancel/forceAssign/retry/priority).
 * Agent side:   claimTask / findAndStartAssigned / renewLease / completeTask /
 *               failTask / releaseTask.
 *
 * All lease timestamps use MongoDB's server clock ($$NOW via pipeline updates) so
 * agent clock skew can't corrupt lease math. Ownership is fenced by `leaseEpoch`:
 * every renewing/finalizing write requires (leasedBy === me && leaseEpoch === mine).
 */

const Task = require('../../models/taskModel');
const BucketLedger = require('../../models/bucketLedgerModel');
const DeepSearch = require('../../models/deepSearchModel');
const User = require('../../models/userModel');
const deepSearchService = require('../deepSearchService'); // reuse generateTerms()
const events = require('./eventService');
const { LEASE_TTL_MS, MAX_ATTEMPTS, FORCE_ASSIGN_GRACE_MS } = require('./agentConfig');

const DAY_MS = 1000 * 60 * 60 * 24;

// Auto-chaining of day-by-day deep searches: when one completes, the next pending search (by
// date) auto-starts CHAIN_DELAY_MS later. Set DEEP_SEARCH_AUTO_CHAIN=false to disable.
const CHAIN_DELAY_MS = parseInt(process.env.DEEP_SEARCH_CHAIN_DELAY_MS || '300000', 10); // 5 min
const AUTO_CHAIN = process.env.DEEP_SEARCH_AUTO_CHAIN !== 'false';

const lease = (ms) => ({ $add: ['$$NOW', ms] });

/* ============================ MANAGER: generation ============================ */

/**
 * Split a deep search into (day × term) bucket tasks. Idempotent (upsert on
 * searchId+globalKey) and cross-search-deduped (skips globalKeys already finished
 * by any search). Returns the number of bucket tasks now present for this search.
 */
async function generateTasksForSearch(search) {
  const accountType = 'user';
  const terms = deepSearchService.generateTerms(search.termSet || 'alnum2');
  const fromDate = new Date(search.dateRange.fromDate);
  const toDate = new Date(search.dateRange.toDate);

  let created = 0;
  for (let day = new Date(fromDate); day <= toDate; day = new Date(day.getTime() + DAY_MS)) {
    const createdDate = day.toISOString().split('T')[0];

    const dayKeys = terms.map((t) => `deep:${createdDate}:${t}`);
    // Cross-search dedup: skip buckets already finished by any search.
    const finished = await BucketLedger.find({ globalKey: { $in: dayKeys } }).select('globalKey');
    const finishedSet = new Set(finished.map((f) => f.globalKey));

    const ops = [];
    for (const term of terms) {
      const globalKey = `deep:${createdDate}:${term}`;
      if (finishedSet.has(globalKey)) continue;
      ops.push({
        updateOne: {
          filter: { searchId: search._id, globalKey },
          update: {
            $setOnInsert: {
              type: 'deep-search-bucket',
              searchId: search._id,
              payload: { day: createdDate, term, accountType },
              globalKey,
              status: 'pending',
              priority: search.priority || 0,
              maxAttempts: MAX_ATTEMPTS,
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) {
      const res = await Task.bulkWrite(ops, { ordered: false });
      created += res.upsertedCount || 0;
    }
  }

  const total = await Task.countDocuments({ searchId: search._id, type: 'deep-search-bucket' });
  await DeepSearch.updateOne(
    { _id: search._id },
    { $set: { totalBuckets: total, 'progress.totalBuckets': total } }
  );
  await events.emit({
    type: 'manager.generate',
    searchId: search._id,
    message: `generated tasks for ${search.searchId}: ${created} new, ${total} total`,
  });
  return total;
}

/* ============================ AGENT: claim & run ============================ */

/** Atomically claim the next runnable task (also reclaims expired leases). */
async function claimTask(agentId, capabilities) {
  const now = new Date();
  return Task.findOneAndUpdate(
    {
      type: { $in: capabilities },
      // Never steal a manager force-assign (pre-leased to a specific agent). Only the
      // reaper re-pools an expired force-assign back into the open queue.
      $or: [
        { status: 'pending', assignedByManager: { $ne: true } },
        { status: 'leased', leaseUntil: { $lt: now }, assignedByManager: { $ne: true } },
      ],
    },
    [
      {
        $set: {
          status: 'leased',
          leasedBy: agentId,
          leaseUntil: lease(LEASE_TTL_MS),
          leaseEpoch: { $add: ['$leaseEpoch', 1] },
          attempts: { $add: ['$attempts', 1] },
          claimedAt: '$$NOW',
          startedAt: { $ifNull: ['$startedAt', '$$NOW'] },
          progressAt: '$$NOW',
        },
      },
    ],
    { sort: { priority: -1, _id: 1 }, returnDocument: 'after' }
  );
}

/** Pick up a task force-assigned (pre-leased) to this agent; extend its lease. */
async function findAndStartAssigned(agentId) {
  return Task.findOneAndUpdate(
    { leasedBy: agentId, status: 'leased', assignedByManager: true },
    [
      {
        $set: {
          assignedByManager: false,
          leaseUntil: lease(LEASE_TTL_MS),
          startedAt: { $ifNull: ['$startedAt', '$$NOW'] },
          progressAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after' }
  );
}

/** Renew a held lease (fenced). Returns true if we still own the task. */
async function renewLease(taskId, agentId, leaseEpoch) {
  const r = await Task.updateOne(
    { _id: taskId, leasedBy: agentId, leaseEpoch, status: 'leased' },
    [{ $set: { leaseUntil: lease(LEASE_TTL_MS), progressAt: '$$NOW' } }]
  );
  return r.modifiedCount > 0;
}

/** Mark a task done (fenced) and record its globalKey in the cross-search ledger. */
async function completeTask(taskId, agentId, leaseEpoch, result, meta = {}) {
  const r = await Task.updateOne(
    { _id: taskId, leasedBy: agentId, leaseEpoch },
    { $set: { status: 'done', finishedAt: new Date(), result, leasedBy: null, leaseUntil: null } }
  );
  if (r.modifiedCount > 0) {
    // Cross-search dedup ledger is gated on globalKey; the audit event is not.
    if (meta.globalKey) {
      await BucketLedger.updateOne(
        { globalKey: meta.globalKey },
        { $setOnInsert: { globalKey: meta.globalKey, searchId: meta.searchId, taskId, finishedAt: new Date() } },
        { upsert: true }
      ).catch(() => {});
    }
    await events.emit({ type: 'task.done', agentId, taskId, searchId: meta.searchId, data: result });
  }
  return r.modifiedCount > 0;
}

/**
 * Fail a task (fenced): retryable → pending, or dead-letter if attempts exhausted.
 * The write and the resulting status are one atomic, fenced operation — a zombie
 * (lost-lease) caller gets null and emits nothing (true end-to-end no-op).
 */
async function failTask(taskId, agentId, leaseEpoch, error) {
  const t = await Task.findOneAndUpdate(
    { _id: taskId, leasedBy: agentId, leaseEpoch },
    [
      {
        $set: {
          status: { $cond: [{ $gte: ['$attempts', '$maxAttempts'] }, 'dead', 'pending'] },
          lastError: { message: error?.message, code: error?.code, at: '$$NOW', agentId },
          leasedBy: null,
          leaseUntil: null,
        },
      },
    ],
    { returnDocument: 'after', projection: { status: 1, searchId: 1 } }
  );
  if (!t) return null; // fence didn't match (zombie/reclaimed) → no event, no-op
  await events.emit({
    type: t.status === 'dead' ? 'task.dead' : 'task.failed',
    level: t.status === 'dead' ? 'error' : 'warn',
    agentId,
    taskId,
    searchId: t.searchId,
    message: error?.message,
  });
  return t.status;
}

/**
 * Release a task back to a given status (fenced) — used by preempt/abort.
 * When the release is due to an abort (lease lost / capacity / pause), pass
 * restoreAttempt=true so the claim-time attempt increment is undone (a pure
 * capacity/abort wait should not burn the retry budget toward dead-letter).
 */
async function releaseTask(taskId, agentId, leaseEpoch, toStatus = 'pending', restoreAttempt = false) {
  const update = { $set: { status: toStatus, leasedBy: null, leaseUntil: null } };
  if (restoreAttempt) update.$inc = { attempts: -1 };
  await Task.updateOne({ _id: taskId, leasedBy: agentId, leaseEpoch }, update);
}

/* ============================ MANAGER: reaper & rollup ============================ */

/**
 * Reclaim expired leases (crashed/hung/zombie owners). Bumps leaseEpoch so any
 * revived owner is fenced out. Honors parent control (paused→held, stopped→canceled).
 * Returns the number reclaimed.
 */
async function reaper() {
  const now = new Date();
  const expired = await Task.find({ status: 'leased', leaseUntil: { $lt: now } }).limit(500);
  const parentCache = new Map();
  let n = 0;

  for (const task of expired) {
    let desired = parentCache.get(String(task.searchId));
    if (desired === undefined) {
      const parent = await DeepSearch.findById(task.searchId).select('control.desired');
      desired = parent?.control?.desired || 'run';
      parentCache.set(String(task.searchId), desired);
    }

    let target = 'pending';
    if (desired === 'paused') target = 'held';
    else if (desired === 'stopped') target = 'canceled';
    else if (task.attempts >= task.maxAttempts) target = 'dead';

    const r = await Task.updateOne(
      { _id: task._id, status: 'leased', leaseUntil: { $lt: now } },
      { $set: { status: target, leasedBy: null, leaseUntil: null }, $inc: { leaseEpoch: 1 } }
    );
    if (r.modifiedCount > 0) {
      n += 1;
      await events.emit({
        type: 'task.reclaimed',
        level: 'warn',
        taskId: task._id,
        searchId: task.searchId,
        message: `lease expired → ${target} (was held by ${task.leasedBy})`,
      });
    }
  }
  return n;
}

/** Recompute a parent's progress from its tasks (source of truth) and derive status. */
async function rollupSearch(searchId) {
  const rows = await Task.aggregate([
    { $match: { searchId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        users: { $sum: { $ifNull: ['$result.usersNew', 0] } },
      },
    },
  ]);

  const by = { pending: 0, leased: 0, done: 0, failed: 0, dead: 0, canceled: 0, held: 0 };
  let total = 0;
  for (const r of rows) {
    by[r._id] = r.count;
    total += r.count;
  }

  const search = await DeepSearch.findById(searchId).select('control.desired status');
  if (!search) return null;

  // Authoritative user count from the DB (not the volatile per-task result.usersNew,
  // which undercounts when a bucket is partially run then re-run).
  const usersFound = await User.countDocuments({ 'searchIterationHistory.searchId': searchId });

  const remaining = by.pending + by.leased + by.held + by.failed;
  let status = search.status;
  if (search.control?.desired === 'stopped') status = 'failed'; // treated as stopped/ended
  else if (search.control?.desired === 'paused') status = 'paused';
  else if (total > 0 && remaining === 0) status = 'completed';
  // A started search whose buckets were all cross-search-deduped has zero tasks —
  // its work is already done elsewhere, so complete it (otherwise it hangs forever).
  else if (total === 0 && search.control?.desired === 'run' && search.status === 'in_progress') {
    status = 'completed';
  } else if (by.leased > 0 || by.pending > 0) status = 'in_progress';

  const progress = {
    totalBuckets: total,
    done: by.done,
    failed: by.failed + by.dead,
    dead: by.dead,
    pending: by.pending + by.held,
    leased: by.leased,
    usersFound,
    rollupAt: new Date(),
  };

  await DeepSearch.updateOne(
    { _id: searchId },
    {
      $set: {
        progress,
        status,
        // Consistent with the socket payload (managerService): processed = terminal work.
        bucketsProcessed: by.done + by.dead,
        usersFound,
        ...(status === 'completed' ? { completedAt: new Date() } : {}),
      },
    }
  );
  return { status, progress };
}

/* ============================ MANAGER: control ============================ */

async function pauseSearch(searchId) {
  await DeepSearch.updateOne({ _id: searchId }, { $set: { 'control.desired': 'paused', status: 'paused' } });
  // Hold queued work so agents stop claiming it.
  const held = await Task.updateMany({ searchId, status: 'pending' }, { $set: { status: 'held' } });
  // Stop any in-flight (leased) task instead of letting the current bucket run to completion:
  //  - bump leaseEpoch  → the running agent's next renewLease fails, so it aborts (and its
  //    own releaseTask no-ops on the stale epoch, so it can't override us);
  //  - leaseUntil = epoch(0) (a PAST date, not null, so the reaper's `{ $lt: now }` matches)
  //    → the reaper reclaims it as 'held' (parent desired === 'paused') within a tick;
  //  - attempts-1 (clamped ≥0) → pausing is not a failed attempt, so it doesn't eat the
  //    retry budget across pause/resume cycles.
  const fenced = await Task.updateMany({ searchId, status: 'leased' }, [
    {
      $set: {
        leaseEpoch: { $add: ['$leaseEpoch', 1] },
        leaseUntil: new Date(0),
        attempts: { $max: [{ $subtract: ['$attempts', 1] }, 0] },
      },
    },
  ]);
  await events.emit({
    type: 'control.pause',
    searchId,
    message: `paused; ${held.modifiedCount} held, ${fenced.modifiedCount} in-flight fenced`,
  });
  return held.modifiedCount + fenced.modifiedCount;
}

async function resumeSearch(searchId) {
  await DeepSearch.updateOne({ _id: searchId }, { $set: { 'control.desired': 'run', status: 'in_progress' } });
  // Release queued work back to agents. 'failed' is included defensively — the agent path
  // normally produces only pending/dead, but a retryable failure must never be stranded.
  // Actively-leased tasks are left alone: any with an expired lease are reclaimed to 'pending'
  // by the reaper/claimTask (desired === 'run' now); 'canceled'/'dead' stay terminal.
  const r = await Task.updateMany(
    { searchId, status: { $in: ['held', 'failed'] } },
    { $set: { status: 'pending', leasedBy: null, leaseUntil: null } }
  );
  await events.emit({ type: 'control.resume', searchId, message: `resumed; ${r.modifiedCount} tasks released` });
  return r.modifiedCount;
}

async function stopSearch(searchId) {
  await DeepSearch.updateOne({ _id: searchId }, { $set: { 'control.desired': 'stopped' } });
  const r = await Task.updateMany(
    { searchId, status: { $in: ['pending', 'held', 'failed'] } },
    { $set: { status: 'canceled' } }
  );
  await events.emit({ type: 'control.stop', searchId, message: `stopped; ${r.modifiedCount} tasks canceled` });
  return r.modifiedCount;
}

/** Force-assign a specific task to a specific agent by PRE-LEASING it (race-free). */
async function forceAssign(taskId, agentId) {
  const r = await Task.updateOne(
    { _id: taskId, status: { $in: ['pending', 'failed', 'held'] } },
    [
      {
        $set: {
          status: 'leased',
          leasedBy: agentId,
          assignedByManager: true,
          leaseUntil: lease(FORCE_ASSIGN_GRACE_MS),
          leaseEpoch: { $add: ['$leaseEpoch', 1] },
        },
      },
    ]
  );
  await events.emit({ type: 'task.assigned', taskId, agentId, message: `force-assigned to ${agentId}` });
  return r.modifiedCount > 0;
}

async function retryTask(taskId) {
  // 'held' is included so a held task can be released back into the queue (un-hold).
  await Task.updateOne(
    { _id: taskId, status: { $in: ['dead', 'failed', 'canceled', 'held'] } },
    { $set: { status: 'pending', attempts: 0, leasedBy: null, leaseUntil: null } }
  );
}

/**
 * Set a task's status (hold/cancel/…). Bumps leaseEpoch and clears the lease so that ANY
 * current owner is fenced out — this is what makes Hold/Cancel work on a LEASED (in-flight)
 * task: the agent's next renewLease fails (epoch/status mismatch) → it aborts the task and
 * its completeTask becomes a no-op, so the new status sticks.
 */
async function setTaskStatus(taskId, status) {
  const t = await Task.findOneAndUpdate(
    { _id: taskId },
    [{ $set: { status, leaseEpoch: { $add: ['$leaseEpoch', 1] }, leasedBy: null, leaseUntil: null } }],
    { returnDocument: 'after', projection: { searchId: 1, status: 1 } }
  );
  if (t) {
    await events.emit({
      type: status === 'held' ? 'task.held' : status === 'canceled' ? 'task.canceled' : 'task.status',
      taskId,
      searchId: t.searchId,
      message: `status → ${status}`,
    });
  }
}

async function setTaskPriority(taskId, priority) {
  await Task.updateOne({ _id: taskId }, { $set: { priority } });
}

/* ============================ MANAGER: auto-chaining ============================ */

/**
 * After a search completes, schedule the NEXT day's search to auto-start CHAIN_DELAY_MS later:
 * the pending search that is opted into chaining (autoChain:true) with the smallest
 * dateRange.fromDate strictly after the completed one. Atomic on `autoStartAt: null` so
 * concurrent completions can't double-book it.
 */
async function scheduleNextChainedSearch(completedSearchId) {
  if (!AUTO_CHAIN) return null;
  const done = await DeepSearch.findById(completedSearchId).select('dateRange.fromDate');
  if (!done?.dateRange?.fromDate) return null;

  const next = await DeepSearch.findOneAndUpdate(
    { status: 'pending', autoChain: true, autoStartAt: null, 'dateRange.fromDate': { $gt: done.dateRange.fromDate } },
    { $set: { autoStartAt: new Date(Date.now() + CHAIN_DELAY_MS) } },
    { sort: { 'dateRange.fromDate': 1 }, new: true }
  );
  if (next) {
    await events.emit({
      type: 'control.chain',
      searchId: next._id,
      message: `auto-start scheduled (+${Math.round(CHAIN_DELAY_MS / 1000)}s) after ${completedSearchId} completed`,
    });
  }
  return next;
}

/**
 * Start any searches whose scheduled auto-start time has arrived. Crash-safe (the schedule
 * lives in the DB, so a manager restart still fires it) and idempotent (atomic pending→
 * in_progress claim). Returns the started search docs.
 */
async function startDueChainedSearches() {
  if (!AUTO_CHAIN) return [];
  const now = new Date();
  const due = await DeepSearch.find({ status: 'pending', autoStartAt: { $ne: null, $lte: now } }).select('_id');
  const started = [];
  for (const d of due) {
    const search = await DeepSearch.findOneAndUpdate(
      { _id: d._id, status: 'pending', autoStartAt: { $lte: now } },
      { $set: { status: 'in_progress', startedAt: new Date(), 'control.desired': 'run', error: null, autoStartAt: null } },
      { new: true }
    );
    if (!search) continue; // already started/changed by something else
    await generateTasksForSearch(search);
    started.push(search);
    await events.emit({ type: 'control.chain', searchId: search._id, message: 'auto-started (chained)' });
  }
  return started;
}

module.exports = {
  generateTasksForSearch,
  claimTask,
  findAndStartAssigned,
  renewLease,
  completeTask,
  failTask,
  releaseTask,
  reaper,
  rollupSearch,
  pauseSearch,
  resumeSearch,
  stopSearch,
  forceAssign,
  retryTask,
  setTaskStatus,
  setTaskPriority,
  scheduleNextChainedSearch,
  startDueChainedSearches,
};
