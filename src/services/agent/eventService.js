/**
 * Event service — append-only structured logging for the agent system.
 *
 * Fire-and-forget by design: logging must never break the work. Every write is
 * best-effort (errors are swallowed) and also mirrored to the normal logger.
 */

const Event = require('../../models/eventModel');
const Logger = require('../../utils/logger');

const logger = new Logger();

/**
 * @param {object} e
 * @param {string} e.type   - controlled vocabulary, e.g. 'task.done'
 * @param {string} [e.level='info']
 * @param {string} [e.message]
 * @param {string} [e.agentId]
 * @param {*} [e.taskId] @param {*} [e.searchId] @param {*} [e.tokenId]
 * @param {object} [e.data]
 */
async function emit(e) {
  const level = e.level || 'info';
  try {
    await Event.create({
      ts: new Date(),
      level,
      type: e.type,
      agentId: e.agentId || null,
      taskId: e.taskId || null,
      searchId: e.searchId || null,
      tokenId: e.tokenId || null,
      message: e.message,
      data: e.data,
    });
  } catch (err) {
    // Never let logging failures affect the pipeline.
    logger.warn(`[events] failed to persist ${e.type}: ${err.message}`);
  }

  const line = `[event:${e.type}] ${e.message || ''}`;
  if (level === 'error' || level === 'critical') logger.error(line);
  else if (level === 'warn') logger.warn(line);
  else logger.info(line);
}

module.exports = { emit };
