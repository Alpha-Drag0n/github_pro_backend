/**
 * tracing.js - the workflow tracing engine.
 *
 * Captures a per-task TRACE made of nested SPANS and writes them to the `spans`
 * collection (see models/spanModel.js). Designed around four cheap chokepoints:
 *   1. withTrace()   - wraps handler.run → the root task span (agentRunner.js)
 *   2. instrumentGithubAxios() - one axios interceptor → every GitHub request
 *   3. dbPlugin (global mongoose plugin) → every DB read/write inside a trace
 *   4. withSpan()    - wraps a business function (location/contact/etc.)
 *
 * Context flows implicitly via AsyncLocalStorage, so child code emits correctly
 * parented spans WITHOUT threading a ctx object everywhere.
 *
 * SAFETY (this runs in the hot path):
 *   - Everything is fire-and-forget and wrapped in try/catch - tracing must
 *     NEVER throw into or slow the work loop.
 *   - Spans are BUFFERED and bulk-inserted (mirrors requestLogService), never
 *     one awaited insert per event.
 *   - Telemetry collections are excluded from DB tracing (no self-recursion).
 *   - Kill switches: TRACING_ENABLED=false (all), TRACE_DB=false (db spans only).
 *   - Task-level sampling: TRACE_SAMPLE=0.2 fully traces 20% of tasks (default 1).
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');
const Logger = require('../../utils/logger');

const logger = new Logger();
const als = new AsyncLocalStorage();

const ENABLED = process.env.TRACING_ENABLED !== 'false';
const DB_ENABLED = ENABLED && process.env.TRACE_DB !== 'false';
const SAMPLE = Math.max(0, Math.min(1, parseFloat(process.env.TRACE_SAMPLE || '1')));
const BATCH = parseInt(process.env.TRACE_BATCH || '200', 10);
const FLUSH_MS = parseInt(process.env.TRACE_FLUSH_MS || '5000', 10);
const ATTR_MAX = 1024;
const EXCLUDE_COLLECTIONS = new Set(['spans', 'events', 'requestlogs', 'healthlogs']);

const genId = () => crypto.randomBytes(8).toString('hex');
const safe = (fn) => { try { return fn(); } catch { return undefined; } };

// Lazy require so models compile AFTER the global plugin is registered.
let Span = null;
const spanModel = () => (Span || (Span = require('../../models/spanModel')));

/* ------------------------------------------------------------------ *
 * Buffered emitter (bulk insert; never one-await-per-span)
 * ------------------------------------------------------------------ */
let buffer = [];
let flushTimer = null;
let flushing = false;
let bufferCapWarned = false;

function startFlushTimer() {
  if (flushTimer || !ENABLED) return;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref(); // don't keep the process alive for this
}

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await spanModel().insertMany(batch, { ordered: false });
    bufferCapWarned = false; // recovered
  } catch (e) {
    // Bounded re-buffer: never grow without limit, even in a Mongo outage.
    if (buffer.length < BATCH * 5) {
      buffer = batch.slice(-BATCH).concat(buffer);
      logger.warn(`[tracing] span flush failed (${batch.length} re-buffered): ${e.message}`);
    } else if (!bufferCapWarned) {
      // High-water mark: make prolonged span loss visible (once, until recovery).
      bufferCapWarned = true;
      logger.error(`[tracing] span buffer at cap (${buffer.length}); dropping spans until Mongo recovers: ${e.message}`);
    }
  } finally {
    flushing = false;
  }
}

function capAttr(attr) {
  if (attr == null) return undefined;
  try {
    const s = JSON.stringify(attr);
    if (s.length <= ATTR_MAX) return attr;
    return { _truncated: true, preview: s.slice(0, ATTR_MAX) };
  } catch {
    return undefined;
  }
}

/** Low-level: queue one span. Honors sampling (task spans always recorded). */
function recordSpan(span) {
  if (!ENABLED) return;
  try {
    const store = als.getStore();
    if (span.kind !== 'task' && store && store.sampled === false) return;
    buffer.push({
      traceId: span.traceId,
      spanId: span.spanId || genId(),
      parentSpanId: span.parentSpanId || null,
      name: span.name,
      kind: span.kind,
      startTs: span.startTs,
      endTs: span.endTs,
      durationMs: span.durationMs,
      status: span.status || 'ok',
      taskId: span.taskId || null,
      agentId: span.agentId || null,
      searchId: span.searchId || null,
      tokenId: span.tokenId || null,
      attempt: span.attempt != null ? span.attempt : null,
      attr: capAttr(span.attr),
      error: span.error || null,
    });
    if (buffer.length >= BATCH) flush().catch(() => {});
    startFlushTimer();
  } catch {
    /* never throw into the app */
  }
}

/* ------------------------------------------------------------------ *
 * Context + span wrappers
 * ------------------------------------------------------------------ */
const currentContext = () => als.getStore() || null;

