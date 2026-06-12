/**
 * Manager service — the control-plane background loops.
 *
 * - reaper: reclaim expired task leases + mark dead agents (self-healing).
 * - rollup: recompute each active search's progress from its tasks (source of
 *   truth, avoids parent-doc hotspotting) and broadcast progress over WebSocket.
 *
 * Stateless: everything is read from / written to MongoDB, so the manager can
 * crash and restart without losing anything, and multiple managers are safe
 * (reaper/rollup are idempotent).
 */

const taskQueue = require('./taskQueue');
const agentRegistry = require('./agentRegistry');
const DeepSearch = require('../../models/deepSearchModel');
const { REAPER_INTERVAL_MS, ROLLUP_INTERVAL_MS } = require('./agentConfig');
const Logger = require('../../utils/logger');

const logger = new Logger();
let timers = [];

function startManager(io) {
  // Reaper + dead-agent detection.
  timers.push(
    setInterval(async () => {
      try {
        const reclaimed = await taskQueue.reaper();
        const dead = await agentRegistry.reapDeadAgents();
        if (reclaimed || dead) {
          logger.info(`[manager] reaper: ${reclaimed} task(s) reclaimed, ${dead} agent(s) marked dead`);
        }
      } catch (e) {
        logger.error(`[manager] reaper error: ${e.message}`);
      }
    }, REAPER_INTERVAL_MS)
  );

  // Progress rollup for active searches.
  timers.push(
    setInterval(async () => {
      try {
        const active = await DeepSearch.find({
          status: { $in: ['in_progress', 'paused'] },
        }).select('_id searchId');

        for (const s of active) {
          const res = await taskQueue.rollupSearch(s._id);
          if (!res || !io) continue;
          const pct = res.progress.totalBuckets
            ? Math.round(((res.progress.done + res.progress.dead) / res.progress.totalBuckets) * 100)
            : 0;
          io.emit('deep-search:progress', {
            searchId: s.searchId,
            status: res.status,
            usersFound: res.progress.usersFound,
            bucketsProcessed: res.progress.done + res.progress.dead,
            totalBuckets: res.progress.totalBuckets,
            percentage: pct,
          });
          if (res.status === 'completed') {
            io.emit('deep-search:completed', {
              searchId: s.searchId,
              usersFound: res.progress.usersFound,
            });
          }
        }
      } catch (e) {
        logger.error(`[manager] rollup error: ${e.message}`);
      }
    }, ROLLUP_INTERVAL_MS)
  );

  logger.info('[manager] reaper + rollup loops started');
}

function stopManager() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { startManager, stopManager };
