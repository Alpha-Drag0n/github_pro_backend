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
const UserSearchService = require('../services/userSearchService');
const EmailExtractorService = require('../services/emailExtractorService');

const logger = new Logger();

// Track running searches to support pause/resume
const runningSearches = new Map(); // Map<searchId, { status, abortFlag }>

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

    // Check if already running
    if (search.status === 'running') {
      return res.status(400).json({ error: 'Search is already running' });
    }

    // Select best available token
    selectedToken = await TokenSelector.selectBestToken();
    if (!selectedToken) {
      search.status = 'failed';
      search.error = 'No available GitHub tokens in database. Add tokens via Tokens tab.';
      await search.save();
      return res.status(400).json({ error: search.error });
    }

    // Update search with token info and status
    search.status = 'running';
    search.startedAt = new Date();
    search.tokenId = selectedToken._id;
    search.tokenName = selectedToken.name;
    search.searchLog = [];
    await search.save();

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

  try {
    // Register this search as running
    runningSearches.set(search.searchId, { status: 'running', shouldPause: false });
    logger.info(`Search ${search.searchId} registered in running searches`);

    // Get token full document
    const token = await Token.findById(selectedToken._id);

    // Initialize search service with selected token and search parameters
    const searchService = new UserSearchService(token.token, search.parameters);
    
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
      // Check if search has been paused
      const searchState = runningSearches.get(search.searchId);
      if (searchState && searchState.shouldPause) {
        logger.info(`Search ${search.searchId} paused at combination ${currentCombination}/${totalCombinations}`);
        break; // Exit the loop - search will be paused
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
        const existingLog = await Log.findOne({
          location: combo.location,
          year: combo.year,
        });

        if (existingLog) {
          logger.info(`Skipping ${combo.location} ${combo.year} - already searched on ${existingLog.completedAt}`);
          
          // Add to search log and mark as skipped
          search.searchLog.push({
            location: combo.location,
            year: combo.year,
            date: new Date(),
            usersFound: existingLog.usersFound,
            status: 'skipped (already searched)',
          });

          // Mark this combination as completed
          if (!completedIndices.includes(i)) {
            search.progress.completedIndices.push(i);
          }

          // Calculate and update progress
          const percentage = Math.round((currentCombination / totalCombinations) * 100);
          search.progress.current = currentCombination;
          search.progress.percentage = percentage;
          await search.save();

          // Broadcast progress
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

        // Track token usage for search API call
        if (users.length > 0) {
          // Estimate API requests used (1 search call + 1 per page)
          const estimatedPages = Math.ceil(users.length / 100);
          await TokenSelector.updateTokenUsage(selectedToken._id, estimatedPages);
        }

        logger.info(`Found ${users.length} users for ${combo.location} ${combo.year}`);

        // Extract emails and save found users to database
        const emailExtractor = new EmailExtractorService(token.token);
        let newUsersCount = 0;
        let skippedUsersCount = 0;

        for (const user of users) {
          // Check again if search has been paused while processing users
          const searchState = runningSearches.get(search.searchId);
          if (searchState && searchState.shouldPause) {
            logger.info(`Search ${search.searchId} paused while processing users`);
            break; // Exit the user processing loop
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
              await TokenSelector.updateTokenUsage(selectedToken._id, 1);
            } catch (profileError) {
              logger.warn(`Could not fetch full profile for ${user.login}, using search result: ${profileError.message}`);
              // Continue with search result data if profile fetch fails
            }

            // Extract emails from bio, commits, and README
            const extractedData = await emailExtractor.extractEmailsForUser(userProfile);

            // Track token usage for email extraction (commit search + readme fetch)
            await TokenSelector.updateTokenUsage(selectedToken._id, 2);

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

        // Create log entry for this combination
        await Log.create({
          searchId: search.searchId,
          location: combo.location,
          year: combo.year,
          usersFound: users.length,
          status: 'completed',
          completedAt: new Date(),
        });

        // Update search log
        search.searchLog.push({
          location: combo.location,
          year: combo.year,
          date: new Date(),
          usersFound: users.length,
          status: 'completed',
          newUsers: newUsersCount,
          skippedUsers: skippedUsersCount,
        });

        // Update results
        search.results.totalUsersFound = await User.countDocuments({
          searchId: search.searchId,
        });

        // Mark this combination as completed
        if (!completedIndices.includes(i)) {
          search.progress.completedIndices.push(i);
        }

        // Calculate and update progress
        const percentage = Math.round((currentCombination / totalCombinations) * 100);
        search.progress.current = currentCombination;
        search.progress.percentage = percentage;

        // Save after each combination (for resumption support)
        await search.save();

        // Broadcast progress via WebSocket
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

        // Check if it's a token error requiring failover
        const status = comboError.response?.status;
        if (status === 401 || status === 403) {
          // Mark current token as failed/rate-limited before trying next token
          const errorReason = `GitHub API error: ${comboError.message}`;
          await TokenSelector.markTokenError(selectedToken._id, errorReason);
          logger.warn(`Token ${selectedToken.name} marked as failed. Attempting to select next available token...`);

          // Token failed, try to select next one
          const nextToken = await TokenSelector.selectBestToken();
          if (nextToken && nextToken._id.toString() !== token._id.toString()) {
            logger.info(`Failover to next token: ${nextToken.name}`);
            const nextTokenDoc = await Token.findById(nextToken._id);
            const GitHubClient = require('../api/githubClient');
            searchService.currentToken = nextTokenDoc.token;
            searchService.client = new GitHubClient(nextTokenDoc.token);

            // Update local references for next iteration
            token.token = nextTokenDoc.token;
            Object.assign(token, nextTokenDoc.toObject());
            // Update search with new token
            search.tokenId = nextToken._id;
            search.tokenName = nextToken.name;
            await search.save();

            // Broadcast failover event
            if (io) {
              io.emit('search:token:failover', {
                searchId: search.searchId,
                previousToken: selectedToken.name,
                currentToken: nextToken.name,
              });
            }
          } else {
            throw new Error('No available tokens for failover');
          }
          
          // Retry the combination with the new token after a short delay
          logger.info(`Retrying combination ${combo.location} ${combo.year} with new token...`);
          await new Promise((resolve) => setTimeout(resolve, 500)); // Brief delay before retry
          i--; // Decrement loop counter to retry this combination
          continue; // Skip error logging and move to next iteration (which will retry current combo)
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

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Search completed successfully
    const duration = Date.now() - startTime;
    search.status = 'completed';
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

    // Broadcast completion
    if (io) {
      io.emit('search:completed', {
        searchId: search.searchId,
        status: 'completed',
        duration,
        usersFound: search.results.totalUsersFound,
      });
    }

    // Clean up from running searches
    runningSearches.delete(search.searchId);
  } catch (error) {
    logger.error(`Search execution failed: ${error.message}`);

    search.status = 'failed';
    search.error = error.message;
    search.completedAt = new Date();
    search.duration = Date.now() - startTime;
    await search.save();

    // Mark token as having error
    if (selectedToken) {
      await TokenSelector.markTokenError(selectedToken._id, error.message);
    }

    // Broadcast failure
    if (io) {
      io.emit('search:failed', {
        searchId: search.searchId,
        status: 'failed',
        error: error.message,
      });
    }

    // Clean up from running searches
    runningSearches.delete(search.searchId);
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
    const searchState = runningSearches.get(search.searchId);
    if (searchState) {
      searchState.shouldPause = true;
      logger.info(`Pause flag set for search ${search.searchId}`);
    }

    // Update database status
    search.status = 'paused';
    search.pausedAt = new Date();
    await search.save();

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

    if (search.status !== 'paused' && search.status !== 'failed') {
      return res.status(400).json({ error: 'Can only resume paused or failed searches' });
    }

    // Select best available token
    const selectedToken = await TokenSelector.selectBestToken();
    if (!selectedToken) {
      return res.status(400).json({ error: 'No available GitHub tokens' });
    }

    search.status = 'running';
    search.resumedAt = new Date();
    search.tokenId = selectedToken._id;
    search.tokenName = selectedToken.name;
    search.error = null; // Clear error if resuming a failed search
    await search.save();

    const previousStatus = search.status === 'failed' ? 'failed' : 'paused';
    logger.info(`Search resumed from ${previousStatus} status: ${search.searchId} with token: ${selectedToken.name}`);

    // Execute search in background
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

    const logs = await Log.find({
      location: location,
      year: parseInt(year),
    }).sort({ completedAt: -1 });

    res.json({
      location,
      year: parseInt(year),
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

    const result = await Log.deleteMany({
      location: location,
      year: parseInt(year),
    });

    logger.info(`Deleted ${result.deletedCount} log entries for ${location} ${year}`);

    res.json({
      message: 'Log entries deleted successfully',
      location,
      year: parseInt(year),
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
 * Body: { username, location, company, minFollowers, maxFollowers, minRepos, keyword, email }
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

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ extractedAt: -1 });

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
      },
      users,
    });
  } catch (error) {
    logger.error(`Error filtering users: ${error.message}`);
    res.status(500).json({ error: 'Failed to filter users' });
  }
});

module.exports = router;
