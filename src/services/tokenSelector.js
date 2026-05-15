/**
 * Token Selector Service
 * Intelligently selects the best available token for API calls
 * Handles priority, rate limits, and token health
 */

const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');

const logger = new Logger();

/**
 * Get the best available token for API calls
 * Selection criteria (in order):
 * 1. Token must be active (isActive: true)
 * 2. Token must have healthy status (not 'invalid' or 'expired')
 * 3. Token must have requests remaining
 * 4. Select token used least recently (load balancing - PRIMARY)
 *
 * @returns {Object|null} Token document or null if no tokens available
 */
async function selectBestToken() {
  try {
    // Find all potentially usable tokens
    const tokens = await Token.find({
      // isActive: true,
      // status: { $in: ['active', 'rate_limited'] },
      // requestsRemaining: { $gt: 0 },
    }).sort({
      lastUsed: 1, // Least recently used first (load balancing)
    });

    if (tokens.length === 0) {
      logger.warn('No available tokens with remaining requests');
      return null;
    }

    const selectedToken = tokens[0];
    logger.info(
      `Selected token: ${selectedToken.name} (${selectedToken.requestsRemaining}/${selectedToken.requestsLimit} requests, lastUsed: ${selectedToken.lastUsed || 'never'})`
    );

    return selectedToken;
  } catch (error) {
    logger.error(`Error selecting token: ${error.message}`);
    return null;
  }
}

/**
 * Get token by ID and check if it's available
 * @param {string} tokenId - MongoDB token ID
 * @returns {Object|null} Token document or null if not available
 */
async function getTokenById(tokenId) {
  try {
    const token = await Token.findById(tokenId);

    if (!token) {
      logger.warn(`Token not found: ${tokenId}`);
      return null;
    }

    if (!token.isActive) {
      logger.warn(`Token is not active: ${token.name}`);
      return null;
    }

    if (token.status === 'invalid' || token.status === 'expired') {
      logger.warn(`Token is not healthy: ${token.name} (${token.status})`);
      return null;
    }

    if (token.requestsRemaining <= 0) {
      logger.warn(`Token has no remaining requests: ${token.name}`);
      return null;
    }

    return token;
  } catch (error) {
    logger.error(`Error getting token by ID: ${error.message}`);
    return null;
  }
}

/**
 * Get all available tokens (for monitoring/selection)
 * @returns {Array} Array of available token documents
 */
async function getAllAvailableTokens() {
  try {
    const tokens = await Token.find({
      // isActive: true,
      // status: { $in: ['active', 'rate_limited'] },
    })
      .select('-token') // Don't return the actual token value
      .sort({ lastUsed: 1 });

    return tokens;
  } catch (error) {
    logger.error(`Error getting available tokens: ${error.message}`);
    return [];
  }
}

/**
 * Update token usage (called after successful API call)
 * @param {string} tokenId - MongoDB token ID
 * @param {number} requestsUsed - Number of requests consumed
 */
async function updateTokenUsage(tokenId, requestsUsed = 1) {
  try {
    const token = await Token.findById(tokenId);

    if (!token) {
      logger.warn(`Token not found for update: ${tokenId}`);
      return false;
    }

    // Update token metrics
    token.lastUsed = new Date();
    token.successCount += 1;
    token.usageCount += 1; // Increment total usage count
    token.requestsRemaining = Math.max(0, token.requestsRemaining - requestsUsed);

    // If no requests left, mark as rate limited
    if (token.requestsRemaining <= 0) {
      // token.status = 'rate_limited';
      logger.warn(
        `Token rate limited: ${token.name} (${token.requestsRemaining}/${token.requestsLimit})`
      );
    }

    await token.save();
    logger.debug(`Token usage updated: ${token.name} (Total: ${token.usageCount}, Remaining: ${token.requestsRemaining})`);
    return true;
  } catch (error) {
    logger.error(`Error updating token usage: ${error.message}`);
    return false;
  }
}

/**
 * Mark token as having an error (called after API error)
 * @param {string} tokenId - MongoDB token ID
 * @param {string} errorReason - Error message/reason
 */
async function markTokenError(tokenId, errorReason) {
  try {
    const token = await Token.findById(tokenId);

    if (!token) {
      logger.warn(`Token not found for error update: ${tokenId}`);
      return false;
    }

    token.errorCount += 1;
    token.failureReason = errorReason;
    token.lastChecked = new Date();

    // Mark as invalid if authentication fails
    if (errorReason.includes('401') || errorReason.includes('authentication')) {
      // token.status = 'invalid';
      // token.isActive = false;
      logger.error(`Token marked as invalid: ${token.name}`);
    }
    // Mark as expired if token is revoked
    else if (errorReason.includes('403') || errorReason.includes('revoked')) {
      // token.status = 'expired';
      // token.isActive = false;
      logger.error(`Token marked as expired: ${token.name}`);
    }

    await token.save();
    return true;
  } catch (error) {
    logger.error(`Error marking token error: ${error.message}`);
    return false;
  }
}

/**
 * Get token status summary
 * @returns {Object} Summary of token statuses
 */
async function getTokenStatusSummary() {
  try {
    const tokens = await Token.find().select('-token');

    const summary = {
      total: tokens.length,
      active: tokens.filter(t => t.status === 'active').length,
      rateLimited: tokens.filter(t => t.status === 'rate_limited').length,
      expired: tokens.filter(t => t.status === 'expired').length,
      invalid: tokens.filter(t => t.status === 'invalid').length,
      totalRequestsRemaining: tokens.reduce((sum, t) => sum + t.requestsRemaining, 0),
      totalRequestsLimit: tokens.reduce((sum, t) => sum + t.requestsLimit, 0),
      availableForUse: tokens.filter(t => t.isActive && t.status === 'active').length,
    };

    return summary;
  } catch (error) {
    logger.error(`Error getting token status summary: ${error.message}`);
    return null;
  }
}

module.exports = {
  selectBestToken,
  getTokenById,
  getAllAvailableTokens,
  updateTokenUsage,
  markTokenError,
  getTokenStatusSummary,
};
