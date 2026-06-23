/**
 * Agent runner — the generic claim → run → finalize loop.
 *
 * The same loop runs in-process (Phase 0, started by the manager) or as a separate
 * process (Phase 1, src/agent.js). It is handler-agnostic: it looks up
 * handlers[task.type] and runs it, renewing the lease via heartbeat and honoring
 * the manager's control commands (pause/drain/stop/preempt) + force-assignment.
 */

const os = require('os');
const Logger = require('../../utils/logger');
const Token = require('../../models/tokenModel');
const DeepSearch = require('../../models/deepSearchModel');
const agentRegistry = require('./agentRegistry');
const taskQueue = require('./taskQueue');
const deepSearchBucketHandler = require('./handlers/deepSearchBucketHandler');
const tracing = require('../observability/tracing');
const { HEARTBEAT_MS, CLAIM_IDLE_BACKOFF_MS, MAX_TASK_MS } = require('./agentConfig');

const logger = new Logger();
const HANDLERS = { [deepSearchBucketHandler.type]: deepSearchBucketHandler };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start an agent. Returns { agentId, stop() }.
 * @param {object} [opts] { agentId, ordinal, instanceId, capabilities }
 *   Identity is STABLE across redeploys: agentId wins, else
 *   `${RENDER_SERVICE_ID || AGENT_NAME || host}-${ordinal ?? pid}`, so the same logical
 *   agent slot reuses its record instead of creating a new one on every deploy.
 */
