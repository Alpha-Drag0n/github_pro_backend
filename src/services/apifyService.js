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
// Max profile URLs per actor run. Free Apify accounts return at most 15 results
// per run, so we never send more than this in one call (override for paid plans).
const MAX_RESULTS_PER_RUN = parseInt(process.env.APIFY_MAX_RESULTS_PER_RUN, 10) || 15;

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

/**
 * True if a stored value is a usable LinkedIn URL — actually hosted on linkedin.com
 * (any scheme, with/without www. or a country subdomain) with a path. Host-anchored
 * via linkedInPath, so look-alikes (mylinkedin.com) and embedded URLs are rejected.
 */
function isLinkedInUrl(url) {
  return linkedInPath(url) !== '';
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
 * The identifying path of a LinkedIn URL, HOST-ANCHORED and reduced to the profile
 * identity segment. Both "https://linkedin.com/in/foo" and
 * "https://www.linkedin.com/in/foo/recent-activity/" yield "/in/foo". Returns '' for
 * anything not actually hosted on linkedin.com — so a "linkedin.com/in/x" embedded in
 * another host's URL (e.g. a tracking redirect) is rejected, not treated as a profile.
 * Ignores scheme, www./country subdomain, sub-paths, query, hash, case, trailing slash,
 * so two URLs for the SAME profile compare equal.
 */
function linkedInPath(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  let host;
  let path;
  try {
    const parsed = new URL(u);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname || '';
  } catch {
    return '';
  }
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
  // Profile identity segment only (ignore trailing sub-paths like /recent-activity).
  const m = path.match(/^\/(in|company|school|pub)\/([^/]+)/i);
  if (m) {
    let slug = m[2];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep raw slug */
    }
    return `/${m[1].toLowerCase()}/${slug.toLowerCase()}`;
  }
  return path.replace(/\/+$/, '').toLowerCase();
}

/**
 * True only when both URLs point to the SAME LinkedIn profile (identical /in|/company
 * path). The actor sometimes returns an UNRELATED fallback profile for a query it
 * can't resolve; comparing the queried URL to the returned profileUrl catches that.
 */
function sameLinkedInProfile(a, b) {
  const pa = linkedInPath(a);
  const pb = linkedInPath(b);
  return !!pa && pa === pb;
}

/** A "not found" profile entry — records the URL we tried, stores no profile data. */
function notFoundProfile(queriedUrl) {
  return {
    sourceUrl: queriedUrl || null,
    status: 'not_found',
    fullName: null,
    profileUrl: null,
    headline: null,
    location: null,
    connectionsCount: null,
    followerCount: null,
  };
}

/**
 * Map one RESOLVED Apify dataset row to a `linkedinInfo.profiles[]` entry. Callers
 * pass only rows that actually resolved (profileUrl + fullName present) and join them
 * to users by the profile-URL slug — so there is no positional/guess matching here.
 * `sourceUrl` defaults to the canonical profileUrl; the caller overrides it with the
 * user's own queried URL.
 */
function mapItemToProfile(item) {
  const loc = item.location || null;
  const parsed = (loc && loc.parsed) || {};

  return {
    sourceUrl: item.profileUrl || null,
    status: 'found',
    fullName: item.fullName || null,
    profileUrl: item.profileUrl || null,
    headline: item.headline || null,
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
    connectionsCount: typeof item.connectionsCount === 'number' ? item.connectionsCount : null,
    followerCount: typeof item.followerCount === 'number' ? item.followerCount : null,
  };
}

/**
 * Run the actor for ONE chunk of URLs (≤ MAX_RESULTS_PER_RUN) and return its rows.
 *
 * Uses ONE token at a time (the highest-priority active one). If that token fails
 * with a token-dead error (bad token / exhausted credits), it is DISABLED and the
 * same chunk is retried on the next active token — i.e. tokens are consumed one by
 * one, not load-balanced. Transient errors (timeout, 5xx, rate limit) are NOT
 * blamed on the token and are surfaced to the caller without disabling it.
 */
async function runChunk(queries, opts) {
  const input = { countryFilter: opts.countryFilter || [], queries };
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

    try {
      const res = await axios.post(
        `${APIFY_BASE}/acts/${LINKEDIN_ACTOR_ID}/run-sync-get-dataset-items`,
        input,
        { params: { token: tokenDoc.token }, timeout: RUN_TIMEOUT_MS }
      );
      const items = Array.isArray(res.data) ? res.data : [];
      await recordTokenUsage(tokenDoc, { ok: true });
      const enrichedCount = items.filter((i) => i && i.profileUrl && i.fullName).length;
      await recordTokenUsage(tokenDoc, { profiles: enrichedCount, finalize: true });
      return { tokenDoc, items };
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
  }
}

/**
 * Run the LinkedIn actor for a set of profile URLs and return mapped results.
 *
 * URLs are split into chunks of MAX_RESULTS_PER_RUN (15 on the free Apify plan) and
 * run sequentially, so a single run never exceeds the plan's per-run result cap —
 * regardless of how many URLs the caller passes (a user may have several). Each
 * chunk applies the token-failover above; results are merged.
 *
 * Results are joined to users by the profile-URL SLUG (linkedInPath), NOT by array
 * position: the actor returns rows in arbitrary order and omits failed lookups, so a
 * positional join mis-assigns results (and made the same-profile guard drop valid
 * ones). The returned map is keyed by linkedInPath(profileUrl); a user matches when
 * their queried URL has the same /in|/company slug.
 *
 * @param {string[]} urls - LinkedIn profile URLs to enrich
 * @param {object}   [opts]
 * @param {string[]} [opts.countryFilter] - actor countryFilter input
 * @returns {Promise<{ tokenDoc, byUrl: Map<identityPath, profile>, raw: object[] }>}
 */
async function enrichLinkedInProfiles(urls, opts = {}) {
  const cleanUrls = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (cleanUrls.length === 0) {
    return { tokenDoc: null, byUrl: new Map(), raw: [] };
  }

  const byUrl = new Map();
  const raw = [];
  let lastToken = null;

  for (let i = 0; i < cleanUrls.length; i += MAX_RESULTS_PER_RUN) {
    const chunk = cleanUrls.slice(i, i + MAX_RESULTS_PER_RUN);
    const { tokenDoc, items } = await runChunk(chunk, opts);
    lastToken = tokenDoc;
    raw.push(...items);

    // Key each RESOLVED row by its own profileUrl slug (order-independent). Skip nulls
    // / failed lookups. A user is matched later iff their queried URL shares the slug,
    // which both fixes the reorder misses and still rejects unrelated fallback rows.
    items.forEach((item) => {
      if (!item || !item.profileUrl || !item.fullName) return;
      const key = linkedInPath(item.profileUrl);
      if (key) byUrl.set(key, mapItemToProfile(item));
    });
  }

  return { tokenDoc: lastToken, byUrl, raw };
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
  linkedInPath,
  sameLinkedInProfile,
  mapItemToProfile,
  LINKEDIN_ACTOR_ID,
};
