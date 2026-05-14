/**
 * Admin Routes
 * User profile management for administrators
 */

const express = require('express');
const router = express.Router();
const Profile = require('../models/profileModel');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const Logger = require('../utils/logger');

const logger = new Logger();

/**
 * GET /api/admin/profiles
 * Get all user profiles (admin only)
 */
router.get('/profiles', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const skip = (page - 1) * limit;

    const query = search
      ? {
          $or: [
            { username: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
          ],
        }
      : {};

    const total = await Profile.countDocuments(query);
    const profiles = await Profile.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.status(200).json({
      profiles,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`Get profiles error: ${error.message}`);
    res.status(500).json({
      error: 'Error fetching profiles',
    });
  }
});

/**
 * GET /api/admin/profiles/:userId
 * Get specific user profile (admin only)
 */
router.get('/profiles/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await Profile.findById(req.params.userId).select('-password');

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    res.status(200).json({
      user,
    });
  } catch (error) {
    logger.error(`Get profile error: ${error.message}`);
    res.status(500).json({
      error: 'Error fetching profile',
    });
  }
});

/**
 * PUT /api/admin/profiles/:userId
 * Update user profile (admin only)
 */
router.put('/profiles/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { firstName, lastName, bio, avatar, role, isActive, isVerified } = req.body;

    const user = await Profile.findByIdAndUpdate(
      req.params.userId,
      {
        firstName,
        lastName,
        bio,
        avatar,
        role,
        isActive,
        isVerified,
      },
      { new: true, runValidators: true }
    ).select('-password');

    logger.log(`Admin updated profile: ${user.username}`);

    res.status(200).json({
      message: 'Profile updated successfully',
      user,
    });
  } catch (error) {
    logger.error(`Update profile error: ${error.message}`);
    res.status(500).json({
      error: 'Error updating profile',
    });
  }
});

/**
 * PATCH /api/admin/profiles/:userId/role
 * Change user role (admin only)
 */
router.patch('/profiles/:userId/role', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
      });
    }

    const user = await Profile.findByIdAndUpdate(
      req.params.userId,
      { role },
      { new: true }
    ).select('-password');

    logger.log(`Admin changed role for ${user.username} to ${role}`);

    res.status(200).json({
      message: 'Role updated successfully',
      user,
    });
  } catch (error) {
    logger.error(`Change role error: ${error.message}`);
    res.status(500).json({
      error: 'Error changing role',
    });
  }
});

/**
 * PATCH /api/admin/profiles/:userId/status
 * Toggle user active status (admin only)
 */
router.patch('/profiles/:userId/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { isActive } = req.body;

    const user = await Profile.findByIdAndUpdate(
      req.params.userId,
      { isActive },
      { new: true }
    ).select('-password');

    logger.log(`Admin changed status for ${user.username} to ${isActive}`);

    res.status(200).json({
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user,
    });
  } catch (error) {
    logger.error(`Change status error: ${error.message}`);
    res.status(500).json({
      error: 'Error changing status',
    });
  }
});

/**
 * DELETE /api/admin/profiles/:userId
 * Delete user profile (admin only)
 */
router.delete('/profiles/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await Profile.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = await Profile.countDocuments({ role: 'admin' });
      if (adminCount === 1) {
        return res.status(403).json({
          error: 'Cannot delete the last admin',
        });
      }
    }

    await Profile.findByIdAndDelete(req.params.userId);

    logger.log(`Admin deleted profile: ${user.username}`);

    res.status(200).json({
      message: 'User deleted successfully',
    });
  } catch (error) {
    logger.error(`Delete profile error: ${error.message}`);
    res.status(500).json({
      error: 'Error deleting profile',
    });
  }
});

/**
 * GET /api/admin/stats
 * Get admin statistics (admin only)
 */
router.get('/stats', authenticate, authorize('admin'), async (req, res) => {
  try {
    const totalUsers = await Profile.countDocuments();
    const totalAdmins = await Profile.countDocuments({ role: 'admin' });
    const activeUsers = await Profile.countDocuments({ isActive: true });
    const verifiedUsers = await Profile.countDocuments({ isVerified: true });

    const recentUsers = await Profile.find()
      .select('username email createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      stats: {
        totalUsers,
        totalAdmins,
        activeUsers,
        verifiedUsers,
        inactiveUsers: totalUsers - activeUsers,
      },
      recentUsers,
    });
  } catch (error) {
    logger.error(`Get stats error: ${error.message}`);
    res.status(500).json({
      error: 'Error fetching statistics',
    });
  }
});

module.exports = router;
