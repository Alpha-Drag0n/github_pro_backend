/**
 * Token Selector Service
 * Deterministic token rotation ordered by createdAt (oldest first).
 */

const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');

const logger = new Logger();

const CREATED_AT_SORT = { createdAt: 1 };

/**
 * All tokens in stable creation order (same order on every query).
 * @returns {Promise<Array>}
 */
async function getTokensByCreatedAt() {
  return Token.find().sort(CREATED_AT_SORT);
}

/**
 * First token in creation order (start of rotation).
 * @returns {Promise<Object|null>}
 */
async function selectFirstToken() {
  const tokens = await getTokensByCreatedAt();
  if (tokens.length === 0) {
    logger.warn('No GitHub tokens in database');
    return null;
  }

  const selected = tokens[0];
  logger.info(`Selected first token (by createdAt): ${selected.name}`);
  return selected;
}

/**
 * Next token after currentTokenId in creation order; wraps to the first token.
 * @param {string|Object|null} currentTokenId - Current token _id (null = first token)
 * @returns {Promise<{ token: Object|null, fullCycle: boolean }>}
 */
async function selectNextToken(currentTokenId = null) {
  const tokens = await getTokensByCreatedAt();

  if (tokens.length === 0) {
    logger.warn('No GitHub tokens in database');
    return { token: null, fullCycle: false };
  }

  if (!currentTokenId) {
    return { token: tokens[0], fullCycle: false };
  }

  const currentId = currentTokenId.toString();
  const currentIdx = tokens.findIndex((t) => t._id.toString() === currentId);

  if (currentIdx === -1) {
    logger.warn(`Current token ${currentId} not found; starting rotation from first token`);
    return { token: tokens[0], fullCycle: false };
  }

  const nextIdx = (currentIdx + 1) % tokens.length;
  const fullCycle =
    tokens.length === 1 || (currentIdx === tokens.length - 1 && nextIdx === 0);
  const selected = tokens[nextIdx];

  logger.info(
    `Rotated to next token: ${selected.name} (index ${nextIdx + 1}/${tokens.length}${fullCycle ? ', full cycle' : ''})`
  );

  return { token: selected, fullCycle };
}

/**
 * @deprecated Use selectFirstToken for new searches.
 */
async function selectBestToken() {
  return selectFirstToken();
}

/**
 * Get token by ID
 * @param {string} tokenId
 * @returns {Promise<Object|null>}
 */
async function getTokenById(tokenId) {
  try {
    return await Token.findById(tokenId);
  } catch (error) {
    logger.error(`Error getting token by ID: ${error.message}`);
    return null;
  }
}

/**
 * All tokens in creation order (without secret value in list responses).
 * @returns {Promise<Array>}
 */
async function getAllAvailableTokens() {
  try {
    return Token.find().select('-token').sort(CREATED_AT_SORT);
  } catch (error) {
    logger.error(`Error getting available tokens: ${error.message}`);
    return [];
  }
}

/**
 * @param {string} tokenId
 * @param {number} requestsUsed
 */
async function updateTokenUsage(tokenId, requestsUsed = 1) {
  try {
    const token = await Token.findById(tokenId);

    if (!token) {
      logger.warn(`Token not found for update: ${tokenId}`);
      return false;
    }

    token.lastUsed = new Date();
    token.successCount += 1;
    token.usageCount += 1;
    token.requestsRemaining = Math.max(0, token.requestsRemaining - requestsUsed);

    if (token.requestsRemaining <= 0) {
      logger.warn(
        `Token rate limited: ${token.name} (${token.requestsRemaining}/${token.requestsLimit})`
      );
    }

    await token.save();
    return true;
  } catch (error) {
    logger.error(`Error updating token usage: ${error.message}`);
    return false;
  }
}

/**
 * Record an API error on a token (does not disable rotation).
 * @param {string} tokenId
 * @param {string} errorReason
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
    await token.save();
    return true;
  } catch (error) {
    logger.error(`Error marking token error: ${error.message}`);
    return false;
  }
}

/**
 * @returns {Promise<Object|null>}
 */
async function getTokenStatusSummary() {
  try {
    const tokens = await Token.find().select('-token');

    return {
      total: tokens.length,
      active: tokens.filter((t) => t.status === 'active').length,
      rateLimited: tokens.filter((t) => t.status === 'rate_limited').length,
      expired: tokens.filter((t) => t.status === 'expired').length,
      invalid: tokens.filter((t) => t.status === 'invalid').length,
      totalRequestsRemaining: tokens.reduce((sum, t) => sum + t.requestsRemaining, 0),
      totalRequestsLimit: tokens.reduce((sum, t) => sum + t.requestsLimit, 0),
      availableForUse: tokens.filter((t) => t.isActive && t.status === 'active').length,
    };
  } catch (error) {
    logger.error(`Error getting token status summary: ${error.message}`);
    return null;
  }
}

module.exports = {
  getTokensByCreatedAt,
  selectFirstToken,
  selectNextToken,
  selectBestToken,
  getTokenById,
  getAllAvailableTokens,
  updateTokenUsage,
  markTokenError,
  getTokenStatusSummary,
};
