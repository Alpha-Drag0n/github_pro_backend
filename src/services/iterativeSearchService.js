/**
 * Iterative Search Service
 * Performs iterative GitHub user searches with keyword + location partitioning.
 *
 * For every day in a search's date range, the day is split into per-term buckets
 * (e.g. "aa", "b3", …). Each bucket is then driven below GitHub's 1000-result cap
 * by iteratively excluding the locations found in that bucket:
 *
 *   "<term> created:<day> type:user -location:"…" -location:"…" …"
 *
 * Buckets are the unit of progress, dedup (across searches), and resume.
 */

const axios = require('axios');
const User = require('../models/userModel');
const IterativeSearch = require('../models/iterativeSearchModel');
const IterativeSearchLog = require('../models/iterativeSearchLogModel');
const Token = require('../models/tokenModel');
const GitHubClient = require('../api/githubClient');
const SearchTokenPool = require('./searchTokenPool');
const TokenSelector = require('./tokenSelector');
const Logger = require('../utils/logger');

const logger = new Logger();

const BASE_URL = 'https://api.github.com';
const GITHUB_SEARCH_CAP = 1000; // GitHub search API hard limit
const PROFILE_FETCH_DELAY_MS = 120; // Be gentle on the rate limit between profile fetches
const DAY_MS = 1000 * 60 * 60 * 24;
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Token rotation (mirrors the regular search worker).
const TOKEN_ROTATION_DELAY_MS = 500;
const TOKEN_STANDBY_POLL_MS = 30000;
const TOKEN_FULL_CYCLE_COOLDOWN_MS = 60000;
const MAX_TOKEN_ROTATIONS_PER_CALL = 12; // safety cap per single GitHub call

class IterativeSearchService {
  /**
   * Generate the keyword term list for a search.
   * 'alnum2' → every two-character combination of [a-z0-9] (36 × 36 = 1296).
   */
  generateTerms(termSet = 'alnum2') {
    switch (termSet) {
      case 'alnum2':
      default: {
        const terms = [];
        for (const a of ALNUM) {
          for (const b of ALNUM) {
            terms.push(a + b);
          }
        }
        return terms; // 1296
      }
    }
  }

