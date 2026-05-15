/**
 * Express Server Setup with WebSocket Support
 * Main backend server with API routes and real-time updates via Socket.io
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('./utils/database');
const Logger = require('./utils/logger');
const { initializeTokensFromDatabase } = require('./utils/tokenInitializer');
const tokenRoutes = require('./routes/tokenRoutes');
const searchRoutes = require('./routes/searchRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const healthRoutes = require('./routes/healthRoutes');
const { authenticate } = require('./middleware/authMiddleware');
const socketAuthMiddleware = require('./middleware/socketAuthMiddleware');
const setupSocketHandlers = require('./routes/socketRoutes');
const { recoverSearchesOnStartup } = require('./services/searchRecovery');
const { registerGracefulShutdown } = require('./services/gracefulShutdown');

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

// Serve frontend build in production
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Public health check (no auth)
app.use('/health', healthRoutes);

// Auth routes (signup/signin public; rest protected per-route)
app.use('/api/auth', authRoutes);

// Admin routes (protected per-route)
app.use('/api/admin', adminRoutes);

// Protected API routes
app.use('/api', authenticate, tokenRoutes);
app.use('/api', authenticate, searchRoutes);

// Serve frontend for all non-API routes (client-side routing)
app.get('*', (req, res) => {
  const indexPath = path.join(frontendBuildPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ message: 'Frontend not built. Run: npm run build in frontend/' });
    }
  });
});

// WebSocket — require JWT (same as HTTP API)
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

    registerGracefulShutdown({ server });

    await recoverSearchesOnStartup(io, (search, selectedToken) => {
      searchRoutes.executeSearchInBackground(search, selectedToken, io);
    });

    server.listen(PORT, () => {
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
