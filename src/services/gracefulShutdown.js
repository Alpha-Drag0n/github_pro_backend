/**
 * Graceful shutdown for Render deploys, spin-down (SIGTERM), and local Ctrl+C.
 * Stops search workers immediately; does not wait for in-flight GitHub work.
 */

const Search = require('../models/searchModel');
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
  const result = await Search.updateMany(
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

async function runShutdown(server) {
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
function registerGracefulShutdown({ server }) {
  const handleSignal = (signal) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    logger.info(`Received ${signal} (active workers: ${getActiveWorkerCount()})`);

    shutdownPromise = runShutdown(server)
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
