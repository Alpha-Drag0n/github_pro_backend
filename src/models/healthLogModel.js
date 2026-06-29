/**
 * Health check history - alive / dead / degraded snapshots.
 */

const mongoose = require('mongoose');

const healthLogSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['alive', 'dead', 'degraded'],
    required: true,
    index: true,
  },
  source: {
    type: String,
    enum: ['http', 'keep_alive', 'startup', 'shutdown'],
    default: 'http',
  },
  mongoConnected: {
    type: Boolean,
    default: false,
  },
  httpStatus: {
    type: Number,
    default: null,
  },
  responseTimeMs: {
    type: Number,
    default: null,
  },
  message: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

healthLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('HealthLog', healthLogSchema);
