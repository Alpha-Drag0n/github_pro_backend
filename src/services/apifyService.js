/**
 * Apify Service
 * Thin wrapper around the Apify REST API for LinkedIn profile enrichment.
 *
 * We talk to Apify over plain HTTP (axios — already a dependency) instead of the
 * `apify-client` SDK to keep the dependency surface small and consistent with
 * `githubClient`. The LinkedIn actor is invoked synchronously via
 * `run-sync-get-dataset-items`, which runs the actor and returns its dataset
 * rows in a single request.
 */

const axios = require('axios');
const ApifyToken = require('../models/apifyTokenModel');
const Logger = require('../utils/logger');

const logger = new Logger();

// LinkedIn profile-scraper actor. Input shape: { queries: [profileUrl, ...], countryFilter: [] }.
const LINKEDIN_ACTOR_ID = process.env.APIFY_LINKEDIN_ACTOR_ID || 'MgJeZOsv2i4WkCqDy';
const APIFY_BASE = 'https://api.apify.com/v2';
// LinkedIn scraping is slow — allow generous time for a synchronous run.
const RUN_TIMEOUT_MS = parseInt(process.env.APIFY_RUN_TIMEOUT_MS, 10) || 300000;

/**
 * Verify an Apify token by calling /users/me.
 * Returns { valid, username } — never throws.
 */
async function verifyToken(token) {
  try {
    const res = await axios.get(`${APIFY_BASE}/users/me`, {
      params: { token },
      timeout: 15000,
    });
    const username = res.data?.data?.username || null;
    return { valid: true, username };
  } catch (error) {
    const reason = error.response?.status === 401 ? 'Invalid Apify token' : error.message;
    return { valid: false, reason };
  }
}

/**
 * Pick the active Apify token to use for a run.
 * Highest priority first, then oldest (stable rotation start). Falls back to the
 * APIFY_API_TOKEN env var so enrichment still works before any DB token is added.
 * Returns a token document (or a synthetic { token } when only the env var exists).
 */
async function selectToken() {
  const doc = await ApifyToken.findOne({ isActive: true, status: 'active' }).sort({
    priority: -1,
    createdAt: 1,
  });
  if (doc) return doc;
  if (process.env.APIFY_API_TOKEN) {
    return { token: process.env.APIFY_API_TOKEN, _envOnly: true };
  }
  return null;
}

/**
 * Normalize a LinkedIn URL for matching: lowercase, drop protocol/www/query/hash
 * and any trailing slash, collapse linkedin.com/in vs www.linkedin.com/in.
 */
function normalizeLinkedInUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Map a single Apify dataset item to our `linkedinInfo` sub-document shape.
 * The actor returns rows positionally aligned with the input queries; rows for
 * companies / failed lookups come back as all-null. `queriedUrl` is the URL we
 * asked for, preserved so we can join the row back to the right user.
 */
function mapItemToLinkedInInfo(item, queriedUrl) {
  const found = !!(item && item.profileUrl && item.fullName);
  const loc = (item && item.location) || null;
  const parsed = (loc && loc.parsed) || {};

  return {
    fullName: item?.fullName || null,
    profileUrl: item?.profileUrl || null,
    headline: item?.headline || null,
    location: loc
      ? {
          linkedinText: loc.linkedinText || null,
          countryCode: loc.countryCode || null,
          parsed: {
            text: parsed.text || null,
            countryCode: parsed.countryCode || null,
            regionCode: parsed.regionCode || null,
            country: parsed.country || null,
            countryFull: parsed.countryFull || null,
            state: parsed.state || null,
            city: parsed.city || null,
          },
        }
      : null,
    connectionsCount: typeof item?.connectionsCount === 'number' ? item.connectionsCount : null,
    followerCount: typeof item?.followerCount === 'number' ? item.followerCount : null,
    sourceUrl: queriedUrl || item?.profileUrl || null,
    status: found ? 'found' : 'not_found',
    updatedAt: new Date(),
  };
}

/**
 * Run the LinkedIn actor for a batch of profile URLs and return mapped results.
 *
 * @param {string[]} urls - LinkedIn profile URLs to enrich
 * @param {object}   [opts]
 * @param {string[]} [opts.countryFilter] - actor countryFilter input
 * @returns {Promise<{ tokenDoc, byUrl: Map<normUrl, linkedinInfo>, raw: object[] }>}
 */
async function enrichLinkedInProfiles(urls, opts = {}) {
  const cleanUrls = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (cleanUrls.length === 0) {
    return { tokenDoc: null, byUrl: new Map(), raw: [] };
  }

  const tokenDoc = await selectToken();
  if (!tokenDoc) {
    const err = new Error('No Apify token available. Add one under Tokens → Apify.');
    err.code = 'NO_APIFY_TOKEN';
    throw err;
  }

  const input = {
    countryFilter: opts.countryFilter || [],
    queries: cleanUrls,
  };

  let items = [];
  try {
    const res = await axios.post(
      `${APIFY_BASE}/acts/${LINKEDIN_ACTOR_ID}/run-sync-get-dataset-items`,
      input,
      { params: { token: tokenDoc.token }, timeout: RUN_TIMEOUT_MS }
    );
    items = Array.isArray(res.data) ? res.data : [];
    await recordTokenUsage(tokenDoc, { ok: true, profiles: 0 });
  } catch (error) {
    await recordTokenUsage(tokenDoc, { ok: false, reason: error.message });
    logger.error(`Apify LinkedIn enrichment failed: ${error.message}`);
    throw error;
  }

  // Join results back to the queried URLs. Prefer the actor's profileUrl (it may
  // be a canonicalized vanity URL), then fall back to positional alignment.
  const byUrl = new Map();
  items.forEach((item, idx) => {
    const queriedUrl = cleanUrls[idx]; // positional fallback
    const info = mapItemToLinkedInInfo(item, queriedUrl);
    if (item?.profileUrl) byUrl.set(normalizeLinkedInUrl(item.profileUrl), info);
    if (queriedUrl) byUrl.set(normalizeLinkedInUrl(queriedUrl), info);
  });

  const enrichedCount = items.filter((i) => i && i.profileUrl && i.fullName).length;
  await recordTokenUsage(tokenDoc, { ok: true, profiles: enrichedCount, finalize: true });

  return { tokenDoc, byUrl, raw: items };
}

/** Increment counters on the token document (no-op for env-only tokens). */
async function recordTokenUsage(tokenDoc, { ok, profiles = 0, reason = null, finalize = false }) {
  if (!tokenDoc || tokenDoc._envOnly || typeof tokenDoc.save !== 'function') return;
  try {
    if (finalize) {
      tokenDoc.profilesEnriched = (tokenDoc.profilesEnriched || 0) + profiles;
    } else {
      tokenDoc.usageCount = (tokenDoc.usageCount || 0) + 1;
      tokenDoc.lastUsed = new Date();
      if (ok) tokenDoc.successCount = (tokenDoc.successCount || 0) + 1;
      else {
        tokenDoc.errorCount = (tokenDoc.errorCount || 0) + 1;
        tokenDoc.failureReason = reason;
      }
    }
    await tokenDoc.save();
  } catch (e) {
    logger.warn(`Failed to record Apify token usage: ${e.message}`);
  }
}

module.exports = {
  verifyToken,
  selectToken,
  enrichLinkedInProfiles,
  normalizeLinkedInUrl,
  mapItemToLinkedInInfo,
  LINKEDIN_ACTOR_ID,
};
