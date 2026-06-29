#!/usr/bin/env node
/**
 * Online-DB Drainer
 * =================
 * A standalone, SINGLE-CONNECTION tool that evacuates data from the online
 * (Atlas) database to local JSON files, then deletes the exported documents
 * from online - keeping the 512 MB free-tier cluster from filling up.
 *
 * It connects ONLY to the online DB. It does NOT touch your local DB; you
 * import the produced files into local Mongo yourself (MongoDB Compass →
 * Import Data → the file is a JSON array in relaxed Extended JSON).
 *
 * TWO PASSES
 *   1. Telemetry pass (safe any time, append-only collections):
 *        spans, events           [logs is EXCLUDED by default - it is a Quick
 *                                 Search dedup ledger, not telemetry; opt in
 *                                 with --telemetry spans,events,logs only if
 *                                 you never run Quick Search]
 *   2. Results pass (gated): users belonging to deep searches whose status is
 *        'completed' ONLY. In-flight / paused / failed searches are never
 *        touched (their users are still being written / may resume).
 *
 *   ALL OTHER COLLECTIONS ARE LEFT UNTOUCHED.
 *
 * CRASH SAFETY (no data loss, at-least-once):
 *   For each part file we  write→fsync→atomic-rename→THEN deleteMany(by _id).
 *   A document leaves online only after it is durably in a finalized local
 *   file. A crash at worst re-exports a part next run (a few duplicates, never
 *   a loss). Deletes target the EXACT _ids written, so real-time inserts that
 *   arrive mid-run are never deleted un-exported.
 *
 * FILE FORMAT (matches your existing Compass exports):
 *   - JSON array, relaxed Extended JSON ({"$oid":..}, {"$date":"ISO"}).
 *   - Compact: one document per line between the array brackets.
 *   - Named D_<collection>[_<n>].json inside data/YYYY.MM.DD/.
 *   - Multi-line string values (bio/readme) are auto-escaped to \n by the
 *     serializer, so they always stay on one line and never break the array.
 *
 * USAGE
 *   node src/tools/drainer.js --uri "mongodb+srv://..." --once
 *   node src/tools/drainer.js --uri "..." --watch --interval 300
 *   npm run drain -- --uri "..." --once --dry-run
 *
 * FLAGS
 *   --uri <str>        Online connection string (or env ONLINE_MONGODB_URI / MONGODB_URI). REQUIRED.
 *   --db <name>        Database name (default: the db in the URI).
 *   --out <dir>        Output base dir (default: <repo>/data).
 *   --mode <m>         both | telemetry | users      (default both)
 *   --telemetry <csv>  Telemetry collections to drain (default "spans,events").
 *                      Allowed: spans,events,logs. (logs only if you don't use Quick Search.)
 *   --statuses <csv>   Deep-search statuses whose users are drainable (default "completed").
 *   --watch            Run continuously; otherwise run once and exit.
 *   --interval <sec>   Loop interval after a CLEAN run (default 300).
 *   --retry-interval <sec>  After a FAILED run (e.g. network drop), retry this fast with
 *                           exponential backoff instead of waiting --interval (default 5).
 *   --max-part-mb <n>  Roll to a new part file at this size (default 128).
 *   --max-part-docs <n> Roll to a new part file at this doc count (default 100000).
 *   --batch <n>        Cursor batch size (default 2000).
 *   --dry-run          Export files but DO NOT delete from online (verify first).
 *   --pretty           Pretty-print instead of compact (bigger files).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

// ---- Hard allow-list. The drainer can NEVER touch anything outside this. ----
const ALLOWED_TELEMETRY = ['spans', 'events', 'logs'];
const DEFAULT_TELEMETRY = ['spans', 'events'];

// ---------------------------------------------------------------- args -------
function parseArgs(argv) {
  const flags = new Set(['watch', 'dry-run', 'pretty', 'no-verify']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (flags.has(key)) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDay(d) { return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`; }

/** Date-range label for users files, matching your existing names
 *  (D_users_2021.01.14.json for one day, _<from>_<to> for a range). */
