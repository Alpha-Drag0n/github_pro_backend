/**
 * Metrics / Observability API — aggregates the `spans` collection (plus Task,
 * Agent, Token) into the time-series the Monitoring page renders. Mounted under
 * /api (protected). Read-only.
 *
 * Endpoints return the SAME shape the frontend mock produces, so the page can
 * switch from mock to live with no component changes:
 *   GET /metrics/overview?range=1h   → { range, series, kpis }
 *   GET /metrics/traces?range&limit  → [ traceSummary ]
 *   GET /metrics/trace/:traceId      → { trace, spans }
 *   GET /metrics/tokens              → [ tokenHealth ]
 *   GET /metrics/agents?range        → [ agentRow + segments ]
 *   GET /metrics/yield?range         → { funnel, ... }
 */

const express = require('express');
const router = express.Router();
const Span = require('../models/spanModel');
const Task = require('../models/taskModel');
const Agent = require('../models/agentModel');
const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');

const logger = new Logger();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  logger.error(`[metricsRoutes] ${e.message}`);
  res.status(500).json({ error: e.message });
});

const RANGES = {
  '15m': { ms: 15 * 60_000, buckets: 15 },
  '1h': { ms: 60 * 60_000, buckets: 30 },
  '6h': { ms: 6 * 60 * 60_000, buckets: 24 },
  '24h': { ms: 24 * 60 * 60_000, buckets: 24 },
};
const SPAN_FETCH_CAP = 100_000;
const DAY_MS = 24 * 60 * 60_000;

