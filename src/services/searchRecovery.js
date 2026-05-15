/**
 * Startup recovery for searches interrupted by deploy, spin-down, or crash.
 */

const Search = require('../models/searchModel');
const Logger = require('../utils/logger');
const SearchTokenPool = require('./searchTokenPool');
const {
  getMaxConcurrentSearches,
  tryAcquireSearchWorker,
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
async function reconcileOrphanedSearches() {
  const orphans = await Search.find({
    status: { $in: ['running', 'awaiting_tokens'] },
  });

  if (orphans.length === 0) {
    return [];
  }

  const now = new Date();
  const ids = orphans.map((s) => s.searchId);

  await Search.updateMany(
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

  return Search.find({ searchId: { $in: ids } });
}

/**
 * Resume searches that were paused during shutdown/recovery and are not finished.
 */
async function autoResumeRecoverableSearches(io, executeSearchInBackground) {
  if (!isAutoResumeEnabled()) {
    logger.info('AUTO_RESUME_SEARCHES is disabled — recoverable searches stay paused');
    return { resumed: 0, skipped: 0 };
  }

  const candidates = await Search.find({
    status: 'paused',
    recoverable: true,
  }).sort({ updatedAt: 1 });

  const incomplete = candidates.filter(isSearchIncomplete);
  const limit = getMaxConcurrentSearches();
  let resumed = 0;
  let skipped = 0;

  for (const search of incomplete) {
    if (resumed >= limit) {
      skipped += 1;
      continue;
    }

    const slot = tryAcquireSearchWorker(search.searchId);
    if (!slot.ok) {
      skipped += 1;
      continue;
    }

    const token = await SearchTokenPool.assignTokenForSearch(search.searchId);

    search.status = 'running';
    search.error = null;
    search.resumedAt = new Date();
    if (token) {
      search.tokenId = token._id;
      search.tokenName = token.name;
    }
    await search.save();

    logger.info(`Auto-resuming search ${search.searchId} after startup`);
    executeSearchInBackground(search, token, io);
    resumed += 1;
  }

  if (resumed > 0 || skipped > 0) {
    logger.info(`Startup auto-resume: ${resumed} started, ${skipped} deferred`);
  }

  return { resumed, skipped };
}

/**
 * Run full startup recovery sequence.
 * @param {import('socket.io').Server} io
 * @param {Function} executeSearchInBackground
 */
async function recoverSearchesOnStartup(io, executeSearchInBackground) {
  await reconcileOrphanedSearches();
  await autoResumeRecoverableSearches(io, executeSearchInBackground);
}

module.exports = {
  SHUTDOWN_MESSAGE,
  RESTART_MESSAGE,
  isSearchIncomplete,
  reconcileOrphanedSearches,
  autoResumeRecoverableSearches,
  recoverSearchesOnStartup,
};
