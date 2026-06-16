/**
 * Agent entry point (Phase 1) — run search agents as a standalone process:
 *   npm run agent            # one agent
 *   AGENT_COUNT=4 npm run agent
 *
 * Agents connect to the same MongoDB as the manager and pull tasks from the queue
 * (they never talk to the manager directly). Phase 0 runs the identical loop in-process
 * inside the manager (see server.js); this file lets you scale out to separate processes
 * or separate machines with zero logic change.
 *
 * It also exposes a minimal HTTP /health server + self keep-alive so the agent can be
 * deployed as a host that requires an open port / health check (e.g. a Render web
 * service) and stays awake (set KEEP_ALIVE_URL to this service's public URL).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const Database = require('./utils/database');
const Logger = require('./utils/logger');
const { startAgent } = require('./services/agent/agentRunner');
const { startSelfKeepAlive, stopSelfKeepAlive } = require('./services/keepAlive');

const logger = new Logger();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/github-user-research';
const PORT = process.env.PORT || 3001;

async function main() {
  await Database.connect(MONGODB_URI);
  logger.info('Agent process connected to MongoDB');

  const count = Math.max(1, parseInt(process.env.AGENT_COUNT || '1', 10));
  const agents = [];
  for (let i = 0; i < count; i++) {
    // Stable per-slot id (`${RENDER_SERVICE_ID}-${i}`) so redeploys reuse the agent record.
    agents.push(await startAgent({ ordinal: i }));
  }
  logger.info(`Started ${agents.length} agent(s) in this process`);

  // Minimal health server — lets the agent run as a host that needs an open port /
  // health check, and gives the keep-alive (and any uptime monitor) something to ping.
  const healthServer = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/health' || url === '/') {
      const mongo = Database.isConnected();
      res.writeHead(mongo ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: mongo ? 'ok' : 'degraded',
          role: 'agent',
          agents: agents.map((a) => a.agentId),
          mongoConnected: mongo,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  healthServer.listen(PORT, () => {
    logger.info(`Agent health server listening on :${PORT} (GET /health)`);
    // Self-ping to stay awake on hosts that idle-stop without traffic.
    // For Render free web services, set KEEP_ALIVE_URL to this service's PUBLIC url.
    startSelfKeepAlive();
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} — draining agents...`);
    stopSelfKeepAlive();
    healthServer.close();
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
