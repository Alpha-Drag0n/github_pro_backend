/**
 * API Routes for Iterative Search Operations
 * Handles searches that bypass GitHub's 1000-result limit via location-based exclusion
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const DeepSearch = require('../models/deepSearchModel');
const DeepSearchLog = require('../models/deepSearchLogModel');
const User = require('../models/userModel');
const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');
const requestLogService = require('../services/requestLogService');
const SearchTokenPool = require('../services/searchTokenPool');
const iterativeSearchService = require('../services/deepSearchService');

const logger = new Logger();

/** Guards against launching two background loops for the same search in one process. */
const runningIterativeSearches = new Set();

/**
 * Assign a token and run the iterative search in the background (fire-and-forget).
 * Releases the worker guard and token assignment when finished.
 */
async function launchIterativeSearch(search, io) {
  const searchId = search.searchId;

  if (runningIterativeSearches.has(searchId)) {
    logger.warn(`Iterative search ${searchId} already running in this process`);
    return { ok: false, reason: 'already_running' };
  }

  const selectedToken = await SearchTokenPool.assignTokenForSearch(searchId);
  if (!selectedToken) {
    return { ok: false, reason: 'no_token' };
  }

  const tokenDoc = await Token.findById(selectedToken._id);
  if (!tokenDoc) {
    SearchTokenPool.releaseTokenForSearch(searchId);
    return { ok: false, reason: 'no_token' };
  }

  runningIterativeSearches.add(searchId);

  // Run in background — do not await.
  iterativeSearchService
    .runIterativeRangeSearch({ search, token: tokenDoc, io })
    .catch((error) => {
      logger.error(`Iterative search ${searchId} crashed: ${error.message}`);
    })
    .finally(() => {
      runningIterativeSearches.delete(searchId);
      SearchTokenPool.releaseTokenForSearch(searchId);
    });

  return { ok: true, tokenName: tokenDoc.name };
}

/**
 * Normalize an DeepSearch document for API responses.
 *
 * The model stores dates nested under `dateRange`, but the frontend reads flat
 * `fromDate` / `toDate` fields. This flattens them to `YYYY-MM-DD` strings while
 * preserving every other field (and the original `dateRange`) so existing and
 * future consumers both work.
 */
function serializeSearch(search) {
  const obj = typeof search.toObject === 'function' ? search.toObject() : { ...search };

  const from = obj.dateRange && obj.dateRange.fromDate;
  const to = obj.dateRange && obj.dateRange.toDate;
  const toIsoDate = (value) =>
    value ? new Date(value).toISOString().split('T')[0] : null;

  return {
    ...obj,
    fromDate: toIsoDate(from),
    toDate: toIsoDate(to),
  };
}

/**
 * Get all iterative searches
 * GET /api/deep-searches
 */