  /**
   * Run an iterative search across the full date range of an IterativeSearch document.
   * Walks day → term bucket; updates progress and emits socket events as it goes.
   * Stops gracefully if the search is paused/deleted (status leaves 'in_progress').
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
    const terms = this.generateTerms(search.termSet || 'alnum2');

    // Mutable per-run context — `token`/`client` are swapped in place on rotation.
    const ctx = {
      searchId,
      search,
      io,
      token,
      client: new GitHubClient(token.token, searchId),
    };

    logger.info(
      `[IterativeSearch] Starting range search ${searchId} with token ${token.name} (${terms.length} terms/day)`
    );

    const fromDate = new Date(search.dateRange.fromDate);
    const toDate = new Date(search.dateRange.toDate);

    for (
      let day = new Date(fromDate);
      day <= toDate;
      day = new Date(day.getTime() + DAY_MS)
    ) {
      const createdDate = day.toISOString().split('T')[0];
      const dayDate = new Date(`${createdDate}T00:00:00.000Z`);

      for (const term of terms) {
        // Honor pause / delete before each bucket.
        const live = await IterativeSearch.findById(search._id).select('status');
        if (!live || live.status !== 'in_progress') {
          logger.info(`[IterativeSearch] ${searchId} stopping (status=${live ? live.status : 'deleted'})`);
          return { status: live ? live.status : 'deleted', usersFound: search.usersFound || 0 };
        }

        // Resume: this search already finished this exact bucket → skip (already counted).
        const ownLog = await IterativeSearchLog.findOne({ searchId: search._id, date: dayDate, term }).select('status');
        if (ownLog && ownLog.status === 'finish') {
          continue;
        }

        // Cross-search dedup: another search already finished this (day, term) → skip the
        // GitHub work, record a skipped bucket, and advance progress.
        const finishedElsewhere = await IterativeSearchLog.findOne({
          date: dayDate,
          term,
          status: 'finish',
          searchId: { $ne: search._id },
        }).select('searchId');

        if (finishedElsewhere) {
          await this.upsertBucketLog(search._id, dayDate, term, {
            iteration: 0,
            status: 'finish',
            usersProcessed: 0,
            usersFound: 0,
            excludedLocations: [],
            completedAt: new Date(),
            duration: 0,
            error: `Skipped — bucket already processed by search ${finishedElsewhere.searchId}`,
          });
          await this.advanceBucket({ search, io, createdDate, term, created: 0 });
          continue;
        }

        // Mark this bucket as started.
        const bucketStartedAt = Date.now();
        await this.upsertBucketLog(search._id, dayDate, term, {
          iteration: 0,
          status: 'start',
          timestamp: new Date(),
        });

        let bucketCreated = 0;
        try {
          bucketCreated = await this.processBucket(ctx, { createdDate, term, accountType });
        } catch (error) {
          logger.error(`[IterativeSearch] ${searchId} failed on ${createdDate}/${term}: ${error.message}`);
          await this.upsertBucketLog(search._id, dayDate, term, {
            status: 'error',
            error: error.message,
            completedAt: new Date(),
            duration: Date.now() - bucketStartedAt,
          });
          search.status = 'failed';
          search.error = `Failed on ${createdDate} (term ${term}): ${error.message}`;
          search.errorDetails = { lastErrorAt: new Date(), errorCount: (search.errorDetails?.errorCount || 0) + 1 };
          await search.save();
          this.emit(io, 'iterative-search:failed', { searchId, error: search.error });
          return { status: 'failed', usersFound: search.usersFound || 0 };
        }

        // The bucket may have been paused/deleted mid-processing — re-check before marking
        // it finished, so we don't clobber a 'paused' status or record a partial bucket.
        const afterBucket = await IterativeSearch.findById(search._id).select('status');
        if (!afterBucket || afterBucket.status !== 'in_progress') {
          logger.info(`[IterativeSearch] ${searchId} stopping after ${createdDate}/${term} (status=${afterBucket ? afterBucket.status : 'deleted'})`);
          return { status: afterBucket ? afterBucket.status : 'deleted', usersFound: search.usersFound || 0 };
        }

        await this.upsertBucketLog(search._id, dayDate, term, {
          status: 'finish',
          usersProcessed: bucketCreated,
          usersFound: bucketCreated,
          completedAt: new Date(),
          duration: Date.now() - bucketStartedAt,
          error: null,
        });

        await this.advanceBucket({ search, io, createdDate, term, created: bucketCreated });
      }

      // Whole day complete (all terms) — bump the day counter for display.
      const liveAfterDay = await IterativeSearch.findById(search._id).select('status');
      if (!liveAfterDay || liveAfterDay.status !== 'in_progress') {
        return { status: liveAfterDay ? liveAfterDay.status : 'deleted', usersFound: search.usersFound || 0 };
      }
      search.daysProcessed = (search.daysProcessed || 0) + 1;
      await search.save();
      logger.info(`[IterativeSearch] ${searchId} day ${createdDate} complete — ${search.daysProcessed}/${search.totalDays} days`);
    }

    search.status = 'completed';
    search.completedAt = new Date();
    search.usersFound = await User.countDocuments({ 'searchIterationHistory.searchId': search._id });
    await search.save();

    this.emit(io, 'iterative-search:completed', {
      searchId,
      usersFound: search.usersFound,
      daysProcessed: search.daysProcessed,
      bucketsProcessed: search.bucketsProcessed,
    });

    logger.info(`[IterativeSearch] ${searchId} completed — ${search.usersFound} users found`);
    return { status: 'completed', usersFound: search.usersFound };
  }

  /**
   * Process a single (day, term) bucket: repeatedly search with a growing per-bucket
   * location-exclusion set until results fall below the 1000 cap with no new locations
   * to exclude. Returns the number of NEW users saved for this bucket.
   */
  async processBucket(ctx, { createdDate, term, accountType }) {
    const { search } = ctx;
    const maxIterations = search.maxIterations || 50;
    const excludedLocations = new Set(); // fresh per bucket
    let iteration = 0;
    let created = 0;

    while (iteration < maxIterations) {
      iteration += 1;

      // Honor pause / delete between iterations of a long bucket.
      const live = await IterativeSearch.findById(search._id).select('status');
      if (!live || live.status !== 'in_progress') {
        return created;
      }

      const query = this.buildSearchQuery(term, createdDate, accountType, Array.from(excludedLocations));
      const results = await this.searchUsersWithRotation(ctx, query);

      if (results.length === 0) {
        break;
      }

      // Fetch profiles (search API omits location) and persist users.
      const { locations, created: createdNow } = await this.saveResults(ctx, {
        results,
        iteration,
        excludedLocations: Array.from(excludedLocations),
      });
      created += createdNow;

      const freshLocations = locations.filter((loc) => !excludedLocations.has(loc));
      freshLocations.forEach((loc) => excludedLocations.add(loc));

      search.currentIteration = (search.currentIteration || 0) + 1;

      // Below the cap with nothing new to exclude → this bucket is exhausted.
      if (results.length < GITHUB_SEARCH_CAP && freshLocations.length === 0) {
        break;
      }
      // No new locations to narrow with → cannot make further progress.
      if (freshLocations.length === 0) {
        break;
      }
    }

    return created;
  }

