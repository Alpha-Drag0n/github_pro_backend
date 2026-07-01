/**
 * Agent & Task management API - powers the monitoring dashboard and the
 * Agent / Task management pages (force-assign, priority, pause/stop, retry).
 * Mounted under /api (protected).
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Agent = require('../models/agentModel');
const Task = require('../models/taskModel');
const Event = require('../models/eventModel');
const taskQueue = require('../services/agent/taskQueue');
const agentRegistry = require('../services/agent/agentRegistry');
const { pingHealth } = require('../services/keepAlive');
const Logger = require('../utils/logger');

const logger = new Logger();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  logger.error(`[agentRoutes] ${e.message}`);
  res.status(500).json({ error: e.message });
});

/* ---------------- monitoring ---------------- */

// Fleet overview.
router.get('/agents', wrap(async (req, res) => {
  const agents = await Agent.find().sort({ lastHeartbeat: -1 });
  res.json(agents);
}));

// Tasks with filtering, sorting, and pagination.
const SORTABLE = ['priority', 'updatedAt', 'createdAt', 'attempts', 'status'];
router.get('/tasks', wrap(async (req, res) => {
  const { searchId, status, type, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
  const sortField = SORTABLE.includes(req.query.sort) ? req.query.sort : 'updatedAt';
  const dir = req.query.dir === 'asc' ? 1 : -1;

  const filter = {};
  const sid = searchId && mongoose.Types.ObjectId.isValid(searchId)
    ? new mongoose.Types.ObjectId(searchId)
    : null;
  if (sid) filter.searchId = sid;
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (q) filter.globalKey = { $regex: q, $options: 'i' }; // search by day/term (globalKey)

  const [tasks, total, counts] = await Promise.all([
    Task.find(filter)
      .sort({ [sortField]: dir, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Task.countDocuments(filter),
    Task.aggregate([
      ...(sid ? [{ $match: { searchId: sid } }] : []),
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    tasks,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
  });
}));

// Recent events (the structured log stream).
router.get('/agent-events', wrap(async (req, res) => {
  const { searchId, agentId, level, type } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const filter = {};
  if (searchId) filter.searchId = searchId;
  if (agentId) filter.agentId = agentId;
  if (level) filter.level = level;
  if (type) filter.type = type;
  const events = await Event.find(filter).sort({ ts: -1 }).limit(limit);
  res.json(events);
}));

/* ---------------- agent control ---------------- */

router.post('/agents/:agentId/control', wrap(async (req, res) => {
  const { command, assignTaskId } = req.body;
  if (!['run', 'pause', 'drain', 'stop', 'preempt', 'sleep'].includes(command)) {
    return res.status(400).json({ error: 'Invalid command' });
  }
  await agentRegistry.setControl(req.params.agentId, command, assignTaskId || null);
  res.json({ ok: true });
}));

// Rename an agent and/or set its wake URL. name must be unique across the fleet (409 on clash);
// an empty name clears it (falls back to showing the agentId).
router.patch('/agents/:agentId', wrap(async (req, res) => {
  const { name, renderUrl } = req.body;
  const exists = await Agent.exists({ agentId: req.params.agentId });
  if (!exists) return res.status(404).json({ error: 'Agent not found' });

  let agent;
  if (name !== undefined) {
    try {
      agent = await agentRegistry.setName(req.params.agentId, name);
    } catch (e) {
      if (e.code === 'NAME_TAKEN') return res.status(409).json({ error: e.message });
      throw e;
    }
  }
  if (renderUrl !== undefined) {
    agent = await agentRegistry.setRenderUrl(req.params.agentId, renderUrl);
  }
  res.json(agent || (await Agent.findOne({ agentId: req.params.agentId })));
}));

// Wake a sleeping/suspended agent: reset its control to `run` (so the freshly-booted process
// does not immediately re-sleep on a stale command), then hit its Render URL to boot the
// idle-suspended web service. The boot can take ~30-60s, so a ping timeout is NOT a failure -
// the request itself is what triggers Render to spin the instance back up.
router.post('/agents/:agentId/wake', wrap(async (req, res) => {
  const agent = await Agent.findOne({ agentId: req.params.agentId }).select('renderUrl');
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!agent.renderUrl) {
    return res.status(400).json({ error: 'No renderUrl set for this agent. Add one first, then wake.' });
  }
  await agentRegistry.setControl(req.params.agentId, 'run');
  const ping = await pingHealth(agent.renderUrl);
  res.json({
    ok: true,
    triggered: true,
    url: agent.renderUrl,
    httpStatus: ping.httpStatus,
    responseTimeMs: ping.responseTimeMs,
    note: ping.httpStatus === 200
      ? 'Agent responded - awake.'
      : 'Wake request sent. Cold start may take up to a minute before the agent reappears.',
  });
}));

/* ---------------- task control ---------------- */

router.post('/tasks/:id/retry', wrap(async (req, res) => {
  await taskQueue.retryTask(req.params.id);
  res.json({ ok: true });
}));

router.post('/tasks/:id/priority', wrap(async (req, res) => {
  await taskQueue.setTaskPriority(req.params.id, parseInt(req.body.priority, 10) || 0);
  res.json({ ok: true });
}));

router.post('/tasks/:id/hold', wrap(async (req, res) => {
  await taskQueue.setTaskStatus(req.params.id, 'held');
  res.json({ ok: true });
}));

router.post('/tasks/:id/cancel', wrap(async (req, res) => {
  await taskQueue.setTaskStatus(req.params.id, 'canceled');
  res.json({ ok: true });
}));

// Force-assign a task to a specific agent (pre-lease, race-free). Optionally preempt.
router.post('/tasks/:id/assign', wrap(async (req, res) => {
  const { agentId, preempt } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const ok = await taskQueue.forceAssign(req.params.id, agentId);
  if (preempt) await agentRegistry.setControl(agentId, 'preempt');
  res.json({ ok });
}));

module.exports = router;
