/**
 * Record and query service health check history.
 * Optimized: Check every 3 seconds, but only save to DB every 30 seconds
 */

const HealthLog = require('../models/healthLogModel');
const Database = require('../utils/database');
const Logger = require('../utils/logger');
const { isShuttingDown } = require('./searchWorkerRegistry');

const logger = new Logger();

// Health check batching configuration
const SAVE_INTERVAL_MS = 30000; // Save to DB every 30 seconds
let lastSavedTime = 0;
let currentHealthStatus = null;
let statusChanged = false;

function deriveStatus(mongoConnected, httpStatus) {
  if (!mongoConnected) {
    return 'degraded';
  }
  if (httpStatus != null && (httpStatus < 200 || httpStatus >= 500)) {
    return 'dead';
  }
  if (httpStatus != null && httpStatus >= 400) {
    return 'degraded';
  }
  return 'alive';
}

/**
 * Check health status (called every 3 seconds) but only save periodically
 * Saves to DB every 30 seconds OR when status changes
 */
async function recordHealthCheck({
  source = 'http',
  mongoConnected = Database.isConnected(),
  httpStatus = null,
  responseTimeMs = null,
  message = '',
  status: explicitStatus,
  forceDBWrite = false, // Force immediate save regardless of interval
}) {
  if (isShuttingDown() && source !== 'shutdown') {
    return null;
  }

  const status = explicitStatus || deriveStatus(mongoConnected, httpStatus);

  // Store current status in memory
  const newHealthStatus = {
    status,
    source,
    mongoConnected,
    httpStatus,
    responseTimeMs,
    message,
    checkedAt: new Date(),
  };

  // Check if status changed
  const statusHasChanged = !currentHealthStatus || currentHealthStatus.status !== status;
  if (statusHasChanged) {
    statusChanged = true;
  }

  currentHealthStatus = newHealthStatus;

  const label = status.toUpperCase();
  const parts = [
    `[health:${label}]`,
    `source=${source}`,
    `mongo=${mongoConnected ? 'up' : 'down'}`,
  ];
  if (httpStatus != null) {
    parts.push(`http=${httpStatus}`);
  }
  if (responseTimeMs != null) {
    parts.push(`${responseTimeMs}ms`);
  }
  if (message) {
    parts.push(message);
  }

  if (status === 'alive') {
    logger.info(parts.join(' '));
  } else {
    logger.warn(parts.join(' '));
  }

  // Decide whether to save to DB
  const now = Date.now();
  const timeSinceLastSave = now - lastSavedTime;
  const shouldSaveToDb = forceDBWrite || statusChanged || timeSinceLastSave >= SAVE_INTERVAL_MS;

  if (shouldSaveToDb) {
    try {
      const entry = await HealthLog.create({
        status,
        source,
        mongoConnected,
        httpStatus,
        responseTimeMs,
        message,
      });
      lastSavedTime = now;
      statusChanged = false;
      return entry;
    } catch (error) {
      logger.error(`Error saving health log to DB: ${error.message}`);
      // Continue even if save fails - current status is in memory
      return null;
    }
  }

  // Health check recorded in memory but not saved yet
  return null;
}

async function getRecentHealthLogs(limit = 50) {
  return HealthLog.find().sort({ createdAt: -1 }).limit(limit);
}

async function getLatestHealthLog() {
  return HealthLog.findOne().sort({ createdAt: -1 });
}

/**
 * Get current health status (from memory, always fresh)
 */
function getCurrentHealthStatus() {
  return currentHealthStatus;
}

async function getHealthSummary() {
  const latest = currentHealthStatus || (await getLatestHealthLog());
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [recentAlive, recentDead, recentTotal] = await Promise.all([
    HealthLog.countDocuments({ status: 'alive', createdAt: { $gte: oneHourAgo } }),
    HealthLog.countDocuments({
      status: { $in: ['dead', 'degraded'] },
      createdAt: { $gte: oneHourAgo },
    }),
    HealthLog.countDocuments({ createdAt: { $gte: oneHourAgo } }),
  ]);

  return {
    current: latest
      ? {
          status: latest.status,
          source: latest.source,
          mongoConnected: latest.mongoConnected,
          httpStatus: latest.httpStatus,
          responseTimeMs: latest.responseTimeMs,
          message: latest.message,
          checkedAt: latest.checkedAt || latest.createdAt,
        }
      : null,
    lastHour: {
      total: recentTotal,
      alive: recentAlive,
      deadOrDegraded: recentDead,
    },
    isAlive: latest?.status === 'alive',
  };
}

module.exports = {
  deriveStatus,
  recordHealthCheck,
  getRecentHealthLogs,
  getLatestHealthLog,
  getCurrentHealthStatus,
  getHealthSummary,
};