function fmtRange(dateRange, fallback) {
  try {
    const from = dateRange && dateRange.fromDate ? new Date(dateRange.fromDate) : null;
    const to = dateRange && dateRange.toDate ? new Date(dateRange.toDate) : null;
    if (!from || isNaN(from)) return fallback;
    const f = fmtDay(from);
    if (!to || isNaN(to) || fmtDay(to) === f) return f;
    return `${f}_${fmtDay(to)}`;
  } catch {
    return fallback;
  }
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/** Remove abandoned *.tmp parts from a prior crashed run (their docs are still online). */
function cleanTmp(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json.tmp')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }
}

/** First free part index for D_<base>: 0 -> "D_base.json", n -> "D_base_n.json". */
function findStartIndex(dir, base) {
  if (!fs.existsSync(path.join(dir, `D_${base}.json`))) return 0;
  let max = 0;
  const re = new RegExp(`^D_${base}_(\\d+)\\.json$`);
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}
function partName(base, index) { return index === 0 ? `D_${base}.json` : `D_${base}_${index}.json`; }

/**
 * Read-back check, run AFTER the file is on disk and BEFORE any delete.
 * Small files: full JSON.parse + exact doc-count match. Huge files (> maxBytes,
 * too big to parse in memory): structural sanity ("[" ... "]"). Returns false on
 * any error so the caller keeps the docs online.
 */
function verifyPart(file, expectedDocs, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(arr) && arr.length === expectedDocs;
    }
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(1); fs.readSync(fd, head, 0, 1, 0);
    const tail = Buffer.alloc(8); fs.readSync(fd, tail, 0, 8, Math.max(0, size - 8));
    fs.closeSync(fd);
    return head.toString() === '[' && tail.toString().trim().endsWith(']');
  } catch {
    return false;
  }
}

// ------------------------------------------------------- core drain routine --
/**
 * Stream every doc matching `filter` from `coll` into one or more part files,
 * rotating by size/count, and (unless dry-run) deleting each part's exact _ids
 * from online immediately after the file is finalized on disk.
 */
async function drainCollection(coll, base, filter, ctx) {
  const { dir, opts } = ctx;
  const cursor = coll.find(filter, { sort: { _id: 1 } }).batchSize(opts.batch);

  let index = findStartIndex(dir, base);
  let stream = null, finalPath = null, tmpPath = null;
  let ids = [], bytes = 0, docs = 0, first = true, minId = null, maxId = null;
  let totalDocs = 0, totalFiles = 0;

  const write = async (chunk) => {
    if (!stream.write(chunk)) await once(stream, 'drain');
    bytes += Buffer.byteLength(chunk);
  };

  const openPart = async () => {
    finalPath = path.join(dir, partName(base, index));
    tmpPath = finalPath + '.tmp';
    stream = fs.createWriteStream(tmpPath, { flags: 'w' });
    ids = []; bytes = 0; docs = 0; first = true; minId = null; maxId = null;
    await write('[\n');
  };

  const finalizePart = async () => {
    await write('\n]\n');
    stream.end();
    await once(stream, 'finish');
    // Flush OS buffers to physical disk before we trust the file enough to delete from online.
    const fd = fs.openSync(tmpPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, finalPath); // atomic on the same volume

    // Gate the delete on a successful read-back. On failure: keep docs online,
    // quarantine the file so it is never imported, and move on.
    if (opts.verify && !verifyPart(finalPath, docs, opts.verifyMaxBytes)) {
      const bad = finalPath.replace(/\.json$/, '.UNVERIFIED.json');
      try { fs.renameSync(finalPath, bad); } catch { /* ignore */ }
      console.error(`    ! VERIFY FAILED ${path.basename(finalPath)} - NOT deleted from online; quarantined as ${path.basename(bad)}`);
      appendManifest(dir, {
        ts: new Date().toISOString(), collection: coll.collectionName,
        file: path.basename(bad), docs, deleted: 0, verifyFailed: true,
      });
      totalFiles += 1; stream = null;
      return;
    }

    let deleted = 0;
    if (!opts.dryRun) {
      for (let i = 0; i < ids.length; i += 5000) {
        const r = await coll.deleteMany({ _id: { $in: ids.slice(i, i + 5000) } });
        deleted += r.deletedCount || 0;
      }
    }
    appendManifest(dir, {
      ts: new Date().toISOString(), collection: coll.collectionName,
      file: path.basename(finalPath), docs, deleted, dryRun: !!opts.dryRun,
      minId: minId && EJSON.stringify(minId), maxId: maxId && EJSON.stringify(maxId),
    });
    console.log(`    → ${path.basename(finalPath)}  ${docs} docs` +
      (opts.dryRun ? '  (dry-run, not deleted)' : `  (deleted ${deleted})`));
    totalDocs += docs; totalFiles += 1;
    stream = null;
  };

  for await (const doc of cursor) {
    if (!stream) await openPart();
    // bson EJSON.stringify(value, replacer, space, options) - space (3rd arg) controls indent.
    const ejson = EJSON.stringify(doc, undefined, opts.pretty ? 2 : 0, { relaxed: true });
    const line = (first ? '' : ',\n') + ejson;
    await write(line);
    if (first) minId = doc._id;
    maxId = doc._id;
    ids.push(doc._id);
    first = false; docs += 1;
    if (bytes >= opts.maxPartBytes || docs >= opts.maxPartDocs) {
      await finalizePart();
      index += 1;
    }
  }
  if (stream && docs > 0) await finalizePart();
  return { totalDocs, totalFiles };
}

