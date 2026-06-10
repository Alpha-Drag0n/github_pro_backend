/**
 * Startup recovery for searches interrupted by deploy, spin-down, or crash.
 */

const QuickSearch = require('../models/quickSearchModel');
const Logger = require('../utils/logger');
const SearchTokenPool = require('./searchTokenPool');
const { notifySearchChange } = require('./searchBroadcast');
const {
  getMaxConcurrentSearches,
  tryAcquireSearchWorker,
  releaseSearchWorker,
} = require('./searchWorkerRegistry');

const logger = new Logger();

const SHUTDOWN_MESSAGE = 'Interrupted by server shutdown — resume to continue';
const RESTART_MESSAGE = 'Recovered after unexpected restart — resume to continue';

function isAutoResumeEnabled() {
  return process.env.AUTO_RESUME_SEARCHES === 'true';
}

function isSearchIncomplete(search) {
  const total = search.progress?.total ?? 0;
  const completed = search.progress?.completedIndices?.length ?? 0;
  if (total <= 0) {
    return search.status !== 'completed';
  }
  return completed < total;
}

/**
 * Mark DB rows that still say "running" but have no live worker (this process just started).
 */
async function reconcileOrphanedSearches(io) {
  const orphans = await QuickSearch.find({
    status: { $in: ['running', 'awaiting_tokens'] },
  });

  if (orphans.length === 0) {
    return 0;
  }

  const now = new Date();
  const ids = orphans.map((s) => s.searchId);

  await QuickSearch.updateMany(
    { searchId: { $in: ids } },
    {
      $set: {
        status: 'paused',
        error: RESTART_MESSAGE,
        pausedAt: now,
        recoverable: true,
      },
    }
  );

  logger.warn(`Reconciled ${orphans.length} orphaned search(es) after startup`);

  if (io) {
    const updated = await QuickSearch.find({ searchId: { $in: ids } });
    for (const search of updated) {
      await notifySearchChange(io, search);
    }
  }

  return orphans.length;
}

/**
 * Resume searches that were paused during shutdown/recovery and are not finished.
 */
async function autoResumeRecoverableSearches(io, executeSearchInBackground) {
  if (!isAutoResumeEnabled()) {
    logger.info('AUTO_RESUME_SEARCHES is disabled — recoverable searches stay paused');
    return { resumed: 0, skipped: 0 };
  }

  const candidates = await QuickSearch.find({
    status: 'paused',
    recoverable: true,
  }).sort({ updatedAt: 1 });

  const incomplete = candidates.filter(isSearchIncomplete);
  const limit = getMaxConcurrentSearches();
  let resumed = 0;
  let skipped = 0;

  for (const candidate of incomplete) {
    if (resumed >= limit) {
      skipped += 1;
      continue;
    }

    const slot = tryAcquireSearchWorker(candidate.searchId);
    if (!slot.ok) {
      skipped += 1;
      continue;
    }

    const token = await SearchTokenPool.assignTokenForSearch(candidate.searchId);

    const update = {
      status: 'running',
      error: null,
      resumedAt: new Date(),
      recoverable: true,
    };

    if (token) {
      update.tokenId = token._id;
      update.tokenName = token.name;
    }

    const search = await QuickSearch.findOneAndUpdate(
      { searchId: candidate.searchId },
      { $set: update },
      { new: true }
    );

    if (!search) {
      releaseSearchWorker(candidate.searchId);
      skipped += 1;
      continue;
    }

    await notifySearchChange(io, search);

    logger.info(`Auto-resuming search ${search.searchId} (status=running)`);
    executeSearchInBackground(search, token, io);
    resumed += 1;
  }

  if (resumed > 0 || skipped > 0) {
    logger.info(`Startup auto-resume: ${resumed} started, ${skipped} deferred`);
  }

  return { resumed, skipped };
}

/**
 * Run full startup recovery sequence (call after HTTP server is listening).
 */
async function recoverSearchesOnStartup(io, executeSearchInBackground) {
  const reconciled = await reconcileOrphanedSearches(io);
  const { resumed, skipped } = await autoResumeRecoverableSearches(io, executeSearchInBackground);
  return { reconciled, resumed, skipped };
}

module.exports = {
  SHUTDOWN_MESSAGE,
  RESTART_MESSAGE,
  isSearchIncomplete,
  reconcileOrphanedSearches,
  autoResumeRecoverableSearches,
  recoverSearchesOnStartup,
};
