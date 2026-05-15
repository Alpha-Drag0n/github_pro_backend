/**
 * Graceful shutdown for Render deploys, spin-down (SIGTERM), and local Ctrl+C.
 */

const Search = require('../models/searchModel');
const Logger = require('../utils/logger');
const { SHUTDOWN_MESSAGE } = require('./searchRecovery');
const {
  setShuttingDown,
  pauseAllActiveWorkers,
  waitForWorkersToFinish,
  clearAllWorkers,
  getActiveWorkerCount,
} = require('./searchWorkerRegistry');

const logger = new Logger();

const GRACEFUL_SHUTDOWN_MS = parseInt(process.env.GRACEFUL_SHUTDOWN_MS || '25000', 10);

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
  setShuttingDown(true);
  logger.info('Graceful shutdown started');

  pauseAllActiveWorkers();

  const remaining = await waitForWorkersToFinish(GRACEFUL_SHUTDOWN_MS);
  if (remaining > 0) {
    logger.warn(`${remaining} search worker(s) still active after ${GRACEFUL_SHUTDOWN_MS}ms — forcing DB pause`);
  }

  await pauseActiveSearchesInDatabase();
  clearAllWorkers();

  return new Promise((resolve) => {
    server.close(() => {
      logger.info('HTTP server closed');
      resolve();
    });
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
  GRACEFUL_SHUTDOWN_MS,
};
