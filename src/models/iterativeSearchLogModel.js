/**
 * Iterative Search Log Model
 * Tracks processing status per date for iterative searches
 * Prevents duplicate processing and enables resumption
 */

const mongoose = require('mongoose');

const iterativeSearchLogSchema = new mongoose.Schema({
  searchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IterativeSearch',
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  iteration: {
    type: Number,
    required: true,
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

// Composite index for quick lookups
iterativeSearchLogSchema.index({ searchId: 1, date: 1, iteration: 1 });

module.exports = mongoose.model('IterativeSearchLog', iterativeSearchLogSchema);
