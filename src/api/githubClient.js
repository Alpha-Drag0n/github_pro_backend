/**
 * GitHub API Client
 * Handles all API interactions with GitHub
 */

const axios = require('axios');
const Logger = require('../utils/logger');
const requestLogService = require('../services/requestLogService');
const tracing = require('../services/observability/tracing');

const BASE_URL = 'https://api.github.com';

class GitHubClient {
  /**
   * @param {string} token   GitHub PAT
   * @param {string} [searchId]  searchId (string) for request logging correlation
   * @param {object} [meta]   { tokenId } - used to attribute tracing spans to a token
   */
  constructor(token, searchId = null, meta = {}) {
    if (!token) {
      throw new Error('GitHub token is required. Set GITHUB_TOKEN in .env file');
    }
    this.token = token;
    this.searchId = searchId;
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    // One interceptor → a github.* span for EVERY method on this client.
    tracing.instrumentGithubAxios(this.client, { tokenId: meta.tokenId || null });
    this.logger = new Logger();
  }

  /**
   * Search for users by location and creation date range with followers filter
   * Fetches all results up to 1000 (GitHub's limit)
   * @param {string} location - User location
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} followers - Followers filter (e.g., '10', '>10', '<30', '1..100'). Default: '<30'
   * @param {string} accountType - 'user' or 'org'
   * @param {number} perPage - Results per page (default 100, max 100)
   * @returns {Promise<Array>} Array of users (up to 1000)
   */
  async searchUsers(location, startDate, endDate, followers = '<30', accountType = 'user', perPage = 100) {
    const type = accountType === 'org' ? 'type:org' : 'type:user';
    const query = `location:"${location}" created:${startDate}..${endDate} followers:${followers} ${type}`;

    try {
      let allUsers = [];
      const maxResults = 1000; // GitHub search API limit
      const resultsPerPage = Math.min(perPage, 100); // Max 100 per page
      const maxPages = Math.ceil(maxResults / resultsPerPage); // Up to 10 pages

      for (let page = 1; page <= maxPages; page++) {
        const startTime = Date.now();
        try {
          const response = await this.client.get('/search/users', {
            params: {
              q: query,
              per_page: resultsPerPage,
              page: page,
              sort: 'joined',
            },
          });
          const duration = Date.now() - startTime;

          // Log the API call
          requestLogService.logGitHubCall(
            '/search/users',
            { query, perPage: resultsPerPage, page, sort: 'joined' },
            'read',
            duration,
            true,
            null,
            response.status,
            this.searchId
          );

          const items = response.data.items || [];
          if (items.length === 0) {
            // No more results
            break;
          }

          allUsers = allUsers.concat(items);

          // Stop if we've reached 1000 results
          if (allUsers.length >= maxResults) {
            allUsers = allUsers.slice(0, maxResults);
            break;
          }

          // Check rate limit before next page
          const remaining = response.headers['x-ratelimit-remaining'];
          if (remaining && parseInt(remaining) < 2) {
            this.logger.warn(`Rate limit approaching (${remaining} remaining), stopping pagination`);
            break;
          }
        } catch (pageError) {
          const duration = Date.now() - startTime;
          requestLogService.logGitHubCall(
            '/search/users',
            { query, perPage: resultsPerPage, page, sort: 'joined' },
            'read',
            duration,
            false,
            pageError.message,
            pageError.response?.status || null,
            this.searchId
          );
          throw pageError;
        }
      }

      this.logger.info(`Search complete: fetched ${allUsers.length} users for location "${location}" with followers filter: ${followers}`);
      return allUsers;
    } catch (error) {
      this.logger.error(`Error searching users: ${error.message}`);
      if (error.response?.status === 422) {
        this.logger.warn(`Invalid query parameters: ${query}`);
        return [];
      }
      throw error;
    }
  }