async function startAgent(opts = {}) {
  const capabilities = opts.capabilities || Object.keys(HANDLERS);
  const base = process.env.RENDER_SERVICE_ID || process.env.AGENT_NAME || os.hostname();
  const agentId = opts.agentId || `${base}-${opts.ordinal != null ? opts.ordinal : process.pid}`;
  // Unique per process boot. A newer deploy registering the SAME agentId supersedes this one.
  const instanceId = opts.instanceId || process.env.RENDER_INSTANCE_ID || `${os.hostname()}:${process.pid}`;

  let stopped = false;
  let currentTask = null;
  let leaseLost = false;
  let superseded = false;
  let control = { command: 'run', assignTaskId: null };
  const metricsInc = {}; // buffered, flushed on heartbeat

  // The status the agent should report given its current command + work.
  const statusFor = () =>
    control.command === 'pause'
      ? 'paused'
      : control.command === 'drain'
      ? 'draining'
      : currentTask
      ? 'busy'
      : 'idle';

  await agentRegistry.register({
    agentId,
    host: os.hostname(),
    pid: process.pid,
    version: process.env.npm_package_version || '1.0.0',
    capabilities,
    instanceId,
  });
  logger.info(`[agent ${agentId}] started (capabilities: ${capabilities.join(', ')})`);

  // Heartbeat (unconditional) + task-lease renewal (only while holding a task).
  const hb = setInterval(async () => {
    try {
      const inc = {};
      for (const k of Object.keys(metricsInc)) {
        if (metricsInc[k]) { inc[k] = metricsInc[k]; metricsInc[k] = 0; }
      }
      const beat = await agentRegistry.heartbeat(agentId, {
        status: statusFor(),
        currentTaskId: currentTask ? currentTask._id : null,
        metricsInc: inc,
      });
      if (beat) {
        control = beat.control || control;
        if (beat.instanceId && beat.instanceId !== instanceId) superseded = true; // newer deploy took over
      }

      if (currentTask) {
        const ok = await taskQueue.renewLease(currentTask._id, agentId, currentTask.leaseEpoch);
        if (!ok) leaseLost = true; // lost the lease (zombie/reclaimed) → abort current task
      }
    } catch (e) {
      logger.warn(`[agent ${agentId}] heartbeat error: ${e.message}`);
    }
  }, HEARTBEAT_MS);

  const shouldAbort = async () =>
    leaseLost || superseded || control.command === 'preempt' || control.command === 'stop';

  async function runTask(task) {
    currentTask = task;
    leaseLost = false;
    await agentRegistry.setStatus(agentId, 'busy', task._id).catch(() => {}); // reflect immediately

    const handler = HANDLERS[task.type];
    if (!handler) {
      await taskQueue.failTask(task._id, agentId, task.leaseEpoch, {
        message: `no handler for type ${task.type}`,
        code: 'NO_HANDLER',
      });
      currentTask = null;
      return;
    }

    // Parent job must exist and be running; otherwise release and skip. A missing
    // parent (search deleted while this task was in-flight) is treated as canceled —
    // critically this prevents running the handler with searchUuid=undefined, which
    // would corrupt the User dedup/unique key.
    const parent = await DeepSearch.findById(task.searchId).select('control.desired searchId');
    if (!parent || (parent.control?.desired && parent.control.desired !== 'run')) {
      await taskQueue.releaseTask(
        task._id,
        agentId,
        task.leaseEpoch,
        !parent || parent.control?.desired === 'stopped' ? 'canceled' : 'held',
        true // not the task's fault → don't burn an attempt
      );
      currentTask = null;
      return;
    }

    const ctx = {
      task,
      agentId,
      searchId: task.searchId, // DeepSearch _id (ObjectId) → searchIterationHistory link
      searchUuid: parent ? parent.searchId : undefined, // uuid string → User.searchId
      tokenCount: await Token.countDocuments({ disabled: { $ne: true } }),
      shouldAbort,
      renew: async () => {
        const ok = await taskQueue.renewLease(task._id, agentId, task.leaseEpoch);
        if (!ok) leaseLost = true;
      },
    };

    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      leaseLost = true; // per-task watchdog (failure A2): abort a task that runs too long
    }, MAX_TASK_MS);

    try {
      // Root of the trace: traceId = `${taskId}:${leaseEpoch}` (one trace per attempt).
      // Every github/db/compute/token span emitted by the handler nests under this.
      const result = await tracing.withTrace(
        {
          traceId: `${task._id}:${task.leaseEpoch}`,
          taskId: task._id,
          agentId,
          searchId: task.searchId,
          attempt: task.leaseEpoch,
          name: 'task.bucket',
          kind: 'task',
          attr: (r) => ({
            type: task.type,
            day: task.payload && task.payload.day,
            term: task.payload && task.payload.term,
            usersNew: r && r.usersNew,
            usersFound: r && r.usersFound,
            requests: r && r.requests,
          }),
        },
        () => handler.run(task.payload, ctx)
      );
      clearTimeout(watchdog);

      if (result?.aborted || leaseLost) {
        // Abort (lost lease / paused / capacity) — release without burning an attempt.
        await taskQueue.releaseTask(task._id, agentId, task.leaseEpoch, 'pending', true);
      } else {
        await taskQueue.completeTask(
          task._id,
          agentId,
          task.leaseEpoch,
          { usersNew: result.usersNew, requests: result.requests, ms: Date.now() - startedAt },
          { globalKey: task.globalKey, searchId: task.searchId }
        );
        metricsInc.tasksDone = (metricsInc.tasksDone || 0) + 1;
        metricsInc.requestsMade = (metricsInc.requestsMade || 0) + (result.requests || 0);
      }
    } catch (e) {
      clearTimeout(watchdog);
      await taskQueue.failTask(task._id, agentId, task.leaseEpoch, { message: e.message, code: e.code });
      metricsInc.tasksFailed = (metricsInc.tasksFailed || 0) + 1;
    }
    currentTask = null;
  }

  // Main loop.
  (async () => {
    while (!stopped) {
      try {
        // Refresh the command channel quickly so pause/stop/preempt/assign react within
        // ~CLAIM_IDLE_BACKOFF_MS (not the 15s heartbeat), and reflect the status promptly.
        const fresh = await agentRegistry.readControl(agentId);
        if (fresh) {
          control = fresh.control || control;
          if (fresh.instanceId && fresh.instanceId !== instanceId) superseded = true;
        }
        await agentRegistry
          .setStatus(agentId, statusFor(), currentTask ? currentTask._id : null)
          .catch(() => {});

        // A newer deploy took over this agentId → release current work (the handler aborts
        // via shouldAbort and the task returns to 'pending') and stop claiming. Render's
        // SIGTERM then becomes a backstop rather than the trigger.
        if (superseded) {
          logger.info(`[agent ${agentId}] superseded by a newer instance — draining`);
          break;
        }
        if (control.command === 'stop') break;
        if (control.command === 'pause') {
          await sleep(CLAIM_IDLE_BACKOFF_MS);
          continue;
        }
        if (control.command === 'preempt') {
          // No current task to preempt at the top of the loop → just clear it.
          await agentRegistry.clearControl(agentId);
          control = { command: 'run', assignTaskId: null };
        }

        // Force-assigned tasks first (pre-leased to this agent), then the open pool.
        let task = await taskQueue.findAndStartAssigned(agentId);
        if (!task && control.command !== 'drain') {
          task = await taskQueue.claimTask(agentId, capabilities);
        }

        if (!task) {
          if (control.command === 'drain') break;
          await sleep(CLAIM_IDLE_BACKOFF_MS + Math.floor(Math.random() * 1000)); // jitter (D4)
          continue;
        }

        await runTask(task);
      } catch (e) {
        logger.error(`[agent ${agentId}] loop error: ${e.message}`);
        await sleep(2000);
      }
    }
    clearInterval(hb);
    // Don't overwrite the shared record's status if a newer instance now owns this agentId.
    if (!superseded) await agentRegistry.markStopped(agentId);
    logger.info(`[agent ${agentId}] stopped${superseded ? ' (superseded by newer deploy)' : ''}`);
  })();

  const stop = async () => {
    stopped = true;
    clearInterval(hb);
    // Release an in-flight task so it isn't stranded until lease expiry.
    if (currentTask) {
      await taskQueue
        .releaseTask(currentTask._id, agentId, currentTask.leaseEpoch, 'pending', true)
        .catch(() => {});
    }
    if (!superseded) await agentRegistry.markStopped(agentId).catch(() => {});
  };

  return { agentId, stop };
}

module.exports = { startAgent, HANDLERS };
