/**
 * API Routes for Apify Token Management
 * CRUD for the Apify API tokens used by LinkedIn profile enrichment.
 * Token values are never returned to clients (projected out with '-token').
 */

const express = require('express');
const router = express.Router();
const ApifyToken = require('../models/apifyTokenModel');
const apifyService = require('../services/apifyService');
const Logger = require('../utils/logger');

const logger = new Logger();

/** Get all Apify tokens (without the secret value). */
router.get('/apify-tokens', async (req, res) => {
  try {
    const tokens = await ApifyToken.find({}, '-token').sort({ priority: -1, createdAt: -1 });
    res.json(tokens);
  } catch (error) {
    logger.error(`Error fetching Apify tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch Apify tokens' });
  }
});

/**
 * Add a new Apify token.
 * Body: { token, name, priority? } - verified against the Apify API before saving.
 */
router.post('/apify-tokens', async (req, res) => {
  try {
    const { token, name, priority } = req.body || {};
    if (!token || !name) {
      return res.status(400).json({ error: 'Token and name are required' });
    }

    const existing = await ApifyToken.findOne({ token });
    if (existing) {
      return res.status(400).json({ error: 'Token already exists' });
    }

    const { valid, username, reason } = await apifyService.verifyToken(token);
    if (!valid) {
      return res.status(400).json({ error: reason || 'Invalid Apify token' });
    }

    const newToken = new ApifyToken({
      token,
      name,
      apifyUsername: username,
      priority: priority !== undefined ? priority : 0,
      isActive: true,
      status: 'active',
    });
    await newToken.save();

    res.status(201).json({
      id: newToken._id,
      name: newToken.name,
      apifyUsername: newToken.apifyUsername,
      status: newToken.status,
      priority: newToken.priority,
      createdAt: newToken.createdAt,
    });
  } catch (error) {
    logger.error(`Error adding Apify token: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to add Apify token' });
  }
});

/** Update an Apify token (priority / isActive / status). */
router.patch('/apify-tokens/:id', async (req, res) => {
  try {
    const { priority, isActive, status } = req.body || {};
    const token = await ApifyToken.findById(req.params.id);
    if (!token) return res.status(404).json({ error: 'Token not found' });

    if (priority !== undefined) token.priority = priority;
    if (isActive !== undefined) token.isActive = isActive;
    if (status !== undefined) token.status = status;

    await token.save();
    res.json({
      id: token._id,
      name: token.name,
      apifyUsername: token.apifyUsername,
      priority: token.priority,
      status: token.status,
      isActive: token.isActive,
    });
  } catch (error) {
    logger.error(`Error updating Apify token: ${error.message}`);
    res.status(500).json({ error: 'Failed to update Apify token' });
  }
});

/** Delete an Apify token. */
router.delete('/apify-tokens/:id', async (req, res) => {
  try {
    const token = await ApifyToken.findByIdAndDelete(req.params.id);
    if (!token) return res.status(404).json({ error: 'Token not found' });
    logger.info(`Apify token deleted: ${token.name}`);
    res.json({ message: 'Apify token deleted successfully' });
  } catch (error) {
    logger.error(`Error deleting Apify token: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete Apify token' });
  }
});

/** Re-verify a stored Apify token against the Apify API. */
router.post('/apify-tokens/:id/check', async (req, res) => {
  try {
    const token = await ApifyToken.findById(req.params.id);
    if (!token) return res.status(404).json({ error: 'Token not found' });

    const { valid, username, reason } = await apifyService.verifyToken(token.token);
    token.status = valid ? 'active' : 'invalid';
    token.isActive = valid ? token.isActive : false;
    if (valid && username) token.apifyUsername = username;
    if (!valid) token.failureReason = reason;
    await token.save();

    res.json({ id: token._id, name: token.name, status: token.status, valid });
  } catch (error) {
    logger.error(`Error checking Apify token: ${error.message}`);
    res.status(500).json({ error: 'Failed to check Apify token' });
  }
});

module.exports = router;
