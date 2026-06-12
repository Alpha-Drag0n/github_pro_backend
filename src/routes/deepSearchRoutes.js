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
const Task = require('../models/taskModel');
const taskQueue = require('../services/agent/taskQueue');

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

// Array-field "non-empty" existence checks, keyed by the presence-filter param name.
const PRESENCE_FIELDS = {
  email: { $or: [{ 'contactInfo.emails.0': { $exists: true } }, { 'emails.0': { $exists: true } }] },
  linkedin: { 'socialProfiles.linkedin.0': { $exists: true } },
  x: { 'socialProfiles.x.0': { $exists: true } },
  discord: { 'contactInfo.discord.0': { $exists: true } },
  telegram: { 'contactInfo.telegram.0': { $exists: true } },
  whatsapp: { 'contactInfo.whatsapp.0': { $exists: true } },
  phone: { 'contactInfo.phone.0': { $exists: true } },
};
const HAS_PROFILE_LOCATION = { location: { $nin: [null, ''] } };
const HAS_DISCOVERED_LOCATION = { 'locationInfo.discovered.0': { $exists: true } };

/** Build the Mongo filter for the deep-search users query from request params. */
function buildDeepUserFilter(q) {
  const and = [{ 'searchIterationHistory.0': { $exists: true } }]; // deep-search users only

  if (q.username) and.push({ username: { $regex: q.username, $options: 'i' } });

  if (q.location) {
    const rx = { $regex: q.location, $options: 'i' };
    and.push({ $or: [{ location: rx }, { 'locationInfo.best': rx }, { 'locationInfo.discovered.value': rx }] });
  }
  if (q.email) {
    const rx = { $regex: q.email, $options: 'i' };
    and.push({ $or: [{ 'contactInfo.emails.email': rx }, { emails: rx }] });
  }
  if (q.minFollowers) and.push({ followers: { $gte: parseInt(q.minFollowers, 10) } });
  if (q.maxFollowers) and.push({ followers: { $lte: parseInt(q.maxFollowers, 10) } });

  // Location presence: any | has (profile or repo) | profile | discovered | none
  switch (q.locationPresence) {
    case 'has':
      and.push({ $or: [HAS_PROFILE_LOCATION, HAS_DISCOVERED_LOCATION, { 'locationInfo.best': { $nin: [null, ''] } }] });
      break;
    case 'profile':
      and.push(HAS_PROFILE_LOCATION);
      break;
    case 'discovered':
      and.push(HAS_DISCOVERED_LOCATION);
      break;
    case 'none':
      and.push({ $nor: [HAS_PROFILE_LOCATION, HAS_DISCOVERED_LOCATION] });
      break;
    default:
      break;
  }

  // Per-field presence toggles: <field>Has = 'yes' | 'no'
  for (const [field, cond] of Object.entries(PRESENCE_FIELDS)) {
    const v = q[`${field}Has`];
    if (v === 'yes') and.push(cond);
    else if (v === 'no') and.push({ $nor: [cond] });
  }

  return { $and: and };
}

/**
 * Unified Deep Search results — users found across ALL deep searches, with detailed filters.
 * GET /api/deep-searches/users?page&limit&username&location&email&minFollowers&maxFollowers
 *   &locationPresence=has|profile|discovered|none
 *   &emailHas|linkedinHas|xHas|discordHas|telegramHas|whatsappHas|phoneHas = yes|no
 * NOTE: must be declared before '/deep-searches/:id' so "users" isn't read as an id.
 */
router.get('/deep-searches/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = buildDeepUserFilter(req.query);

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

    // Agent system: generate per-bucket tasks; the manager's agents drain the queue.
    // (No token check here — agents wait on the shared rate limiter when tokens are busy.)
    search.status = 'in_progress';
    search.startedAt = new Date();
    search.pausedAt = null;
    search.error = null;
    search.control = { desired: 'run', requestedAt: new Date() };
    await search.save();

    const totalBuckets = await taskQueue.generateTasksForSearch(search);

    logger.info(`Deep search started: ${search.searchId} — ${totalBuckets} bucket tasks queued`);

    res.json({
      searchId: search.searchId,
      status: search.status,
      totalBuckets,
      message: 'Search started — tasks queued for agents',
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

    // Pause = hold pending tasks + set desired state. In-flight tasks finish.
    const held = await taskQueue.pauseSearch(search._id);
    await DeepSearch.updateOne({ _id: search._id }, { $set: { pausedAt: new Date() } });

    logger.info(`Deep search paused: ${search.searchId} (${held} tasks held)`);

    res.json({
      searchId: search.searchId,
      status: 'paused',
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

    // If the search never had tasks generated (e.g. created but never started),
    // generate them now; otherwise release any held tasks back to the queue.
    const existingTasks = await Task.countDocuments({ searchId: search._id });
    if (existingTasks === 0) {
      search.status = 'in_progress';
      search.startedAt = search.startedAt || new Date();
      search.resumedAt = new Date();
      search.error = null;
      search.control = { desired: 'run', requestedAt: new Date() };
      await search.save();
      await taskQueue.generateTasksForSearch(search);
    } else {
      await taskQueue.resumeSearch(search._id);
      await DeepSearch.updateOne({ _id: search._id }, { $set: { resumedAt: new Date(), error: null } });
    }

    logger.info(`Deep search resumed: ${search.searchId}`);

    res.json({
      searchId: search.searchId,
      status: 'in_progress',
      message: 'Search resumed — tasks queued for agents',
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

    // Cancel queued tasks first so agents stop picking them up, then delete.
    await taskQueue.stopSearch(search._id);
    const deletedTasks = await Task.deleteMany({ searchId: search._id });

    // Delete associated logs
    const deletedLogs = await DeepSearchLog.deleteMany({
      searchId: search._id
    });

    // Delete search
    await DeepSearch.deleteOne({ _id: search._id });
    logger.info(`Deleted ${deletedTasks.deletedCount} tasks for ${search.searchId}`);

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
