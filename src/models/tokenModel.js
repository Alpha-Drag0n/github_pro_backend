/**
 * GitHub Token Model
 * Manages GitHub API tokens with health checking
 */

const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    trim: true,
    default: null,
  },
  gitHubUsername: {
    type: String,
    trim: true,
    default: null,
  },
  status: {
    type: String,
    // enum: ['active', 'expired', 'invalid', 'rate_limited'],
    enum: ['active'],
    default: 'active',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastUsed: {
    type: Date,
    default: null,
  },
  lastChecked: {
    type: Date,
    default: new Date(),
  },
  requestsRemaining: {
    type: Number,
    default: 5000,
  },
  requestsLimit: {
    type: Number,
    default: 5000,
  },
  resetTime: {
    type: Date,
    default: null,
  },
  scopes: {
    type: [String],
    default: ['public_repo', 'read:user'],
  },
  priority: {
    type: Number,
    default: 0,
    description: 'Higher priority tokens are selected first (useful for limiting token usage)',
  },
  errorCount: {
    type: Number,
    default: 0,
  },
  successCount: {
    type: Number,
    default: 0,
  },
  usageCount: {
    type: Number,
    default: 0,
    description: 'Total number of API requests made with this token',
  },
  failureReason: {
    type: String,
    default: null,
  },

  // ===== Agent system: shared rate budget (self-imposed central limiter) =====
  // GitHub has TWO separate rate buckets that deep search hits: the SEARCH API
  // (~30/min) and the CORE API (5000/hr) used for profile/repos/readme. Agents
  // sharing this token atomically "spend" from these before each call so the whole
  // fleet can never exceed the real limit. `remaining` resets to `limit` once
  // `resetAt` passes; values are also reconciled from GitHub's x-ratelimit headers.
  budget: {
    search: {
      remaining: { type: Number, default: 28 }, // conservative (< real 30)
      limit: { type: Number, default: 28 },
      resetAt: { type: Date, default: null },
    },
    core: {
      remaining: { type: Number, default: 4500 }, // conservative (< real 5000)
      limit: { type: Number, default: 4500 },
      resetAt: { type: Date, default: null },
    },
  },
  // Token health: cool a token down after auth/abuse errors; quarantine if revoked.
  consecutiveErrors: { type: Number, default: 0 },
  cooldownUntil: { type: Date, default: null },
  disabled: { type: Boolean, default: false }, // 401/revoked → removed from rotation

  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
    default: new Date(),
  },
});

// Update timestamp on save
tokenSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Token', tokenSchema);