router.get('/deep-searches', async (req, res) => {
  try {
    const searches = await DeepSearch.find()
      .sort({ createdAt: -1 });

    requestLogService.logDBOperation(
      'DeepSearch.find',
      { count: searches.length },
      'find',
      0,
      true,
      null
    );

    res.json(searches.map(serializeSearch));
  } catch (error) {
    logger.error(`Error fetching iterative searches: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch searches' });
  }
});

/**
 * Unified Deep Search results — users found across ALL deep searches, with filters.
 * GET /api/deep-searches/users?page&limit&username&location&email&minFollowers
 * NOTE: must be declared before '/deep-searches/:id' so "users" isn't read as an id.
 */
router.get('/deep-searches/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Deep Search is the only flow that populates searchIterationHistory.
    const filter = { 'searchIterationHistory.0': { $exists: true } };

    if (req.query.username) {
      filter.username = { $regex: req.query.username, $options: 'i' };
    }
    if (req.query.location) {
      filter.location = { $regex: req.query.location, $options: 'i' };
    }
    if (req.query.email) {
      filter['contactInfo.emails.email'] = { $regex: req.query.email, $options: 'i' };
    }
    if (req.query.minFollowers) {
      filter.followers = { $gte: parseInt(req.query.minFollowers) };
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ extractedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalSearches = await DeepSearch.countDocuments();

    res.json({
      users,
      totalSearches,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`Error fetching unified deep-search users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/**
 * Create new iterative search
 * POST /api/deep-searches
 * Body: { fromDate, toDate }
 */
router.post('/deep-searches', async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['fromDate', 'toDate'],
      });
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);

    if (from > to) {
      return res.status(400).json({
        error: 'Invalid date range',
        message: 'fromDate must be before toDate',
      });
    }

    // Calculate total days
    const totalDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    // Each day is split into per-term buckets; progress is tracked at the bucket level.
    const termSet = 'alnum2';
    const termCount = iterativeSearchService.generateTerms(termSet).length;
    const totalBuckets = totalDays * termCount;

    const searchId = uuidv4();
    const search = new DeepSearch({
      searchId,
      status: 'pending',
      dateRange: {
        fromDate: from,
        toDate: to,
      },
      totalDays,
      daysProcessed: 0,
      currentIteration: 0,
      termSet,
      totalBuckets,
      bucketsProcessed: 0,
      excludedLocations: [],
      lastFoundLocations: [],
    });

    await search.save();

    requestLogService.logDBOperation(
      'DeepSearch.save',
      { searchId, totalDays, totalBuckets },
      'create',
      0,
      true,
      null
    );

    logger.info(`Iterative search created: ${searchId} (${totalDays} days × ${termCount} terms = ${totalBuckets} buckets)`);

    res.status(201).json(serializeSearch(search));
  } catch (error) {
    logger.error(`Error creating iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to create search' });
  }
});

/**
 * Get iterative search by ID with users
 * GET /api/deep-searches/:id/users
 */
router.get('/deep-searches/:id/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Find by either searchId or MongoDB _id
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Get users from this search
    const total = await User.countDocuments({ 
      'searchIterationHistory.searchId': search._id 
    });

    const users = await User.find({ 
      'searchIterationHistory.searchId': search._id 
    })
      .skip(skip)
      .limit(limit);

    requestLogService.logDBOperation(
      'User.find',
      { searchId: search.searchId, count: users.length },
      'find',
      0,
      true,
      null
    );

    res.json({
      search: serializeSearch(search),
      users,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`Error fetching iterative search users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * Get iterative search by ID
 * GET /api/deep-searches/:id
 */
router.get('/deep-searches/:id', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    res.json(serializeSearch(search));
  } catch (error) {
    logger.error(`Error fetching iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch search' });
  }
});

/**
 * Start iterative search execution
 * POST /api/deep-searches/:id/start
 */
router.post('/deep-searches/:id/start', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (search.status === 'in_progress') {
      return res.status(400).json({ error: 'Search is already running' });
    }

    if (search.status === 'completed') {
      return res.status(400).json({ error: 'Search is already completed' });
    }

    // Assign a token and kick off the background runner BEFORE flipping status,
    // so we don't mark it running when there is no token to run with.
    search.status = 'in_progress';
    search.startedAt = new Date();
    search.pausedAt = null;
    search.error = null;
    await search.save();

    const launch = await launchIterativeSearch(search, req.io);
    if (!launch.ok) {
      search.status = 'failed';
      search.error =
        launch.reason === 'no_token'
          ? 'No GitHub tokens available — add a token and try again'
          : 'Search is already running';
      await search.save();
      return res.status(launch.reason === 'no_token' ? 400 : 409).json({ error: search.error });
    }

    requestLogService.logDBOperation(
      'DeepSearch.updateOne',
      { searchId: search.searchId, newStatus: 'in_progress' },
      'update',
      0,
      true,
      null
    );

    logger.info(`Iterative search started: ${search.searchId} with token ${launch.tokenName}`);

    res.json({
      searchId: search.searchId,
      status: search.status,
      tokenName: launch.tokenName,
      message: 'Search started',
    });
  } catch (error) {
    logger.error(`Error starting iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to start search' });
  }
});

/**
 * Pause iterative search
 * POST /api/deep-searches/:id/pause
 */
router.post('/deep-searches/:id/pause', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    search.status = 'paused';
    search.pausedAt = new Date();
    await search.save();

    requestLogService.logDBOperation(
      'DeepSearch.updateOne',
      { searchId: search.searchId, newStatus: 'paused' },
      'update',
      0,
      true,
      null
    );

    logger.info(`Iterative search paused: ${search.searchId}`);

    res.json({
      searchId: search.searchId,
      status: search.status,
      message: 'Search paused',
    });
  } catch (error) {
    logger.error(`Error pausing iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to pause search' });
  }
});

/**
 * Resume iterative search
 * POST /api/deep-searches/:id/resume
 */
router.post('/deep-searches/:id/resume', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Any not-completed search can be resumed (failed, paused, pending, or a stuck
    // in_progress left over from a restart). The launch guard below rejects a search
    // that is genuinely still running in this process.
    if (search.status === 'completed') {
      return res.status(400).json({
        error: 'Cannot resume search',
        message: 'Search is already completed',
        currentStatus: search.status,
      });
    }

    const previousStatus = search.status;
    search.status = 'in_progress';
    search.resumedAt = new Date();
    search.error = null;
    await search.save();

    const launch = await launchIterativeSearch(search, req.io);
    if (!launch.ok) {
      search.status = previousStatus;
      search.error =
        launch.reason === 'no_token'
          ? 'No GitHub tokens available — add a token and try again'
          : 'Search is already running';
      await search.save();
      return res.status(launch.reason === 'no_token' ? 400 : 409).json({ error: search.error });
    }

    requestLogService.logDBOperation(
      'DeepSearch.updateOne',
      { searchId: search.searchId, newStatus: 'in_progress' },
      'update',
      0,
      true,
      null
    );

    logger.info(`Iterative search resumed: ${search.searchId} with token ${launch.tokenName}`);

    res.json({
      searchId: search.searchId,
      status: search.status,
      tokenName: launch.tokenName,
      message: 'Search resumed',
    });
  } catch (error) {
    logger.error(`Error resuming iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to resume search' });
  }
});

/**
 * Delete iterative search and associated data
 * DELETE /api/deep-searches/:id
 */
router.delete('/deep-searches/:id', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Delete associated logs
    const deletedLogs = await DeepSearchLog.deleteMany({ 
      searchId: search._id 
    });

    // Delete search
    await DeepSearch.deleteOne({ _id: search._id });

    requestLogService.logDBOperation(
      'DeepSearch.deleteOne',
      { searchId: search.searchId, deletedLogs: deletedLogs.deletedCount },
      'delete',
      0,
      true,
      null
    );

    logger.info(`Iterative search deleted: ${search.searchId}`);

    res.json({
      message: 'Search deleted',
      searchId: search.searchId,
      deletedLogs: deletedLogs.deletedCount,
    });
  } catch (error) {
    logger.error(`Error deleting iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete search' });
  }
});

/**
 * Get iterative search logs
 * GET /api/deep-searches/:id/logs
 */
router.get('/deep-searches/:id/logs', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const logs = await DeepSearchLog.find({ searchId: search._id })
      .sort({ date: 1 });

    res.json({
      searchId: search.searchId,
      totalLogs: logs.length,
      logs,
    });
  } catch (error) {
    logger.error(`Error fetching iterative search logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

module.exports = router;
