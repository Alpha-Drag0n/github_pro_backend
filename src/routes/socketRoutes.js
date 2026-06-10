/**
 * WebSocket Event Handlers
 * Manages real-time communication between server and clients
 */

const Token = require('../models/tokenModel');
const QuickSearch = require('../models/quickSearchModel');

function setupSocketHandlers(socket, io, logger) {
  // ============================================
  // Token Events
  // ============================================

  /**
   * Request to get all tokens and subscribe to updates
   */
  socket.on('subscribe:tokens', async () => {
    try {
      const tokens = await Token.find({}, '-token');
      socket.emit('tokens:updated', tokens);

      // Join room for token updates
      socket.join('tokens');
      logger.info(`Socket ${socket.id} subscribed to token updates`);
    } catch (error) {
      logger.error(`Error subscribing to tokens: ${error.message}`);
      socket.emit('error', { message: 'Failed to subscribe to tokens' });
    }
  });

  /**
   * Request to get single token details
   */
  socket.on('token:get', async (tokenId) => {
    try {
      const token = await Token.findById(tokenId, '-token');
      if (token) {
        socket.emit('token:details', { id: tokenId, data: token });
      }
    } catch (error) {
      logger.error(`Error getting token: ${error.message}`);
    }
  });

  /**
   * Broadcast token update to all connected clients
   */
  socket.on('token:updated', async (tokenData) => {
    try {
      const token = await Token.findById(tokenData.id, '-token');
      if (token) {
        io.to('tokens').emit('tokens:updated', token);
        logger.info(`Token updated broadcast: ${token.name}`);
      }
    } catch (error) {
      logger.error(`Error broadcasting token update: ${error.message}`);
    }
  });

  // ============================================
  // Search Events
  // ============================================

  /**
   * Request to subscribe to search updates
   */
  socket.on('subscribe:searches', async () => {
    try {
      const searches = await QuickSearch.find().sort({ createdAt: -1 });
      socket.emit('searches:updated', searches);

      socket.join('searches');
      logger.info(`Socket ${socket.id} subscribed to search updates`);
    } catch (error) {
      logger.error(`Error subscribing to searches: ${error.message}`);
    }
  });

  /**
   * Subscribe to specific search progress
   */
  socket.on('subscribe:search-progress', (searchId) => {
    const roomName = `search:${searchId}`;
    socket.join(roomName);
    logger.info(`Socket ${socket.id} subscribed to search ${searchId} progress`);
    socket.emit('search:subscribed', { searchId });
  });

  /**
   * Update search progress (called by search service)
   */
  socket.on('search:progress', async (data) => {
    try {
      const { searchId, current, total, percentage, status } = data;
      const roomName = `search:${searchId}`;

      // Broadcast progress to all subscribers
      io.to(roomName).emit('search:progress:updated', {
        searchId,
        current,
        total,
        percentage,
        status,
      });

      logger.debug(`Search progress: ${searchId} - ${percentage}%`);
    } catch (error) {
      logger.error(`Error updating search progress: ${error.message}`);
    }
  });

  /**
   * Update search results (called by search service)
   */
  socket.on('search:results', async (data) => {
    try {
      const { searchId, usersFound, usersProcessed, emailsExtracted } = data;
      const roomName = `search:${searchId}`;

      io.to(roomName).emit('search:results:updated', {
        searchId,
        usersFound,
        usersProcessed,
        emailsExtracted,
      });

      logger.debug(`Search results updated: ${searchId}`);
    } catch (error) {
      logger.error(`Error updating search results: ${error.message}`);
    }
  });

  /**
   * Search completed (called by search service)
   */
  socket.on('search:completed', async (data) => {
    try {
      const { searchId, duration, status } = data;
      const roomName = `search:${searchId}`;

      // Update all subscribers
      io.to(roomName).emit('search:completed', {
        searchId,
        duration,
        status,
        completedAt: new Date(),
      });

      // Also update global searches list
      const search = await QuickSearch.findOne({ searchId });
      if (search) {
        io.to('searches').emit('search:added', search);
      }

      logger.info(`Search completed: ${searchId}`);
    } catch (error) {
      logger.error(`Error on search completed: ${error.message}`);
    }
  });

  /**
   * Search error
   */
  socket.on('search:error', async (data) => {
    try {
      const { searchId, error } = data;
      const roomName = `search:${searchId}`;

      io.to(roomName).emit('search:error', {
        searchId,
        error,
        status: 'failed',
      });

      logger.error(`Search error: ${searchId} - ${error}`);
    } catch (err) {
      logger.error(`Error handling search error: ${err.message}`);
    }
  });

  // ============================================
  // Dashboard Events
  // ============================================

  /**
   * Request dashboard statistics
   */
  socket.on('dashboard:stats', async () => {
    try {
      const tokens = await Token.find();
      const searches = await QuickSearch.find();

      const activeTokens = tokens.filter(t => t.status === 'active' && t.isActive).length;
      let totalUsers = 0;
      let totalEmails = 0;

      searches.forEach(search => {
        totalUsers += search.results.totalUsersFound || 0;
        totalEmails += search.results.totalEmailsExtracted || 0;
      });

      socket.emit('dashboard:stats', {
        totalTokens: activeTokens,
        totalSearches: searches.length,
        totalUsers,
        totalEmails,
        recentSearches: searches.slice(0, 5),
      });

      socket.join('dashboard');
      logger.info(`Socket ${socket.id} subscribed to dashboard updates`);
    } catch (error) {
      logger.error(`Error getting dashboard stats: ${error.message}`);
    }
  });

  /**
   * Broadcast dashboard update
   */
  socket.on('dashboard:refresh', async () => {
    try {
      const tokens = await Token.find();
      const searches = await QuickSearch.find();

      const activeTokens = tokens.filter(t => t.status === 'active' && t.isActive).length;
      let totalUsers = 0;
      let totalEmails = 0;

      searches.forEach(search => {
        totalUsers += search.results.totalUsersFound || 0;
        totalEmails += search.results.totalEmailsExtracted || 0;
      });

      io.to('dashboard').emit('dashboard:stats', {
        totalTokens: activeTokens,
        totalSearches: searches.length,
        totalUsers,
        totalEmails,
        recentSearches: searches.slice(0, 5),
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error(`Error refreshing dashboard: ${error.message}`);
    }
  });

  // ============================================
  // System Events
  // ============================================

  /**
   * Ping for connection health check
   */
  socket.on('ping', () => {
    socket.emit('pong');
  });

  /**
   * Get connection info
   */
  socket.on('connection:info', () => {
    socket.emit('connection:info', {
      connected: true,
      socketId: socket.id,
      timestamp: new Date(),
    });
  });
}

module.exports = setupSocketHandlers;
