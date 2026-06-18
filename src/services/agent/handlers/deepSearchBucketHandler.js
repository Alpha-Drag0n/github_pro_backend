/**
 * Handler: 'deep-search-bucket'
 *
 * Processes ONE (day, term) bucket: query GitHub with growing location exclusions
 * until results fall below the 1000 cap, fetch profiles, run contact/social
 * discovery, and upsert users linked to the search. Idempotent — re-running a
 * partially-done bucket skips users already saved for the search.
 *
 * Token use: SEARCH calls are gated by the shared rate limiter (precise); CORE
 * calls (profile/repos/readme) rely on GitHub's 429 + token rotation (reactive),
 * which is correct because GitHub enforces the real limit and we rotate off a hot
 * token. The handler checks ctx.shouldAbort() so a lost lease / paused job stops it
 * cleanly without marking the task done.
 */

const axios = require('axios');
const User = require('../../../models/userModel');
const GitHubClient = require('../../../api/githubClient');
const contactDiscoveryService = require('../../contactDiscoveryService');
const tokenRateLimiter = require('../tokenRateLimiter');
const tracing = require('../../observability/tracing');
const Logger = require('../../../utils/logger');

const logger = new Logger();
const BASE_URL = 'https://api.github.com';
const GITHUB_SEARCH_CAP = 1000;
const PROFILE_FETCH_DELAY_MS = 120;
// Log which token each agent picks to the CONSOLE only (never persisted). Set
// LOG_TOKEN_SELECTION=false to silence it.
const LOG_TOKEN_SELECTION = process.env.LOG_TOKEN_SELECTION !== 'false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(token) {
  return {
    'User-Agent': 'GitHub-User-Research-Tool',
    Accept: 'application/vnd.github.v3+json',
    Authorization: `token ${token}`,
  };
}

const MAX_CAPACITY_WAIT_MS = 4 * 60_000; // don't squat a lease forever when all tokens are cooling

/**
 * Acquire a rate-limited token, waiting (with abort checks) until one is free.
 * Returns null on abort OR after MAX_CAPACITY_WAIT_MS of no capacity — in the latter
 * case it flags ctx.capacityAborted so the handler releases the task for a later retry
 * instead of holding the lease for the full per-task watchdog window.
 */
async function acquireOrWait(resource, ctx, excludeIds = []) {
  const deadline = Date.now() + MAX_CAPACITY_WAIT_MS;
  const waitStart = Date.now(); // capture the (previously invisible) token-wait latency
  let waited = false;
  for (;;) {
    if (await ctx.shouldAbort()) return null;
    const tok = await tokenRateLimiter.acquire(resource, excludeIds);
    if (tok) {
      if (LOG_TOKEN_SELECTION) {
        console.log(`[token] agent ${ctx.agentId || '?'} → "${tok.name}" (${resource})`);
      }
      // Only record when we actually had to wait — keeps the trace clean.
      if (waited) {
        tracing.recordLeaf({
          name: 'token.wait', kind: 'token', start: waitStart, end: Date.now(),
          status: 'ok', tokenId: tok._id,
          attr: { resource, waitedMs: Date.now() - waitStart, acquiredToken: tok.name },
        });
      }
      return tok;
    }
    if (Date.now() >= deadline) {
      ctx.capacityAborted = true; // no token capacity for too long → give up this task
      tracing.recordLeaf({
        name: 'token.wait', kind: 'token', start: waitStart, end: Date.now(),
        status: 'aborted', attr: { resource, waitedMs: Date.now() - waitStart, reason: 'capacity_timeout' },
      });
      return null;
    }
    waited = true;
    await sleep(2_000 + Math.floor(Math.random() * 1000)); // every token cooling → wait (C2) + jitter
  }
}

function classifyTokenError(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'abuse';
  if (status === 429) return 'rate';
  return null;
}

