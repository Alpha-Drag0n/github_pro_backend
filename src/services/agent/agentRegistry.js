/**
 * Agent registry — register agents, accept heartbeats, expose the control channel,
 * and let the manager reap dead agents.
 *
 * The heartbeat is the single liveness signal: agents call `heartbeat()` every
 * HEARTBEAT_MS unconditionally (idle or busy). The manager calls `reapDeadAgents()`
 * to mark anyone silent for > DEAD_AGENT_MS as dead.
 */

const Agent = require('../../models/agentModel');
const events = require('./eventService');
const { DEAD_AGENT_MS } = require('./agentConfig');

/** Register (or re-register) an agent. Returns the agent doc. */
async function register({ agentId, host, pid, version, capabilities, instanceId }) {
  const now = new Date();
  const agent = await Agent.findOneAndUpdate(
    { agentId },
    {
      // instanceId is set on EVERY (re)register: a newer deploy claiming the same agentId
      // overwrites it, which is how the older instance learns it has been superseded.
      $set: { host, pid, version, capabilities, instanceId, status: 'idle', lastHeartbeat: now },
      // Initialize the control channel ONLY on first insert — a re-register (restart/
      // reconnect with a reused agentId) must not clobber a pending manager command.
      $setOnInsert: {
        startedAt: now,
        'control.command': 'run',
        'control.assignTaskId': null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await events.emit({ type: 'agent.up', agentId, message: `agent ${agentId} online`, data: { host, pid } });
  return agent;
}

/**
 * Heartbeat: refresh liveness + status/metrics, and RETURN the current control doc so
 * the agent can react to manager commands in the same round-trip.
 */
async function heartbeat(agentId, patch = {}) {
  const set = { lastHeartbeat: new Date() };
  if (patch.status) set.status = patch.status;
  if ('currentTaskId' in patch) set.currentTaskId = patch.currentTaskId;
  if ('currentTokenId' in patch) set.currentTokenId = patch.currentTokenId;

  const inc = {};
  if (patch.metricsInc) {
    for (const [k, v] of Object.entries(patch.metricsInc)) inc[`metrics.${k}`] = v;
  }

  const update = { $set: set };
  if (Object.keys(inc).length) update.$inc = inc;

  const agent = await Agent.findOneAndUpdate({ agentId }, update, { new: true });
  return agent
    ? { control: agent.control, instanceId: agent.instanceId }
    : { control: { command: 'run', assignTaskId: null }, instanceId: null };
}

/** Read the control channel + current instanceId (cheap) so the agent loop can react quickly. */
async function readControl(agentId) {
  const a = await Agent.findOne({ agentId }).select('control instanceId');
  return a ? { control: a.control, instanceId: a.instanceId } : null;
}

/** Light status-only update (used by the loop to reflect paused/draining/idle/busy promptly). */
async function setStatus(agentId, status, currentTaskId = undefined) {
  const set = { status };
  if (currentTaskId !== undefined) set.currentTaskId = currentTaskId;
  await Agent.updateOne({ agentId }, { $set: set });
}

/** Manager → agent command. */
async function setControl(agentId, command, assignTaskId = null) {
  await Agent.updateOne(
    { agentId },
    { $set: { 'control.command': command, 'control.assignTaskId': assignTaskId, 'control.requestedAt': new Date() } }
  );
  await events.emit({ type: 'agent.control', agentId, message: `control=${command}`, data: { assignTaskId } });
}

/** Agent acknowledges a one-shot command (e.g. preempt) by resetting to 'run'. */
async function clearControl(agentId) {
  await Agent.updateOne(
    { agentId },
    { $set: { 'control.command': 'run', 'control.assignTaskId': null } }
  );
}

async function markStopped(agentId) {
  await Agent.updateOne({ agentId }, { $set: { status: 'stopped' } });
  await events.emit({ type: 'agent.down', agentId, message: `agent ${agentId} stopped` });
}

/**
 * Mark agents silent for too long as `dead`. Their leased tasks are reclaimed
 * separately by the task reaper (lease expiry). Returns the number marked.
 */
async function reapDeadAgents() {
  const cutoff = new Date(Date.now() - DEAD_AGENT_MS);
  const dead = await Agent.find({
    status: { $in: ['starting', 'idle', 'busy', 'draining'] },
    lastHeartbeat: { $lt: cutoff },
  }).select('agentId');

  for (const a of dead) {
    await Agent.updateOne({ _id: a._id }, { $set: { status: 'dead' } });
    await events.emit({
      type: 'agent.down',
      level: 'warn',
      agentId: a.agentId,
      message: `agent ${a.agentId} declared dead (no heartbeat)`,
    });
  }
  return dead.length;
}

module.exports = {
  register,
  heartbeat,
  readControl,
  setStatus,
  setControl,
  clearControl,
  markStopped,
  reapDeadAgents,
};
