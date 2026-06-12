/**
 * Event Model — append-only structured log stream for the agent system.
 *
 * Every meaningful step (by agents AND the manager) writes one event. This is the
 * audit trail and the data source for the monitoring UI. Correlation ids
 * (agentId / taskId / searchId / tokenId) let you trace any task end-to-end.
 *
 * A TTL index auto-deletes events older than EVENT_TTL_DAYS so this collection can
 * never fill the disk (failure mode D5).
 */

const mongoose = require('mongoose');

const EVENT_TTL_DAYS = 14;

const eventSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },

  level: {
    type: String,
    enum: ['debug', 'info', 'warn', 'error', 'critical'],
    default: 'info',
  },

  // Controlled vocabulary so events can be queried/aggregated, e.g.:
  //  task.created|claimed|progress|done|failed|dead|reclaimed|canceled|assigned
  //  agent.up|heartbeat|down|stalled|control
  //  token.rate_limited|exhausted|invalid|reset
  //  manager.reaper|rollup|generate   db.error
  type: { type: String, required: true, index: true },

  // Correlation ids (sparse — only set when relevant).
  agentId: { type: String, default: null },
  taskId: { type: mongoose.Schema.Types.ObjectId, default: null },
  searchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  tokenId: { type: mongoose.Schema.Types.ObjectId, default: null },

  message: String,
  data: mongoose.Schema.Types.Mixed, // structured detail (counts, codes, durations)
});

eventSchema.index({ searchId: 1, ts: -1 });
eventSchema.index({ agentId: 1, ts: -1 });
eventSchema.index({ level: 1, ts: -1 });
// TTL: auto-expire old events (D5).
eventSchema.index({ ts: 1 }, { expireAfterSeconds: EVENT_TTL_DAYS * 24 * 3600 });

module.exports = mongoose.model('Event', eventSchema);
