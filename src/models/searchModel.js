/**
 * Search History Model
 * Tracks all search operations
 */

const mongoose = require('mongoose');

const searchSchema = new mongoose.Schema({
  searchId: {
    type: String,
    required: true,
    unique: true,
  },
  parameters: {
    locations: [String],
    startYear: Number,
    endYear: Number,
    accountType: String,
    followers: {
      type: String,
      default: '<30',
    },
  },
  tokenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Token',
    default: null,
  },
  tokenName: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'paused', 'completed', 'failed', 'awaiting_tokens'],
    default: 'pending',
  },
  progress: {
    current: {
      type: Number,
      default: 0,
    },
    total: {
      type: Number,
      default: 0,
    },
    percentage: {
      type: Number,
      default: 0,
    },
    completedIndices: {
      type: [Number],
      default: [],
    },
  },
  results: {
    totalUsersFound: {
      type: Number,
      default: 0,
    },
    totalUsersProcessed: {
      type: Number,
      default: 0,
    },
    totalEmailsExtracted: {
      type: Number,
      default: 0,
    },
  },
  searchLog: [
    {
      location: String,
      year: Number,
      date: Date,
      usersFound: Number,
      status: String,
      error: String,
    },
  ],
  outputFiles: {
    users: String,
    searchLog: String,
    summary: String,
  },
  error: String,
  startedAt: {
    type: Date,
    default: new Date(),
  },
  pausedAt: Date,
  resumedAt: Date,
  completedAt: Date,
  duration: Number, // in milliseconds
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

module.exports = mongoose.model('Search', searchSchema);