  /**
   * Get user details
   * @param {string} username - GitHub username
   * @returns {Promise<Object>} User details
   */
  async getUser(username) {
    const startTime = Date.now();
    try {
      const response = await this.client.get(`/users/${username}`);
      const duration = Date.now() - startTime;
      
      requestLogService.logGitHubCall(
        `/users/${username}`,
        { username },
        'read',
        duration,
        true,
        null,
        response.status,
        this.searchId
      );
      
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      requestLogService.logGitHubCall(
        `/users/${username}`,
        { username },
        'read',
        duration,
        false,
        error.message,
        error.response?.status || null,
        this.searchId
      );
      
      this.logger.error(`Error getting user ${username}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user details with full bio and profile info
   * Enriches search results with complete profile information
   * @param {string} username - GitHub username
   * @returns {Promise<Object>} Complete user profile with bio
   */
  async getUserProfile(username) {
    try {
      const response = await this.client.get(`/users/${username}`);
      const user = response.data;
      
      // Extract key fields including bio
      return {
        login: user.login,
        id: user.id,
        avatar_url: user.avatar_url,
        profile_url: user.html_url,
        name: user.name,
        company: user.company,
        blog: user.blog,
        location: user.location,
        bio: user.bio, // Full bio from profile
        email: user.email, // Public profile email (structured field; often null)
        twitter_username: user.twitter_username, // Dedicated X/Twitter handle (structured field)
        public_repos: user.public_repos,
        followers: user.followers,
        following: user.following,
        created_at: user.created_at,
        updated_at: user.updated_at,
      };
    } catch (error) {
      this.logger.error(`Error getting user profile for ${username}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user's commits
   * @param {string} username - GitHub username
   * @param {number} perPage - Results per page
   * @returns {Promise<Array>} Array of commits
   */
  async getUserCommits(username, perPage = 100) {
    try {
      const response = await this.client.get(`/search/commits`, {
        params: {
          q: `author:${username}`,
          per_page: perPage,
          sort: 'committer-date',
          order: 'desc',
        },
      });

      return response.data.items || [];
    } catch (error) {
      this.logger.error(`Error getting commits for ${username}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get repository details including README
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Object>} Repository details
   */
  async getRepository(owner, repo) {
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Error getting repo ${owner}/${repo}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get README content
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<string>} README content
   */
  async getReadme(owner, repo) {
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/readme`, {
        headers: {
          Accept: 'application/vnd.github.v3.raw',
        },
      });

      return response.data;
    } catch (error) {
      // 404 means README doesn't exist
      if (error.response?.status !== 404) {
        this.logger.error(`Error getting README for ${owner}/${repo}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get a repository's README together with its exact source URL.
   * Uses the JSON form of the readme endpoint so we get the html_url (exact blob URL) and
   * decode the full raw content (base64) - nothing is stripped, so HTML comments / hidden
   * <details> blocks are preserved for extraction.
   * @returns {Promise<{ content: string, htmlUrl: string, downloadUrl: string, path: string } | null>}
   */
  async getReadmeWithMeta(owner, repo) {
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/readme`);
      const data = response.data || {};
      let content = '';
      if (data.content) {
        content = Buffer.from(data.content, data.encoding || 'base64').toString('utf-8');
      }
      return {
        content,
        htmlUrl: data.html_url || null,
        downloadUrl: data.download_url || null,
        path: data.path || 'README',
      };
    } catch (error) {
      const status = error.response?.status;
      // 404 = no README (normal). Auth/rate-limit errors are rethrown so callers can rotate.
      if (status === 404) {
        return null;
      }
      if (status === 401 || status === 403 || status === 429) {
        throw error;
      }
      this.logger.error(`Error getting README meta for ${owner}/${repo}: ${error.message}`);
      return null;
    }
  }

  /**
   * List a user's public repositories (owner type), newest first, paginated.
   * @returns {Promise<Array>} repos with html_url, name, description, fork, updated_at
   */
  async getUserRepos(username, perPage = 100, maxPages = 30) {
    const repos = [];
    for (let page = 1; page <= maxPages; page++) {
      try {
        const response = await this.client.get(`/users/${username}/repos`, {
          params: { page, per_page: perPage, sort: 'updated', direction: 'desc', type: 'owner' },
        });
        const items = response.data || [];
        repos.push(...items);
        if (items.length < perPage) break;
      } catch (error) {
        const status = error.response?.status;
        // Auth/rate-limit errors are rethrown so callers can rotate the token and retry.
        if (status === 401 || status === 403 || status === 429) {
          throw error;
        }
        this.logger.error(`Error listing repos for ${username}: ${error.message}`);
        break;
      }
    }
    return repos;
  }

  /**
   * Get commit details
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} sha - Commit SHA
   * @returns {Promise<Object>} Commit details
   */
  async getCommit(owner, repo, sha) {
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/commits/${sha}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Error getting commit ${sha}: ${error.message}`);
      return null;
    }
  }

  /**
   * Check rate limit status
   * @returns {Promise<Object>} Rate limit info
   */
  async getRateLimit() {
    try {
      const response = await this.client.get('/rate_limit');
      return response.data.resources;
    } catch (error) {
      this.logger.error(`Error checking rate limit: ${error.message}`);
      return null;
    }
  }

  /**
   * Get authenticated user info
   * @returns {Promise<Object|null>} Authenticated user info
   */
  async getAuthenticatedUser() {
    try {
      const response = await this.client.get('/user');
      return response.data;
    } catch (error) {
      this.logger.error(`Error getting authenticated user: ${error.message}`);
      return null;
    }
  }
}

module.exports = GitHubClient;
