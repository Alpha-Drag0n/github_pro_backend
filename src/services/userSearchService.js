/**
 * User Search Service
 * Orchestrates user search across locations and date ranges with automatic token failover
 */

const GitHubClient = require('../api/githubClient');
const Logger = require('../utils/logger');
const Token = require('../models/tokenModel');
const TokenSelector = require('./tokenSelector');
const { sleep } = require('../utils/helpers');

const TOKEN_ROTATION_DELAY_MS = 500;
const TOKEN_FULL_CYCLE_COOLDOWN_MS = 60000;

class UserSearchService {
  constructor(githubToken, searchParameters = null, options = {}) {
    this.client = new GitHubClient(githubToken);
    this.logger = new Logger();
    this.currentToken = githubToken;
    this.currentTokenId = options.currentTokenId || null;
    this.foundUsers = [];
    this.searchLog = [];
    
    // Use provided parameters or fall back to config
    if (searchParameters) {
      this.locations = searchParameters.locations || [];
      this.startYear = searchParameters.startYear || 2011;
      this.endYear = searchParameters.endYear || new Date().getFullYear();
      this.accountType = searchParameters.accountType || 'user';
      this.followers = searchParameters.followers || '<30';
    } else {
      const config = require('../../config/searchConfig');
      this.locations = config.locations || [];
      this.startYear = config.startYear || 2011;
      this.endYear = config.endYear || new Date().getFullYear();
      this.accountType = config.accountType || 'user';
      this.followers = config.followers || '<30';
    }
  }

  /**
   * Execute API call with automatic token failover on error
   * @param {string} operation - Operation name for logging
   * @param {Function} apiCall - Async function that makes the API call
   * @returns {Promise<any>} Result from API call or null on failure
   */
  async executeWithFailover(operation, apiCall) {
    try {
      return await apiCall(this.client);
    } catch (error) {
      // Handle rate limiting and authentication errors with failover
      const status = error.response?.status;
      
      if (status === 401 || status === 403) {
        this.logger.warn(`${operation} failed with status ${status}. Rotating to next token...`);

        const { token: nextMeta, fullCycle } = await TokenSelector.selectNextToken(this.currentTokenId);

        if (!nextMeta) {
          throw error;
        }

        const nextDoc = await Token.findById(nextMeta._id);
        this.currentTokenId = nextDoc._id;
        this.currentToken = nextDoc.token;
        this.client = new GitHubClient(nextDoc.token);

        this.logger.info(`Switched to token: ${nextDoc.name}${fullCycle ? ' (full rotation cycle)' : ''}`);

        await sleep(fullCycle ? TOKEN_FULL_CYCLE_COOLDOWN_MS : TOKEN_ROTATION_DELAY_MS);
        return await apiCall(this.client);
      }
      
      throw error;
    }
  }

  /**
   * Generate all location-year combinations for search
   * @returns {Array<Object>} Array of {location, startDate, endDate} objects
   */
  generateSearchCombinations() {
    const combinations = [];
    for (let year = this.startYear; year <= this.endYear; year++) {
      for (const location of this.locations) {
        combinations.push({
          location,
          year,
          startDate: `${year}-01-01`,
          endDate: `${year}-12-31`,
        });
      }
    }
    return combinations;
  }

  /**
   * Execute all searches based on configuration
   * @returns {Promise<Array>} Array of found users
   */
  async executeSearch() {
    const combinations = this.generateSearchCombinations();
    this.logger.info(`Starting search with ${combinations.length} combinations`);

    for (const combo of combinations) {
      try {
        this.logger.info(`Searching: ${combo.location} (${combo.year})`);

        const users = await this.executeWithFailover(
          `Search ${combo.location} (${combo.year})`,
          (client) => client.searchUsers(
            combo.location,
            combo.startDate,
            combo.endDate,
            this.followers,
            this.accountType,
            100
          )
        );

        this.searchLog.push({
          location: combo.location,
          year: combo.year,
          date: new Date().toISOString(),
          usersFound: users.length,
          startDate: combo.startDate,
          endDate: combo.endDate,
        });

        // Deduplicate users by adding to map
        for (const user of users) {
          if (!this.foundUsers.find(u => u.id === user.id)) {
            this.foundUsers.push(user);
          }
        }

        // Rate limiting
        await sleep(config.rateLimitDelay);
      } catch (error) {
        this.logger.error(`Error during search for ${combo.location} ${combo.year}: ${error.message}`);
        this.searchLog.push({
          location: combo.location,
          year: combo.year,
          date: new Date().toISOString(),
          error: error.message,
          startDate: combo.startDate,
          endDate: combo.endDate,
        });
      }
    }

    this.logger.info(`Search complete. Found ${this.foundUsers.length} unique users`);
    return this.foundUsers;
  }

  /**
   * Get search log
   * @returns {Array} Search log entries
   */
  getSearchLog() {
    return this.searchLog;
  }

  /**
   * Get found users
   * @returns {Array} Found users
   */
  getFoundUsers() {
    return this.foundUsers;
  }
}

module.exports = UserSearchService;
