/**
 * WebSocket broadcasts for search list and status changes.
 */

const Search = require('../models/searchModel');
const Logger = require('../utils/logger');

const logger = new Logger();

async function notifySearchChange(io, search) {
  if (!io || !search) {
    return;
  }

  try {
    io.emit('search:status:updated', {
      searchId: search.searchId,
      status: search.status,
      tokenName: search.tokenName,
      error: search.error,
      progress: search.progress,
      results: search.results,
      recoverable: search.recoverable,
      updatedAt: search.updatedAt,
    });

    const searches = await Search.find().sort({ createdAt: -1 }).limit(100);
    io.emit('searches:updated', searches);
  } catch (error) {
    logger.error(`Search broadcast failed: ${error.message}`);
  }
}

module.exports = { notifySearchChange };
