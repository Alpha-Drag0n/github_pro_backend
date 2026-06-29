#!/usr/bin/env node
/**
 * Local-DB Importer
 * =================
 * Imports the JSON files produced by drainer.js into your LOCAL MongoDB,
 * preserving every value EXACTLY - `_id` (ObjectId), Date fields, etc. are
 * kept byte-for-byte, NOT regenerated or turned into strings.
 *
 * Connects to the LOCAL db ONLY. The companion to drainer.js (which is online-only).
 *
 * WHY _id IS PRESERVED
 *   The files are (relaxed) Extended JSON: {"_id":{"$oid":".."}}, {"$date":".."}.
 *   We parse with bson's EJSON.parse (NOT JSON.parse), which turns $oid back into a
 *   real ObjectId and $date back into a real Date. We then upsert each doc keyed on
 *   its own _id, so existing _ids match and nothing is regenerated. Re-running is
 *   idempotent (a re-exported duplicate just replaces itself).
 *   (JSON.parse would leave _id as a plain {$oid} object and corrupt it - we don't use it.)
 *
 * USAGE
 *   node src/tools/importer.js --dir ../data/2026.06.19
 *   node src/tools/importer.js --file ../data/2026.06.19/D_users_2021.01.14.json
 *   npm run drain:import -- --dir ../data/2026.06.19 --dry-run
 *
 * FLAGS
 *   --uri <str>     Local connection string (or env LOCAL_MONGODB_URI / MONGODB_URI).
 *                   Default: mongodb://localhost:27017/github-user-research
 *   --db <name>     Database name (default: the db in the URI).
 *   --dir <dir>     Import every D_*.json in this folder.
 *   --file <path>   Import a single file (overrides --dir).
 *   --collection <n> Force target collection (else derived from the filename).
 *   --mode <m>      upsert | insert   (default upsert - idempotent, preserves _id)
 *   --batch <n>     Bulk write size (default 1000).
 *   --dry-run       Parse + count only; write nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

function parseArgs(argv) {
  const flags = new Set(['dry-run']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = flags.has(k) ? true : argv[++i]; }
    else out._.push(a);
  }
  return out;
}

/** D_<collection>[_<part-or-range>].json -> <collection>. e.g.
 *  D_spans.json, D_spans_1.json -> spans ; D_users_2021.01.14.json -> users. */
function deriveCollection(filename) {
  const base = path.basename(filename).replace(/\.json$/i, '');
  const m = base.match(/^D_([a-zA-Z]+)/);
  return m ? m[1] : null;
}

/** Files the drainer wrote that we should import (skip quarantine/manifest/tmp). */
function isImportable(name) {
  return /^D_.*\.json$/i.test(name) && !/\.UNVERIFIED\.json$/i.test(name);
}

async function importFile(db, file, opts) {
  const collName = opts.collection || deriveCollection(file);
  if (!collName) { console.warn(`  ? skip ${path.basename(file)} (cannot derive collection)`); return; }

  // Files are capped by the drainer (~128MB / 100k docs), so a whole-file parse is bounded.
  const text = fs.readFileSync(file, 'utf8');
  const docs = EJSON.parse(text, { relaxed: true }); // -> real ObjectId / Date, _id intact
  if (!Array.isArray(docs)) { console.warn(`  ? skip ${path.basename(file)} (not a JSON array)`); return; }
  if (!docs.length) { console.log(`  - ${path.basename(file)} -> ${collName}: empty`); return; }

  if (opts.dryRun) {
    console.log(`  ~ ${path.basename(file)} -> ${collName}: ${docs.length} docs (dry-run, parsed OK, _id sample ${docs[0]._id})`);
    return;
  }

  const coll = db.collection(collName);
  let inserted = 0, modified = 0, upserted = 0;
  for (let i = 0; i < docs.length; i += opts.batch) {
    const batch = docs.slice(i, i + opts.batch);
    if (opts.mode === 'insert') {
      try {
        const r = await coll.insertMany(batch, { ordered: false });
        inserted += r.insertedCount || 0;
      } catch (e) {
        // ordered:false keeps going; dup _id just means already imported.
        inserted += (e.result && e.result.insertedCount) || 0;
      }
    } else {
      // Upsert keyed on the doc's own _id -> _id never changes, re-runs are idempotent.
      const ops = batch.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
      const r = await coll.bulkWrite(ops, { ordered: false });
      upserted += r.upsertedCount || 0;
      modified += r.modifiedCount || 0;
    }
  }
  const detail = opts.mode === 'insert'
    ? `inserted ${inserted}`
    : `upserted ${upserted}, replaced ${modified}`;
  console.log(`  + ${path.basename(file)} -> ${collName}: ${docs.length} docs (${detail})`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const uri = a.uri || process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI
    || 'mongodb://localhost:27017/github-user-research';

  const opts = {
    collection: a.collection || null,
    mode: a.mode === 'insert' ? 'insert' : 'upsert',
    batch: parseInt(a.batch || '1000', 10),
    dryRun: !!a['dry-run'],
  };

  let files = [];
  if (a.file) files = [path.resolve(a.file)];
  else if (a.dir) {
    const dir = path.resolve(a.dir);
    files = fs.readdirSync(dir).filter(isImportable).sort().map((f) => path.join(dir, f));
  } else { console.error('ERROR: provide --dir <folder> or --file <path>.'); process.exit(1); }
  if (!files.length) { console.error('Nothing to import.'); process.exit(1); }

  const client = new MongoClient(uri);
  await client.connect();
  const db = a.db ? client.db(a.db) : client.db();
  console.log(`Connected (local): db="${db.databaseName}"  mode=${opts.mode}  files=${files.length}` + (opts.dryRun ? '  [DRY-RUN]' : ''));

  for (const f of files) await importFile(db, f, opts);

  await client.close();
  console.log('Import complete.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