  /**
   * Fetch full profiles for search results and upsert them as users linked to this search.
   * Returns { locations, created } — discovered locations (for exclusion) and new-user count.
   */
  async saveResults(ctx, { results, iteration, excludedLocations }) {
    const { search } = ctx;
    const locations = new Set();
    let created = 0;

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
        profile = await this.getProfileWithRotation(ctx, username);
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
        created += 1;
      } catch (error) {
        if (!error.message.includes('duplicate key')) {
          logger.warn(`[IterativeSearch] Error saving user ${username}: ${error.message}`);
        }
      }
    }

    return { locations: Array.from(locations), created };
  }

  /**
   * Build a GitHub user-search query: keyword term + creation day + location exclusions.
   */
  buildSearchQuery(term, createdDate, accountType, excludedLocations) {
    let query = `${term} created:${createdDate} type:${accountType}`;
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

  /** GitHub auth/rate-limit errors that should trigger a token rotation. */
  isGitHubTokenError(error) {
    const status = error?.response?.status;
    return status === 401 || status === 403 || status === 429;
  }

  /**
   * Run a user search, rotating to the next token on auth/rate-limit errors and retrying.
   */
  async searchUsersWithRotation(ctx, query) {
    let attempts = 0;
    while (true) {
      try {
        return await this.searchUsers(query, ctx.token.token);
      } catch (error) {
        if (this.isGitHubTokenError(error) && attempts < MAX_TOKEN_ROTATIONS_PER_CALL) {
          attempts += 1;
          const rotated = await this.rotateToken(ctx, `search ${error.response?.status}: ${error.message}`);
          if (!rotated) {
            throw error; // search was paused/stopped while waiting for a token
          }
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Fetch a profile, rotating once on an auth/rate-limit error. Non-fatal: returns null
   * if the profile can't be fetched (matches the previous best-effort behavior).
   */
  async getProfileWithRotation(ctx, username) {
    try {
      return await ctx.client.getUserProfile(username);
    } catch (error) {
      if (this.isGitHubTokenError(error)) {
        const rotated = await this.rotateToken(ctx, `profile ${error.response?.status}: ${error.message}`);
        if (rotated) {
          try {
            return await ctx.client.getUserProfile(username);
          } catch (retryError) {
            logger.warn(`[IterativeSearch] Profile fetch failed after rotation for ${username}: ${retryError.message}`);
            return null;
          }
        }
      }
      logger.warn(`[IterativeSearch] Could not fetch profile for ${username}: ${error.message}`);
      return null;
    }
  }

  /**
   * Advance this search to the next token in createdAt order. Marks the current token's
   * error, waits if no token is free, applies a cooldown after a full cycle, and swaps the
   * client in `ctx`. Returns false if the search was stopped while waiting.
   */
  async rotateToken(ctx, reason) {
    if (ctx.token?._id) {
      await TokenSelector.markTokenError(ctx.token._id, reason);
    }

    let { token: nextMeta, fullCycle } = await SearchTokenPool.selectNextTokenForSearch(
      ctx.token?._id,
      ctx.searchId
    );

    if (!nextMeta) {
      const waitedDoc = await this.waitForAvailableToken(ctx);
      if (!waitedDoc) {
        return false;
      }
      ctx.token = waitedDoc;
      ctx.client = new GitHubClient(waitedDoc.token, ctx.searchId);
      logger.info(`[IterativeSearch] ${ctx.searchId} resumed on token ${waitedDoc.name}`);
      return true;
    }

    if (fullCycle) {
      logger.info(`[IterativeSearch] ${ctx.searchId} full token cycle — cooling down before retry`);
      await this.sleep(TOKEN_FULL_CYCLE_COOLDOWN_MS);
    } else {
      await this.sleep(TOKEN_ROTATION_DELAY_MS);
    }

    const nextDoc = await Token.findById(nextMeta._id);
    if (!nextDoc) {
      // Token vanished mid-rotation — try once more from the wait path.
      const waitedDoc = await this.waitForAvailableToken(ctx);
      if (!waitedDoc) {
        return false;
      }
      ctx.token = waitedDoc;
      ctx.client = new GitHubClient(waitedDoc.token, ctx.searchId);
      return true;
    }

    ctx.token = nextDoc;
    ctx.client = new GitHubClient(nextDoc.token, ctx.searchId);
    this.emit(ctx.io, 'iterative-search:token:rotated', {
      searchId: ctx.searchId,
      currentToken: nextDoc.name,
      fullCycle,
    });
    logger.info(`[IterativeSearch] ${ctx.searchId} rotated to token ${nextDoc.name}`);
    return true;
  }

  /**
   * Poll until a token is available or the search stops (paused/deleted).
   * Returns a Token document, or null if the search was stopped.
   */
  async waitForAvailableToken(ctx) {
    while (true) {
      const live = await IterativeSearch.findById(ctx.search._id).select('status');
      if (!live || live.status !== 'in_progress') {
        return null;
      }

      const meta = await SearchTokenPool.assignTokenForSearch(ctx.searchId);
      if (meta) {
        const doc = await Token.findById(meta._id);
        if (doc) {
          return doc;
        }
      }

      logger.info(`[IterativeSearch] ${ctx.searchId} awaiting an available token — retrying in ${TOKEN_STANDBY_POLL_MS / 1000}s`);
      await this.sleep(TOKEN_STANDBY_POLL_MS);
    }
  }

  /**
   * Create or update the per-bucket log entry (one row per searchId + date + term).
   */
  async upsertBucketLog(searchId, date, term, fields) {
    return IterativeSearchLog.findOneAndUpdate(
      { searchId, date, term },
      { $set: { searchId, date, term, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  /**
   * Advance bucket-level progress (count + users), then emit a progress event.
   */
  async advanceBucket({ search, io, createdDate, term, created }) {
    const live = await IterativeSearch.findById(search._id).select('status');
    if (!live || live.status !== 'in_progress') {
      return;
    }

    search.bucketsProcessed = (search.bucketsProcessed || 0) + 1;
    search.usersFound = (search.usersFound || 0) + (created || 0);
    await search.save();

    this.emit(io, 'iterative-search:progress', {
      searchId: search.searchId,
      daysProcessed: search.daysProcessed,
      totalDays: search.totalDays,
      bucketsProcessed: search.bucketsProcessed,
      totalBuckets: search.totalBuckets,
      usersFound: search.usersFound,
      percentage: search.totalBuckets
        ? Math.round((search.bucketsProcessed / search.totalBuckets) * 100)
        : 0,
      currentDay: createdDate,
      currentTerm: term,
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
