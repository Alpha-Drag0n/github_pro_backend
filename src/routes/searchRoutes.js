/**
 * API Routes for Search Operations
 */

const express = require('express');
const router = express.Router();
const Search = require('../models/searchModel');
const User = require('../models/userModel');
const Token = require('../models/tokenModel');
const Log = require('../models/logModel');
const Logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const TokenSelector = require('../services/tokenSelector');
const SearchTokenPool = require('../services/searchTokenPool');
const UserSearchService = require('../services/userSearchService');
const EmailExtractorService = require('../services/emailExtractorService');
const {
  isShuttingDown,
  getActiveWorkerCount,
  hasActiveWorker,
  tryAcquireSearchWorker,
  releaseSearchWorker,
  getSearchWorkerState,
  clearShouldPause,
  shouldStopWorker,
} = require('../services/searchWorkerRegistry');
const { notifySearchChange } = require('../services/searchBroadcast');

const logger = new Logger();

const TOKEN_ROTATION_DELAY_MS = 500;
const TOKEN_STANDBY_POLL_MS = 30000;
const TOKEN_FULL_CYCLE_COOLDOWN_MS = 60000;

function getSearchComboLogFilter(search, combo) {
  return {
    location: combo.location,
    year: combo.year,
    followers: search.parameters.followers || '<30',
    accountType: search.parameters.accountType || 'user',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUnlessStopped(ms, searchId) {
  const chunkMs = 500;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldStopWorker(searchId)) {
      return false;
    }
    const step = Math.min(chunkMs, remaining);
    await sleep(step);
    remaining -= step;
  }
  return !shouldStopWorker(searchId);
}

/**
 * Exit worker after pause or shutdown. DB is already updated on shutdown.
 */
async function handleWorkerStopped(search, searchId, io) {
  if (isShuttingDown()) {
    logger.info(`Search ${searchId} worker stopped (server shutting down)`);
    if (hasActiveWorker(searchId)) {
      releaseSearchWorker(searchId);
    }
    return;
  }

  const latest = await Search.findOne({ searchId });
  if (!latest) {
    if (hasActiveWorker(searchId)) {
      releaseSearchWorker(searchId);
    }
    return;
  }

  if (latest.status !== 'paused') {
    latest.status = 'paused';
    latest.error = latest.error || 'Search paused';
    latest.pausedAt = latest.pausedAt || new Date();
    latest.recoverable = true;
    await latest.save();
    await notifySearchChange(io, latest);
    logger.info(`Search ${searchId} paused at ${latest.progress?.percentage ?? 0}%`);
  }

  if (hasActiveWorker(searchId)) {
    releaseSearchWorker(searchId);
  }
}

function isGitHubTokenError(error) {
  const status = error?.response?.status;
  return status === 401 || status === 403;
}

/**
 * Poll until a token exists or the search is paused.
 */
async function waitForAvailableToken(search, io) {
  while (true) {
    if (shouldStopWorker(search.searchId)) {
      return null;
    }

    const first = await SearchTokenPool.assignTokenForSearch(search.searchId);
    if (first) {
      const doc = await Token.findById(first._id);
      if (doc) {
        if (search.status === 'awaiting_tokens') {
          search.status = 'running';
          search.error = null;
          search.tokenId = doc._id;
          search.tokenName = doc.name;
          await search.save();
          await notifySearchChange(io, search);
          if (io) {
            io.emit('search:token:available', {
              searchId: search.searchId,
              tokenName: doc.name,
            });
          }
        }
        return doc;
      }
    }

    search.status = 'awaiting_tokens';
    search.error = 'Waiting for a GitHub token — will retry automatically';
    await search.save();
    await notifySearchChange(io, search);

    if (io) {
      io.emit('search:awaiting_tokens', {
        searchId: search.searchId,
        message: search.error,
      });
    }

    logger.info(
      `Search ${search.searchId} awaiting tokens — polling again in ${TOKEN_STANDBY_POLL_MS / 1000}s`
    );
    const continued = await sleepUnlessStopped(TOKEN_STANDBY_POLL_MS, search.searchId);
    if (!continued) {
      return null;
    }
  }
}

/**
 * Advance to the next token in createdAt order; keeps rotating instead of failing the search.
 */
