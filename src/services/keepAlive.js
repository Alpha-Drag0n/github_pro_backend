/**
 * Periodic self-request to /health (keeps process active while it is already running).
 */

const http = require('http');
const https = require('https');
const Logger = require('../utils/logger');
const { recordHealthCheck } = require('./healthLogService');
const Database = require('../utils/database');

const logger = new Logger();

let intervalId = null;

function pingHealth(url) {
  const started = Date.now();
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      resolve({ httpStatus: res.statusCode, responseTimeMs: Date.now() - started });
    });
    req.on('error', (err) => {
      resolve({
        httpStatus: null,
        responseTimeMs: Date.now() - started,
        error: err.message,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        httpStatus: null,
        responseTimeMs: Date.now() - started,
        error: 'timeout',
      });
    });
  });
}

/**
 * Start interval pings to the health endpoint.
 */
function startSelfKeepAlive() {
  if (process.env.ENABLE_SELF_KEEP_ALIVE === 'false') {
    logger.info('Self keep-alive disabled (ENABLE_SELF_KEEP_ALIVE=false)');
    return;
  }

  const intervalMs = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '30000', 10);
  const port = process.env.PORT || 3000;
  const url = process.env.KEEP_ALIVE_URL || `http://127.0.0.1:${port}/health`;

  if (intervalId) {
    clearInterval(intervalId);
  }

  logger.info(`Self keep-alive enabled: GET ${url} every ${intervalMs / 1000}s`);

  const runPing = async () => {
    const result = await pingHealth(url);
    const mongoConnected = Database.isConnected();

    if (result.httpStatus === 200 && mongoConnected) {
      await recordHealthCheck({
        source: 'keep_alive',
        mongoConnected,
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        message: 'Keep-alive ping succeeded',
      });
    } else {
      await recordHealthCheck({
        source: 'keep_alive',
        mongoConnected,
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        status: result.httpStatus === 200 && !mongoConnected ? 'degraded' : 'dead',
        message: result.error
          ? `Keep-alive ping failed: ${result.error}`
          : `Keep-alive ping HTTP ${result.httpStatus}`,
      });
    }
  };

  runPing();

  intervalId = setInterval(runPing, intervalMs);
}

function stopSelfKeepAlive() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { startSelfKeepAlive, stopSelfKeepAlive, pingHealth };
