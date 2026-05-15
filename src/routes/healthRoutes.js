/**
 * Service health check (public — not behind JWT auth).
 * For load balancers, orchestrators, and uptime monitors.
 */

const express = require('express');
const router = express.Router();
const Database = require('../utils/database');

router.get('/', (req, res) => {
  const mongoConnected = Database.isConnected();

  res.status(mongoConnected ? 200 : 503).json({
    status: mongoConnected ? 'ok' : 'degraded',
    service: 'github-user-research-backend',
    timestamp: new Date().toISOString(),
    checks: {
      database: mongoConnected ? 'up' : 'down',
    },
  });
});

module.exports = router;
