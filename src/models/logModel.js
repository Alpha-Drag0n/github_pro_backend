/**
 * Search Log Model
 * Stores completed location-year combinations to avoid duplicate searches
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

// Create indexes for fast lookup
logSchema.index({ searchId: 1, location: 1, year: 1 }, { unique: true });
logSchema.index({ location: 1, year: 1 });

module.exports = mongoose.model('Log', logSchema);
