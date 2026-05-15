/**
 * Record and query service health check history.
 */

const HealthLog = require('../models/healthLogModel');
const Database = require('../utils/database');
const Logger = require('../utils/logger');
const { isShuttingDown } = require('./searchWorkerRegistry');

const logger = new Logger();

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
 * Persist a health check and log to console.
 */
async function recordHealthCheck({
  source = 'http',
  mongoConnected = Database.isConnected(),
  httpStatus = null,
  responseTimeMs = null,
  message = '',
  status: explicitStatus,
}) {
  if (isShuttingDown() && source !== 'shutdown') {
    return null;
  }

  const status = explicitStatus || deriveStatus(mongoConnected, httpStatus);

  const entry = await HealthLog.create({
    status,
    source,
    mongoConnected,
    httpStatus,
    responseTimeMs,
    message,
  });

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

  return entry;
}

async function getRecentHealthLogs(limit = 50) {
  return HealthLog.find().sort({ createdAt: -1 }).limit(limit);
}

async function getLatestHealthLog() {
  return HealthLog.findOne().sort({ createdAt: -1 });
}

async function getHealthSummary() {
  const latest = await getLatestHealthLog();
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
          checkedAt: latest.createdAt,
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
  getHealthSummary,
};
