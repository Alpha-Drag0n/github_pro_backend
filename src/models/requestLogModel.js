/**
 * Request Log Model
 * Tracks all GitHub API and Database requests with timing and parameters
 */

const mongoose = require('mongoose');

const requestLogSchema = new mongoose.Schema({
  serverType: {
    type: String,
    enum: ['github', 'db'],
    required: true,
    index: true,
  },
  endpoint: {
    type: String,
    required: true,
  },
  parameters: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  purpose: {
    type: String,
    enum: ['create', 'read', 'update', 'delete', 'find'],
    required: true,
  },
  sentAt: {
    type: Date,
    required: true,
  },
  receivedAt: {
    type: Date,
    required: true,
  },
  duration: {
    type: Number,
    required: true,
    description: 'Response time in milliseconds',
  },
  status: {
    type: String,
    enum: ['success', 'error'],
    default: 'success',
  },
  errorMessage: String,
  statusCode: Number,
  searchId: {
    type: String,
    index: true,
  },
  createdAt: {
    type: Date,
    default: () => new Date(),
    index: true,
  },
});

// Index for efficient querying
requestLogSchema.index({ createdAt: -1 });
requestLogSchema.index({ serverType: 1, createdAt: -1 });
requestLogSchema.index({ searchId: 1, createdAt: -1 });

module.exports = mongoose.model('RequestLog', requestLogSchema);
