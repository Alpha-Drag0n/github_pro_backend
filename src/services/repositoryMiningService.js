/**
 * Repository Mining Service
 * Fetches and parses repositories for users to extract contact info and social profiles
 */

const axios = require('axios');
const ContactPatternExtractor = require('./contactPatternExtractor');
const logger = require('../utils/logger');

class RepositoryMiningService {
  constructor() {
    this.githubToken = process.env.GITHUB_TOKEN;
    this.baseUrl = 'https://api.github.com';
  }

  /**
   * Mine all repositories for a user
   * @param {string} username - GitHub username
   * @param {string} userId - MongoDB user ID for logging
   * @returns {object} Consolidated contact info and social profiles
   */
  async mineUserRepositories(username, userId) {
    try {
      logger.log(`[RepositoryMining] Starting mining for user: ${username}`);

      // Fetch all repositories
      const repositories = await this.fetchAllRepositories(username);
      logger.log(`[RepositoryMining] Found ${repositories.length} repositories for ${username}`);

      if (repositories.length === 0) {
        return this.getEmptyMiningResult();
      }

      const consolidatedData = {
        contactInfo: {
          emails: [],
          discord: [],
          telegram: [],
          whatsapp: [],
          phone: [],
        },
        socialProfiles: {
          linkedin: [],
          facebook: [],
          x: [],
          youtube: [],
          instagram: [],
          tiktok: [],
        },
        locations: [],
        minedRepositories: [],
        repositoriesChecked: repositories.length,
        repositoriesWithData: 0,
        lastMiningDate: new Date(),
      };

      // Mine each repository
      for (const repo of repositories) {
        try {
          const repoData = await this.mineRepository(username, repo);
          if (repoData.hasData) {
            consolidatedData.repositoriesWithData++;
          }
          consolidatedData.minedRepositories.push(repoData.metadata);

          // Merge contact info
          this.mergeContactInfo(consolidatedData.contactInfo, repoData.contactInfo);

          // Merge social profiles
          this.mergeSocialProfiles(consolidatedData.socialProfiles, repoData.socialProfiles);

          // Merge locations
          this.mergeLocations(consolidatedData.locations, repoData.locations, repo.name);
        } catch (error) {
          logger.log(
            `[RepositoryMining] Error mining repo ${repo.name}: ${error.message}`,
            'error'
          );
        }
      }

      logger.log(
        `[RepositoryMining] Mining complete for ${username}. Found data in ${consolidatedData.repositoriesWithData} repos`
      );

      return consolidatedData;
    } catch (error) {
      logger.log(`[RepositoryMining] Fatal error mining user ${username}: ${error.message}`, 'error');
      return this.getEmptyMiningResult();
    }
  }

  /**
   * Fetch all repositories for a user (paginated)
   */
  async fetchAllRepositories(username) {
    const repos = [];
    let page = 1;
    const perPage = 100;
    const maxPages = 10; // Limit to 1000 repos

    try {
      while (page <= maxPages) {
        const response = await axios.get(`${this.baseUrl}/users/${username}/repos`, {
          headers: this.getHeaders(),
          params: {
            page,
            per_page: perPage,
            sort: 'updated',
            direction: 'desc',
          },
          timeout: 10000,
        });

        if (response.data.length === 0) {
          break;
        }

        repos.push(...response.data);
        page++;
      }

      return repos;
    } catch (error) {
      logger.log(`[RepositoryMining] Error fetching repos for ${username}: ${error.message}`, 'error');
      return repos;
    }
  }

