/**
 * Agent entry point (Phase 1) — run search agents as a standalone process:
 *   npm run agent            # one agent
 *   AGENT_COUNT=4 npm run agent
 *
 * Agents connect to the same MongoDB as the manager and pull tasks from the queue.
 * Phase 0 runs the identical loop in-process inside the manager (see server.js);
 * this file lets you scale out to separate processes with zero logic change.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Database = require('./utils/database');
const Logger = require('./utils/logger');
const { startAgent } = require('./services/agent/agentRunner');

const logger = new Logger();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/github-user-research';

async function main() {
  await Database.connect(MONGODB_URI);
  logger.info(`Agent process connected to MongoDB`);

  const count = Math.max(1, parseInt(process.env.AGENT_COUNT || '1', 10));
  const agents = [];
  for (let i = 0; i < count; i++) {
    agents.push(await startAgent());
  }
  logger.info(`Started ${agents.length} agent(s) in this process`);

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} — draining agents...`);
    await Promise.all(agents.map((a) => a.stop().catch(() => {})));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logger.error(`Agent process failed to start: ${e.message}`);
  process.exit(1);
});
