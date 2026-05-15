/**
 * Search Log Model
 * Tracks completed location-year-followers-accountType combinations to avoid duplicate API work.
 */

const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  searchId: {
    type: String,
    required: true,
    index: true,
  },
  location: {
    type: String,
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  followers: {
    type: String,
    required: true,
    default: '<30',
  },
  accountType: {
    type: String,
    required: true,
    default: 'user',
  },
  usersFound: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['completed', 'error', 'skipped'],
    default: 'completed',
  },
  error: String,
  completedAt: {
    type: Date,
    default: new Date(),
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

// One log per unique search combination (global dedup for re-runs)
logSchema.index(
  { location: 1, year: 1, followers: 1, accountType: 1 },
  { unique: true }
);
logSchema.index({ searchId: 1, completedAt: -1 });

module.exports = mongoose.model('Log', logSchema);
