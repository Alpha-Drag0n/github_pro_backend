/**
 * Iterative Search Service
 * Performs iterative GitHub user searches with location exclusion.
 * Bypasses the 1000-result limit by excluding locations found in user profiles,
 * iterating across every day in a search's date range.
 */

const axios = require('axios');
const User = require('../models/userModel');
const IterativeSearch = require('../models/iterativeSearchModel');
const IterativeSearchLog = require('../models/iterativeSearchLogModel');
const GitHubClient = require('../api/githubClient');
const Logger = require('../utils/logger');

const logger = new Logger();

const BASE_URL = 'https://api.github.com';
const GITHUB_SEARCH_CAP = 1000; // GitHub search API hard limit
const PROFILE_FETCH_DELAY_MS = 120; // Be gentle on the rate limit between profile fetches
const DAY_MS = 1000 * 60 * 60 * 24;

class IterativeSearchService {
  /**
   * Run an iterative search across the full date range of an IterativeSearch document.
   * Updates progress on the document and emits socket events as it goes.
   * Stops gracefully if the search is paused/deleted (status changes away from in_progress).
   *
   * @param {object} params
   * @param {object} params.search - IterativeSearch mongoose document
   * @param {object} params.token  - Token document ({ _id, token, name })
   * @param {object} [params.io]   - Socket.io instance for progress events
   * @returns {Promise<{ status: string, usersFound: number }>}
   */
  async runIterativeRangeSearch({ search, token, io }) {
    const searchId = search.searchId;
    const accountType = 'user';
    const client = new GitHubClient(token.token, searchId);

    logger.info(`[IterativeSearch] Starting range search ${searchId} with token ${token.name}`);

    const fromDate = new Date(search.dateRange.fromDate);
    const toDate = new Date(search.dateRange.toDate);

    const excludedLocations = new Set(search.excludedLocations || []);

    // Resume from the first unprocessed day rather than re-scanning the whole range.
    const startOffsetDays = search.daysProcessed || 0;
    const firstDay = new Date(fromDate.getTime() + startOffsetDays * DAY_MS);
    if (startOffsetDays > 0) {
      logger.info(`[IterativeSearch] ${searchId} resuming from day offset ${startOffsetDays}`);
    }

    for (
      let day = new Date(firstDay);
      day <= toDate;
      day = new Date(day.getTime() + DAY_MS)
    ) {
      // Honor pause / delete between days.
      const live = await IterativeSearch.findById(search._id);
      if (!live || live.status !== 'in_progress') {
        logger.info(`[IterativeSearch] ${searchId} stopping (status=${live ? live.status : 'deleted'})`);
        return { status: live ? live.status : 'deleted', usersFound: search.usersFound || 0 };
      }

      const createdDate = day.toISOString().split('T')[0];
      const dayDate = new Date(`${createdDate}T00:00:00.000Z`);

      // Cross-search dedup: if ANY search already finished this exact day, skip the
      // GitHub work entirely. Each created-day is processed only once across all searches.
      const finishedElsewhere = await IterativeSearchLog.findOne({
        date: dayDate,
        status: 'finish',
      });

      if (finishedElsewhere) {
        logger.info(
          `[IterativeSearch] ${searchId} skipping ${createdDate} — already finished by search ${finishedElsewhere.searchId}`
        );
        await this.upsertDayLog(search._id, dayDate, {
          iteration: 0,
          status: 'finish',
          usersProcessed: 0,
          usersFound: 0,
          excludedLocations: [],
          completedAt: new Date(),
          duration: 0,
          error: `Skipped — day already processed by search ${finishedElsewhere.searchId}`,
        });
        await this.advanceDay({ search, createdDate, excludedLocations, io });
        continue;
      }

      // Mark this day as started for this search.
      const dayStartedAt = Date.now();
      const dayLog = await this.upsertDayLog(search._id, dayDate, {
        iteration: 0,
        status: 'start',
        timestamp: new Date(),
      });

      let dayUsersProcessed = 0;
      try {
        dayUsersProcessed = await this.processDay({
          search,
          client,
          token,
          createdDate,
          accountType,
          excludedLocations,
          io,
        });
      } catch (error) {
        logger.error(`[IterativeSearch] ${searchId} failed on ${createdDate}: ${error.message}`);
        await this.upsertDayLog(search._id, dayDate, {
          status: 'error',
          error: error.message,
          completedAt: new Date(),
          duration: Date.now() - dayStartedAt,
        });
        search.status = 'failed';
        search.error = `Failed on ${createdDate}: ${error.message}`;
        search.errorDetails = { lastErrorAt: new Date(), errorCount: (search.errorDetails?.errorCount || 0) + 1 };
        await search.save();
        this.emit(io, 'iterative-search:failed', { searchId, error: search.error });
        return { status: 'failed', usersFound: search.usersFound || 0 };
      }

      // The day may have been paused/deleted mid-processing — re-check before saving
      // so we don't clobber a 'paused' status back to 'in_progress' or mark the day finished.
      const afterDay = await IterativeSearch.findById(search._id).select('status');
      if (!afterDay || afterDay.status !== 'in_progress') {
        logger.info(`[IterativeSearch] ${searchId} stopping after ${createdDate} (status=${afterDay ? afterDay.status : 'deleted'})`);
        return { status: afterDay ? afterDay.status : 'deleted', usersFound: search.usersFound || 0 };
      }

      // Mark the day finished for this search (enables cross-search dedup + resume).
      await this.upsertDayLog(search._id, dayDate, {
        status: 'finish',
        usersProcessed: dayUsersProcessed,
        usersFound: dayUsersProcessed,
        excludedLocations: Array.from(excludedLocations),
        completedAt: new Date(),
        duration: Date.now() - dayStartedAt,
        error: null,
      });

      // Persist per-day progress.
      search.daysProcessed = (search.daysProcessed || 0) + 1;
      search.excludedLocations = Array.from(excludedLocations);
      search.usersFound = await User.countDocuments({ 'searchIterationHistory.searchId': search._id });
      await search.save();

      this.emit(io, 'iterative-search:progress', {
        searchId,
        daysProcessed: search.daysProcessed,
        totalDays: search.totalDays,
        usersFound: search.usersFound,
        excludedLocations: search.excludedLocations.length,
        percentage: search.totalDays
          ? Math.round((search.daysProcessed / search.totalDays) * 100)
          : 0,
      });

      logger.info(
        `[IterativeSearch] ${searchId} day ${createdDate} done — ${search.daysProcessed}/${search.totalDays} days, ${search.usersFound} users`
      );
    }

    search.status = 'completed';
    search.completedAt = new Date();
    search.excludedLocations = Array.from(excludedLocations);
    search.usersFound = await User.countDocuments({ 'searchIterationHistory.searchId': search._id });
    await search.save();

    this.emit(io, 'iterative-search:completed', {
      searchId,
      usersFound: search.usersFound,
      daysProcessed: search.daysProcessed,
    });

    logger.info(`[IterativeSearch] ${searchId} completed — ${search.usersFound} users found`);
    return { status: 'completed', usersFound: search.usersFound };
  }

