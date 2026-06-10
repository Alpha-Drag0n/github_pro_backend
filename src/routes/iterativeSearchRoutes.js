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
const Logger = require('../utils/logger');
const requestLogService = require('../services/requestLogService');

const logger = new Logger();

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
      excludedLocations: [],
      lastFoundLocations: [],
    });

    await search.save();

    requestLogService.logDBOperation(
      'IterativeSearch.save',
      { searchId, totalDays },
      'create',
      0,
      true,
      null
    );

    logger.info(`Iterative search created: ${searchId} (${totalDays} days)`);

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

    search.status = 'in_progress';
    search.startedAt = new Date();
    search.pausedAt = null;
    await search.save();

    requestLogService.logDBOperation(
      'IterativeSearch.updateOne',
      { searchId: search.searchId, newStatus: 'in_progress' },
      'update',
      0,
      true,
      null
    );

    logger.info(`Iterative search started: ${search.searchId}`);

    res.json({
      searchId: search.searchId,
      status: search.status,
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

    if (search.status !== 'paused') {
      return res.status(400).json({
        error: 'Cannot resume search',
        message: 'Search must be in paused status',
        currentStatus: search.status,
      });
    }

    search.status = 'in_progress';
    search.resumedAt = new Date();
    await search.save();

    requestLogService.logDBOperation(
      'IterativeSearch.updateOne',
      { searchId: search.searchId, newStatus: 'in_progress' },
      'update',
      0,
      true,
      null
    );

    logger.info(`Iterative search resumed: ${search.searchId}`);

    res.json({
      searchId: search.searchId,
      status: search.status,
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