  /**
   * Mine a single repository
   */
  async mineRepository(username, repo) {
    const metadata = {
      repoName: repo.name,
      repoUrl: repo.html_url,
      readmeParsed: false,
      descriptionParsed: false,
      lastUpdated: repo.updated_at,
      dataExtracted: {
        hasContactInfo: false,
        hasSocialProfiles: false,
        hasLocation: false,
      },
    };

    const contactInfo = {
      emails: [],
      discord: [],
      telegram: [],
      whatsapp: [],
      phone: [],
    };

    const socialProfiles = {
      linkedin: [],
      facebook: [],
      x: [],
      youtube: [],
      instagram: [],
      tiktok: [],
    };

    const locations = [];
    let hasData = false;

    // Parse description
    if (repo.description) {
      metadata.descriptionParsed = true;
      const descData = this.parseContent(repo.description, repo.name);
      this.mergeContactInfo(contactInfo, descData.contactInfo);
      this.mergeSocialProfiles(socialProfiles, descData.socialProfiles);
      if (descData.contactInfo.emails.length > 0 || Object.values(descData.socialProfiles).some(arr => arr.length > 0)) {
        metadata.dataExtracted.hasContactInfo = true;
        metadata.dataExtracted.hasSocialProfiles = true;
        hasData = true;
      }
    }

    // Fetch and parse README
    try {
      const readme = await this.fetchReadme(username, repo.name);
      if (readme) {
        metadata.readmeParsed = true;
        const readmeData = this.parseContent(readme, repo.name);
        this.mergeContactInfo(contactInfo, readmeData.contactInfo);
        this.mergeSocialProfiles(socialProfiles, readmeData.socialProfiles);
        if (readmeData.contactInfo.emails.length > 0 || Object.values(readmeData.socialProfiles).some(arr => arr.length > 0)) {
          metadata.dataExtracted.hasContactInfo = true;
          metadata.dataExtracted.hasSocialProfiles = true;
          hasData = true;
        }

        // Extract locations from README
        const locationMatches = this.extractLocations(readme);
        if (locationMatches.length > 0) {
          metadata.dataExtracted.hasLocation = true;
          locations.push(...locationMatches);
          hasData = true;
        }
      }
    } catch (error) {
      logger.log(
        `[RepositoryMining] Could not fetch README for ${username}/${repo.name}: ${error.message}`
      );
    }

    return {
      hasData,
      metadata,
      contactInfo,
      socialProfiles,
      locations,
    };
  }

