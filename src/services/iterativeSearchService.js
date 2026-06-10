/**
 * Iterative Search Service
 * Performs iterative GitHub user searches with location exclusion
 * Bypasses the 1000 result limit by excluding locations found in user profiles
 */

const axios = require('axios');
const User = require('../models/userModel');
const Search = require('../models/searchModel');
const logger = require('../utils/logger');

class IterativeSearchService {
  constructor() {
    this.githubToken = process.env.GITHUB_TOKEN;
    this.baseUrl = 'https://api.github.com';
  }

  /**
   * Execute iterative search to find users without location in bio
   * @param {object} options - Search options
   * @param {string} options.createdDate - GitHub creation date (e.g., 2011-01-01)
   * @param {string} options.accountType - 'user' or 'org'
   * @param {string} options.searchId - Search ID for tracking
   * @returns {array} Found users
   */
  async executeIterativeSearch(options) {
    const {
      createdDate,
      accountType = 'user',
      searchId,
    } = options;

    try {
      logger.log(
        `[IterativeSearch] Starting iterative search for date: ${createdDate}, searchId: ${searchId}`
      );

      const allFoundUsers = [];
      const searchHistory = [];
      let iteration = 1;
      let excludedLocations = [];
      let previousResultCount = 1000;

      // Continue until we get results with no location info
      while (true) {
        logger.log(
          `[IterativeSearch] Iteration ${iteration}: Searching with ${excludedLocations.length} exclusions`
        );

        // Build search query
        const query = this.buildSearchQuery(createdDate, accountType, excludedLocations);
        
        // Execute search
        const results = await this.searchUsers(query);
        logger.log(
          `[IterativeSearch] Iteration ${iteration} returned ${results.length} results`
        );

        // Save search history
        searchHistory.push({
          iterationNumber: iteration,
          searchDate: new Date(),
          excludedLocations: [...excludedLocations],
          resultCount: results.length,
        });

        // If no results, stop
        if (results.length === 0) {
          logger.log(`[IterativeSearch] No results in iteration ${iteration}. Stopping.`);
          break;
        }

        // If results <= 1000 and no new locations found, stop
        if (results.length < 1000) {
          const newLocations = this.extractLocationsList(results);
          const newLocationsNotExcluded = newLocations.filter(
            loc => !excludedLocations.includes(loc)
          );

          if (newLocationsNotExcluded.length === 0) {
            logger.log(
              `[IterativeSearch] No new locations found in iteration ${iteration}. All results added. Stopping.`
            );
            allFoundUsers.push(...results);
            break;
          }

          // Add results and continue with exclusions
          allFoundUsers.push(...results);
          excludedLocations.push(...newLocationsNotExcluded);
          iteration++;
          continue;
        }

        // Results = 1000, may have more
        allFoundUsers.push(...results);

        // Extract locations from these results
        const newLocations = this.extractLocationsList(results);
        logger.log(
          `[IterativeSearch] Found ${newLocations.length} unique locations in iteration ${iteration}`
        );

        // If no new locations found at 1000 limit, stop
        const newLocationsNotExcluded = newLocations.filter(
          loc => !excludedLocations.includes(loc)
        );

        if (newLocationsNotExcluded.length === 0) {
          logger.log(
            `[IterativeSearch] No new locations to exclude. Stopping at iteration ${iteration}.`
          );
          break;
        }

        // Add to exclusion list and iterate
        excludedLocations.push(...newLocationsNotExcluded);
        iteration++;

        // Safety check: max 50 iterations
        if (iteration > 50) {
          logger.log(
            `[IterativeSearch] Reached max iterations (50). Stopping with ${excludedLocations.length} excluded locations.`,
            'warn'
          );
          if (allFoundUsers.length > 1000) {
            logger.log(
              `[IterativeSearch] WARNING: Final result count ${allFoundUsers.length} exceeds 1000 after all exclusions.`,
              'warn'
            );
          }
          break;
        }
      }

      logger.log(
        `[IterativeSearch] Complete: Found ${allFoundUsers.length} unique users, ${excludedLocations.length} locations excluded, ${iteration} iterations`
      );

      // Log search completion
      await this.logSearchCompletion(searchId, searchHistory, allFoundUsers.length, excludedLocations);

      return allFoundUsers;
    } catch (error) {
      logger.log(`[IterativeSearch] Fatal error: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Build GitHub search query with location exclusions
   */
  buildSearchQuery(createdDate, accountType, excludedLocations) {
    let query = `created:${createdDate} type:${accountType}`;

    // Add location exclusions
    excludedLocations.forEach(location => {
      query += ` -location:"${location}"`;
    });

    return query;
  }

  /**
   * Search GitHub for users by query
   */
  async searchUsers(query) {
    try {
      const response = await axios.get(`${this.baseUrl}/search/users`, {
        headers: this.getHeaders(),
        params: {
          q: query,
          per_page: 100,
          page: 1,
          sort: 'repositories',
          order: 'desc',
        },
        timeout: 15000,
      });

      // GitHub returns up to 1000 total results, but limited per page
      // We can only fetch first 100 per page without hitting limits
      const results = response.data.items || [];
      
      // Try to fetch up to 10 pages if available
      if (response.data.total_count > 100) {
        for (let page = 2; page <= Math.min(10, Math.ceil(response.data.total_count / 100)); page++) {
          try {
            const pageResponse = await axios.get(`${this.baseUrl}/search/users`, {
              headers: this.getHeaders(),
              params: {
                q: query,
                per_page: 100,
                page,
                sort: 'repositories',
                order: 'desc',
              },
              timeout: 15000,
            });
            results.push(...(pageResponse.data.items || []));
          } catch (pageError) {
            logger.log(`[IterativeSearch] Error fetching page ${page}: ${pageError.message}`);
            break;
          }
        }
      }

      logger.log(`[IterativeSearch] Search query returned ${results.length} results`);
      return results;
    } catch (error) {
      logger.log(`[IterativeSearch] Search error: ${error.message}`, 'error');
      return [];
    }
  }

  /**
   * Extract unique locations from search results
   */
  extractLocationsList(results) {
    const locations = new Set();

    results.forEach(user => {
      if (user.location && user.location.trim()) {
        locations.add(user.location.trim());
      }
    });

    return Array.from(locations);
  }

  /**
   * Save users from iterative search to database
   */
  async saveSearchResults(users, searchId, searchIterationHistory) {
    try {
      const savedCount = {
        new: 0,
        updated: 0,
        error: 0,
      };

      for (let index = 0; index < users.length; index++) {
        try {
          const githubUser = users[index];
          
          // Find or create user
          let user = await User.findOne({ username: githubUser.login, searchId });

          if (!user) {
            user = new User({
              username: githubUser.login,
              displayName: githubUser.name,
              githubUrl: githubUser.html_url,
              avatar_url: githubUser.avatar_url,
              location: githubUser.location,
              followers: githubUser.followers,
              public_repos: githubUser.public_repos,
              searchId,
              foundIn: {
                location: githubUser.location || 'Unknown',
                year: new Date(githubUser.created_at).getFullYear(),
              },
              github_created_at: githubUser.created_at,
              github_updated_at: githubUser.updated_at,
              searchIterationHistory: [
                {
                  iterationNumber: 1,
                  searchDate: new Date(),
                  excludedLocations: [],
                  resultPosition: index + 1,
                },
              ],
            });
            await user.save();
            savedCount.new++;
          } else {
            // Update existing user
            user.searchIterationHistory = searchIterationHistory;
            await user.save();
            savedCount.updated++;
          }
        } catch (error) {
          logger.log(
            `[IterativeSearch] Error saving user ${users[index].login}: ${error.message}`,
            'error'
          );
          savedCount.error++;
        }
      }

      logger.log(
        `[IterativeSearch] Save results: new=${savedCount.new}, updated=${savedCount.updated}, errors=${savedCount.error}`
      );

      return savedCount;
    } catch (error) {
      logger.log(`[IterativeSearch] Fatal error saving results: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Log search completion
   */
  async logSearchCompletion(searchId, searchHistory, totalFound, excludedLocations) {
    try {
      const search = await Search.findById(searchId);
      if (search) {
        search.iterativeSearchLog = {
          completedAt: new Date(),
          totalIterations: searchHistory.length,
          totalLocationsExcluded: excludedLocations.length,
          excludedLocationsList: excludedLocations,
          searchHistory: searchHistory,
          usersFoundCount: totalFound,
        };

        if (totalFound > 1000) {
          search.warnings = search.warnings || [];
          search.warnings.push(
            `Iterative search exceeded 1000 results (${totalFound} found). Some results may not have been processed.`
          );
        }

        await search.save();
        logger.log(`[IterativeSearch] Logged search completion for searchId: ${searchId}`);
      }
    } catch (error) {
      logger.log(`[IterativeSearch] Error logging search completion: ${error.message}`, 'error');
    }
  }

  getHeaders() {
    const headers = {
      'User-Agent': 'GitHub-User-Research-Tool',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (this.githubToken) {
      headers['Authorization'] = `token ${this.githubToken}`;
    }
    return headers;
  }
}

module.exports = new IterativeSearchService();
