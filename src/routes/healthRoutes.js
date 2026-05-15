/**
 * Service health check (public — not behind JWT auth).
 */

const express = require('express');
const router = express.Router();
const Database = require('../utils/database');
const {
  recordHealthCheck,
  getRecentHealthLogs,
  getHealthSummary,
} = require('../services/healthLogService');

router.get('/', async (req, res) => {
  const started = Date.now();
  const mongoConnected = Database.isConnected();

  const payload = {
    status: mongoConnected ? 'ok' : 'degraded',
    service: 'github-user-research-backend',
    timestamp: new Date().toISOString(),
    checks: {
      database: mongoConnected ? 'up' : 'down',
    },
  };

  const httpStatus = mongoConnected ? 200 : 503;

  await recordHealthCheck({
    source: 'http',
    mongoConnected,
    httpStatus,
    responseTimeMs: Date.now() - started,
    message: payload.status === 'ok' ? 'Health check OK' : 'Database disconnected',
  });

  res.status(httpStatus).json(payload);
});

/**
 * Current health summary + whether service is considered alive.
 */
router.get('/status', async (req, res) => {
  try {
    const summary = await getHealthSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read health status' });
  }
});

/**
 * Recent health check log entries (newest first).
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const logs = await getRecentHealthLogs(limit);
    const summary = await getHealthSummary();

    res.json({
      isAlive: summary.isAlive,
      current: summary.current,
      lastHour: summary.lastHour,
      count: logs.length,
      logs,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch health logs' });
  }
});

module.exports = router;
