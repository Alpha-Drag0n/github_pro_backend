/**
 * Agent Model - fleet registry, health, and the manager→agent control channel.
 *
 * Each running agent owns one document. The agent UPDATES its own row (heartbeat,
 * status, metrics); the manager READS it for monitoring and WRITES `control` to
 * issue commands. Communication is entirely through MongoDB - no direct RPC.
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

    // Human-friendly display name, unique across the fleet (see the partial unique index
    // below - null/absent is allowed for many agents, but any two set names must differ).
    // The UI shows `name || agentId` everywhere; this is purely cosmetic identity.
    name: { type: String, default: null, trim: true },

    // Public Render URL for this agent's web service (auto-captured from RENDER_EXTERNAL_URL
    // on register, manually overridable). Hitting it wakes a spun-down free-tier instance,
    // which is how `sleeping` agents are brought back (see POST /agents/:id/wake).
    renderUrl: { type: String, default: null },

    // Unique per process boot (RENDER_INSTANCE_ID, else host:pid). A newer deploy registering
    // with the SAME agentId overwrites this; the older instance sees the mismatch and self-drains.
    instanceId: { type: String, default: null },

    host: String,
    pid: Number,
    version: String,

    // `sleeping` is an INTENTIONAL rest state: the agent stopped its self keep-alive so
    // Render idle-suspends the instance. Unlike `dead` (missed heartbeats), the reaper
    // leaves `sleeping` agents alone - they are woken on demand via their renderUrl.
    status: {
      type: String,
      enum: ['starting', 'idle', 'busy', 'paused', 'draining', 'sleeping', 'stopped', 'dead'],
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

// Unique display name, but ONLY among agents that actually have one - a partial index so
// the many agents with name=null don't collide with each other (a plain unique index would
// reject all-but-one null). Any two STRING names must differ.
agentSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { name: { $type: 'string' } } }
);

module.exports = mongoose.model('Agent', agentSchema);
