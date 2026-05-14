/**
 * Email Extractor Service
 * Extracts emails from commits, bio, and README
 */

const GitHubClient = require('../api/githubClient');
const Logger = require('../utils/logger');
const { extractEmailsFromText, sleep } = require('../utils/helpers');
const config = require('../../config/searchConfig');

class EmailExtractorService {
  constructor(githubToken) {
    this.client = new GitHubClient(githubToken);
    this.logger = new Logger();
  }

  /**
   * Extract all emails for a user
   * @param {Object} user - User object from GitHub API
   * @returns {Promise<Object>} User data with extracted emails
   */
  async extractEmailsForUser(user) {
    const userData = {
      username: user.login,
      displayName: user.name || user.login,
      githubUrl: user.html_url,
      bio: user.bio || '',
      readme: '',
      emails: [],
      emailMetadata: [],
    };

    try {
      // Extract emails from bio
      if (user.bio) {
        const bioEmails = extractEmailsFromText(user.bio);
        bioEmails.forEach(email => {
          userData.emailMetadata.push({
            email,
            source: 'bio',
            lastUsed: null,
          });
        });
      }

      // Get user's personal README (username/username)
      try {
        const readme = await this.client.getReadme(user.login, user.login);
        if (readme) {
          userData.readme = readme;
          const readmeEmails = extractEmailsFromText(readme);
          readmeEmails.forEach(email => {
            // Check if email already exists
            if (!userData.emailMetadata.find(e => e.email === email)) {
              userData.emailMetadata.push({
                email,
                source: 'readme',
                lastUsed: null,
              });
            }
          });
        }
      } catch (error) {
        // README might not exist, that's okay
      }

      // Get commits and extract emails
      try {
        const emails = await this.extractEmailsFromCommits(user.login);
        emails.forEach(emailData => {
          // Check if email already exists
          const existing = userData.emailMetadata.find(e => e.email === emailData.email);
          if (existing) {
            existing.source = [existing.source, 'commits'].join(', ');
            if (!existing.lastUsed || emailData.lastUsed > existing.lastUsed) {
              existing.lastUsed = emailData.lastUsed;
            }
          } else {
            userData.emailMetadata.push({
              email: emailData.email,
              source: 'commits',
              lastUsed: emailData.lastUsed,
            });
          }
        });
      } catch (error) {
        this.logger.error(`Error extracting emails from commits for ${user.login}: ${error.message}`);
      }

      // Sort emails by last used date (most recent first)
      userData.emailMetadata.sort((a, b) => {
        if (!a.lastUsed && !b.lastUsed) return 0;
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });

      // Extract just the emails list
      userData.emails = userData.emailMetadata.map(e => e.email);

      return userData;
    } catch (error) {
      this.logger.error(`Error extracting emails for user ${user.login}: ${error.message}`);
      return userData;
    }
  }

  /**
   * Extract emails from user's commits
   * @param {string} username - GitHub username
   * @returns {Promise<Array>} Array of {email, lastUsed} objects
   */
  async extractEmailsFromCommits(username) {
    const emailMap = new Map(); // email -> lastUsed date

    try {
      const commits = await this.client.getUserCommits(username, config.perPage);

      for (const commit of commits) {
        try {
          // Get full commit details
          if (commit.commit && commit.repository) {
            const owner = commit.repository.owner.login;
            const repo = commit.repository.name;
            const sha = commit.sha;

            const fullCommit = await this.client.getCommit(owner, repo, sha);

            if (fullCommit && fullCommit.commit && fullCommit.commit.author) {
              const email = fullCommit.commit.author.email;
              const date = fullCommit.commit.author.date;

              if (email && email !== `${username}@users.noreply.github.com`) {
                if (!emailMap.has(email) || new Date(date) > new Date(emailMap.get(email))) {
                  emailMap.set(email, date);
                }
              }
            }
          }

          // Rate limiting
          await sleep(config.rateLimitDelay);
        } catch (error) {
          this.logger.warn(`Error processing commit: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error fetching commits for ${username}: ${error.message}`);
    }

    // Convert map to array
    return Array.from(emailMap.entries()).map(([email, date]) => ({
      email,
      lastUsed: date,
    }));
  }
}

module.exports = EmailExtractorService;
