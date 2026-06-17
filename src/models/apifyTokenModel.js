/**
 * Apify API Token Model
 * Manages Apify API tokens used for LinkedIn profile enrichment.
 * Mirrors the GitHub `tokenModel` shape (name/status/usage counters) but
 * tracks Apify-specific usage instead of GitHub rate-limit buckets.
 */

const mongoose = require('mongoose');

const apifyTokenSchema = new mongoose.Schema({
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
  // Apify account this token belongs to (resolved from /users/me on verify).
  apifyUsername: {
    type: String,
    trim: true,
    default: null,
  },
  status: {
    type: String,
    enum: ['active', 'invalid'],
    default: 'active',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  priority: {
    type: Number,
    default: 0,
    description: 'Higher priority tokens are selected first',
  },
  lastUsed: {
    type: Date,
    default: null,
  },
  // Counters — every LinkedIn enrichment run increments these.
  usageCount: { type: Number, default: 0 }, // total actor runs made with this token
  profilesEnriched: { type: Number, default: 0 }, // total LinkedIn URLs successfully resolved
  successCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  failureReason: { type: String, default: null },

  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

apifyTokenSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ApifyToken', apifyTokenSchema);
