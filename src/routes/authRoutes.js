/**
 * Authentication Routes
 * Sign up, sign in, and session management
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Profile = require('../models/profileModel');
const { authenticate } = require('../middleware/authMiddleware');
const Logger = require('../utils/logger');

const logger = new Logger();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * POST /api/auth/signup
 * Register a new user
 */
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password, firstName, lastName } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email, and password are required',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters',
      });
    }

    // Check if user already exists
    const existingUser = await Profile.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'Username or email already exists',
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const newUser = new Profile({
      username,
      email,
      password: hashedPassword,
      firstName,
      lastName,
    });

    await newUser.save();

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: newUser._id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.log(`New user registered: ${username}`);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role,
      },
    });
  } catch (error) {
    logger.error(`Sign up error: ${error.message}`);
    res.status(500).json({
      error: 'Error registering user',
    });
  }
});

/**
 * POST /api/auth/signin
 * Login user with username/email and password
 */
router.post('/signin', async (req, res) => {
  try {
    const { username, password } = req.body;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = req.ip || req.connection.remoteAddress;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required',
      });
    }

    // Find user by username or email
    const user = await Profile.findOne({
      $or: [{ username }, { email: username }],
    }).select('+password');

    if (!user) {
      return res.status(401).json({
        error: 'Invalid username or password',
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({
        error: 'User account is inactive',
      });
    }

    // Compare passwords
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Invalid username or password',
      });
    }

    // Update last login and login count
    user.lastLogin = new Date();
    user.loginCount += 1;

    // Add session
    user.sessions.push({
      sessionId: require('uuid').v4(),
      userAgent,
      ipAddress,
    });

    // Keep only last 5 sessions
    if (user.sessions.length > 5) {
      user.sessions.shift();
    }

    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.log(`User logged in: ${user.username}`);

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    logger.error(`Sign in error: ${error.message}`);
    res.status(500).json({
      error: 'Error logging in',
    });
  }
});

/**
 * GET /api/auth/profile
 * Get current user profile (requires authentication)
 */
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await Profile.findById(req.userId).select('-password');

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    res.status(200).json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatar: user.avatar,
        bio: user.bio,
        isVerified: user.isVerified,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    logger.error(`Get profile error: ${error.message}`);
    res.status(500).json({
      error: 'Error fetching profile',
    });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile (requires authentication)
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { firstName, lastName, bio, avatar } = req.body;

    const user = await Profile.findByIdAndUpdate(
      req.userId,
      {
        firstName,
        lastName,
        bio,
        avatar,
      },
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatar: user.avatar,
        bio: user.bio,
      },
    });
  } catch (error) {
    logger.error(`Update profile error: ${error.message}`);
    res.status(500).json({
      error: 'Error updating profile',
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change user password (requires authentication)
 */
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Current password and new password are required',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'New password must be at least 6 characters',
      });
    }

    const user = await Profile.findById(req.userId).select('+password');

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Current password is incorrect',
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    logger.log(`User changed password: ${user.username}`);

    res.status(200).json({
      message: 'Password changed successfully',
    });
  } catch (error) {
    logger.error(`Change password error: ${error.message}`);
    res.status(500).json({
      error: 'Error changing password',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (invalidate session)
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    const user = await Profile.findById(req.userId);

    // Remove current session
    if (user.sessions.length > 0) {
      user.sessions.pop();
      await user.save();
    }

    logger.log(`User logged out: ${user.username}`);

    res.status(200).json({
      message: 'Logout successful',
    });
  } catch (error) {
    logger.error(`Logout error: ${error.message}`);
    res.status(500).json({
      error: 'Error logging out',
    });
  }
});

/**
 * GET /api/auth/sessions
 * Get user sessions (requires authentication)
 */
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const user = await Profile.findById(req.userId);

    res.status(200).json({
      sessions: user.sessions,
    });
  } catch (error) {
    logger.error(`Get sessions error: ${error.message}`);
    res.status(500).json({
      error: 'Error fetching sessions',
    });
  }
});

module.exports = router;
