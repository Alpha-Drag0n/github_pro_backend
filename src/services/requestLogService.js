/**
 * Request Log Service
 * Buffers request logs and saves them in batches to reduce DB writes
 */

const RequestLog = require('../models/requestLogModel');
const Logger = require('../utils/logger');

const logger = new Logger();

class RequestLogService {
  constructor(batchSize = 100, autoFlushIntervalMs = 60000) {
    this.buffer = [];
    this.batchSize = batchSize;
    this.autoFlushIntervalMs = autoFlushIntervalMs;
    this.flushIntervalId = null;
    this.startAutoFlush();
  }

  /**
   * Add a request log to the buffer
   * @param {Object} logData - Request log data
   */
  addLog(logData) {
    const log = {
      serverType: logData.serverType, // 'github' or 'db'
      endpoint: logData.endpoint,
      parameters: logData.parameters || {},
      purpose: logData.purpose, // 'create', 'read', 'update', 'delete', 'find'
      sentAt: logData.sentAt || new Date(),
      receivedAt: logData.receivedAt || new Date(),
      duration: logData.duration || 0,
      status: logData.status || 'success',
      errorMessage: logData.errorMessage || null,
      statusCode: logData.statusCode || null,
      searchId: logData.searchId || null,
    };

    this.buffer.push(log);

    // Auto-flush if buffer reaches batch size
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Log a GitHub API call
   * @param {string} endpoint - GitHub endpoint (e.g., '/search/users')
   * @param {Object} parameters - Request parameters
   * @param {string} purpose - Operation purpose
   * @param {number} duration - Response time in ms
   * @param {boolean} success - Whether request succeeded
   * @param {string} errorMessage - Error message if failed
   * @param {number} statusCode - HTTP status code
   * @param {string} searchId - Optional search ID reference
   */
  logGitHubCall(endpoint, parameters = {}, purpose = 'read', duration = 0, success = true, errorMessage = null, statusCode = 200, searchId = null) {
    this.addLog({
      serverType: 'github',
      endpoint,
      parameters,
      purpose,
      duration,
      status: success ? 'success' : 'error',
      errorMessage,
      statusCode,
      searchId,
    });
  }

  /**
   * Log a Database operation
   * @param {string} endpoint - MongoDB operation (e.g., 'User.findOne', 'Search.updateOne')
   * @param {Object} parameters - Query/update parameters
   * @param {string} purpose - Operation purpose
   * @param {number} duration - Operation time in ms
   * @param {boolean} success - Whether operation succeeded
   * @param {string} errorMessage - Error message if failed
   * @param {string} searchId - Optional search ID reference
   */
  logDBOperation(endpoint, parameters = {}, purpose = 'read', duration = 0, success = true, errorMessage = null, searchId = null) {
    this.addLog({
      serverType: 'db',
      endpoint,
      parameters,
      purpose,
      duration,
      status: success ? 'success' : 'error',
      errorMessage,
      searchId,
    });
  }

  /**
   * Flush buffered logs to database
   */
  async flush() {
    if (this.buffer.length === 0) {
      return;
    }

    const logsToSave = [...this.buffer];
    this.buffer = [];

    try {
      const result = await RequestLog.insertMany(logsToSave);
      logger.info(`Flushed ${result.length} request logs to database`);
    } catch (error) {
      logger.error(`Error flushing request logs: ${error.message}`);
      // Re-add logs to buffer on error (best effort)
      this.buffer = [...logsToSave, ...this.buffer];
    }
  }

  /**
   * Start auto-flush interval
   */
  startAutoFlush() {
    if (this.flushIntervalId) {
      return;
    }

    this.flushIntervalId = setInterval(async () => {
      await this.flush();
    }, this.autoFlushIntervalMs);

    logger.info(`RequestLogService auto-flush started (interval: ${this.autoFlushIntervalMs}ms, batch size: ${this.batchSize})`);
  }

  /**
   * Stop auto-flush interval
   */
  stopAutoFlush() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
  }

  /**
   * Get buffer size
   */
  getBufferSize() {
    return this.buffer.length;
  }

  /**
   * Flush on graceful shutdown
   */
  async shutdown() {
    this.stopAutoFlush();
    await this.flush();
    logger.info('RequestLogService shutdown complete');
  }
}

// Create singleton instance
const requestLogService = new RequestLogService(100, 60000); // Batch 100 or flush every 60s

module.exports = requestLogService;
