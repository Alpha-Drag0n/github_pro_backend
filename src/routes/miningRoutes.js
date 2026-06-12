/**
 * Mining Routes
 * Handles repository mining and contact extraction endpoints
 */

const express = require('express');
const router = express.Router();
const User = require('../models/userModel');
const repositoryMiningService = require('../services/repositoryMiningService');
const requestLogService = require('../services/requestLogService');
const logger = require('../utils/logger');

/**
 * POST /api/mining/start
 * Start mining repositories for selected users
 */
router.post('/start', async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array is required' });
    }

    logger.log(`[Mining Route] Starting mining for ${userIds.length} users`);

    const miningResults = {
      users: [],
      summary: {
        totalUsers: userIds.length,
        successfulMines: 0,
        failedMines: 0,
        totalContactsFound: 0,
        totalSocialProfilesFound: 0,
      },
    };

    // Mine each user
    for (const userId of userIds) {
      try {
        // Find user by ID or username
        let user = await User.findById(userId);
        if (!user) {
          user = await User.findOne({ username: userId });
        }

        if (!user) {
          logger.log(`[Mining Route] User not found: ${userId}`, 'warn');
          miningResults.summary.failedMines++;
          continue;
        }

        logger.log(`[Mining Route] Mining repositories for: ${user.username}`);

        // Mark as mining in progress
        user.repositoryMining = user.repositoryMining || {};
        user.repositoryMining.miningInProgress = true;
        await user.save();

        // Mine repositories
        const miningData = await repositoryMiningService.mineUserRepositories(
          user.username,
          user._id
        );

        // Log mining operation
        await requestLogService.logDBOperation({
          serverType: 'db',
          endpoint: 'User.updateOne',
          purpose: 'update',
          searchId: user.searchId,
          parameters: {
            userId: user._id,
            repositoriesMined: miningData.repositoriesChecked,
            dataSources: miningData.repositoriesWithData,
          },
        });

        // Merge mining data into user
        user.contactInfo = miningData.contactInfo;
        user.socialProfiles = miningData.socialProfiles;
        user.repositoryMining = {
          ...user.repositoryMining,
          ...miningData,
          miningInProgress: false,
        };

        // Save updated user
        await user.save();

        // Count results
        const contactCount =
          (miningData.contactInfo.emails?.length || 0) +
          (miningData.contactInfo.discord?.length || 0) +
          (miningData.contactInfo.telegram?.length || 0) +
          (miningData.contactInfo.whatsapp?.length || 0) +
          (miningData.contactInfo.phone?.length || 0);

        const socialCount = Object.values(miningData.socialProfiles).reduce(
          (sum, arr) => sum + (arr?.length || 0),
          0
        );

        miningResults.users.push(user);
        miningResults.summary.successfulMines++;
        miningResults.summary.totalContactsFound += contactCount;
        miningResults.summary.totalSocialProfilesFound += socialCount;

        logger.log(
          `[Mining Route] Mining complete for ${user.username}: ${miningData.repositoriesChecked} repos, ${miningData.repositoriesWithData} with data`
        );
      } catch (error) {
        logger.log(`[Mining Route] Error mining user ${userId}: ${error.message}`, 'error');
        miningResults.summary.failedMines++;
      }
    }

    logger.log(
      `[Mining Route] Mining batch complete: ${miningResults.summary.successfulMines} successful, ${miningResults.summary.failedMines} failed`
    );

    res.json(miningResults);
  } catch (error) {
    logger.log(`[Mining Route] Fatal error: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mining/cancel/:userId
 * Cancel mining operation for a user
 */
router.post('/cancel/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.repositoryMining = user.repositoryMining || {};
    user.repositoryMining.miningInProgress = false;
    await user.save();

    logger.log(`[Mining Route] Cancelled mining for user: ${user.username}`);
    res.json({ message: 'Mining cancelled' });
  } catch (error) {
    logger.log(`[Mining Route] Error cancelling mining: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mining/status/:userId
 * Get current mining status for a user
 */
router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const status = {
      username: user.username,
      miningInProgress: user.repositoryMining?.miningInProgress || false,
      lastMiningDate: user.repositoryMining?.lastMiningDate || null,
      repositoriesChecked: user.repositoryMining?.repositoriesChecked || 0,
      repositoriesWithData: user.repositoryMining?.repositoriesWithData || 0,
      contactInfoCount: {
        emails: user.contactInfo?.emails?.length || 0,
        phones: user.contactInfo?.phone?.length || 0,
        discord: user.contactInfo?.discord?.length || 0,
        telegram: user.contactInfo?.telegram?.length || 0,
        whatsapp: user.contactInfo?.whatsapp?.length || 0,
      },
      socialProfilesCount: {
        linkedin: user.socialProfiles?.linkedin?.length || 0,
        facebook: user.socialProfiles?.facebook?.length || 0,
        x: user.socialProfiles?.x?.length || 0,
        youtube: user.socialProfiles?.youtube?.length || 0,
        instagram: user.socialProfiles?.instagram?.length || 0,
        tiktok: user.socialProfiles?.tiktok?.length || 0,
      },
    };

    res.json(status);
  } catch (error) {
    logger.log(`[Mining Route] Error getting mining status: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mining/results/:userId
 * Get mining results for a user
 */
router.get('/results/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select(
      'username avatar_url contactInfo socialProfiles repositoryMining'
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      username: user.username,
      avatar_url: user.avatar_url,
      contactInfo: user.contactInfo || {},
      socialProfiles: user.socialProfiles || {},
      repositoryMining: user.repositoryMining || {},
    });
  } catch (error) {
    logger.log(`[Mining Route] Error getting mining results: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/mining/clear/:userId
 * Clear mining data for a user (reset)
 */
router.delete('/clear/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.contactInfo = {
      emails: [],
      discord: [],
      telegram: [],
      whatsapp: [],
      phone: [],
    };

    user.socialProfiles = {
      linkedin: [],
      facebook: [],
      x: [],
      youtube: [],
      instagram: [],
      tiktok: [],
    };

    user.repositoryMining = {
      repositoriesChecked: 0,
      repositoriesWithData: 0,
      minedRepositories: [],
      locations: [],
    };

    await user.save();

    logger.log(`[Mining Route] Cleared mining data for user: ${user.username}`);
    res.json({ message: 'Mining data cleared' });
  } catch (error) {
    logger.log(`[Mining Route] Error clearing mining data: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
