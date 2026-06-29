/**
 * Express Server Setup with WebSocket Support
 * Main backend server with API routes and real-time updates via Socket.io
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// Require tracing FIRST so its global mongoose plugin is installed before any
// model is compiled (models loaded earlier would miss DB span capture).
require('./services/observability/tracing');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('./utils/database');
const Logger = require('./utils/logger');
const { initializeTokensFromDatabase } = require('./utils/tokenInitializer');
const tokenRoutes = require('./routes/tokenRoutes');
const apifyTokenRoutes = require('./routes/apifyTokenRoutes');
const quickSearchRoutes = require('./routes/quickSearchRoutes');
const userLookupRoutes = require('./routes/userLookupRoutes');
const deepSearchRoutes = require('./routes/deepSearchRoutes');
const miningRoutes = require('./routes/miningRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const agentRoutes = require('./routes/agentRoutes');
const metricsRoutes = require('./routes/metricsRoutes');
const healthRoutes = require('./routes/healthRoutes');
const { startManager } = require('./services/agent/managerService');
const { startAgent } = require('./services/agent/agentRunner');
const { authenticate } = require('./middleware/authMiddleware');
const socketAuthMiddleware = require('./middleware/socketAuthMiddleware');
const setupSocketHandlers = require('./routes/socketRoutes');
const { recoverSearchesOnStartup } = require('./services/searchRecovery');
const { registerGracefulShutdown } = require('./services/gracefulShutdown');
const { startSelfKeepAlive, stopSelfKeepAlive } = require('./services/keepAlive');
const { recordHealthCheck } = require('./services/healthLogService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const logger = new Logger();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/github-user-research';

// Make io accessible to routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Serve frontend build in production (optional - only if built)
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
const frontendExists = fs.existsSync(frontendBuildPath);

if (frontendExists) {
  app.use(express.static(frontendBuildPath));
} else {
  logger.warn('Frontend build not found at ' + frontendBuildPath + ' - frontend routes will not be served');
}

// Public health check (no auth)
app.use('/health', healthRoutes);

// Auth routes (signup/signin public; rest protected per-route)
app.use('/api/auth', authRoutes);

// Admin routes (protected per-route)
app.use('/api/admin', adminRoutes);

// Protected API routes
app.use('/api', authenticate, tokenRoutes);
app.use('/api', authenticate, apifyTokenRoutes);
app.use('/api', authenticate, quickSearchRoutes);
app.use('/api', authenticate, userLookupRoutes);
app.use('/api', authenticate, deepSearchRoutes);
app.use('/api', authenticate, agentRoutes);
app.use('/api', authenticate, metricsRoutes);
app.use('/api/mining', authenticate, miningRoutes);

// API error handler for unmatched API routes
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API endpoint not found',
    path: req.path,
    method: req.method,
    message: 'The requested API endpoint does not exist. Use /health for server status.',
  });
});

// Serve frontend for all non-API routes (client-side routing)
// Only applies when frontend is built; otherwise return 404
app.get('*', (req, res) => {
  // Try to serve frontend if it exists
  if (!frontendExists) {
    return res.status(404).json({
      error: 'Not found',
      message: 'Frontend build not found. API is available at /health or /api/*',
    });
  }

  const indexPath = path.join(frontendBuildPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// WebSocket - require JWT (same as HTTP API)
io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);

  // Setup socket event handlers
  setupSocketHandlers(socket, io, logger);

  // Handle disconnect
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
  });

  // Handle errors
  socket.on('error', (error) => {
    logger.error(`Socket error: ${error.message}`);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Server error: ${err.message}`);
  res.status(500).json({
    error: 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// Start server
async function startServer() {
  try {
    // Connect to MongoDB
    await Database.connect(MONGODB_URI);

    // Initialize and verify tokens from database
    logger.info('Initializing tokens from database...');
    const tokenResults = await initializeTokensFromDatabase();

    // Handles of in-process agents, so graceful shutdown can stop them (release in-flight
    // tasks immediately) instead of leaving them for the 90s reaper.
    const inProcessAgents = [];
    registerGracefulShutdown({ server, getAgents: () => inProcessAgents });

    server.listen(PORT, async () => {
      startSelfKeepAlive();

      await recordHealthCheck({
        source: 'startup',
        mongoConnected: Database.isConnected(),
        httpStatus: 200,
        message: 'Server started',
      });

      await recoverSearchesOnStartup(io, (search, selectedToken) => {
        quickSearchRoutes.executeSearchInBackground(search, selectedToken, io);
      });

      // Agent system: manager control loops (reaper + rollup) always run here.
      startManager(io);

      // Phase 0: run search agents IN-PROCESS (no separate deploy). Set
      // RUN_INPROCESS_AGENTS=false once you run agents as separate processes (npm run agent).
      if (process.env.RUN_INPROCESS_AGENTS !== 'false') {
        const n = Math.max(1, parseInt(process.env.INPROCESS_AGENT_COUNT || '1', 10));
        for (let i = 0; i < n; i++) {
          startAgent({ ordinal: i })
            .then((a) => inProcessAgents.push(a))
            .catch((e) => logger.error(`Failed to start in-process agent: ${e.message}`));
        }
        logger.info(`Started ${n} in-process search agent(s)`);
      }

      logger.info(`================================`);
      logger.info(`Server running on port ${PORT}`);
      logger.info(`MongoDB connected to ${MONGODB_URI}`);
      if (tokenResults.length > 0) {
        logger.info(`Verified ${tokenResults.length} token(s) from database`);
      } else {
        logger.warn(`No active tokens in database. Add tokens via Web UI (http://localhost:${PORT})`);
      }
      logger.info(`Web UI available at http://localhost:${PORT}`);
      logger.info(`WebSocket support enabled`);
      logger.info(
        `Search recovery: AUTO_RESUME_SEARCHES=${process.env.AUTO_RESUME_SEARCHES === 'true' ? 'on' : 'off'}`
      );
      logger.info(`API Endpoints:`);
      logger.info(`  GET    /health                  - Service health check (public)`);
      logger.info(`  GET    /health/status           - Current alive/dead summary`);
      logger.info(`  GET    /health/logs             - Health check history`);
      logger.info(`  POST   /api/tokens              - Add new token`);
      logger.info(`  GET    /api/tokens              - List all tokens`);
      logger.info(`  DELETE /api/tokens/:id          - Delete token`);
      logger.info(`  PATCH  /api/tokens/:id          - Update token (email, priority)`);
      logger.info(`  GET    /api/tokens/select/best  - Get best available token`);
      logger.info(`  POST   /api/tokens/check/all    - Check all token health`);
      logger.info(`================================`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

startServer();

module.exports = { app, server, io };
