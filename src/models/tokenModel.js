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
    enum: ['active', 'expired', 'invalid', 'rate_limited'],
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