function appendManifest(dir, entry) {
  fs.appendFileSync(path.join(dir, '_drain_manifest.jsonl'), JSON.stringify(entry) + '\n');
}

// ------------------------------------------------------------------ passes ---
async function telemetryPass(db, ctx) {
  for (const name of ctx.opts.telemetry) {
    const coll = db.collection(name);
    const count = await coll.estimatedDocumentCount();
    if (!count) { console.log(`  [telemetry] ${name}: empty, skip`); continue; }
    console.log(`  [telemetry] ${name}: draining (~${count} docs)`);
    const r = await drainCollection(coll, name, {}, ctx);
    if (!r.totalDocs) console.log(`  [telemetry] ${name}: nothing to drain`);
  }
}

async function usersPass(db, ctx) {
  const searches = await db.collection('deepsearches')
    .find({ status: { $in: ctx.opts.statuses } })
    .project({ searchId: 1, status: 1, dateRange: 1 })
    .toArray();
  if (!searches.length) { console.log(`  [users] no ${ctx.opts.statuses.join('/')} searches`); return; }

  const users = db.collection('users');
  for (const s of searches) {
    if (!s.searchId) { console.log(`  [users] search ${s._id} has no searchId, skip`); continue; }
    const filter = { searchId: s.searchId };
    const count = await users.countDocuments(filter);
    if (!count) continue; // already drained (idempotent) or never had users
    const label = `users_${fmtRange(s.dateRange, String(s.searchId))}`;
    console.log(`  [users] search ${s.searchId} (${s.status}): ${count} users → D_${label}*.json`);
    await drainCollection(users, label, filter, ctx);
  }
}

async function runOnce(db, ctx) {
  cleanTmp(ctx.dir);
  console.log(`Drain run @ ${new Date().toISOString()}  →  ${ctx.dir}` + (ctx.opts.dryRun ? '  [DRY-RUN]' : ''));
  if (ctx.opts.mode !== 'users') await telemetryPass(db, ctx);
  if (ctx.opts.mode !== 'telemetry') await usersPass(db, ctx);
  console.log('Run complete.\n');
}

