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
  publicEmail: String, // GitHub profile's public email field (structured; distinct from mined emails)
  twitter_username: String, // GitHub profile's dedicated X/Twitter handle (structured)
  location: String, // From GitHub profile (verbatim) — kept for backward compatibility
  // Structured location: the profile location AND locations self-reported in repo
  // READMEs/descriptions, each with the exact source URL, how it was found, and confidence.
  locationInfo: {
    profile: String, // profile.location
    discovered: [
      {
        value: String, // e.g. "Berlin, Germany"
        city: String,
        country: String,
        sources: [String], // source labels: "<repoUrl>#readme", "<repoUrl> (description)", "<profileUrl> (bio|blog|company)"
        method: { type: String }, // 'marker' | 'flag' | 'ner'
        confidence: { type: String }, // 'high' | 'medium' | 'low'
      },
    ],
    best: String, // resolved single value (profile if present, else best discovered)
    // RocketReach enrichment — location resolved from the user's LinkedIn URL via the
    // RocketReach Chrome extension. Kept isolated from `discovered[]` so it never mixes
    // with repo-mined data and can be displayed/exported on its own.
    rocketreach: {
      value: String, // location string from RocketReach, e.g. "San Francisco, California, US" ('' when not found)
      linkedinUrl: String, // the LinkedIn URL that was looked up
      status: { type: String }, // 'found' | 'not_found' | 'error' (any non-empty status means "processed" → skipped on resume)
      updatedAt: Date,
    },
  },
  followers: Number,
  following: Number,
  public_repos: Number,
  github_created_at: Date,
  github_updated_at: Date,

  // ========== LinkedIn Enrichment (from Apify LinkedIn actor) ==========
  // Populated by enriching a user's LinkedIn URL(s) (socialProfiles.linkedin[].url) through the
  // Apify LinkedIn profile actor. A user may have SEVERAL LinkedIn URLs, so every URL is checked
  // and each result is stored in `profiles[]`. `status` is a roll-up over them ('found' if any URL
  // resolved) used by filters/stats/resume. Its own sub-document so it never mixes with GitHub data.
  linkedinInfo: {
    status: { type: String }, // roll-up: 'found' | 'not_found' | 'error' (non-empty = processed → skip on resume)
    profiles: [
      {
        sourceUrl: String, // the LinkedIn URL we queried (from socialProfiles)
        status: String, // 'found' | 'not_found' | 'error' for this specific URL
        fullName: String,
        profileUrl: String, // canonical LinkedIn URL returned by the actor
        headline: String,
        location: {
          linkedinText: String, // verbatim LinkedIn location label
          countryCode: String,
          parsed: {
            text: String,
            countryCode: String,
            regionCode: String,
            country: String,
            countryFull: String,
            state: String,
            city: String,
          },
        },
        connectionsCount: Number,
        followerCount: Number,
      },
    ],
    updatedAt: Date,
  },

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

  // ========== Outreach marking (manual — set by the operator from the Deep Search UI) ==========
  // Two independent manual flags toggled per profile from the Deep Search overview:
  //   markedUS → operator has judged this profile to be US-based
  //   sent     → outreach has been sent to this profile
  // Kept in their own sub-document so they never mix with mined/enriched data. Each flag
  // carries a timestamp recording when it was last flipped on (cleared when toggled off).
  outreach: {
    markedUS: { type: Boolean, default: false },
    markedUSAt: Date,
    sent: { type: Boolean, default: false },
    sentAt: Date,
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
userSchema.index({ 'contactInfo.phone.number': 1 });
userSchema.index({ 'socialProfiles.linkedin.handle': 1 });
userSchema.index({ 'repositoryMining.locations.location': 1 });
userSchema.index({ 'repositoryMining.miningInProgress': 1 });
userSchema.index({ 'linkedinInfo.status': 1 });
userSchema.index({ 'linkedinInfo.profiles.location.parsed.countryCode': 1 });
userSchema.index({ 'outreach.markedUS': 1 });
userSchema.index({ 'outreach.sent': 1 });

// ========== Pre-save Hook for updatedAt ==========
userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