/** One paginated /search/users call, rate-limited per page, rotating on token errors. */
async function paginatedSearch(query, ctx) {
  const results = [];
  const perPage = 100;
  const maxPages = GITHUB_SEARCH_CAP / perPage;
  const tokenCount = Math.max(1, ctx.tokenCount || 1);
  let tried = []; // DISTINCT-token rotation for the CURRENT page; reset once a page succeeds

  for (let page = 1; page <= maxPages; page++) {
    // Never re-pick a token that already failed this page → t1..tN are all different.
    const token = await acquireOrWait('search', ctx, tried);
    if (!token) return { results, aborted: true };
    tracing.setToken(token._id, token.name); // attribute subsequent spans to this token

    try {
      // This raw axios.get bypasses GitHubClient's interceptor, so wrap it explicitly
      // → a github.search span per page (the deep-search hot path).
      const res = await tracing.withSpan(
        'github.search', 'github',
        () => axios.get(`${BASE_URL}/search/users`, {
          headers: headers(token.token),
          params: { q: query, per_page: perPage, page, sort: 'joined', order: 'desc' },
          timeout: 15_000,
        }),
        (r) => ({
          method: 'GET', endpoint: '/search/users', page,
          statusCode: r && r.status,
          rateRemaining: r && r.headers ? Number(r.headers['x-ratelimit-remaining']) : undefined,
          resultCount: r && r.data && Array.isArray(r.data.items) ? r.data.items.length : undefined,
        })
      );
      // Await reconcile so it serializes BEFORE the next page's acquire() decrement
      // (otherwise a late reconcile could clobber the new decrement).
      await tokenRateLimiter.reconcile(token._id, 'search', res.headers);
      await tokenRateLimiter.reportSuccess(token._id);
      ctx.requests++;
      tried = []; // page ok → any token may serve the next page

      const items = res.data.items || [];
      results.push(...items);
      if (items.length < perPage || results.length >= GITHUB_SEARCH_CAP) break;
    } catch (error) {
      const status = error.response?.status;
      if (status === 422) {
        logger.warn(`[bucket] invalid query, stopping pagination: ${query}`);
        break;
      }
      const kind = classifyTokenError(status);
      if (!kind) throw Object.assign(error, { code: `HTTP_${status || 'NETWORK'}` });

      // Cool this token and exclude it for the rest of this page (rotate to a DISTINCT token).
      const retryAfter = parseInt(error.response?.headers?.['retry-after'], 10);
      await tokenRateLimiter.reportError(token._id, kind, retryAfter ? retryAfter * 1000 : 0);
      tried.push(token._id);
      if (tried.length >= tokenCount) {
        // Tried every token once → give up this bucket (task retries later).
        throw Object.assign(new Error(`search failed after trying ${tried.length} token(s)`), { code: 'RATE_LIMIT' });
      }
      page--; // retry the same page with a different (not-yet-tried) token
      continue;
    }
  }
  return { results, aborted: false };
}

/** Build a core-API GitHubClient backed by the rate limiter. excludeIds → distinct rotation. */
async function makeCoreClient(ctx, excludeIds = []) {
  const token = await acquireOrWait('core', ctx, excludeIds);
  if (!token) return null;
  tracing.setToken(token._id, token.name);
  return {
    client: new GitHubClient(token.token, ctx.searchUuid, { tokenId: token._id }),
    tokenId: token._id,
  };
}