  /**
   * Process a single creation-day: repeatedly search with growing location exclusions
   * until results stop hitting the 1000 cap with new locations to exclude.
   */
  async processDay({ search, client, token, createdDate, accountType, excludedLocations, io }) {
    const maxIterations = search.maxIterations || 50;
    let iteration = 0;
    let usersProcessed = 0;

    while (iteration < maxIterations) {
      iteration += 1;

      // Honor pause / delete between iterations of a long day.
      const live = await IterativeSearch.findById(search._id).select('status');
      if (!live || live.status !== 'in_progress') {
        return usersProcessed;
      }

      const query = this.buildSearchQuery(createdDate, accountType, Array.from(excludedLocations));
      const results = await this.searchUsers(query, token.token);

      if (results.length === 0) {
        break;
      }

      // Fetch profiles (search API omits location) and persist users.
      const { locations: newLocations, processed } = await this.saveResults({
        search,
        client,
        results,
        iteration,
        excludedLocations: Array.from(excludedLocations),
      });
      usersProcessed += processed;

      const freshLocations = newLocations.filter((loc) => !excludedLocations.has(loc));
      freshLocations.forEach((loc) => excludedLocations.add(loc));

      search.currentIteration = (search.currentIteration || 0) + 1;

      // Below the cap with nothing new to exclude → this day is exhausted.
      if (results.length < GITHUB_SEARCH_CAP && freshLocations.length === 0) {
        break;
      }
      // At/below cap but no new locations to narrow with → cannot make progress.
      if (freshLocations.length === 0) {
        break;
      }
    }

    return usersProcessed;
  }