async function rotateSearchToken(search, searchService, emailExtractor, currentTokenDoc, io, errorReason) {
  if (currentTokenDoc?._id) {
    await TokenSelector.markTokenError(currentTokenDoc._id, errorReason);
  }

  let { token: nextMeta, fullCycle } = await SearchTokenPool.selectNextTokenForSearch(
    currentTokenDoc?._id,
    search.searchId
  );

  if (!nextMeta) {
    const waited = await waitForAvailableToken(search, io);
    if (!waited) {
      return null;
    }
    nextMeta = waited;
    fullCycle = false;
  }

  if (fullCycle) {
    logger.info(`Full token rotation cycle for search ${search.searchId} — cooling down before retry`);
    await sleep(TOKEN_FULL_CYCLE_COOLDOWN_MS);
  } else {
    await sleep(TOKEN_ROTATION_DELAY_MS);
  }

  const nextTokenDoc = await Token.findById(nextMeta._id);
  const GitHubClient = require('../api/githubClient');

  searchService.currentToken = nextTokenDoc.token;
  searchService.currentTokenId = nextTokenDoc._id;
  searchService.client = new GitHubClient(nextTokenDoc.token);

  if (emailExtractor) {
    emailExtractor.client = new GitHubClient(nextTokenDoc.token);
  }

  search.tokenId = nextTokenDoc._id;
  search.tokenName = nextTokenDoc.name;
  search.status = 'running';
  search.error = null;
  await search.save();
  await notifySearchChange(io, search);

  if (io) {
    io.emit('search:token:rotated', {
      searchId: search.searchId,
      previousToken: currentTokenDoc?.name ?? null,
      currentToken: nextTokenDoc.name,
      fullCycle,
    });
  }

  logger.info(`Search ${search.searchId} rotated to token: ${nextTokenDoc.name}`);
  return nextTokenDoc;
}

/**
 * Get all searches
 */
