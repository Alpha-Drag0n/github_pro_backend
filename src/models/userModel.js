/**
 * GitHub User Model
 * Stores extracted user data with enhanced contact and social profile extraction
 * Backward compatible - existing documents preserved
 */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // ========== CORE GitHub Profile Info (EXISTING - unchanged) ==========
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
  location: String, // From GitHub profile bio
  followers: Number,
  following: Number,
  public_repos: Number,
  github_created_at: Date,
  github_updated_at: Date,

  // ========== EXISTING Email Fields (backward compatibility) ==========
  readme: String, // GitHub profile README
  emails: [String], // Flat list (legacy, use contactInfo.emails for new data)
  emailMetadata: [
    {
      email: String,
      source: String, // 'commits', 'bio', 'readme'
      lastUsed: Date,
    },
  ],

  // ========== NEW: Contact Information (from repository mining) ==========
  contactInfo: {
    emails: [
      {
        email: String,
        sources: [String], // repo names where found
        confidence: String, // 'high', 'medium', 'low'
      },
    ],
    discord: [
      {
        handle: String,
        sources: [String],
      },
    ],
    telegram: [
      {
        username: String,
        sources: [String],
      },
    ],
    whatsapp: [
      {
        phone: String,
        sources: [String],
      },
    ],
    phone: [
      {
        number: String,
        country: String,
        sources: [String],
        confidence: String,
      },
    ],
  },

  // ========== NEW: Social Profiles (from repository mining) ==========
  socialProfiles: {
    linkedin: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
    facebook: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
    x: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
    youtube: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
    instagram: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
    tiktok: [
      {
        url: String,
        handle: String,
        sources: [String],
      },
    ],
  },

  // ========== NEW: Repository Mining Data ==========
  repositoryMining: {
    repositoriesChecked: { type: Number, default: 0 }, // Total repos scanned
    repositoriesWithData: { type: Number, default: 0 }, // Repos with contact/social info
    lastMiningDate: Date,
    miningInProgress: { type: Boolean, default: false },
    minedRepositories: [
      {
        repoName: String,
        repoUrl: String,
        readmeParsed: Boolean,
        descriptionParsed: Boolean,
        lastUpdated: Date,
        dataExtracted: {
          hasContactInfo: Boolean,
          hasSocialProfiles: Boolean,
          hasLocation: Boolean,
        },
      },
    ],
    locations: [
      {
        location: String,
        sources: [String], // repo names
        frequency: Number,
      },
    ],
  },

  // ========== Search Tracking ==========
  searchId: String, // Reference to the search that found this user
  foundIn: {
    location: String,
    year: Number,
  },
  searchIterationHistory: [
    {
      searchId: mongoose.Schema.Types.ObjectId, // Reference to the IterativeSearch that found this user
      iterationNumber: Number,
      searchDate: Date,
      excludedLocations: [String],
      resultPosition: Number, // Position in search results (1-1000)
    },
  ],

  // ========== Timestamps ==========
  extractedAt: {
    type: Date,
    default: () => new Date(),
  },
  createdAt: {
    type: Date,
    default: () => new Date(),
  },
  updatedAt: {
    type: Date,
    default: () => new Date(),
  },
});

// ========== Indexes for Performance ==========
userSchema.index({ username: 1, searchId: 1 }, { unique: true });
userSchema.index({ 'foundIn.location': 1, 'foundIn.year': 1 });
userSchema.index({ 'repositoryMining.lastMiningDate': 1 });
userSchema.index({ 'contactInfo.emails.email': 1 });
userSchema.index({ 'contactInfo.phones.number': 1 });
userSchema.index({ 'socialProfiles.linkedin.handle': 1 });
userSchema.index({ 'repositoryMining.locations.location': 1 });
userSchema.index({ 'repositoryMining.miningInProgress': 1 });

// ========== Pre-save Hook for updatedAt ==========
userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
