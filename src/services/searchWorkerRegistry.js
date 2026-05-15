/**
 * In-memory registry of active search workers (per process).
 */

const SearchTokenPool = require('./searchTokenPool');

const MAX_CONCURRENT_SEARCHES = parseInt(process.env.MAX_CONCURRENT_SEARCHES || '3', 10);

/** @type {Map<string, { shouldPause: boolean, startedAt: number }>} */
const runningSearches = new Map();

let shuttingDown = false;

function isShuttingDown() {
  return shuttingDown;
}

function setShuttingDown(value) {
  shuttingDown = value;
}

function getMaxConcurrentSearches() {
  return MAX_CONCURRENT_SEARCHES;
}

function getActiveWorkerCount() {
  return runningSearches.size;
}

function getActiveSearchIds() {
  return [...runningSearches.keys()];
}

function hasActiveWorker(searchId) {
  return runningSearches.has(searchId);
}

function tryAcquireSearchWorker(searchId) {
  if (shuttingDown) {
    return { ok: false, reason: 'shutting_down', message: 'Server is shutting down' };
  }
  if (runningSearches.has(searchId)) {
    return { ok: false, reason: 'already_running' };
  }
  if (runningSearches.size >= MAX_CONCURRENT_SEARCHES) {
    return {
      ok: false,
      reason: 'concurrency_limit',
      message: `Maximum ${MAX_CONCURRENT_SEARCHES} concurrent searches allowed`,
    };
  }
  runningSearches.set(searchId, { shouldPause: false, startedAt: Date.now() });
  return { ok: true };
}

function releaseSearchWorker(searchId) {
  runningSearches.delete(searchId);
  SearchTokenPool.releaseTokenForSearch(searchId);
}

function getSearchWorkerState(searchId) {
  return runningSearches.get(searchId);
}

function clearShouldPause(searchId) {
  const state = runningSearches.get(searchId);
  if (state) {
    state.shouldPause = false;
  }
}

function pauseAllActiveWorkers() {
  for (const state of runningSearches.values()) {
    state.shouldPause = true;
  }
}

function clearAllWorkers() {
  const ids = getActiveSearchIds();
  runningSearches.clear();
  for (const searchId of ids) {
    SearchTokenPool.releaseTokenForSearch(searchId);
  }
}

function waitForWorkersToFinish(timeoutMs) {
  const intervalMs = 500;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (runningSearches.size === 0 || Date.now() >= deadline) {
        resolve(runningSearches.size);
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

module.exports = {
  isShuttingDown,
  setShuttingDown,
  getMaxConcurrentSearches,
  getActiveWorkerCount,
  getActiveSearchIds,
  hasActiveWorker,
  tryAcquireSearchWorker,
  releaseSearchWorker,
  getSearchWorkerState,
  clearShouldPause,
  pauseAllActiveWorkers,
  clearAllWorkers,
  waitForWorkersToFinish,
};