/** Set the active token on the current trace so child github/db spans attribute it. */
function setToken(tokenId, tokenName) {
  const s = als.getStore();
  if (s) {
    if (tokenId) s.tokenId = tokenId;
    if (tokenName) s.tokenName = tokenName;
  }
}

/**
 * Run fn as the ROOT of a new trace. Records the root (task) span on completion.
 * @param {object} meta { traceId, taskId, agentId, searchId, attempt, name, kind, attr|attrFn }
 */
async function withTrace(meta, fn) {
  if (!ENABLED) return fn();
  const sampled = SAMPLE >= 1 ? true : Math.random() < SAMPLE;
  const spanId = genId();
  const store = {
    traceId: meta.traceId,
    taskId: meta.taskId || null,
    agentId: meta.agentId || null,
    searchId: meta.searchId || null,
    attempt: meta.attempt != null ? meta.attempt : null,
    tokenId: null,
    spanId,
    sampled,
  };
  const start = Date.now();
  return als.run(store, async () => {
    let status = 'ok';
    let error = null;
    let result;
    try {
      result = await fn();
      if (result && result.aborted) status = 'aborted';
      return result;
    } catch (e) {
      status = 'error';
      error = { message: e.message, code: e.code || null };
      throw e;
    } finally {
      const attr = typeof meta.attr === 'function' ? safe(() => meta.attr(result)) : meta.attr;
      recordSpan({
        traceId: store.traceId, spanId, parentSpanId: null,
        name: meta.name || 'task', kind: meta.kind || 'task',
        startTs: new Date(start), endTs: new Date(), durationMs: Date.now() - start,
        status, taskId: store.taskId, agentId: store.agentId, searchId: store.searchId,
        tokenId: store.tokenId, attempt: store.attempt, attr, error,
      });
    }
  });
}

/**
 * Wrap fn as a CHILD span of the current trace. No-op (just runs fn) when there
 * is no active trace, so it is safe to sprinkle anywhere.
 */
async function withSpan(name, kind, fn, attrFn) {
  if (!ENABLED) return fn();
  const parent = als.getStore();
  if (!parent) return fn();
  const spanId = genId();
  const childStore = { ...parent, spanId, parentSpanId: parent.spanId };
  const start = Date.now();
  return als.run(childStore, async () => {
    let status = 'ok';
    let error = null;
    let result;
    try {
      result = await fn();
      return result;
    } catch (e) {
      status = 'error';
      error = { message: e.message, code: e.code || null };
      throw e;
    } finally {
      const attr = typeof attrFn === 'function' ? safe(() => attrFn(result)) : attrFn;
      recordSpan({
        traceId: parent.traceId, spanId, parentSpanId: parent.spanId,
        name, kind, startTs: new Date(start), endTs: new Date(), durationMs: Date.now() - start,
        status, taskId: parent.taskId, agentId: parent.agentId, searchId: parent.searchId,
        tokenId: childStore.tokenId || parent.tokenId, attempt: parent.attempt, attr, error,
      });
    }
  });
}

/** Record an already-measured leaf span (start/end known). Used for token.wait. */
function recordLeaf({ name, kind, start, end, status, attr, error, tokenId }) {
  const parent = als.getStore();
  if (!parent) return;
  recordSpan({
    traceId: parent.traceId, spanId: genId(), parentSpanId: parent.spanId,
    name, kind, startTs: new Date(start), endTs: new Date(end || Date.now()),
    durationMs: (end || Date.now()) - start, status: status || 'ok',
    taskId: parent.taskId, agentId: parent.agentId, searchId: parent.searchId,
    tokenId: tokenId || parent.tokenId, attempt: parent.attempt, attr, error: error || null,
  });
}

/* ------------------------------------------------------------------ *
 * GitHub axios instrumentation (chokepoint #2)
 * ------------------------------------------------------------------ */
