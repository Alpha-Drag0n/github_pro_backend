/**
 * Username Lookup Routes
 * Look up stored users (the User collection) by a list of usernames. Each username
 * is matched against all of its stored records, which are merged into one profile.
 */

const express = require('express');
const router = express.Router();
const Logger = require('../utils/logger');
const { lookupUsernames } = require('../services/usernameLookupService');

const logger = new Logger();

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

module.exports = router;
