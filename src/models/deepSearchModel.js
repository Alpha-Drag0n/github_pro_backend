/**
 * Iterative Search Model
 * Tracks searches that bypass GitHub's 1000-result API limit
 * by executing location-based exclusion searches iteratively
 */

const mongoose = require('mongoose');

const iterativeSearchSchema = new mongoose.Schema({
  searchId: {
    type: String,
    required: true,
    unique: true,
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'paused', 'failed'],
    default: 'pending',
  },
  dateRange: {
    fromDate: {
      type: Date,
      required: true,
    },
    toDate: {
      type: Date,
      required: true,
    },
  },
  // Iterative search tracking
  totalDays: {
    type: Number,
    default: 0,
  },
  daysProcessed: {
    type: Number,
    default: 0,
  },
  currentIteration: {
    type: Number,
    default: 0,
  },
  maxIterations: {
    type: Number,
    default: 50,
  },
  // Keyword partitioning: each day is split into per-term buckets before location
  // exclusion. `termSet` selects the generated list (see iterativeSearchService.generateTerms).
  termSet: {
    type: String,
    default: 'alnum2',
  },
  // Progress is tracked at the (day × term) bucket level.
  totalBuckets: {
    type: Number,
    default: 0,
  },
  bucketsProcessed: {
    type: Number,
    default: 0,
  },

  // ===== Agent system: control + rolled-up progress =====
  // The manager only ever writes a DESIRED state; agents converge to it. Agents no
  // longer write this parent doc per bucket (that was a write hotspot, D6) — the
  // manager's rollup loop recomputes `progress` from the tasks collection.
  control: {
    desired: { type: String, enum: ['run', 'paused', 'stopped'], default: 'run' },
    requestedAt: Date,
  },
  priority: { type: Number, default: 0 }, // propagates to this job's tasks' priority
  // Per-search opt-in (a checkbox on the Deep Search page): only searches with autoChain:true
  // are auto-started by the chain when the previous earlier-dated search completes.
  autoChain: { type: Boolean, default: false },
  // Auto-chaining: when a previous (earlier-dated) search completes, the next pending autoChain
  // search is scheduled to start at this time. The manager starts it once now >= autoStartAt.
  autoStartAt: { type: Date, default: null },
  progress: {
    totalBuckets: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    dead: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    leased: { type: Number, default: 0 },
    usersFound: { type: Number, default: 0 },
    rollupAt: Date,
  },
  // Location tracking
  excludedLocations: [String],
  lastFoundLocations: [String],
  
  // Results
  usersFound: {
    type: Number,
    default: 0,
  },
  uniqueUsers: [
    {
      username: String,
      firstFoundAt: Date,
      lastFoundAt: Date,
    },
  ],
  
  // Progress and timing
  startedAt: {
    type: Date,
    default: () => new Date(),
  },
  pausedAt: Date,
  resumedAt: Date,
  completedAt: Date,
  
  // Error tracking
  error: String,
  errorDetails: {
    lastErrorAt: Date,
    errorCount: Number,
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: () => new Date(),
  },
  updatedAt: {
    type: Date,
    default: () => new Date(),
  },
});

// Update timestamp before saving
iterativeSearchSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('DeepSearch', iterativeSearchSchema);
