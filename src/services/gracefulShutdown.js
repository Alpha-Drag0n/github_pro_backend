/**
 * Graceful shutdown for Render deploys, spin-down (SIGTERM), and local Ctrl+C.
 * Stops search workers immediately; does not wait for in-flight GitHub work.
 */

const QuickSearch = require('../models/quickSearchModel');
const Logger = require('../utils/logger');
const { stopSelfKeepAlive } = require('./keepAlive');
const { recordHealthCheck } = require('./healthLogService');
const Database = require('../utils/database');
const { SHUTDOWN_MESSAGE } = require('./searchRecovery');
const {
  setShuttingDown,
  stopAllWorkersImmediately,
  getActiveWorkerCount,
} = require('./searchWorkerRegistry');

const logger = new Logger();

/** Max time to wait for in-flight HTTP connections after workers are stopped. */
const SERVER_CLOSE_DRAIN_MS = parseInt(process.env.SERVER_CLOSE_DRAIN_MS || '2000', 10);

let shutdownPromise = null;

async function pauseActiveSearchesInDatabase() {
  const result = await QuickSearch.updateMany(
    { status: { $in: ['running', 'awaiting_tokens'] } },
    {
      $set: {
        status: 'paused',
        error: SHUTDOWN_MESSAGE,
        pausedAt: new Date(),
        recoverable: true,
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info(`Paused ${result.modifiedCount} active search(es) in database for shutdown`);
  }
}

async function runShutdown(server, getAgents) {
  stopSelfKeepAlive();
  setShuttingDown(true);

  const activeBeforeStop = getActiveWorkerCount();
  logger.info(
    `Graceful shutdown started (${activeBeforeStop} active worker${activeBeforeStop === 1 ? '' : 's'})`
  );

  await recordHealthCheck({
    source: 'shutdown',
    mongoConnected: Database.isConnected(),
    status: 'dead',
    message: 'Graceful shutdown initiated',
  });

  const stopped = stopAllWorkersImmediately();
  if (stopped > 0) {
    logger.info(`Stopped ${stopped} search worker(s) immediately`);
  }

  // Stop in-process agents: each releases its in-flight task back to 'pending' right away,
  // so a redeploy hands work off immediately instead of waiting for the lease reaper (~90s).
  try {
    const agents = (typeof getAgents === 'function' && getAgents()) || [];
    if (agents.length) {
      await Promise.all(agents.map((a) => a.stop && a.stop().catch(() => {})));
      logger.info(`Stopped ${agents.length} in-process agent(s)`);
    }
  } catch (e) {
    logger.warn(`Agent shutdown error: ${e.message}`);
  }

  await pauseActiveSearchesInDatabase();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (label) => {
      if (settled) return;
      settled = true;
      logger.info(label);
      resolve();
    };

    server.close(() => finish('HTTP server closed'));

    if (SERVER_CLOSE_DRAIN_MS > 0) {
      setTimeout(() => finish(`HTTP server close timed out after ${SERVER_CLOSE_DRAIN_MS}ms`), SERVER_CLOSE_DRAIN_MS);
    }
  });
}

/**
 * @param {{ server: import('http').Server }} options
 */
function registerGracefulShutdown({ server, getAgents }) {
  const handleSignal = (signal) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    logger.info(`Received ${signal} (active workers: ${getActiveWorkerCount()})`);

    shutdownPromise = runShutdown(server, getAgents)
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        logger.error(`Shutdown error: ${err.message}`);
        process.exit(1);
      });

    return shutdownPromise;
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}

module.exports = {
  registerGracefulShutdown,
  SERVER_CLOSE_DRAIN_MS,
};