  /**
   * Fetch README content from repository
   */
  async fetchReadme(username, repoName) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/repos/${username}/${repoName}/readme`,
        {
          headers: {
            ...this.getHeaders(),
            Accept: 'application/vnd.github.v3.raw',
          },
          timeout: 5000,
        }
      );
      return response.data;
    } catch (error) {
      // 404 means no README, which is normal
      return null;
    }
  }

  /**
   * Parse content for contact info and social profiles
   */
  parseContent(content, source) {
    if (!content) {
      return {
        contactInfo: {
          emails: [],
          discord: [],
          telegram: [],
          whatsapp: [],
          phone: [],
        },
        socialProfiles: {
          linkedin: [],
          facebook: [],
          x: [],
          youtube: [],
          instagram: [],
          tiktok: [],
        },
      };
    }

    // Extract contact info
    const contactInfo = ContactPatternExtractor.extractContactInfo(content);
    
    // Add source to each contact
    Object.keys(contactInfo).forEach(key => {
      if (Array.isArray(contactInfo[key])) {
        contactInfo[key] = contactInfo[key].map(item => ({
          ...(typeof item === 'string' ? { value: item } : item),
          sources: [source],
        }));
      }
    });

    // Extract social profiles
    const socialProfiles = ContactPatternExtractor.extractSocialProfiles(content);

    // Add source to each social profile
    Object.keys(socialProfiles).forEach(key => {
      if (Array.isArray(socialProfiles[key])) {
        socialProfiles[key] = socialProfiles[key].map(item => ({
          ...item,
          sources: [source],
        }));
      }
    });

    return {
      contactInfo,
      socialProfiles,
    };
  }

  /**
   * Extract locations from content (US locations)
   */
  extractLocations(content) {
    const usStates = [
      'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
      'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
      'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
      'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
      'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
      'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
      'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
      'Wisconsin', 'Wyoming',
    ];

    const usStateAbbrev = {
      'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
      'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
      'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
      'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
      'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
      'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire',
      'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina',
      'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania',
      'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee',
      'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
      'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
    };

    const locations = [];

    // Find full state names
    usStates.forEach(state => {
      const regex = new RegExp(`\\b${state}\\b`, 'gi');
      if (regex.test(content)) {
        if (!locations.includes(state)) {
          locations.push(state);
        }
      }
    });

    // Find state abbreviations
    Object.entries(usStateAbbrev).forEach(([abbrev, fullName]) => {
      const regex = new RegExp(`\\b${abbrev}\\b`, 'g');
      if (regex.test(content)) {
        if (!locations.includes(fullName)) {
          locations.push(fullName);
        }
      }
    });

    return locations;
  }

  /**
   * Merge contact info from multiple sources
   */
  mergeContactInfo(target, source) {
    // Emails
    if (source.emails && source.emails.length > 0) {
      source.emails.forEach(item => {
        const existing = target.emails.find(e => e.email === item.value || e.email === item.email);
        if (existing) {
          if (item.sources) {
            existing.sources = [...new Set([...existing.sources, ...item.sources])];
          }
        } else {
          target.emails.push(item);
        }
      });
    }

    // Discord
    if (source.discord && source.discord.length > 0) {
      source.discord.forEach(item => {
        const existing = target.discord.find(
          d => d.handle === item.value || d.handle === item.handle
        );
        if (existing) {
          if (item.sources) {
            existing.sources = [...new Set([...existing.sources, ...item.sources])];
          }
        } else {
          target.discord.push(item);
        }
      });
    }

    // Telegram
    if (source.telegram && source.telegram.length > 0) {
      source.telegram.forEach(item => {
        const existing = target.telegram.find(
          t => t.username === item.value || t.username === item.username
        );
        if (existing) {
          if (item.sources) {
            existing.sources = [...new Set([...existing.sources, ...item.sources])];
          }
        } else {
          target.telegram.push(item);
        }
      });
    }

    // WhatsApp
    if (source.whatsapp && source.whatsapp.length > 0) {
      source.whatsapp.forEach(item => {
        const existing = target.whatsapp.find(
          w => w.phone === item.value || w.phone === item.phone
        );
        if (existing) {
          if (item.sources) {
            existing.sources = [...new Set([...existing.sources, ...item.sources])];
          }
        } else {
          target.whatsapp.push(item);
        }
      });
    }

    // Phone
    if (source.phone && source.phone.length > 0) {
      source.phone.forEach(item => {
        const existing = target.phone.find(p => p.number === item.value || p.number === item.number);
        if (existing) {
          if (item.sources) {
            existing.sources = [...new Set([...existing.sources, ...item.sources])];
          }
        } else {
          target.phone.push(item);
        }
      });
    }
  }

  /**
   * Merge social profiles from multiple sources
   */
  mergeSocialProfiles(target, source) {
    ['linkedin', 'facebook', 'x', 'youtube', 'instagram', 'tiktok'].forEach(platform => {
      if (source[platform] && source[platform].length > 0) {
        source[platform].forEach(item => {
          const existing = target[platform].find(p => p.handle === item.handle);
          if (existing) {
            if (item.sources) {
              existing.sources = [...new Set([...existing.sources, ...item.sources])];
            }
          } else {
            target[platform].push(item);
          }
        });
      }
    });
  }

  /**
   * Merge locations from multiple sources
   */
  mergeLocations(target, locations, repoName) {
    locations.forEach(location => {
      const existing = target.find(l => l.location === location);
      if (existing) {
        existing.frequency++;
        if (!existing.sources.includes(repoName)) {
          existing.sources.push(repoName);
        }
      } else {
        target.push({
          location,
          sources: [repoName],
          frequency: 1,
        });
      }
    });
  }

  getHeaders() {
    const headers = {
      'User-Agent': 'GitHub-User-Research-Tool',
    };
    if (this.githubToken) {
      headers['Authorization'] = `token ${this.githubToken}`;
    }
    return headers;
  }

  getEmptyMiningResult() {
    return {
      contactInfo: {
        emails: [],
        discord: [],
        telegram: [],
        whatsapp: [],
        phone: [],
      },
      socialProfiles: {
        linkedin: [],
        facebook: [],
        x: [],
        youtube: [],
        instagram: [],
        tiktok: [],
      },
      locations: [],
      minedRepositories: [],
      repositoriesChecked: 0,
      repositoriesWithData: 0,
      lastMiningDate: new Date(),
    };
  }
}

module.exports = new RepositoryMiningService();
