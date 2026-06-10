/**
 * API Routes for Iterative Search Operations
 * Handles searches that bypass GitHub's 1000-result limit via location-based exclusion
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const IterativeSearch = require('../models/iterativeSearchModel');
const IterativeSearchLog = require('../models/iterativeSearchLogModel');
const User = require('../models/userModel');
const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');
const requestLogService = require('../services/requestLogService');
const SearchTokenPool = require('../services/searchTokenPool');
const iterativeSearchService = require('../services/iterativeSearchService');

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
 * Normalize an IterativeSearch document for API responses.
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
 * GET /api/iterative-searches
 */
router.get('/iterative-searches', async (req, res) => {
  try {
    const searches = await IterativeSearch.find()
      .sort({ createdAt: -1 });

    requestLogService.logDBOperation(
      'IterativeSearch.find',
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
 * Create new iterative search
 * POST /api/iterative-searches
 * Body: { fromDate, toDate }
 */
router.post('/iterative-searches', async (req, res) => {
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
    const search = new IterativeSearch({
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
      'IterativeSearch.save',
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
 * GET /api/iterative-searches/:id/users
 */
router.get('/iterative-searches/:id/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Find by either searchId or MongoDB _id
    const search = await IterativeSearch.findOne({
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
 * GET /api/iterative-searches/:id
 */
router.get('/iterative-searches/:id', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
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
 * POST /api/iterative-searches/:id/start
 */
router.post('/iterative-searches/:id/start', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
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
      'IterativeSearch.updateOne',
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
 * POST /api/iterative-searches/:id/pause
 */
router.post('/iterative-searches/:id/pause', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
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
      'IterativeSearch.updateOne',
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
 * POST /api/iterative-searches/:id/resume
 */
router.post('/iterative-searches/:id/resume', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (!['paused', 'failed'].includes(search.status)) {
      return res.status(400).json({
        error: 'Cannot resume search',
        message: 'Search must be in paused or failed status',
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
      'IterativeSearch.updateOne',
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
 * DELETE /api/iterative-searches/:id
 */
router.delete('/iterative-searches/:id', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Delete associated logs
    const deletedLogs = await IterativeSearchLog.deleteMany({ 
      searchId: search._id 
    });

    // Delete search
    await IterativeSearch.deleteOne({ _id: search._id });

    requestLogService.logDBOperation(
      'IterativeSearch.deleteOne',
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
 * GET /api/iterative-searches/:id/logs
 */
router.get('/iterative-searches/:id/logs', async (req, res) => {
  try {
    const search = await IterativeSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const logs = await IterativeSearchLog.find({ searchId: search._id })
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