/** Save one page of search results as users (idempotent), returning {created, locations}. */
async function saveUsers(items, ctx, iteration, excludedLocations) {
  const locations = new Set();
  let created = 0;

  for (let index = 0; index < items.length; index++) {
    // Every 20 users, renew the lease (which detects a fenced-out lease from a Hold/Cancel
    // of THIS task without waiting for the 15s heartbeat) and bail if we should abort.
    if (index % 20 === 0) {
      await ctx.renew();
      if (await ctx.shouldAbort()) break;
    }

    const item = items[index];
    const username = item.login;
    if (!username) continue;

    const historyEntry = {
      searchId: ctx.searchId,
      iterationNumber: iteration,
      searchDate: new Date(),
      excludedLocations,
      resultPosition: index + 1,
    };

    // Already saved for THIS search → skip (idempotency).
    if (await User.findOne({ username, searchId: ctx.searchUuid }).select('_id')) continue;

    // Reuse a profile already stored by another search → no API call.
    const existing = await User.findOne({ username }).sort({ extractedAt: 1 });
    let profile = null;
    let core = null;

    if (existing) {
      profile = {
        name: existing.displayName, avatar_url: existing.avatar_url, bio: existing.bio,
        company: existing.company, blog: existing.blog, location: existing.location,
        email: existing.publicEmail, twitter_username: existing.twitter_username,
        followers: existing.followers, following: existing.following,
        public_repos: existing.public_repos, created_at: existing.github_created_at,
        updated_at: existing.github_updated_at,
      };
    } else {
      const tokenCount = Math.max(1, ctx.tokenCount || 1);
      const tried = []; // token ids already tried → never re-selected (distinct rotation)
      core = await makeCoreClient(ctx);
      if (!core) break; // capacity/abort while waiting for a token
      let skip = false;
      for (;;) {
        try {
          profile = await core.client.getUserProfile(username);
          ctx.requests++;
          await tokenRateLimiter.reportSuccess(core.tokenId);
          break;
        } catch (e) {
          const status = e.response?.status;
          if (status === 404) {
            profile = null; // user genuinely gone → save a minimal record (legit)
            break;
          }
          const kind = classifyTokenError(status);
          if (!kind) {
            // Persistent non-token error (5xx/network) → skip rather than persist a hollow record.
            logger.warn(`[bucket] profile fetch failed for ${username}: ${e.message}`);
            skip = true;
            break;
          }
          // Cool this token and never pick it again this cycle → rotate to a DISTINCT token.
          const ra = parseInt(e.response?.headers?.['retry-after'], 10);
          await tokenRateLimiter.reportError(core.tokenId, kind, ra ? ra * 1000 : 0);
          tried.push(core.tokenId);
          if (tried.length >= tokenCount) {
            // Tried every token once → give up on this user.
            logger.warn(`[bucket] profile fetch for ${username} gave up after ${tried.length} token(s)`);
            skip = true;
            break;
          }
          core = await makeCoreClient(ctx, tried); // a token NOT yet tried this cycle
          if (!core) { skip = true; break; } // no other token available / abort
          continue;
        }
      }
      await sleep(PROFILE_FETCH_DELAY_MS);
      if (skip) continue;
    }

    if (profile?.location && profile.location.trim()) locations.add(profile.location.trim());

    // Deep contact/social/location discovery across all repos (records exact source URLs).
    let contactInfo, socialProfiles, locationInfo, repositoriesChecked = 0;
    try {
      if (!core) core = await makeCoreClient(ctx);
      if (core) {
        const discovery = await tracing.withSpan(
          'contact.discover', 'compute',
          () => contactDiscoveryService.discoverContacts(core.client, username, {
            profile,
            tag: ctx.searchUuid,
            rotate: async () => {
              const next = await makeCoreClient(ctx);
              return next ? next.client : null;
            },
          }),
          (d) => ({ username, repositoriesChecked: d && d.repositoriesChecked, foundContact: !!(d && d.contactInfo) })
        );
        contactInfo = discovery.contactInfo;
        socialProfiles = discovery.socialProfiles;
        locationInfo = discovery.locationInfo;
        repositoriesChecked = discovery.repositoriesChecked;
      }
    } catch (e) {
      logger.warn(`[bucket] contact discovery failed for ${username}: ${e.message}`);
    }

    try {
      await new User({
        username,
        searchId: ctx.searchUuid,
        displayName: profile?.name || item.login,
        name: profile?.name,
        githubUrl: item.html_url,
        avatar_url: profile?.avatar_url || item.avatar_url,
        bio: profile?.bio, company: profile?.company, blog: profile?.blog,
        publicEmail: profile?.email, twitter_username: profile?.twitter_username,
        location: profile?.location, followers: profile?.followers,
        following: profile?.following, public_repos: profile?.public_repos,
        github_created_at: profile?.created_at, github_updated_at: profile?.updated_at,
        contactInfo, socialProfiles, locationInfo,
        repositoryMining: { repositoriesChecked, lastMiningDate: new Date() },
        foundIn: {
          location: profile?.location || 'Unknown',
          year: profile?.created_at ? new Date(profile.created_at).getFullYear() : undefined,
        },
        searchIterationHistory: [historyEntry],
      }).save();
      created++;
    } catch (e) {
      if (!e.message.includes('duplicate key')) logger.warn(`[bucket] save ${username}: ${e.message}`);
    }
  }

  return { created, locations: Array.from(locations) };
}

/**
 * Main handler entry.
 * @param {object} payload  { day, term, accountType }
 * @param {object} ctx      { task, searchId, searchUuid, tokenCount, shouldAbort, renew }
 * @returns {Promise<{ usersNew:number, requests:number, aborted?:boolean }>}
 */
async function run(payload, ctx) {
  const { day, term, accountType = 'user' } = payload;
  // Defensive: never run with a missing search uuid (would null-key User saves).
  if (!ctx.searchUuid) return { usersNew: 0, requests: 0, aborted: true };

  ctx.requests = 0;
  ctx.capacityAborted = false;
  const excluded = new Set();
  const maxIterations = 50;
  let usersNew = 0;
  let usersFound = 0; // total results discovered across iterations (vs usersNew = saved)

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if ((await ctx.shouldAbort()) || ctx.capacityAborted) {
      return { usersNew, usersFound, requests: ctx.requests, aborted: true };
    }
    await ctx.renew();

    let query = `${term} created:${day} type:${accountType}`;
    for (const loc of excluded) query += ` -location:"${loc}"`;

    const { results, aborted } = await paginatedSearch(query, ctx);
    if (aborted) return { usersNew, usersFound, requests: ctx.requests, aborted: true };
    if (results.length === 0) break;
    usersFound += results.length;

    const { created, locations } = await saveUsers(results, ctx, iteration, Array.from(excluded));
    usersNew += created;
    if (ctx.capacityAborted) return { usersNew, usersFound, requests: ctx.requests, aborted: true };

    const fresh = locations.filter((l) => !excluded.has(l));
    fresh.forEach((l) => excluded.add(l));

    if (results.length < GITHUB_SEARCH_CAP && fresh.length === 0) break;
    if (fresh.length === 0) break;
  }

  return { usersNew, usersFound, requests: ctx.requests };
}

module.exports = { type: 'deep-search-bucket', run };
