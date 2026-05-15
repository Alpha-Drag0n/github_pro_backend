/**
 * Socket.io JWT authentication middleware
 */

const jwt = require('jsonwebtoken');
const Logger = require('../utils/logger');

const logger = new Logger();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function socketAuthMiddleware(socket, next) {
  try {
    const raw =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization ||
      socket.handshake.query?.token;

    if (!raw) {
      return next(new Error('Authentication required'));
    }

    const token = raw.startsWith('Bearer ') ? raw.substring(7) : raw;

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        logger.error(`Socket auth failed: ${err.message}`);
        return next(new Error('Invalid or expired token'));
      }

      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.userRole = decoded.role;
      next();
    });
  } catch (error) {
    logger.error(`Socket auth error: ${error.message}`);
    next(new Error('Authentication failed'));
  }
}

module.exports = socketAuthMiddleware;