function classifyGithub(url = '') {
  if (url.includes('/search/users')) return 'github.search';
  if (url.includes('/search/commits')) return 'github.commits';
  if (/\/readme/i.test(url)) return 'github.readme';
  if (/\/repos$/i.test(url) || /\/repos\?/i.test(url) || /users\/[^/]+\/repos/i.test(url)) return 'github.repos';
  if (/^\/?users\/[^/]+$/.test(url)) return 'github.profile';
  if (/^\/?repos\//.test(url)) return 'github.repo';
  if (url.includes('/rate_limit')) return 'github.ratelimit';
  return 'github.request';
}

function emitGithubSpan(config, response, error, staticMeta) {
  try {
    const parent = als.getStore();
    if (!parent || !config) return; // only record within a trace
    const start = config.__traceStart || Date.now();
    const url = config.url || '';
    const headers = response?.headers || {};
    const statusCode = response?.status ?? error?.response?.status ?? null;
    recordSpan({
      traceId: parent.traceId, spanId: genId(), parentSpanId: parent.spanId,
      name: classifyGithub(url), kind: 'github',
      startTs: new Date(start), endTs: new Date(), durationMs: Date.now() - start,
      status: error ? 'error' : 'ok',
      taskId: parent.taskId, agentId: parent.agentId, searchId: parent.searchId,
      tokenId: staticMeta.tokenId || parent.tokenId || null, attempt: parent.attempt,
      attr: {
        method: (config.method || 'get').toUpperCase(),
        endpoint: url,
        params: config.params,
        statusCode,
        rateRemaining: headers['x-ratelimit-remaining'] != null ? Number(headers['x-ratelimit-remaining']) : undefined,
        resultCount: Array.isArray(response?.data?.items) ? response.data.items.length : undefined,
      },
      error: error ? { message: error.message, code: error.code || (statusCode ? `HTTP_${statusCode}` : null) } : null,
    });
  } catch {
    /* swallow */
  }
}

/** Attach request/response interceptors to a GitHubClient axios instance. */
function instrumentGithubAxios(instance, staticMeta = {}) {
  if (!ENABLED || !instance || instance.__traced) return instance;
  instance.__traced = true;
  instance.interceptors.request.use(
    (config) => { config.__traceStart = Date.now(); return config; },
    (err) => Promise.reject(err)
  );
  instance.interceptors.response.use(
    (response) => { emitGithubSpan(response.config, response, null, staticMeta); return response; },
    (error) => { emitGithubSpan(error.config, error.response, error, staticMeta); return Promise.reject(error); }
  );
  return instance;
}

/* ------------------------------------------------------------------ *
 * DB instrumentation (chokepoint #3) - global mongoose plugin
 * ------------------------------------------------------------------ */
const DB_QUERY_OPS = [
  'count', 'countDocuments', 'estimatedDocumentCount', 'find', 'findOne',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'aggregate',
];

function collectionOf(ctx) {
  return (
    ctx?.model?.collection?.collectionName ||
    ctx?._model?.collection?.collectionName ||
    ctx?.mongooseCollection?.collectionName ||
    ctx?.constructor?.collection?.collectionName ||
    null
  );
}

let collectionResolveWarned = false;
function recordDbSpan(ctx, start, err, result, forcedOp) {
  if (!DB_ENABLED || !start) return;
  const store = als.getStore();
  if (!store) return; // only DB ops INSIDE a trace are recorded (skips heartbeats/rollups)
  const collection = collectionOf(ctx);
  if (!collection) {
    if (!collectionResolveWarned) {
      collectionResolveWarned = true;
      logger.warn('[tracing] could not resolve a collection name for a DB op - some db spans may be missing');
    }
    return;
  }
  if (EXCLUDE_COLLECTIONS.has(collection)) return;
  const op = forcedOp || ctx.op || 'aggregate';
  let docCount;
  if (Array.isArray(result)) docCount = result.length;
  else if (result && typeof result === 'object' && typeof result.modifiedCount === 'number') {
    docCount = result.modifiedCount + (result.upsertedCount || 0);
  } else if (result) docCount = 1;
  recordSpan({
    traceId: store.traceId, spanId: genId(), parentSpanId: store.spanId,
    name: `db.${op}`, kind: 'db',
    startTs: new Date(start), endTs: new Date(), durationMs: Date.now() - start,
    status: err ? 'error' : 'ok',
    taskId: store.taskId, agentId: store.agentId, searchId: store.searchId,
    tokenId: store.tokenId, attempt: store.attempt,
    attr: { op, collection, docCount },
    error: err ? { message: err.message, code: err.code || null } : null,
  });
}

function dbPlugin(schema) {
  if (!DB_ENABLED) return;
  // Query middleware: stamp start in pre, record in post (success + error forms).
  schema.pre(DB_QUERY_OPS, function () { try { this.__traceStart = Date.now(); } catch {} });
  schema.post(DB_QUERY_OPS, function (res) { recordDbSpan(this, this.__traceStart, null, res); });
  schema.post(DB_QUERY_OPS, function (err, res, next) { recordDbSpan(this, this.__traceStart, err, res); next(err); });
  // Document save.
  schema.pre('save', function () { try { this.$locals.__traceStart = Date.now(); } catch {} });
  schema.post('save', function (doc) { recordDbSpan(this, this.$locals && this.$locals.__traceStart, null, doc, 'save'); });
  schema.post('save', function (err, doc, next) { recordDbSpan(this, this.$locals && this.$locals.__traceStart, err, doc, 'save'); next(err); });
}

let dbInstalled = false;
function installDbTracing() {
  if (dbInstalled || !DB_ENABLED) return;
  dbInstalled = true;
  mongoose.plugin(dbPlugin);
  logger.info('[tracing] DB tracing installed (global mongoose plugin)');
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
async function shutdown() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  await flush().catch(() => {});
}

// Register the global DB plugin on require, BEFORE models are compiled.
installDbTracing();

module.exports = {
  ENABLED,
  withTrace,
  withSpan,
  recordLeaf,
  setToken,
  currentContext,
  instrumentGithubAxios,
  installDbTracing,
  flush,
  shutdown,
  genId,
};
