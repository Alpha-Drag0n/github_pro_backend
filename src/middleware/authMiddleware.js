/**
 * Authentication Middleware
 * JWT verification and authorization
 */

const jwt = require('jsonwebtoken');
const Logger = require('../utils/logger');

const logger = new Logger();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * Middleware to verify JWT token
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'No token provided',
      });
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        logger.error(`Token verification failed: ${err.message}`);
        return res.status(401).json({
          error: 'Invalid or expired token',
        });
      }

      // Attach user info to request
      req.userId = decoded.userId;
      req.username = decoded.username;
      req.userRole = decoded.role;
      next();
    });
  } catch (error) {
    logger.error(`Authentication error: ${error.message}`);
    res.status(500).json({
      error: 'Authentication failed',
    });
  }
};

/**
 * Middleware to check if user is admin
 */
const authorize = (requiredRole = 'admin') => {
  return (req, res, next) => {
    if (!req.userRole || req.userRole !== requiredRole) {
      return res.status(403).json({
        error: 'Access denied. Admin role required.',
      });
    }
    next();
  };
};

module.exports = {
  authenticate,
  authorize,
};
