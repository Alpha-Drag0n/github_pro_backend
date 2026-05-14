/**
 * Search Configuration File
 * Define your search parameters here
 */

module.exports = {
  // Account type: 'user' or 'org'
  accountType: process.env.ACCOUNT_TYPE || 'user',

  // List of locations to search
  locations: JSON.parse(process.env.LOCATIONS || '["Atlanta, GA", "San Francisco, CA"]'),

  // Date range for account creation
  startYear: parseInt(process.env.START_YEAR || 2011),
  endYear: parseInt(process.env.END_YEAR || 2025),

  // API rate limiting
  rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY || 1000),
  maxRetries: parseInt(process.env.MAX_RETRIES || 3),

  // Results per page for pagination
  perPage: 100,

  // Maximum commits to fetch per user
  maxCommitsPerUser: 1000,
};