// Accepts the request query: either { range:'1h' } (relative-to-now preset) or
// { from, to } (absolute epoch-ms window). Returns a normalized window.
function rangeOf(q = {}) {
  const now = Date.now();
  const from = q.from != null && q.from !== '' ? Number(q.from) : null;
  const to = q.to != null && q.to !== '' ? Number(q.to) : null;
  if (from && to && to > from) {
    const ms = to - from;
    const buckets = Math.max(8, Math.min(60, 30)); // fixed bucket target for custom windows
    return { key: 'custom', custom: true, ms, buckets, now, since: from, until: to, stepMs: ms / buckets };
  }
  const r = RANGES[q.range] || RANGES['1h'];
  return { ...r, key: RANGES[q.range] ? q.range : '1h', custom: false, now, since: now - r.ms, until: now, stepMs: r.ms / r.buckets };
}
function pad(n) { return String(n).padStart(2, '0'); }
function clock(ts, longWindow = false) {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return longWindow ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}` : hm;
}
function emptyBuckets(n, v = 0) {
  return Array.from({ length: n }, () => v);
}
function bucketIndex(ts, since, stepMs, buckets) {
  const i = Math.floor((new Date(ts).getTime() - since) / stepMs);
  return i < 0 ? 0 : i >= buckets ? buckets - 1 : i;
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/* ---------------- overview ---------------- */
router.get('/metrics/overview', wrap(async (req, res) => {
  const R = rangeOf(req.query);
  const { since, until, stepMs, buckets } = R;
  const longWindow = (until - since) > DAY_MS;
  const labels = Array.from({ length: buckets }, (_, b) => clock(since + b * stepMs + stepMs / 2, longWindow));
  const tsFilter = { $gte: new Date(since), $lte: new Date(until) };

  const [githubSpans, tokenSpans, taskSpans, taskCounts] = await Promise.all([
    Span.find({ kind: 'github', startTs: tsFilter })
      .select('startTs durationMs status attr.statusCode').limit(SPAN_FETCH_CAP).lean(),
    Span.find({ kind: 'token', startTs: tsFilter })
      .select('startTs durationMs').limit(SPAN_FETCH_CAP).lean(),
    Span.find({ kind: 'task', startTs: tsFilter })
      .select('startTs status').limit(SPAN_FETCH_CAP).lean(),
    Task.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);

  // GitHub latency percentiles + status mix per bucket
  const durs = Array.from({ length: buckets }, () => []);
  const ok = emptyBuckets(buckets), c4xx = emptyBuckets(buckets), c5xx = emptyBuckets(buckets), c429 = emptyBuckets(buckets), rpm = emptyBuckets(buckets);
  for (const s of githubSpans) {
    const b = bucketIndex(s.startTs, since, stepMs, buckets);
    durs[b].push(s.durationMs || 0);
    rpm[b] += 1;
    const code = s.attr && s.attr.statusCode;
    if (code === 429) c429[b] += 1;
    else if (code >= 500) c5xx[b] += 1;
    else if (code >= 400) c4xx[b] += 1;
    else ok[b] += 1;
  }
  const p50 = [], p95 = [], p99 = [];
  for (let b = 0; b < buckets; b++) {
    const sorted = durs[b].slice().sort((a, z) => a - z);
    p50.push(percentile(sorted, 50)); p95.push(percentile(sorted, 95)); p99.push(percentile(sorted, 99));
  }

  // token wait p95 per bucket
  const waitBuckets = Array.from({ length: buckets }, () => []);
  for (const s of tokenSpans) waitBuckets[bucketIndex(s.startTs, since, stepMs, buckets)].push(s.durationMs || 0);
  const wait = waitBuckets.map((arr) => percentile(arr.slice().sort((a, z) => a - z), 95));

  // task throughput per bucket (done/failed); pending/leased = current snapshot
  const done = emptyBuckets(buckets), failed = emptyBuckets(buckets);
  for (const s of taskSpans) {
    const b = bucketIndex(s.startTs, since, stepMs, buckets);
    if (s.status === 'error') failed[b] += 1; else done[b] += 1;
  }
  const counts = Object.fromEntries(taskCounts.map((c) => [c._id, c.n]));
  const pending = emptyBuckets(buckets); pending[buckets - 1] = counts.pending || 0;
  const leased = emptyBuckets(buckets); leased[buckets - 1] = counts.leased || 0;

  const arr = (a) => a.reduce((s, x) => s + x, 0);
  const totalReq = arr(rpm);
  const totalErr = arr(c4xx) + arr(c5xx) + arr(c429);
  const coolingTokens = await Token.countDocuments({ cooldownUntil: { $gt: new Date() } });
  const totalTokens = await Token.countDocuments({});
  // Latest span overall (any kind) so the UI can flag empty windows and offer to
  // jump to the last activity.
  const lastSpan = await Span.findOne({}, { startTs: 1 }).sort({ startTs: -1 }).lean();

  res.json({
    range: R.key,
    lastActivityTs: lastSpan ? new Date(lastSpan.startTs).getTime() : null,
    series: { labels, github: { p50, p95, p99, ok, c4xx, c5xx, c429, rpm }, queue: { done, failed, pending, leased }, wait },
    kpis: {
      tasksDone: arr(done),
      tasksFailed: arr(failed),
      githubRpm: labels.length ? Math.round(totalReq / labels.length) : 0,
      githubP95: p95.length ? Math.round(p95.reduce((s, x) => s + x, 0) / p95.length) : 0,
      errorRatePct: totalReq ? +((totalErr / totalReq) * 100).toFixed(1) : 0,
      tokenWaitP95: wait.length ? Math.max(...wait) : 0,
      usersSaved: 0, // filled by /yield on the page
      dedupSavedPct: 0,
      activeAgents: await Agent.countDocuments({ status: { $nin: ['dead', 'stopped'] } }),
      totalAgents: await Agent.countDocuments({}),
      coolingTokens,
      totalTokens,
      liveLeased: counts.leased || 0,
    },
  });
}));

/* ---------------- traces (paginated) ---------------- */
router.get('/metrics/traces', wrap(async (req, res) => {
  const R = rangeOf(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const taskFilter = { kind: 'task', startTs: { $gte: new Date(R.since), $lte: new Date(R.until) } };
  if (req.query.agentId) taskFilter.agentId = req.query.agentId; // per-agent timeline

  // Server-side aggregation for wide windows: return per-bucket outcome counts
  // (count/ok/error/aborted) instead of thousands of raw rows.
  if (req.query.agg) {
    const nb = Math.max(8, Math.min(200, parseInt(req.query.buckets, 10) || 80));
    const stepMs = (R.until - R.since) / nb;
    const spans = await Span.find(taskFilter).select('startTs status').limit(SPAN_FETCH_CAP).lean();
    const buckets = Array.from({ length: nb }, (_, b) => ({ t: R.since + b * stepMs, count: 0, ok: 0, error: 0, aborted: 0 }));
    for (const s of spans) {
      const b = Math.max(0, Math.min(nb - 1, Math.floor((new Date(s.startTs).getTime() - R.since) / stepMs)));
      buckets[b].count += 1;
      buckets[b][s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : 'aborted'] += 1;
    }
    return res.json({ agg: true, total: spans.length, buckets });
  }

  const total = await Span.countDocuments(taskFilter);
  const pages = Math.max(1, Math.ceil(total / limit));
  const roots = await Span.find(taskFilter)
    .sort({ startTs: -1 }).skip((page - 1) * limit).limit(limit).lean();
  const ids = roots.map((r) => r.traceId);
  const agg = ids.length
    ? await Span.aggregate([
        { $match: { traceId: { $in: ids } } },
        { $group: {
            _id: '$traceId',
            github: { $sum: { $cond: [{ $eq: ['$kind', 'github'] }, 1, 0] } },
            db: { $sum: { $cond: [{ $eq: ['$kind', 'db'] }, 1, 0] } },
            waitMs: { $sum: { $cond: [{ $eq: ['$kind', 'token'] }, '$durationMs', 0] } },
            spanCount: { $sum: 1 },
        } },
      ])
    : [];
  const m = Object.fromEntries(agg.map((a) => [a._id, a]));
  res.json({
    page,
    pages,
    total,
    traces: roots.map((r) => ({
      traceId: r.traceId,
      taskId: r.taskId,
      agentId: r.agentId,
      searchId: r.searchId,
      attempt: r.attempt,
      status: r.status,
      durationMs: r.durationMs,
      startTs: new Date(r.startTs).getTime(),
      term: r.attr && r.attr.term,
      day: r.attr && r.attr.day,
      usersFound: (r.attr && (r.attr.usersFound != null ? r.attr.usersFound : r.attr.usersNew)) || 0,
      usersSaved: (r.attr && r.attr.usersNew) || 0,
      contacts: 0,
      tokenName: r.tokenId ? String(r.tokenId) : '—',
      githubCount: (m[r.traceId] && m[r.traceId].github) || 0,
      dbCount: (m[r.traceId] && m[r.traceId].db) || 0,
      waitedMs: (m[r.traceId] && m[r.traceId].waitMs) || 0,
      spanCount: (m[r.traceId] && m[r.traceId].spanCount) || 0,
    })),
  });
}));

/* ---------------- one trace (waterfall) ---------------- */
router.get('/metrics/trace/:traceId', wrap(async (req, res) => {
  const spans = await Span.find({ traceId: req.params.traceId }).sort({ startTs: 1 }).lean();
  res.json({
    traceId: req.params.traceId,
    spans: spans.map((s) => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      kind: s.kind,
      startTs: new Date(s.startTs).getTime(),
      endTs: new Date(s.endTs || s.startTs).getTime(),
      durationMs: s.durationMs,
      status: s.status,
      tokenId: s.tokenId ? String(s.tokenId) : null,
      attr: s.attr || {},
      error: s.error || null,
    })),
  });
}));

/* ---------------- tokens ---------------- */
router.get('/metrics/tokens', wrap(async (req, res) => {
  const R = rangeOf(req.query);
  const [tokens, waitSpans] = await Promise.all([
    Token.find({}).lean(),
    Span.find({ kind: 'token', startTs: { $gte: new Date(R.since) } }).select('tokenId durationMs').limit(SPAN_FETCH_CAP).lean(),
  ]);
  const byToken = {};
  for (const s of waitSpans) {
    const k = s.tokenId ? String(s.tokenId) : null;
    if (!k) continue;
    (byToken[k] = byToken[k] || []).push(s.durationMs || 0);
  }
  res.json(tokens.map((t) => {
    const waits = (byToken[String(t._id)] || []).sort((a, z) => a - z);
    return {
      tokenId: String(t._id),
      name: t.name,
      disabled: !!t.disabled,
      searchRemaining: (t.budget && t.budget.search && t.budget.search.remaining) || 0,
      searchLimit: (t.budget && t.budget.search && t.budget.search.limit) || 28,
      coreRemaining: (t.budget && t.budget.core && t.budget.core.remaining) || 0,
      coreLimit: (t.budget && t.budget.core && t.budget.core.limit) || 4500,
      cooldownUntil: t.cooldownUntil ? new Date(t.cooldownUntil).getTime() : null,
      consecutiveErrors: t.consecutiveErrors || 0,
      errorCount: t.errorCount || 0,
      successCount: t.successCount || 0,
      usageCount: t.usageCount || 0,
      waitMsP95: percentile(waits, 95),
    };
  }));
}));

/* ---------------- agents (fleet + utilization) ---------------- */
router.get('/metrics/agents', wrap(async (req, res) => {
  const R = rangeOf(req.query);
  const [agents, taskSpans] = await Promise.all([
    Agent.find({}).sort({ lastHeartbeat: -1 }).lean(),
    Span.find({ kind: 'task', startTs: { $gte: new Date(R.since) } })
      .select('agentId startTs endTs status').limit(SPAN_FETCH_CAP).lean(),
  ]);
  const segByAgent = {};
  for (const s of taskSpans) {
    if (!s.agentId) continue;
    (segByAgent[s.agentId] = segByAgent[s.agentId] || []).push({
      start: new Date(s.startTs).getTime(),
      end: new Date(s.endTs || s.startTs).getTime(),
      status: s.status === 'error' ? 'paused' : s.status === 'aborted' ? 'aborted' : 'busy',
    });
  }
  const now = Date.now();
  res.json(agents.map((a) => ({
    agentId: a.agentId,
    status: a.status,
    heartbeatAgeS: a.lastHeartbeat ? Math.round((now - new Date(a.lastHeartbeat).getTime()) / 1000) : 9999,
    tasksDone: (a.metrics && a.metrics.tasksDone) || 0,
    tasksFailed: (a.metrics && a.metrics.tasksFailed) || 0,
    requestsMade: (a.metrics && a.metrics.requestsMade) || 0,
    avgTaskMs: (a.metrics && a.metrics.avgTaskMs) || 0,
    segments: (segByAgent[a.agentId] || []).slice(0, 400),
  })));
}));

/* ---------------- business yield ---------------- */
router.get('/metrics/yield', wrap(async (req, res) => {
  const R = rangeOf(req.query);
  const since = new Date(R.since);
  const [searchAgg, profiles, contacts, apify, savedAgg] = await Promise.all([
    Span.aggregate([
      { $match: { name: 'github.search', startTs: { $gte: since } } },
      { $group: { _id: null, results: { $sum: { $ifNull: ['$attr.resultCount', 0] } } } },
    ]),
    Span.countDocuments({ name: 'github.profile', startTs: { $gte: since } }),
    Span.countDocuments({ name: 'contact.discover', startTs: { $gte: since } }),
    Span.countDocuments({ kind: 'apify', startTs: { $gte: since } }),
    Span.aggregate([
      { $match: { kind: 'task', startTs: { $gte: since } } },
      { $group: { _id: null, saved: { $sum: { $ifNull: ['$attr.usersNew', 0] } } } },
    ]),
  ]);
  const searchResults = (searchAgg[0] && searchAgg[0].results) || 0;
  const usersSaved = (savedAgg[0] && savedAgg[0].saved) || 0;
  res.json({
    funnel: [
      { stage: 'Search results', value: searchResults, kind: 'github' },
      { stage: 'Profiles fetched', value: profiles, kind: 'github' },
      { stage: 'Users saved', value: usersSaved, kind: 'db' },
      { stage: 'Contacts found', value: contacts, kind: 'compute' },
      { stage: 'LinkedIn enriched', value: apify, kind: 'apify' },
    ],
    dedupReusePct: 0,
    bucketsSkipped: 0,
    bucketsTotal: 0,
    emailHitRatePct: profiles ? +((contacts / profiles) * 100).toFixed(1) : 0,
  });
}));

module.exports = router;