router.get('/searches', async (req, res) => {
  try {
    const searches = await Search.find().sort({ createdAt: -1 });
    res.json(searches);
  } catch (error) {
    logger.error(`Error fetching searches: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch searches' });
  }
});

/**
 * Get search by ID
 */
router.get('/searches/:id', async (req, res) => {
  try {
    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }
    res.json(search);
  } catch (error) {
    logger.error(`Error fetching search: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch search' });
  }
});

/**
 * Create new search
 */
router.post('/searches', async (req, res) => {
  try {
    const { locations, startYear, endYear, accountType, followers } = req.body;

    if (!locations || !startYear || !endYear || !accountType) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const searchId = uuidv4();
    const totalCombinations = locations.length * (endYear - startYear + 1);

    const search = new Search({
      searchId,
      parameters: {
        locations,
        startYear,
        endYear,
        accountType,
        followers: followers || '<30',
      },
      status: 'pending',
      progress: {
        total: totalCombinations,
      },
    });

    await search.save();
    logger.info(`Search created: ${searchId}`);

    res.status(201).json({
      id: search._id,
      searchId: search.searchId,
      status: search.status,
      createdAt: search.createdAt,
    });
  } catch (error) {
    logger.error(`Error creating search: ${error.message}`);
    res.status(500).json({ error: 'Failed to create search' });
  }
});

/**
 * Execute search with automatic token selection
 * POST /api/searches/:id/execute
 * Selects best available token and starts search
 */
router.post('/searches/:id/execute', async (req, res) => {
  let search = null;
  let selectedToken = null;

  try {
    search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (isShuttingDown()) {
      return res.status(503).json({ error: 'Server is shutting down — try again shortly' });
    }

    if (search.status === 'running' || hasActiveWorker(search.searchId)) {
      return res.status(400).json({ error: 'Search is already running' });
    }

    const workerSlot = tryAcquireSearchWorker(search.searchId);
    if (!workerSlot.ok) {
      const statusCode = workerSlot.reason === 'concurrency_limit' ? 429 : 400;
      return res.status(statusCode).json({
        error: workerSlot.message || 'Search is already executing',
      });
    }

    selectedToken = await SearchTokenPool.assignTokenForSearch(search.searchId);
    if (!selectedToken) {
      search.status = 'awaiting_tokens';
      search.error =
        'No GitHub tokens in database yet — search will start automatically when one is added';
      await search.save();
      await notifySearchChange(req.io, search);
      logger.warn(`Search ${search.searchId} queued: awaiting tokens`);

      res.status(202).json({
        id: search._id,
        searchId: search.searchId,
        status: search.status,
        message: search.error,
      });

      executeSearchInBackground(search, null, req.io);
      return;
    }

    const isFreshRun =
      search.status === 'pending' &&
      (!search.progress?.completedIndices || search.progress.completedIndices.length === 0);

    search.status = 'running';
    search.startedAt = search.startedAt || new Date();
    search.tokenId = selectedToken._id;
    search.tokenName = selectedToken.name;
    if (isFreshRun) {
      search.searchLog = [];
    }
    search.error = null;
    await search.save();
    await notifySearchChange(req.io, search);

    logger.info(`Search ${search.searchId} started with token: ${selectedToken.name}`);

    // Respond immediately, execute search in background
    res.json({
      id: search._id,
      searchId: search.searchId,
      status: search.status,
      tokenName: selectedToken.name,
      message: 'Search started. Check progress with GET /api/searches/:id',
    });

    // Execute search in background
    executeSearchInBackground(search, selectedToken, req.io);
  } catch (error) {
    logger.error(`Error executing search: ${error.message}`);
    if (search) {
      releaseSearchWorker(search.searchId);
      search.status = 'failed';
      search.error = error.message;
      await search.save();
    }
    res.status(500).json({ error: 'Failed to execute search' });
  }
});

/**
 * Execute search in background with progress tracking and resumption support
 */
async function executeSearchInBackground(search, selectedToken, io) {
  const startTime = Date.now();
  let currentCombination = 0;
  const searchId = search.searchId;

  if (!hasActiveWorker(searchId)) {
    const acquired = tryAcquireSearchWorker(searchId);
    if (!acquired.ok) {
      logger.warn(`Could not start worker for ${searchId}: ${acquired.reason}`);
      return;
    }
  } else {
    clearShouldPause(searchId);
  }

  if (isShuttingDown()) {
    if (hasActiveWorker(searchId)) {
      releaseSearchWorker(searchId);
    }
    return;
  }

  try {
    const freshDoc = await Search.findOne({ searchId });
    if (!freshDoc) {
      releaseSearchWorker(searchId);
      return;
    }
    search = freshDoc;

    if (search.status !== 'completed') {
      search.status = 'running';
      search.error = null;
      search.startedAt = search.startedAt || new Date();
      await search.save();
      await notifySearchChange(io, search);
    }

    logger.info(`Search ${searchId} worker started (${getActiveWorkerCount()} active)`);

    let token = selectedToken ? await Token.findById(selectedToken._id) : null;
    if (!token) {
      token = await waitForAvailableToken(search, io);
      if (!token) {
        await handleWorkerStopped(search, searchId, io);
        return;
      }
    }

    // Initialize search service with selected token and search parameters
    const searchService = new UserSearchService(token.token, search.parameters, {
      currentTokenId: token._id,
    });
    let emailExtractor = new EmailExtractorService(token.token);
    
    // Generate search combinations
    const combinations = searchService.generateSearchCombinations();
    const totalCombinations = combinations.length;

    // Load completed indices (for resumption)
    const completedIndices = search.progress.completedIndices || [];
    const isResumption = completedIndices.length > 0;
    
    if (isResumption) {
      logger.info(`Resuming search: ${completedIndices.length}/${totalCombinations} already completed`);
    } else {
      logger.info(`Starting search execution: ${totalCombinations} combinations`);
    }

    // Execute search with progress tracking
    for (let i = 0; i < combinations.length; i++) {
      if (shouldStopWorker(searchId)) {
        logger.info(
          `Search ${search.searchId} stopping at combination ${currentCombination}/${totalCombinations}`
        );
        break;
      }

      // Skip already completed combinations
      if (completedIndices.includes(i)) {
        currentCombination = i + 1;
        continue;
      }

      const combo = combinations[i];
      currentCombination = i + 1;

      try {
        // Check if this combination is already logged (already searched)
        const existingLog = await Log.findOne(getSearchComboLogFilter(search, combo));

        if (existingLog?.status === 'completed') {
          logger.info(`Skipping ${combo.location} ${combo.year} - already completed on ${existingLog.completedAt}`);

          search.searchLog.push({
            location: combo.location,
            year: combo.year,
            date: new Date(),
            usersFound: existingLog.usersFound,
            status: 'skipped (already searched)',
          });

          if (!completedIndices.includes(i)) {
            search.progress.completedIndices.push(i);
          }

          const percentage = Math.round((currentCombination / totalCombinations) * 100);
          search.progress.current = currentCombination;
          search.progress.percentage = percentage;
          await search.save();

          if (io) {
            io.emit('search:progress:updated', {
              searchId: search.searchId,
              current: currentCombination,
              total: totalCombinations,
              percentage,
              status: 'running',
              usersFound: search.results.totalUsersFound,
              resumable: true,
            });
          }
          continue;
        }

        if (existingLog?.status === 'in_progress') {
          logger.info(
            `Resuming ${combo.location} ${combo.year} — previous run did not finish email extraction`
          );
        }

        // Search for users in this combination
        const users = await searchService.executeWithFailover(
          `Search ${combo.location} (${combo.year})`,
          (client) =>
            client.searchUsers(
              combo.location,
              combo.startDate,
              combo.endDate,
              search.parameters.followers || '<30',
              search.parameters.accountType,
              100
            )
        );

        if (shouldStopWorker(searchId)) {
          break;
        }

        // Track token usage for search API call
        if (users.length > 0) {
          // Estimate API requests used (1 search call + 1 per page)
          const estimatedPages = Math.ceil(users.length / 100);
          await TokenSelector.updateTokenUsage(token._id, estimatedPages);
        }

        logger.info(`Found ${users.length} users for ${combo.location} ${combo.year}`);

        await Log.findOneAndUpdate(
          getSearchComboLogFilter(search, combo),
          {
            searchId: search.searchId,
            usersFound: users.length,
            usersProcessed: 0,
            status: 'in_progress',
          },
          { upsert: true }
        );

        const emailExtractor = new EmailExtractorService(token.token);
        let newUsersCount = 0;
        let skippedUsersCount = 0;
        let comboFullyProcessed = true;

        for (const user of users) {
          if (shouldStopWorker(searchId)) {
            logger.info(`Search ${search.searchId} stopping while processing users`);
            comboFullyProcessed = false;
            break;
          }

          try {
            // Check if user already exists in database
            const existingUser = await User.findOne({
              username: user.login,
              searchId: search.searchId,
            });

            if (existingUser) {
              logger.debug(`User ${user.login} already exists, skipping`);
              skippedUsersCount++;
              continue;
            }

            // Fetch full user profile with complete bio
            let userProfile = user;
            try {
              userProfile = await searchService.client.getUserProfile(user.login);
              logger.debug(`Fetched full profile for ${user.login}`);
              // Track token usage for profile fetch
              await TokenSelector.updateTokenUsage(token._id, 1);
            } catch (profileError) {
              logger.warn(`Could not fetch full profile for ${user.login}, using search result: ${profileError.message}`);
              // Continue with search result data if profile fetch fails
            }

            // Extract emails from bio, commits, and README
            const extractedData = await emailExtractor.extractEmailsForUser(userProfile);

            // Track token usage for email extraction (commit search + readme fetch)
            await TokenSelector.updateTokenUsage(token._id, 2);

            const newUser = new User({
              searchId: search.searchId,
              username: extractedData.username,
              displayName: extractedData.displayName,
              name: userProfile.name,
              githubUrl: extractedData.githubUrl,
              avatar_url: userProfile.avatar_url,
              bio: extractedData.bio,
              company: userProfile.company,
              blog: userProfile.blog,
              location: userProfile.location,
              followers: userProfile.followers,
              following: userProfile.following,
              public_repos: userProfile.public_repos,
              readme: extractedData.readme,
              emails: extractedData.emails,
              emailMetadata: extractedData.emailMetadata,
              github_created_at: userProfile.created_at,
              github_updated_at: userProfile.updated_at,
              foundIn: {
                location: combo.location,
                year: combo.year,
              },
            });

            await newUser.save();
            logger.debug(`Saved user: ${extractedData.username} with ${extractedData.emails.length} emails`);
            newUsersCount++;

            // Rate limit between profile fetches
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (err) {
            // Duplicate user or other error
            if (!err.message.includes('duplicate key')) {
              logger.warn(`Error saving user ${user.login}: ${err.message}`);
            }
          }
        }

        if (!comboFullyProcessed) {
          await Log.findOneAndUpdate(getSearchComboLogFilter(search, combo), {
            usersProcessed: newUsersCount + skippedUsersCount,
            status: 'in_progress',
          });
          await search.save();
          break;
        }

        await Log.findOneAndUpdate(
          getSearchComboLogFilter(search, combo),
          {
            searchId: search.searchId,
            usersFound: users.length,
            usersProcessed: newUsersCount + skippedUsersCount,
            status: 'completed',
            completedAt: new Date(),
          },
          { upsert: true }
        );

        search.searchLog.push({
          location: combo.location,
          year: combo.year,
          date: new Date(),
          usersFound: users.length,
          status: 'completed',
          newUsers: newUsersCount,
          skippedUsers: skippedUsersCount,
        });

        search.results.totalUsersFound = await User.countDocuments({
          searchId: search.searchId,
        });

        if (!completedIndices.includes(i)) {
          search.progress.completedIndices.push(i);
        }

        const percentage = Math.round((currentCombination / totalCombinations) * 100);
        search.progress.current = currentCombination;
        search.progress.percentage = percentage;

        await search.save();

        if (io) {
          io.emit('search:progress:updated', {
            searchId: search.searchId,
            current: currentCombination,
            total: totalCombinations,
            percentage,
            status: 'running',
            usersFound: search.results.totalUsersFound,
            resumable: true,
          });
        }

        logger.info(
          `Progress: ${currentCombination}/${totalCombinations} (${percentage}%) - Users: ${search.results.totalUsersFound}`
        );
      } catch (comboError) {
        logger.error(`Error in combination ${combo.location} ${combo.year}: ${comboError.message}`);

        if (isGitHubTokenError(comboError)) {
          const errorReason = `GitHub API error (${comboError.response?.status}): ${comboError.message}`;
          logger.warn(
            `Token ${token.name} hit ${comboError.response?.status} — rotating to next token by createdAt`
          );

          const nextTokenDoc = await rotateSearchToken(
            search,
            searchService,
            emailExtractor,
            token,
            io,
            errorReason
          );

          if (!nextTokenDoc) {
            break;
          }

          token = nextTokenDoc;
          logger.info(`Retrying combination ${combo.location} ${combo.year} with token ${token.name}`);
          i--;
          continue;
        }

        search.searchLog.push({
          location: combo.location,
          year: combo.year,
          date: new Date(),
          status: 'error',
          error: comboError.message,
        });

        // Save error state for resumption
        await search.save();
      }

      if (!(await sleepUnlessStopped(1000, searchId))) {
        break;
      }
    }

    if (shouldStopWorker(searchId)) {
      await handleWorkerStopped(search, searchId, io);
      return;
    }

    // Search completed successfully
    const duration = Date.now() - startTime;
    search.status = 'completed';
    search.recoverable = false;
    search.completedAt = new Date();
    search.duration = duration;
    await search.save();

    // Update token metrics
    if (token) {
      token.successCount += 1;
      token.lastUsed = new Date();
      await token.save();
      await TokenSelector.updateTokenUsage(token._id, currentCombination);
    }

    logger.info(
      `Search ${search.searchId} completed in ${(duration / 1000).toFixed(2)}s. Found ${search.results.totalUsersFound} users`
    );

    await notifySearchChange(io, search);

    // Broadcast completion
    if (io) {
      io.emit('search:completed', {
        searchId: search.searchId,
        status: 'completed',
        duration,
        usersFound: search.results.totalUsersFound,
      });
    }

    releaseSearchWorker(searchId);
  } catch (error) {
    logger.error(`Search execution error: ${error.message}`);

    if (shouldStopWorker(searchId)) {
      await handleWorkerStopped(search, searchId, io);
      return;
    }

    if (isGitHubTokenError(error)) {
      search.status = 'awaiting_tokens';
      search.error = 'Token rotation in progress — search will continue automatically';
      await search.save();
      await notifySearchChange(io, search);

      if (io) {
        io.emit('search:awaiting_tokens', {
          searchId,
          message: search.error,
        });
      }

      releaseSearchWorker(searchId);
      if (!isShuttingDown()) {
        const fresh = await Search.findOne({ searchId });
        if (fresh && !hasActiveWorker(searchId)) {
          const acquired = tryAcquireSearchWorker(searchId);
          if (acquired.ok) {
            executeSearchInBackground(fresh, null, io);
          }
        }
      }
      return;
    }

    search.status = 'failed';
    search.error = error.message;
    search.completedAt = new Date();
    search.duration = Date.now() - startTime;
    await search.save();
    await notifySearchChange(io, search);

    if (io) {
      io.emit('search:failed', {
        searchId,
        status: 'failed',
        error: error.message,
      });
    }

    releaseSearchWorker(searchId);
  }
}

/**
 * Update search results
 */
router.patch('/searches/:id/results', async (req, res) => {
  try {
    const { usersFound, usersProcessed, emailsExtracted } = req.body;
    const search = await Search.findOne({ searchId: req.params.id });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (usersFound !== undefined) {
      search.results.totalUsersFound = usersFound;
    }
    if (usersProcessed !== undefined) {
      search.results.totalUsersProcessed = usersProcessed;
    }
    if (emailsExtracted !== undefined) {
      search.results.totalEmailsExtracted = emailsExtracted;
    }

    await search.save();
    res.json(search.results);
  } catch (error) {
    logger.error(`Error updating search results: ${error.message}`);
    res.status(500).json({ error: 'Failed to update search results' });
  }
});

/**
 * Complete search
 */
router.post('/searches/:id/complete', async (req, res) => {
  try {
    const { duration, outputFiles } = req.body;
    const search = await Search.findOne({ searchId: req.params.id });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    search.status = 'completed';
    search.completedAt = new Date();
    search.duration = duration;
    if (outputFiles) {
      search.outputFiles = outputFiles;
    }

    await search.save();
    logger.info(`Search completed: ${search.searchId}`);

    res.json({
      id: search._id,
      status: search.status,
      duration: search.duration,
      results: search.results,
    });
  } catch (error) {
    logger.error(`Error completing search: ${error.message}`);
    res.status(500).json({ error: 'Failed to complete search' });
  }
});

/**
 * Get users for a search
 */
router.get('/searches/:id/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const total = await User.countDocuments({ searchId: search.searchId });
    const users = await User.find({ searchId: search.searchId })
      .skip(skip)
      .limit(limit);

    res.json({
      searchId: search.searchId,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      users,
    });
  } catch (error) {
    logger.error(`Error fetching users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * Delete search and associated users
 * DELETE /api/searches/:id
 */
router.delete('/searches/:id', async (req, res) => {
  try {
    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (hasActiveWorker(search.searchId)) {
      const state = getSearchWorkerState(search.searchId);
      if (state) {
        state.shouldPause = true;
      }
      releaseSearchWorker(search.searchId);
    }

    // Delete all users for this search
    const userDeleteResult = await User.deleteMany({ searchId: search.searchId });
    logger.info(`Deleted ${userDeleteResult.deletedCount} users for search ${search.searchId}`);

    // Delete the search
    await Search.deleteOne({ searchId: search.searchId });
    logger.info(`Deleted search: ${search.searchId}`);

    res.json({
      message: 'Search deleted successfully',
      searchId: search.searchId,
      usersDeleted: userDeleteResult.deletedCount,
    });
  } catch (error) {
    logger.error(`Error deleting search: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete search' });
  }
});

/**
 * Pause search
 * POST /api/searches/:id/pause
 */
router.post('/searches/:id/pause', async (req, res) => {
  try {
    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (search.status !== 'running') {
      return res.status(400).json({ error: 'Can only pause running searches' });
    }

    // Set pause flag in memory to stop the background execution
    const searchState = getSearchWorkerState(search.searchId);
    if (searchState) {
      searchState.shouldPause = true;
      logger.info(`Pause flag set for search ${search.searchId}`);
    }

    // Update database status
    search.status = 'paused';
    search.pausedAt = new Date();
    await search.save();
    await notifySearchChange(req.io, search);

    logger.info(`Search paused: ${search.searchId}`);

    res.json({
      id: search._id,
      searchId: search.searchId,
      status: search.status,
      message: 'Search paused successfully',
    });
  } catch (error) {
    logger.error(`Error pausing search: ${error.message}`);
    res.status(500).json({ error: 'Failed to pause search' });
  }
});

/**
 * Resume search
 * POST /api/searches/:id/resume
 * Can resume both paused and failed searches
 */
router.post('/searches/:id/resume', async (req, res) => {
  try {
    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (!['paused', 'failed', 'awaiting_tokens'].includes(search.status)) {
      return res.status(400).json({
        error: 'Can only resume paused, failed, or awaiting_tokens searches',
      });
    }

    if (isShuttingDown()) {
      return res.status(503).json({ error: 'Server is shutting down — try again shortly' });
    }

    if (hasActiveWorker(search.searchId)) {
      return res.status(400).json({ error: 'Search is already running' });
    }

    const workerSlot = tryAcquireSearchWorker(search.searchId);
    if (!workerSlot.ok) {
      const statusCode = workerSlot.reason === 'concurrency_limit' ? 429 : 400;
      return res.status(statusCode).json({
        error: workerSlot.message || 'Search is already executing',
      });
    }

    const previousStatus = search.status;

    let selectedToken = await SearchTokenPool.assignTokenForSearch(search.searchId);
    if (!selectedToken) {
      search.status = 'awaiting_tokens';
      search.error = 'No GitHub tokens yet — will resume when a token is available';
      search.resumedAt = new Date();
      await search.save();
      await notifySearchChange(req.io, search);

      executeSearchInBackground(search, null, req.io);

      return res.status(202).json({
        id: search._id,
        searchId: search.searchId,
        status: search.status,
        message: `Search resumed from ${previousStatus} — awaiting tokens`,
      });
    }

    search.status = 'running';
    search.resumedAt = new Date();
    search.tokenId = selectedToken._id;
    search.tokenName = selectedToken.name;
    search.error = null;
    await search.save();
    await notifySearchChange(req.io, search);

    logger.info(
      `Search resumed from ${previousStatus}: ${search.searchId} with token: ${selectedToken.name}`
    );

    executeSearchInBackground(search, selectedToken, req.io);

    res.json({
      id: search._id,
      searchId: search.searchId,
      status: search.status,
      tokenName: selectedToken.name,
      message: `Search resumed successfully from ${previousStatus} status`,
    });
  } catch (error) {
    logger.error(`Error resuming search: ${error.message}`);
    releaseSearchWorker(req.params.id);
    res.status(500).json({ error: 'Failed to resume search' });
  }
});

/**
 * Get search logs
 * GET /api/searches/:id/logs
 */
router.get('/searches/:id/logs', async (req, res) => {
  try {
    const search = await Search.findOne({ searchId: req.params.id });
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    res.json({
      searchId: search.searchId,
      status: search.status,
      progress: {
        current: search.progress.current,
        total: search.progress.total,
        percentage: search.progress.percentage,
        completedCombinations: search.progress.completedIndices.length,
        remainingCombinations: search.progress.total - search.progress.completedIndices.length,
      },
      results: search.results,
      logs: search.searchLog,
      timestamps: {
        created: search.createdAt,
        started: search.startedAt,
        paused: search.pausedAt,
        resumed: search.resumedAt,
        completed: search.completedAt,
        duration: search.duration,
      },
      token: {
        id: search.tokenId,
        name: search.tokenName,
      },
    });
  } catch (error) {
    logger.error(`Error fetching search logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch search logs' });
  }
});

/**
 * Get all global logs (all location-year combinations ever searched)
 * GET /api/logs
 */
router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await Log.countDocuments();
    const logs = await Log.find()
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      logs,
    });
  } catch (error) {
    logger.error(`Error fetching logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

/**
 * Get logs for a specific location-year combination
 * GET /api/logs/location/:location/year/:year
 */
router.get('/logs/location/:location/year/:year', async (req, res) => {
  try {
    const { location, year } = req.params;
    const { followers, accountType } = req.query;

    const filter = {
      location,
      year: parseInt(year),
    };
    if (followers) {
      filter.followers = followers;
    }
    if (accountType) {
      filter.accountType = accountType;
    }

    const logs = await Log.find(filter).sort({ completedAt: -1 });

    res.json({
      location,
      year: parseInt(year),
      followers: followers || null,
      accountType: accountType || null,
      searchCount: logs.length,
      logs,
    });
  } catch (error) {
    logger.error(`Error fetching location logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch location logs' });
  }
});

/**
 * Get logs for a specific search
 * GET /api/logs/search/:searchId
 */
router.get('/logs/search/:searchId', async (req, res) => {
  try {
    const { searchId } = req.params;

    const logs = await Log.find({ searchId }).sort({ completedAt: -1 });

    res.json({
      searchId,
      logCount: logs.length,
      logs,
    });
  } catch (error) {
    logger.error(`Error fetching search logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch search logs' });
  }
});

/**
 * Clear/delete log for a location-year combination (to allow redo)
 * DELETE /api/logs/location/:location/year/:year
 */
router.delete('/logs/location/:location/year/:year', async (req, res) => {
  try {
    const { location, year } = req.params;
    const { followers, accountType } = req.query;

    const filter = {
      location,
      year: parseInt(year),
    };
    if (followers) {
      filter.followers = followers;
    }
    if (accountType) {
      filter.accountType = accountType;
    }

    const result = await Log.deleteMany(filter);

    logger.info(`Deleted ${result.deletedCount} log entries for ${location} ${year}`);

    res.json({
      message: 'Log entries deleted successfully',
      location,
      year: parseInt(year),
      followers: followers || null,
      accountType: accountType || null,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    logger.error(`Error deleting logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete logs' });
  }
});

/**
 * Clear all logs for a search (to allow redo)
 * DELETE /api/logs/search/:searchId
 */
router.delete('/logs/search/:searchId', async (req, res) => {
  try {
    const { searchId } = req.params;

    const result = await Log.deleteMany({ searchId });

    logger.info(`Deleted ${result.deletedCount} log entries for search ${searchId}`);

    res.json({
      message: 'Search logs deleted successfully',
      searchId,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    logger.error(`Error deleting search logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete search logs' });
  }
});

/**
 * Get log statistics
 * GET /api/logs/stats
 */
router.get('/logs/stats', async (req, res) => {
  try {
    const totalLogs = await Log.countDocuments();
    const completedLogs = await Log.countDocuments({ status: 'completed' });
    const errorLogs = await Log.countDocuments({ status: 'error' });
    const skippedLogs = await Log.countDocuments({ status: 'skipped' });

    const uniqueLocations = await Log.distinct('location');
    const uniqueYears = await Log.distinct('year');

    res.json({
      total: totalLogs,
      completed: completedLogs,
      errors: errorLogs,
      skipped: skippedLogs,
      uniqueLocations: uniqueLocations.length,
      uniqueYears: uniqueYears.length,
      locations: uniqueLocations,
      years: uniqueYears,
    });
  } catch (error) {
    logger.error(`Error fetching log stats: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch log statistics' });
  }
});

/**
 * Search users with filters
 * POST /api/users/filter
 * Query parameters: page, limit
 * Body: { username, location, company, minFollowers, maxFollowers, minRepos, keyword, email, searchId, foundInLocation, foundInYear }
 */
router.post('/users/filter', async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const {
      username,
      location,
      company,
      minFollowers,
      maxFollowers,
      minRepos,
      keyword,
      email,
      searchId,
      foundInLocation,
      foundInYear,
    } = req.body;

    // Build filter object
    const filter = {};

    if (username) {
      filter.username = { $regex: username, $options: 'i' };
    }

    if (location) {
      filter.location = { $regex: location, $options: 'i' };
    }

    if (company) {
      filter.company = { $regex: company, $options: 'i' };
    }

    if (minFollowers || maxFollowers) {
      filter.followers = {};
      if (minFollowers) {
        filter.followers.$gte = parseInt(minFollowers);
      }
      if (maxFollowers) {
        filter.followers.$lte = parseInt(maxFollowers);
      }
    }

    if (minRepos) {
      filter.public_repos = { $gte: parseInt(minRepos) };
    }

    if (keyword) {
      filter.$or = [
        { bio: { $regex: keyword, $options: 'i' } },
        { name: { $regex: keyword, $options: 'i' } },
        { username: { $regex: keyword, $options: 'i' } },
      ];
    }

    if (email) {
      filter.emails = { $in: [email] };
    }

    if (searchId) {
      filter.searchId = searchId;
    }

    if (foundInLocation) {
      filter['foundIn.location'] = { $regex: foundInLocation, $options: 'i' };
    }

    if (foundInYear) {
      filter['foundIn.year'] = parseInt(foundInYear);
    }

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .skip(skip)
      .limit(parseInt(limit));
      // .sort({ extractedAt: -1 });

    logger.info(`Filtered user search: ${total} total results, page ${page}`);

    res.json({
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      filters: {
        username,
        location,
        company,
        minFollowers,
        maxFollowers,
        minRepos,
        keyword,
        email,
        searchId,
        foundInLocation,
        foundInYear,
      },
      users,
    });
  } catch (error) {
    logger.error(`Error filtering users: ${error.message}`);
    res.status(500).json({ error: 'Failed to filter users' });
  }
});

router.executeSearchInBackground = executeSearchInBackground;

module.exports = router;