  /**
   * Fetch full profiles for search results and upsert them as users linked to this search.
   * Returns the list of unique locations discovered (for exclusion).
   */
  async saveResults({ search, client, results, iteration, excludedLocations }) {
    const locations = new Set();
    let processed = 0;

    for (let index = 0; index < results.length; index++) {
      const item = results[index];
      const username = item.login;
      if (!username) {
        continue;
      }

      const historyEntry = {
        searchId: search._id,
        iterationNumber: iteration,
        searchDate: new Date(),
        excludedLocations,
        resultPosition: index + 1,
      };

      // Already processed for THIS search → nothing to do.
      const existingForSearch = await User.findOne({ username, searchId: search.searchId });
      if (existingForSearch) {
        processed += 1;
        continue;
      }

      // Already processed by ANOTHER search → reuse stored profile, skip the API call.
      const existingAnywhere = await User.findOne({ username }).sort({ extractedAt: 1 });

      let profile = null;
      if (existingAnywhere) {
        profile = {
          name: existingAnywhere.displayName,
          avatar_url: existingAnywhere.avatar_url,
          bio: existingAnywhere.bio,
          company: existingAnywhere.company,
          blog: existingAnywhere.blog,
          location: existingAnywhere.location,
          followers: existingAnywhere.followers,
          following: existingAnywhere.following,
          public_repos: existingAnywhere.public_repos,
          created_at: existingAnywhere.github_created_at,
          updated_at: existingAnywhere.github_updated_at,
        };
      } else {
        try {
          profile = await client.getUserProfile(username);
        } catch (error) {
          logger.warn(`[IterativeSearch] Could not fetch profile for ${username}: ${error.message}`);
        }
        // Only the live API path needs throttling.
        await this.sleep(PROFILE_FETCH_DELAY_MS);
      }

      if (profile?.location && profile.location.trim()) {
        locations.add(profile.location.trim());
      }

      try {
        const user = new User({
          username,
          searchId: search.searchId,
          displayName: profile?.name || item.login,
          githubUrl: item.html_url,
          avatar_url: profile?.avatar_url || item.avatar_url,
          bio: profile?.bio,
          company: profile?.company,
          blog: profile?.blog,
          location: profile?.location,
          followers: profile?.followers,
          following: profile?.following,
          public_repos: profile?.public_repos,
          github_created_at: profile?.created_at,
          github_updated_at: profile?.updated_at,
          foundIn: {
            location: profile?.location || 'Unknown',
            year: profile?.created_at ? new Date(profile.created_at).getFullYear() : undefined,
          },
          searchIterationHistory: [historyEntry],
        });
        await user.save();
        processed += 1;
      } catch (error) {
        if (!error.message.includes('duplicate key')) {
          logger.warn(`[IterativeSearch] Error saving user ${username}: ${error.message}`);
        }
      }
    }

    return { locations: Array.from(locations), processed };
  }

  /**
   * Build a GitHub user-search query for a creation day with location exclusions.
   */
  buildSearchQuery(createdDate, accountType, excludedLocations) {
    let query = `created:${createdDate} type:${accountType}`;
    excludedLocations.forEach((location) => {
      query += ` -location:"${location}"`;
    });
    return query;
  }

  /**
   * Search GitHub users for a raw query string, paginating up to the 1000 cap.
   */
  async searchUsers(query, token) {
    const results = [];
    const perPage = 100;
    const maxPages = GITHUB_SEARCH_CAP / perPage; // 10

    for (let page = 1; page <= maxPages; page++) {
      try {
        const response = await axios.get(`${BASE_URL}/search/users`, {
          headers: this.getHeaders(token),
          params: { q: query, per_page: perPage, page, sort: 'joined', order: 'desc' },
          timeout: 15000,
        });

        const items = response.data.items || [];
        results.push(...items);

        if (items.length < perPage || results.length >= GITHUB_SEARCH_CAP) {
          break;
        }
      } catch (error) {
        const status = error.response?.status;
        if (status === 422) {
          // Invalid query (e.g. too many exclusions) — treat as no more results.
          logger.warn(`[IterativeSearch] Invalid query, stopping pagination: ${query}`);
          break;
        }
        logger.error(`[IterativeSearch] Search error (page ${page}): ${error.message}`);
        throw error;
      }
    }

    logger.info(`[IterativeSearch] Query returned ${results.length} results`);
    return results;
  }

  getHeaders(token) {
    const headers = {
      'User-Agent': 'GitHub-User-Research-Tool',
      Accept: 'application/vnd.github.v3+json',
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }
    return headers;
  }

  /**
   * Create or update the per-day log entry for a search (one row per searchId+date).
   */
  async upsertDayLog(searchId, date, fields) {
    return IterativeSearchLog.findOneAndUpdate(
      { searchId, date },
      { $set: { searchId, date, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  /**
   * Record progress for a skipped day (already processed by another search) without
   * doing any GitHub work, then emit a progress event.
   */
  async advanceDay({ search, createdDate, excludedLocations, io }) {
    const live = await IterativeSearch.findById(search._id).select('status');
    if (!live || live.status !== 'in_progress') {
      return;
    }

    search.daysProcessed = (search.daysProcessed || 0) + 1;
    search.excludedLocations = Array.from(excludedLocations);
    search.usersFound = await User.countDocuments({ 'searchIterationHistory.searchId': search._id });
    await search.save();

    this.emit(io, 'iterative-search:progress', {
      searchId: search.searchId,
      daysProcessed: search.daysProcessed,
      totalDays: search.totalDays,
      usersFound: search.usersFound,
      excludedLocations: search.excludedLocations.length,
      percentage: search.totalDays
        ? Math.round((search.daysProcessed / search.totalDays) * 100)
        : 0,
      skipped: createdDate,
    });
  }

  emit(io, event, payload) {
    if (io) {
      io.emit(event, payload);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = new IterativeSearchService();
