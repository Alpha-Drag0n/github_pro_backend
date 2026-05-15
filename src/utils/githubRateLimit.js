/**
 * Parse GitHub /rate_limit API response (resources.core).
 */

/**
 * @param {Object|null} resources - response.data.resources from GitHub API
 * @returns {{ remaining: number, limit: number, resetTime: Date }|null}
 */
function parseCoreRateLimit(resources) {
  if (!resources) {
    return null;
  }

  const core = resources.core || resources;
  if (core == null || core.reset == null) {
    return null;
  }

  const resetSeconds = Number(core.reset);
  if (!Number.isFinite(resetSeconds)) {
    return null;
  }

  const resetTime = new Date(resetSeconds * 1000);
  if (Number.isNaN(resetTime.getTime())) {
    return null;
  }

  return {
    remaining: Number.isFinite(Number(core.remaining)) ? core.remaining : 0,
    limit: Number.isFinite(Number(core.limit)) ? core.limit : 5000,
    resetTime,
  };
}

module.exports = { parseCoreRateLimit };
