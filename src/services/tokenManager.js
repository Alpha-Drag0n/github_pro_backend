/**
 * Token Manager Service
 * Manages multiple GitHub tokens with automatic failover
 */

const axios = require('axios');
const Logger = require('../utils/logger');
const Token = require('../models/tokenModel');
const TokenSelector = require('./tokenSelector');
const { parseCoreRateLimit } = require('../utils/githubRateLimit');

class TokenManager {
  constructor() {
    this.logger = new Logger();
    this.currentTokenIndex = 0;
    this.tokens = [];
    this.tokenCache = {};
  }

  /**
   * Initialize tokens from database
   */
  async initialize() {
    try {
      this.tokens = await Token.find({ isActive: true }).sort({ createdAt: 1 });
      this.logger.info(`Loaded ${this.tokens.length} active tokens`);

      if (this.tokens.length === 0) {
        this.logger.warn('No active tokens found in database');
      }

      return this.tokens.length > 0;
    } catch (error) {
      this.logger.error(`Error initializing tokens: ${error.message}`);
      return false;
    }
  }

  /**
   * Add new token to database
   */
  async addToken(token, name) {
    try {
      // Verify token first
      const isValid = await this.verifyToken(token);

      if (!isValid) {
        throw new Error('Invalid GitHub token');
      }

      const newToken = new Token({
        token,
        name,
        status: 'active',
        isActive: true,
      });

      await newToken.save();
      this.tokens.push(newToken);

      this.logger.info(`Token added: ${name}`);
      return newToken;
    } catch (error) {
      this.logger.error(`Error adding token: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove token
   */
  async removeToken(tokenId) {
    try {
      const token = await Token.findByIdAndDelete(tokenId);
      this.tokens = this.tokens.filter(t => t._id.toString() !== tokenId);

      this.logger.info(`Token removed: ${token.name}`);
      return true;
    } catch (error) {
      this.logger.error(`Error removing token: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all tokens
   */
  async getAllTokens() {
    try {
      return await Token.find({}, '-token'); // Exclude actual token from response
    } catch (error) {
      this.logger.error(`Error getting tokens: ${error.message}`);
      return [];
    }
  }

  /**
   * Get current active token
   */
  getCurrentToken() {
    if (this.tokens.length === 0) {
      return null;
    }

    // Find first active token
    for (let i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].status === 'active' && this.tokens[i].isActive) {
        return this.tokens[i];
      }
    }

    return null;
  }

  /**
   * Switch to next token in createdAt order (wraps to first).
   */
  async switchToNextToken() {
    const currentToken = this.getCurrentToken();
    const { token: nextToken } = await TokenSelector.selectNextToken(currentToken?._id);

    if (nextToken) {
      this.logger.info(`Switched to token: ${nextToken.name}`);
      return nextToken;
    }

    this.logger.warn('No tokens in database for rotation');
    return null;
  }

  /**
   * Verify token validity
   */
  async verifyToken(token) {
    try {
      const response = await axios.get('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Update rate limit info
   */
  async updateRateLimit(token) {
    try {
      const response = await axios.get('https://api.github.com/rate_limit', {
        headers: {
          Authorization: `token ${token.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      const parsed = parseCoreRateLimit(response.data.resources);

      if (parsed) {
        token.requestsRemaining = parsed.remaining;
        token.requestsLimit = parsed.limit;
        token.resetTime = parsed.resetTime;
      } else {
        token.resetTime = null;
      }
      token.lastChecked = new Date();

      if (parsed && parsed.remaining === 0) {
        // token.status = 'rate_limited';
      } else if (token.status === 'rate_limited') {
        token.status = 'active';
      }

      await token.save();
      return token;
    } catch (error) {
      this.logger.error(`Error updating rate limit: ${error.message}`);
      return null;
    }
  }

  /**
   * Check and update all tokens
   */
  async checkAllTokens() {
    const results = [];

    // Load tokens straight from the DB. The route instantiates a fresh TokenManager and
    // never calls initialize(), so this.tokens would be empty here - which is why the
    // endpoint reported "checked 0 tokens". Querying directly makes the check stateless.
    this.tokens = await Token.find({});

    for (const token of this.tokens) {
      try {
        const isValid = await this.verifyToken(token.token);

        if (!isValid) {
          // token.status = 'invalid';
          // token.isActive = false;
          token.failureReason = 'Token verification failed';
        } else {
          await this.updateRateLimit(token);
          token.errorCount = 0;
          token.failureReason = undefined; // clear any stale failure note on a now-valid token
        }

        await token.save();
        results.push(token);
      } catch (error) {
        this.logger.error(`Error checking token ${token.name}: ${error.message}`);
      }
    }

    this.logger.info(`Token check complete: ${results.length} tokens checked`);
    return results;
  }

  /**
   * Handle token error
   */
  async handleTokenError(token, error) {
    try {
      token.errorCount += 1;

      if (error.response?.status === 401) {
        // token.status = 'expired';
        token.failureReason = 'Unauthorized (401)';
      } else if (error.response?.status === 403) {
        // token.status = 'rate_limited';
        token.failureReason = 'Forbidden (403) - Rate limited';
      }

      await token.save();

      if (error.response?.status === 401 || error.response?.status === 403) {
        return await this.switchToNextToken();
      }

      return token;
    } catch (error) {
      this.logger.error(`Error handling token error: ${error.message}`);
      return null;
    }
  }

  /**
   * Record successful token usage
   */
  async recordSuccess(token) {
    try {
      token.successCount += 1;
      token.lastUsed = new Date();
      await token.save();
    } catch (error) {
      this.logger.error(`Error recording token success: ${error.message}`);
    }
  }
}

module.exports = TokenManager;
