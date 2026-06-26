/**
 * Username Lookup Routes
 * Look up stored users (the User collection) by a list of usernames. Each username
 * is matched against all of its stored records, which are merged into one profile.
 */

const express = require('express');
const router = express.Router();
const Logger = require('../utils/logger');
const User = require('../models/userModel');
const { lookupUsernames } = require('../services/usernameLookupService');

const logger = new Logger();

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Look up stored users by a list of usernames; returns one merged profile each.
 * POST /api/user-lookup
 * Body: { usernames: string[] | string }
 */
router.post('/user-lookup', async (req, res) => {
  try {
    const { usernames } = req.body || {};
    const result = await lookupUsernames(usernames);
    logger.info(
      `Username lookup: ${result.stats.processed} requested, ${result.stats.matched} matched ` +
        `(${result.stats.totalRecords} records), ${result.stats.totalEmails} emails`
    );
    res.json(result);
  } catch (error) {
    if (error.code === 'NO_INPUT') {
      return res.status(400).json({ error: error.message });
    }
    logger.error(`Username lookup failed: ${error.message}`);
    res.status(500).json({ error: 'Username lookup failed' });
  }
});

/**
 * Toggle manual outreach flags for EVERY stored record of a username.
 * PATCH /api/user-lookup/:username/flags   Body: { markedUS?: boolean, sent?: boolean }
 * The Username Search page shows one merged profile per username (many records), so a
 * mark is written to ALL of that username's records to stay consistent app-wide.
 */
router.patch('/user-lookup/:username/flags', async (req, res) => {
  try {
    const name = String(req.params.username || '').trim();
    if (!name) return res.status(400).json({ error: 'username required' });

    const { markedUS, sent } = req.body || {};
    const set = {};
    if (typeof markedUS === 'boolean') {
      set['outreach.markedUS'] = markedUS;
      set['outreach.markedUSAt'] = markedUS ? new Date() : null;
    }
    if (typeof sent === 'boolean') {
      set['outreach.sent'] = sent;
      set['outreach.sentAt'] = sent ? new Date() : null;
    }
    if (Object.keys(set).length === 0) {
      return res.status(400).json({ error: 'Provide markedUS and/or sent as booleans' });
    }

    const rx = new RegExp(`^${escapeRegExp(name)}$`, 'i');
    const result = await User.updateMany({ username: { $regex: rx } }, { $set: set });
    if (!result.matchedCount) return res.status(404).json({ error: 'User not found' });

    const outreach = {};
    if (typeof markedUS === 'boolean') { outreach.markedUS = markedUS; outreach.markedUSAt = set['outreach.markedUSAt']; }
    if (typeof sent === 'boolean') { outreach.sent = sent; outreach.sentAt = set['outreach.sentAt']; }

    logger.info(`Username flags: ${name} → ${JSON.stringify(set)} (${result.modifiedCount}/${result.matchedCount} records)`);
    res.json({ message: 'Flags updated', username: name, matched: result.matchedCount, modified: result.modifiedCount, outreach });
  } catch (error) {
    logger.error(`Username flags update failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to update flags' });
  }
});

module.exports = router;
