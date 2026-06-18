/**
 * API Routes for Token Management
 */

const express = require('express');
const router = express.Router();
const Token = require('../models/tokenModel');
const TokenManager = require('../services/tokenManager');
const TokenSelector = require('../services/tokenSelector');
const Logger = require('../utils/logger');

const logger = new Logger();
const tokenManager = new TokenManager();

/**
 * Get all tokens (without actual token values)
 */
router.get('/tokens', async (req, res) => {
  try {
    const tokens = await Token.find({}, '-token').sort({ priority: -1, createdAt: -1 });
    res.json(tokens);
  } catch (error) {
    logger.error(`Error fetching tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
});

/**
 * Get token by ID
 */
router.get('/tokens/:id', async (req, res) => {
  try {
    const token = await Token.findById(req.params.id, '-token');
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json(token);
  } catch (error) {
    logger.error(`Error fetching token: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch token' });
  }
});

/**
 * Add new token with extended fields
 * Body: { token, name, email, priority }
 */
router.post('/tokens', async (req, res) => {
  try {
    const { token, name, email, priority } = req.body;

    if (!token || !name) {
      return res.status(400).json({ error: 'Token and name are required' });
    }

    // Check if token already exists
    const existing = await Token.findOne({ token });
    if (existing) {
      return res.status(400).json({ error: 'Token already exists' });
    }

    // Create new token with all provided fields
    const newToken = new Token({
      token,
      name,
      email: email || null,
      priority: priority !== undefined ? priority : 0,
      isActive: true,
      status: 'active',
    });

    // Verify token with GitHub API
    const verified = await tokenManager.verifyToken(newToken.token);
    if (!verified) {
      return res.status(400).json({ error: 'Invalid GitHub token' });
    }

    await newToken.save();

    res.status(201).json({
      id: newToken._id,
      name: newToken.name,
      email: newToken.email,
      status: newToken.status,
      priority: newToken.priority,
      createdAt: newToken.createdAt,
    });
  } catch (error) {
    logger.error(`Error adding token: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to add token' });
  }
});

/**
 * Delete token
 */
router.delete('/tokens/:id', async (req, res) => {
  try {
    const token = await Token.findByIdAndDelete(req.params.id);
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    logger.info(`Token deleted: ${token.name}`);
    res.json({ message: 'Token deleted successfully' });
  } catch (error) {
    logger.error(`Error deleting token: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete token' });
  }
});

/**
 * Update token (email, priority, status, etc.)
 */
router.patch('/tokens/:id', async (req, res) => {
  try {
    const { email, priority, isActive, status, disabled } = req.body;
    const token = await Token.findById(req.params.id);

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    if (email !== undefined) token.email = email;
    if (priority !== undefined) token.priority = priority;
    if (status !== undefined) token.status = status;
    if (disabled !== undefined) token.disabled = disabled;
    if (isActive !== undefined) {
      token.isActive = isActive;
      if (isActive) {
        // Re-enabling also lifts an auto-quarantine (401 → disabled) and any active cooldown,
        // and resets the error streak — so the token actually re-enters the agent rotation.
        token.disabled = false;
        token.cooldownUntil = null;
        token.consecutiveErrors = 0;
        token.failureReason = null;
      }
    }

    await token.save();
    res.json({
      id: token._id,
      name: token.name,
      email: token.email,
      priority: token.priority,
      status: token.status,
      isActive: token.isActive,
      disabled: token.disabled,
    });
  } catch (error) {
    logger.error(`Error updating token: ${error.message}`);
    res.status(500).json({ error: 'Failed to update token' });
  }
});

/**
 * Check all tokens health
 */
router.post('/tokens/check/all', async (req, res) => {
  try {
    const results = await tokenManager.checkAllTokens();
    res.json({
      checked: results.length,
      results: results.map(t => ({
        id: t._id,
        name: t.name,
        status: t.status,
        requestsRemaining: t.requestsRemaining,
        requestsLimit: t.requestsLimit,
        lastChecked: t.lastChecked,
      })),
    });
  } catch (error) {
    logger.error(`Error checking tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to check tokens' });
  }
});

/**
 * Get first token in createdAt order (start of rotation)
 */
router.get('/tokens/select/best', async (req, res) => {
  try {
    const token = await TokenSelector.selectFirstToken();
    if (!token) {
      return res.status(404).json({ error: 'No GitHub tokens in database' });
    }

    res.json({
      id: token._id,
      name: token.name,
      email: token.email,
      requestsRemaining: token.requestsRemaining,
      requestsLimit: token.requestsLimit,
      priority: token.priority,
    });
  } catch (error) {
    logger.error(`Error selecting best token: ${error.message}`);
    res.status(500).json({ error: 'Failed to select token' });
  }
});

/**
 * Get all available tokens
 */
router.get('/tokens/available/list', async (req, res) => {
  try {
    const tokens = await TokenSelector.getAllAvailableTokens();
    res.json({
      available: tokens.length,
      tokens: tokens.map(t => ({
        id: t._id,
        name: t.name,
        email: t.email,
        status: t.status,
        requestsRemaining: t.requestsRemaining,
        priority: t.priority,
      })),
    });
  } catch (error) {
    logger.error(`Error listing available tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to list available tokens' });
  }
});

/**
 * Get token status summary
 */
router.get('/tokens/status/summary', async (req, res) => {
  try {
    const summary = await TokenSelector.getTokenStatusSummary();
    if (!summary) {
      return res.status(500).json({ error: 'Failed to get summary' });
    }

    res.json(summary);
  } catch (error) {
    logger.error(`Error getting token summary: ${error.message}`);
    res.status(500).json({ error: 'Failed to get token summary' });
  }
});

/**
 * Get current active token status
 */
router.get('/tokens/current/status', async (req, res) => {
  try {
    const current = await Token.findOne({ status: 'active', isActive: true }, '-token');
    if (!current) {
      return res.status(404).json({ error: 'No active token available' });
    }

    res.json({
      id: current._id,
      name: current.name,
      email: current.email,
      requestsRemaining: current.requestsRemaining,
      requestsLimit: current.requestsLimit,
      resetTime: current.resetTime,
      successCount: current.successCount,
      errorCount: current.errorCount,
    });
  } catch (error) {
    logger.error(`Error getting current token: ${error.message}`);
    res.status(500).json({ error: 'Failed to get current token' });
  }
});

module.exports = router;
