/**
 * Span Model - dedicated tracing store for the agent workflow.
 *
 * One document = one timed step (a "span"). Spans nest via parentSpanId to form
 * a per-task TRACE tree:
 *   task.bucket → [ token.wait, github.search*, github.profile, location.extract,
 *                   contact.discover, db.upsertUser, apify.enrich, ... ]
 *
 * A trace == one task ATTEMPT, identified by traceId = `${taskId}:${leaseEpoch}`
 * (leaseEpoch increments on every (re)claim, so each attempt is its own trace).
 *
 * This is intentionally SEPARATE from the Event collection (audit log): Event
 * answers "what happened", Span answers "how long did each step take and what
 * nested under it".
 *
 * RETENTION: spans are kept INDEFINITELY by default (no TTL). This collection is
 * high-volume, so it will grow without bound - prune/archive it yourself, or set
 * SPAN_TTL_DAYS to a positive number to auto-expire spans older than that many
 * days (e.g. SPAN_TTL_DAYS=30). 0 / unset = keep forever.
 *
 * Written exclusively by services/observability/tracing.js (buffered insertMany).
 */

const mongoose = require('mongoose');

// Retention in days. 0 (default) = no expiry; spans are kept forever.
const SPAN_TTL_DAYS = parseInt(process.env.SPAN_TTL_DAYS || '0', 10);

const spanSchema = new mongoose.Schema(
  {
    traceId: { type: String, required: true },     // `${taskId}:${attempt}`
    spanId: { type: String, required: true },       // unique id of this span
    parentSpanId: { type: String, default: null },  // null for the root (task) span

    name: { type: String, required: true },          // e.g. 'github.search', 'db.updateOne'
    kind: {
      type: String,
      enum: ['task', 'github', 'db', 'compute', 'token', 'apify', 'http'],
      required: true,
    },

    startTs: { type: Date, default: Date.now },
    endTs: { type: Date },
    durationMs: { type: Number },

    status: { type: String, enum: ['ok', 'error', 'aborted'], default: 'ok' },

    // Correlation ids (sparse - pivot any of these to stitch a timeline).
    taskId: { type: mongoose.Schema.Types.ObjectId, default: null },
    agentId: { type: String, default: null },
    searchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    tokenId: { type: mongoose.Schema.Types.ObjectId, default: null },
    attempt: { type: Number, default: null }, // == leaseEpoch

    // kind-specific detail (capped before insert in tracing.js):
    //   github: { method, endpoint, params, statusCode, rateRemaining, resultCount }
    //   db:     { op, collection, docCount }
    //   token:  { resource, reason }
    //   compute:{ input, output }
    attr: { type: mongoose.Schema.Types.Mixed },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false }
);

// Build a trace's waterfall fast.
spanSchema.index({ traceId: 1, startTs: 1 });
// Time-series analytics by kind / name.
spanSchema.index({ kind: 1, startTs: -1 });
spanSchema.index({ name: 1, startTs: -1 });
// Per-search drill-down.
spanSchema.index({ searchId: 1, startTs: -1 });
// Per-agent utilization.
spanSchema.index({ agentId: 1, startTs: -1 });
// Time-range scans over the whole collection. When SPAN_TTL_DAYS > 0 this same
// index also auto-expires old spans; default (0) keeps spans forever (no limit).
// (A key can carry only ONE index, so the TTL and plain forms are exclusive.)
if (SPAN_TTL_DAYS > 0) {
  spanSchema.index({ startTs: 1 }, { expireAfterSeconds: SPAN_TTL_DAYS * 24 * 3600 });
} else {
  spanSchema.index({ startTs: 1 });
}

module.exports = mongoose.model('Span', spanSchema);
