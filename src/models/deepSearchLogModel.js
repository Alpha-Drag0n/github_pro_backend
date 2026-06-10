/**
 * Iterative Search Log Model
 * Tracks processing status per date for iterative searches
 * Prevents duplicate processing and enables resumption
 */

const mongoose = require('mongoose');

const iterativeSearchLogSchema = new mongoose.Schema({
  searchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeepSearch',
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  // Keyword bucket within a day (e.g. "aa", "b3"). One log row per (searchId, date, term).
  term: {
    type: String,
    default: '',
  },
  iteration: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['start', 'in_progress', 'finish', 'error'],
    default: 'start',
  },
  usersProcessed: {
    type: Number,
    default: 0,
  },
  usersFound: {
    type: Number,
    default: 0,
  },
  contactInfoFound: {
    type: Number,
    default: 0,
  },
  excludedLocations: [String],
  error: String,
  
  // Timing
  timestamp: {
    type: Date,
    default: () => new Date(),
  },
  completedAt: Date,
  duration: Number, // in milliseconds
});

// One bucket per (searchId, date, term); plus a cross-search lookup by (date, term, status).
iterativeSearchLogSchema.index({ searchId: 1, date: 1, term: 1 }, { unique: true });
iterativeSearchLogSchema.index({ date: 1, term: 1, status: 1 });

module.exports = mongoose.model('DeepSearchLog', iterativeSearchLogSchema);
