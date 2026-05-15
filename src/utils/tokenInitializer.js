/**
 * Token Initializer - Load and Validate Tokens from Database
 * Runs on server startup to initialize token health and prepare for searches
 */

const Token = require('../models/tokenModel');
const GitHubClient = require('../api/githubClient');
const Logger = require('./logger');
const { parseCoreRateLimit } = require('./githubRateLimit');

const logger = new Logger();

/**
 * Initialize tokens from database on server startup
 * - Load all active tokens
 * - Verify each token with GitHub API
 * - Update token metadata (username, scopes, rate limits)
 * - Mark unhealthy tokens
 */
async function initializeTokensFromDatabase() {
  try {
    logger.info('Starting token initialization from database...');

    // Get all active tokens from database
    const tokens = await Token.find({ isActive: true });
    logger.info(`Found ${tokens.length} active token(s) in database`);

    if (tokens.length === 0) {
      logger.warn('No active tokens found in database. Add tokens via API or Web UI.');
      return [];
    }

    const results = [];

    // Verify each token
    for (const tokenDoc of tokens) {
      try {
        logger.info(`Verifying token: ${tokenDoc.name}`);

        const verified = await verifyAndUpdateToken(tokenDoc);
        if (verified) {
          results.push({
            id: tokenDoc._id,
            name: tokenDoc.name,
            status: 'verified',
            username: verified.username,
            email: verified.email,
            requests: `${verified.requestsRemaining}/${verified.requestsLimit}`,
          });
        } else {
          results.push({
            id: tokenDoc._id,
            name: tokenDoc.name,
            // status: 'invalid',
          });
        }
      } catch (error) {
        logger.error(`Error verifying token ${tokenDoc.name}: ${error.message}`);
        results.push({
          id: tokenDoc._id,
          name: tokenDoc.name,
          status: 'error',
          error: error.message,
        });
      }
    }

    logger.info(`Token initialization complete: ${results.length}/${tokens.length} verified`);
    return results;
  } catch (error) {
    logger.error(`Error initializing tokens: ${error.message}`);
    return [];
  }
}

/**
 * Verify token with GitHub API and update metadata
 * @param {Object} tokenDoc - Token document from database
 * @returns {Object|null} Updated token data or null if invalid
 */
async function verifyAndUpdateToken(tokenDoc) {
  try {
    const client = new GitHubClient(tokenDoc.token);

    // Get authenticated user info
    const user = await client.getAuthenticatedUser();

    if (!user) {
      // tokenDoc.status = 'invalid';
      tokenDoc.failureReason = 'Failed to authenticate with GitHub API';
      await tokenDoc.save();
      return null;
    }

    // Update token metadata
    tokenDoc.gitHubUsername = user.login;
    tokenDoc.email = user.email || tokenDoc.email;
    tokenDoc.status = 'active';
    tokenDoc.failureReason = null;
    tokenDoc.lastChecked = new Date();

    const rateLimit = parseCoreRateLimit(await client.getRateLimit());
    if (rateLimit) {
      tokenDoc.requestsRemaining = rateLimit.remaining;
      tokenDoc.requestsLimit = rateLimit.limit;
      tokenDoc.resetTime = rateLimit.resetTime;
    } else {
      tokenDoc.resetTime = null;
    }

    await tokenDoc.save();

    logger.info(
      `Token verified: ${tokenDoc.name} (${user.login}) - ${tokenDoc.requestsRemaining}/${tokenDoc.requestsLimit} requests`
    );

    return {
      id: tokenDoc._id,
      username: user.login,
      email: user.email,
      requestsRemaining: tokenDoc.requestsRemaining,
      requestsLimit: tokenDoc.requestsLimit,
    };
  } catch (error) {
    logger.error(`Error verifying token: ${error.message}`);
    throw error;
  }
}

/**
 * Check health of all tokens (periodic health check)
 */
async function checkAllTokenHealth() {
  try {
    const tokens = await Token.find({ isActive: true });
    const results = [];

    for (const token of tokens) {
      try {
        await verifyAndUpdateToken(token);
        results.push({
          id: token._id,
          name: token.name,
          status: token.status,
          healthy: true,
        });
      } catch (error) {
        // token.status = 'invalid';
        token.failureReason = error.message;
        await token.save();
        results.push({
          id: token._id,
          name: token.name,
          // status: 'invalid',
          healthy: false,
          error: error.message,
        });
      }
    }

    return results;
  } catch (error) {
    logger.error(`Error checking token health: ${error.message}`);
    throw error;
  }
}

module.exports = {
  initializeTokensFromDatabase,
  verifyAndUpdateToken,
  checkAllTokenHealth,
};
