/**
 * Bucket Ledger - enforces "each (day, term) bucket is processed once across ALL
 * deep searches". When a task finishes, its globalKey is upserted here; task
 * generation for any other search skips keys already present.
 *
 * Tradeoff (by design): a bucket finished by search A is NOT re-run for search B,
 * so B's results won't include users that only A's shared bucket found - this is
 * the intentional resource-saving dedup.
 */

const mongoose = require('mongoose');

const bucketLedgerSchema = new mongoose.Schema({
  globalKey: { type: String, required: true, unique: true }, // e.g. "deep:2011-01-01:aa"
  searchId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeepSearch' }, // who finished it first
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  finishedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('BucketLedger', bucketLedgerSchema);