// -------------------------------------------------------------------- main ---
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const uri = a.uri || process.env.ONLINE_MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: provide --uri or ONLINE_MONGODB_URI. Refusing to run.');
    process.exit(1);
  }

  let telemetry = DEFAULT_TELEMETRY;
  if (a.telemetry) {
    telemetry = a.telemetry.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = telemetry.filter((c) => !ALLOWED_TELEMETRY.includes(c));
    if (bad.length) { console.error(`ERROR: --telemetry only allows ${ALLOWED_TELEMETRY.join(',')}; got: ${bad}`); process.exit(1); }
    if (telemetry.includes('logs')) console.warn('WARNING: draining "logs" - only safe if you NEVER run Quick Search (it is a dedup ledger).');
  }

  const opts = {
    mode: a.mode || 'both',
    telemetry,
    statuses: (a.statuses || 'completed').split(',').map((s) => s.trim()).filter(Boolean),
    maxPartBytes: Math.round((parseFloat(a['max-part-mb']) || 128) * 1024 * 1024),
    maxPartDocs: parseInt(a['max-part-docs'] || '100000', 10),
    batch: parseInt(a.batch || '2000', 10),
    dryRun: !!a['dry-run'],
    pretty: !!a.pretty,
    verify: !a['no-verify'],            // read-back before delete (default ON)
    verifyMaxBytes: 160 * 1024 * 1024,  // full-parse up to this size, else structural check
  };
  const outBase = a.out || path.resolve(__dirname, '../../../data');

  const intervalMs = (parseInt(a.interval || '300', 10)) * 1000;       // cadence after a clean run
  const retryMs = Math.max(parseInt(a['retry-interval'] || '5', 10), 1) * 1000; // fast retry after a failure
  const retryCapMs = Math.min(intervalMs || retryMs, 60 * 1000);       // backoff ceiling

  let stopping = false;
  const ctxFor = () => ({ dir: ensureDayDir(outBase), opts });
  process.on('SIGINT', () => { console.log('\nSIGINT - finishing, will stop after this run.'); stopping = true; });

  // serverSelectionTimeoutMS keeps a down-network op from hanging the default 30s before it throws.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });

  // Connect. In watch mode, retry a failed startup connect instead of exiting.
  let backoff = retryMs;
  for (;;) {
    try { await client.connect(); break; }
    catch (e) {
      if (!a.watch) throw e; // one-shot: fail fast as before
      if (stopping) { await client.close().catch(() => {}); return; }
      console.error(`Connect failed (${isConnectionError(e) ? 'connection' : 'error'}): ${e.message} - retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff, () => stopping);
      backoff = Math.min(backoff * 2, retryCapMs);
    }
  }
  const db = a.db ? client.db(a.db) : client.db();
  console.log(`Connected (online): db="${db.databaseName}"  mode=${opts.mode}  telemetry=[${opts.telemetry}]  users-statuses=[${opts.statuses}]`);

  if (!a.watch) {
    await runOnce(db, ctxFor());
    await client.close();
    return;
  }

  console.log(`Watch mode: every ${intervalMs / 1000}s after a clean run; retry in ${retryMs / 1000}s (backoff to ${retryCapMs / 1000}s) on failure. Ctrl+C to stop.`);
  /* eslint-disable no-await-in-loop */
  backoff = retryMs;
  while (!stopping) {
    let failed = false;
    try {
      await runOnce(db, ctxFor());
    } catch (e) {
      failed = true;
      console.error(`Run failed (${isConnectionError(e) ? 'connection' : 'error'}): ${e.message} - retrying in ${Math.round(backoff / 1000)}s`);
    }
    if (stopping) break;
    if (failed) {
      await sleep(backoff, () => stopping);          // retry fast...
      backoff = Math.min(backoff * 2, retryCapMs);   // ...backing off if it keeps failing
    } else {
      backoff = retryMs;                             // clean run -> reset and wait the normal interval
      await sleep(intervalMs, () => stopping);
    }
  }
  await client.close();
  console.log('Stopped.');
}

function ensureDayDir(outBase) {
  const dir = path.join(outBase, fmtDay(new Date()));
  ensureDir(dir);
  return dir;
}

/** Sleep that wakes early if `abort()` becomes true (so Ctrl+C is responsive). */
function sleep(ms, abort) {
  return new Promise((resolve) => {
    const step = 500; let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || (abort && abort())) { clearInterval(t); resolve(); }
    }, step);
  });
}

/** Heuristic: is this error a network/connectivity problem (vs a logic/data error)? */
function isConnectionError(e) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || '';
  return /MongoNetwork|MongoServerSelection|MongoNotConnected|MongoTopologyClosed/i.test(name)
    || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo|server selection|topology|socket/i.test(msg);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
