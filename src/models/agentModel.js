/**
 * Agent Model — fleet registry, health, and the manager→agent control channel.
 *
 * Each running agent owns one document. The agent UPDATES its own row (heartbeat,
 * status, metrics); the manager READS it for monitoring and WRITES `control` to
 * issue commands. Communication is entirely through MongoDB — no direct RPC.
 *
 * Liveness: the agent heartbeats unconditionally every HEARTBEAT_MS (alive signal,
 * idle or busy). The manager declares an agent `dead` when
 *   now - lastHeartbeat > DEAD_THRESHOLD (3 × heartbeat interval).
 */

const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema(
  {
    // Stable identity for a logical agent slot, reused across redeploys, e.g.
    // `${RENDER_SERVICE_ID}-${ordinal}`. The agent record is upserted on this key.
    agentId: { type: String, required: true, unique: true },

    // Unique per process boot (RENDER_INSTANCE_ID, else host:pid). A newer deploy registering
    // with the SAME agentId overwrites this; the older instance sees the mismatch and self-drains.
    instanceId: { type: String, default: null },

    host: String,
    pid: Number,
    version: String,

    status: {
      type: String,
      enum: ['starting', 'idle', 'busy', 'paused', 'draining', 'stopped', 'dead'],
      default: 'starting',
      index: true,
    },

    // Task types this agent can run, e.g. ['deep-search-bucket'].
    capabilities: { type: [String], default: [] },

    currentTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    currentTokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'Token', default: null },

    // The single liveness signal (see header).
    lastHeartbeat: { type: Date, index: true },
    startedAt: Date,

    metrics: {
      tasksDone: { type: Number, default: 0 },
      tasksFailed: { type: Number, default: 0 },
      requestsMade: { type: Number, default: 0 },
      avgTaskMs: { type: Number, default: 0 },
      lastTaskAt: Date,
    },

    // CONTROL CHANNEL (manager → agent). The agent reads this on each heartbeat and obeys.
    //   run     : work normally
    //   pause   : stop claiming new tasks (keep heartbeating)
    //   drain   : finish current task, then go idle and stop claiming
    //   stop    : finish/release current task, then exit the process
    //   preempt : abort the current task and release it back to the pool
    control: {
      command: {
        type: String,
        enum: ['run', 'pause', 'drain', 'stop', 'preempt'],
        default: 'run',
      },
      // When force-assigning a specific task to this agent (paired with task.assignedByManager).
      assignTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
      requestedAt: Date,
    },

    lastError: { message: String, at: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Agent', agentSchema);
