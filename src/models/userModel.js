/**
 * GitHub User Model
 * Stores extracted user data
 */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    index: true,
  },
  displayName: String,
  name: String,
  githubUrl: String,
  avatar_url: String,
  bio: String,
  company: String,
  blog: String,
  location: String,
  followers: Number,
  following: Number,
  public_repos: Number,
  readme: String,
  emails: [String],
  emailMetadata: [
    {
      email: String,
      source: String, // 'commits', 'bio', 'readme'
      lastUsed: Date,
    },
  ],
  searchId: String, // Reference to the search that found this user
  foundIn: {
    location: String,
    year: Number,
  },
  github_created_at: Date, // When user created GitHub account
  github_updated_at: Date, // When user profile was last updated
  extractedAt: {
    type: Date,
    default: new Date(),
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

// Create indexes for better query performance
userSchema.index({ username: 1, searchId: 1 }, { unique: true });
userSchema.index({ 'foundIn.location': 1, 'foundIn.year': 1 });

module.exports = mongoose.model('User', userSchema);
