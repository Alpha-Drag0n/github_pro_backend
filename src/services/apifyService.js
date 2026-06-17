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
 * Highest priority first, then oldest — so the SAME token is used for every run
 * until it fails (Apify is credit-metered, not rate-limited, so there's no reason
 * to spread load). `excludeIds` skips tokens already disabled this run; `excludeEnv`
 * skips the env fallback once it has failed. Falls back to the APIFY_API_TOKEN env
 * var so enrichment still works before any DB token is added.
 * Returns a token document (or a synthetic { token } when only the env var exists).
 */
async function selectToken({ excludeIds = [], excludeEnv = false } = {}) {
  const query = { isActive: true, status: 'active' };
  if (excludeIds.length) query._id = { $nin: excludeIds };
  const doc = await ApifyToken.findOne(query).sort({ priority: -1, createdAt: 1 });
  if (doc) return doc;
  if (!excludeEnv && process.env.APIFY_API_TOKEN) {
    return { token: process.env.APIFY_API_TOKEN, _envOnly: true };
  }
  return null;
}

/**
 * Whether an Apify error means THIS token is unusable (so we disable it and move to
 * the next), vs. a transient problem (timeout, 5xx, rate limit) that shouldn't kill
 * a good token. Token-dead cases: bad/expired token, exhausted credits, blocked
 * account → HTTP 401/402/403, or an error body mentioning auth/credit/usage limits.
 */
function isTokenFailure(error) {
  const status = error.response?.status;
  if (status && [401, 402, 403].includes(status)) return true;
  const type = error.response?.data?.error?.type || '';
  const message = error.response?.data?.error?.message || '';
  return /limit-exceeded|usage|credit|payment|unauthor|forbidden|invalid.*token|token.*invalid/i.test(
    `${type} ${message}`
  );
}

/** Disable a token so it drops out of selection (no-op for the env-only token). */
async function disableToken(tokenDoc, reason) {
  if (!tokenDoc || tokenDoc._envOnly || typeof tokenDoc.save !== 'function') return;
  try {
    tokenDoc.isActive = false;
    tokenDoc.status = 'invalid';
    tokenDoc.errorCount = (tokenDoc.errorCount || 0) + 1;
    tokenDoc.failureReason = reason;
    tokenDoc.lastUsed = new Date();
    await tokenDoc.save();
    logger.warn(`Apify token "${tokenDoc.name}" disabled: ${reason}`);
  } catch (e) {
    logger.warn(`Failed to disable Apify token: ${e.message}`);
  }
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

// Detects a LinkedIn profile/company URL in ANY common form — with or without a
// scheme, with or without `www.`/country subdomain. The `\b` before `linkedin`
// keeps it from matching look-alikes like `mylinkedin.com`.
const LINKEDIN_URL_RE = /\blinkedin\.com\/\S+/i;

/** True if a stored value is a usable LinkedIn URL (regardless of scheme). */
function isLinkedInUrl(url) {
  return LINKEDIN_URL_RE.test(String(url || ''));
}

/** Every distinct usable LinkedIn URL on a user document (a user may have several). */
function allLinkedInUrls(user) {
  const urls = (user?.socialProfiles?.linkedin || [])
    .map((l) => (l && l.url ? String(l.url).trim() : ''))
    .filter((u) => isLinkedInUrl(u));
  return [...new Set(urls)];
}

/** Ensure a URL has a scheme so the Apify actor accepts it (prepends https://). */
function toQueryUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  return u;
}

/**
 * Map a single Apify dataset item to one `linkedinInfo.profiles[]` entry.
 * The actor returns rows positionally aligned with the input queries; rows for
 * companies / failed lookups come back as all-null. `queriedUrl` is the URL we
 * asked for, preserved so we can join the row back to the right user/URL.
 */
function mapItemToProfile(item, queriedUrl) {
  const found = !!(item && item.profileUrl && item.fullName);
  const loc = (item && item.location) || null;
  const parsed = (loc && loc.parsed) || {};

  return {
    sourceUrl: queriedUrl || item?.profileUrl || null,
    status: found ? 'found' : 'not_found',
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
  };
}

/**
 * Run the LinkedIn actor for a batch of profile URLs and return mapped results.
 *
 * Uses ONE token at a time (the highest-priority active one). If that token fails
 * with a token-dead error (bad token / exhausted credits), it is DISABLED and the
 * same batch is retried on the next active token — i.e. tokens are consumed one by
 * one, not load-balanced. Transient errors (timeout, 5xx, rate limit) are NOT
 * blamed on the token and are surfaced to the caller without disabling it.
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

  const input = { countryFilter: opts.countryFilter || [], queries: cleanUrls };
  const triedIds = []; // DB token _ids disabled this run, skipped on the next select
  let triedEnv = false; // env fallback failed → don't reselect it

  // Walk active tokens one by one until one succeeds or none remain.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tokenDoc = await selectToken({ excludeIds: triedIds, excludeEnv: triedEnv });
    if (!tokenDoc) {
      const err = new Error(
        triedIds.length || triedEnv
          ? 'All Apify tokens failed (disabled). Add a working token under Tokens → Apify.'
          : 'No Apify token available. Add one under Tokens → Apify.'
      );
      err.code = 'NO_APIFY_TOKEN';
      throw err;
    }

    let items;
    try {
      const res = await axios.post(
        `${APIFY_BASE}/acts/${LINKEDIN_ACTOR_ID}/run-sync-get-dataset-items`,
        input,
        { params: { token: tokenDoc.token }, timeout: RUN_TIMEOUT_MS }
      );
      items = Array.isArray(res.data) ? res.data : [];
      await recordTokenUsage(tokenDoc, { ok: true });
    } catch (error) {
      if (isTokenFailure(error)) {
        // This token is dead — disable it and fall through to the next one.
        await disableToken(tokenDoc, error.response?.data?.error?.message || error.message);
        if (tokenDoc._envOnly) triedEnv = true;
        else triedIds.push(tokenDoc._id);
        continue;
      }
      // Transient / non-token error — keep the token, surface the failure.
      await recordTokenUsage(tokenDoc, { ok: false, reason: error.message });
      logger.error(`Apify LinkedIn enrichment failed (token "${tokenDoc.name || 'env'}"): ${error.message}`);
      throw error;
    }

    // Join results back to the queried URLs. Prefer the actor's profileUrl (it may
    // be a canonicalized vanity URL), then fall back to positional alignment.
    const byUrl = new Map();
    items.forEach((item, idx) => {
      const queriedUrl = cleanUrls[idx]; // positional fallback
      const info = mapItemToProfile(item, queriedUrl);
      if (item?.profileUrl) byUrl.set(normalizeLinkedInUrl(item.profileUrl), info);
      if (queriedUrl) byUrl.set(normalizeLinkedInUrl(queriedUrl), info);
    });

    const enrichedCount = items.filter((i) => i && i.profileUrl && i.fullName).length;
    await recordTokenUsage(tokenDoc, { profiles: enrichedCount, finalize: true });

    return { tokenDoc, byUrl, raw: items };
  }
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
  isLinkedInUrl,
  allLinkedInUrls,
  toQueryUrl,
  mapItemToProfile,
  LINKEDIN_ACTOR_ID,
};
