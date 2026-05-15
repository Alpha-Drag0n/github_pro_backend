/**
 * Periodic self-request to /health (keeps process active while it is already running).
 */

const http = require('http');
const https = require('https');
const Logger = require('../utils/logger');

const logger = new Logger();

let intervalId = null;

function pingHealth(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (err) => {
      logger.debug(`Keep-alive ping failed: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
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

  pingHealth(url);

  intervalId = setInterval(() => {
    pingHealth(url);
  }, intervalMs);
}

function stopSelfKeepAlive() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { startSelfKeepAlive, stopSelfKeepAlive, pingHealth };
