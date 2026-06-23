/**
 * API Routes for Iterative Search Operations
 * Handles searches that bypass GitHub's 1000-result limit via location-based exclusion
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const DeepSearch = require('../models/deepSearchModel');
const DeepSearchLog = require('../models/deepSearchLogModel');
const User = require('../models/userModel');
const Token = require('../models/tokenModel');
const Logger = require('../utils/logger');
const requestLogService = require('../services/requestLogService');
const SearchTokenPool = require('../services/searchTokenPool');
const iterativeSearchService = require('../services/deepSearchService');
const apifyService = require('../services/apifyService');
const Task = require('../models/taskModel');
const taskQueue = require('../services/agent/taskQueue');

const logger = new Logger();

/** Guards against launching two background loops for the same search in one process. */
const runningIterativeSearches = new Set();

/** Serializes LinkedIn enrichment so overlapping requests can't double-charge Apify. */
let enrichInProgress = false;

/**
 * Assign a token and run the iterative search in the background (fire-and-forget).
 * Releases the worker guard and token assignment when finished.
 */
async function launchIterativeSearch(search, io) {
  const searchId = search.searchId;

  if (runningIterativeSearches.has(searchId)) {
    logger.warn(`Iterative search ${searchId} already running in this process`);
    return { ok: false, reason: 'already_running' };
  }

  const selectedToken = await SearchTokenPool.assignTokenForSearch(searchId);
  if (!selectedToken) {
    return { ok: false, reason: 'no_token' };
  }

  const tokenDoc = await Token.findById(selectedToken._id);
  if (!tokenDoc) {
    SearchTokenPool.releaseTokenForSearch(searchId);
    return { ok: false, reason: 'no_token' };
  }

  runningIterativeSearches.add(searchId);

  // Run in background — do not await.
  iterativeSearchService
    .runIterativeRangeSearch({ search, token: tokenDoc, io })
    .catch((error) => {
      logger.error(`Iterative search ${searchId} crashed: ${error.message}`);
    })
    .finally(() => {
      runningIterativeSearches.delete(searchId);
      SearchTokenPool.releaseTokenForSearch(searchId);
    });

  return { ok: true, tokenName: tokenDoc.name };
}

/**
 * Normalize an DeepSearch document for API responses.
 *
 * The model stores dates nested under `dateRange`, but the frontend reads flat
 * `fromDate` / `toDate` fields. This flattens them to `YYYY-MM-DD` strings while
 * preserving every other field (and the original `dateRange`) so existing and
 * future consumers both work.
 */
function serializeSearch(search) {
  const obj = typeof search.toObject === 'function' ? search.toObject() : { ...search };

  const from = obj.dateRange && obj.dateRange.fromDate;
  const to = obj.dateRange && obj.dateRange.toDate;
  const toIsoDate = (value) =>
    value ? new Date(value).toISOString().split('T')[0] : null;

  return {
    ...obj,
    fromDate: toIsoDate(from),
    toDate: toIsoDate(to),
  };
}

/**
 * Get all iterative searches
 * GET /api/deep-searches
 */
router.get('/deep-searches', async (req, res) => {
  try {
    const searches = await DeepSearch.find()
      .sort({ createdAt: -1 });

    requestLogService.logDBOperation(
      'DeepSearch.find',
      { count: searches.length },
      'find',
      0,
      true,
      null
    );

    res.json(searches.map(serializeSearch));
  } catch (error) {
    logger.error(`Error fetching iterative searches: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch searches' });
  }
});

// Array-field "non-empty" existence checks, keyed by the presence-filter param name.
const PRESENCE_FIELDS = {
  email: { $or: [{ 'contactInfo.emails.0': { $exists: true } }, { 'emails.0': { $exists: true } }] },
  linkedin: { 'socialProfiles.linkedin.0': { $exists: true } },
  // A LinkedIn entry that actually carries a URL. The RocketReach extension uses `linkedinUrlHas=yes`
  // (not `linkedinHas`) because it needs a real URL to look up — a handle-only entry is unusable and,
  // if counted, would never drain from the resume queue. Mirrors the client's `linkedin[0].url` read.
  linkedinUrl: { 'socialProfiles.linkedin.0.url': { $nin: [null, ''] } },
  x: { 'socialProfiles.x.0': { $exists: true } },
  facebook: { 'socialProfiles.facebook.0': { $exists: true } },
  instagram: { 'socialProfiles.instagram.0': { $exists: true } },
  youtube: { 'socialProfiles.youtube.0': { $exists: true } },
  tiktok: { 'socialProfiles.tiktok.0': { $exists: true } },
  discord: { 'contactInfo.discord.0': { $exists: true } },
  telegram: { 'contactInfo.telegram.0': { $exists: true } },
  whatsapp: { 'contactInfo.whatsapp.0': { $exists: true } },
  phone: { 'contactInfo.phone.0': { $exists: true } },
};
const HAS_PROFILE_LOCATION = { location: { $nin: [null, ''] } };
const HAS_DISCOVERED_LOCATION = { 'locationInfo.discovered.0': { $exists: true } };
// RocketReach enrichment state — used by the extension to resume large runs:
//   rocketreachHas=no   → users never processed (no status at all)
//   rocketreachFound=no → users without a found location (not_found OR never processed) — for retrying misses
const HAS_ROCKETREACH = { 'locationInfo.rocketreach.status': { $nin: [null, ''] } };
const HAS_ROCKETREACH_FOUND = { 'locationInfo.rocketreach.status': 'found' };
// LinkedIn (Apify) enrichment state — used to resume/retry enrichment runs:
//   linkedinInfoHas=no    → users never enriched (no status at all)
//   linkedinInfoFound=no  → users without a resolved profile (not_found OR never enriched)
const HAS_LINKEDIN_INFO = { 'linkedinInfo.status': { $nin: [null, ''] } };
const HAS_LINKEDIN_INFO_FOUND = { 'linkedinInfo.status': 'found' };
// A LinkedIn entry carrying an ENRICHABLE URL on ANY entry. Accepts every common
// form — with/without scheme, with/without www. or a country subdomain — matching
// apifyService.isLinkedInUrl(). The `\b` before `linkedin` avoids look-alikes like
// `mylinkedin.com`. Keeps the "unprocessed" count aligned with what we actually send.
const HAS_USABLE_LINKEDIN_URL = {
  // Host-anchored: linkedin.com must be at the start, after `//`, or after a subdomain
  // dot — so a linkedin.com path embedded in another host's URL isn't counted.
  'socialProfiles.linkedin': { $elemMatch: { url: { $regex: '(^|//|\\.)linkedin\\.com/\\S+', $options: 'i' } } },
};
// Resolved "best" location values, for the have/best/not-have filters:
//   locationInfo: best = resolved best string present; have = best OR any discovered.
//   linkedinInfo: best = a FOUND profile that carries a location; have = processed at all.
const HAS_LOCATIONINFO_BEST = { 'locationInfo.best': { $nin: [null, ''] } };
const HAS_LOCATIONINFO_ANY = { $or: [HAS_LOCATIONINFO_BEST, HAS_DISCOVERED_LOCATION] };
const HAS_LINKEDIN_BEST = {
  'linkedinInfo.profiles': {
    $elemMatch: {
      status: 'found',
      $or: [
        { 'location.linkedinText': { $nin: [null, ''] } },
        { 'location.parsed.country': { $nin: [null, ''] } },
        { 'location.parsed.city': { $nin: [null, ''] } },
      ],
    },
  },
};

/**
 * Build a case-insensitive regex STRING for a free-text filter + match mode.
 * Modes: 'startswith' | 'endswith' | 'exact' | (default) 'contain'.
 */
function matchRegex(value, mode) {
  const esc = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
  switch (mode) {
    case 'startswith':
      return '^' + esc;
    case 'endswith':
      return esc + '$';
    case 'exact':
      return '^' + esc + '$';
    default:
      return esc; // contain
  }
}

/** Build the Mongo filter for the deep-search users query from request params. */
function buildDeepUserFilter(q) {
  const and = [{ 'searchIterationHistory.0': { $exists: true } }]; // deep-search users only

  // Scope to ONE deep search (the DeepSearch _id; Mongoose casts the string).
  // Lets the per-search "view" page reuse this whole filter/enrichment pipeline.
  if (q.searchId) and.push({ 'searchIterationHistory.searchId': q.searchId });

  if (q.username) and.push({ username: { $regex: q.username, $options: 'i' } });

  // Location (profile field only).
  if (q.location) and.push({ location: { $regex: q.location, $options: 'i' } });
  // Location info (repo-discovered): best + discovered place values.
  if (q.locationInfo) {
    const rx = { $regex: q.locationInfo, $options: 'i' };
    and.push({ $or: [{ 'locationInfo.best': rx }, { 'locationInfo.discovered.value': rx }] });
  }
  if (q.email) {
    const rx = { $regex: q.email, $options: 'i' };
    and.push({ $or: [{ 'contactInfo.emails.email': rx }, { emails: rx }] });
  }
  if (q.minFollowers) and.push({ followers: { $gte: parseInt(q.minFollowers, 10) } });
  if (q.maxFollowers) and.push({ followers: { $lte: parseInt(q.maxFollowers, 10) } });

  // Location (profile) presence: yes | no
  if (q.locationHas === 'yes') and.push(HAS_PROFILE_LOCATION);
  else if (q.locationHas === 'no') and.push({ $nor: [HAS_PROFILE_LOCATION] });

  // Location info (repo-discovered) presence: yes | no
  if (q.locationInfoHas === 'yes') and.push(HAS_DISCOVERED_LOCATION);
  else if (q.locationInfoHas === 'no') and.push({ $nor: [HAS_DISCOVERED_LOCATION] });

  // RocketReach processed (any status) presence: yes | no
  if (q.rocketreachHas === 'yes') and.push(HAS_ROCKETREACH);
  else if (q.rocketreachHas === 'no') and.push({ $nor: [HAS_ROCKETREACH] });
  // RocketReach found a location: yes | no  (no = not_found or never processed)
  if (q.rocketreachFound === 'yes') and.push(HAS_ROCKETREACH_FOUND);
  else if (q.rocketreachFound === 'no') and.push({ $nor: [HAS_ROCKETREACH_FOUND] });

  // LinkedIn (Apify) enrichment processed (any status): yes | no
  if (q.linkedinInfoHas === 'yes') and.push(HAS_LINKEDIN_INFO);
  else if (q.linkedinInfoHas === 'no') and.push({ $nor: [HAS_LINKEDIN_INFO] });
  // LinkedIn (Apify) enrichment resolved a profile: yes | no
  if (q.linkedinInfoFound === 'yes') and.push(HAS_LINKEDIN_INFO_FOUND);
  else if (q.linkedinInfoFound === 'no') and.push({ $nor: [HAS_LINKEDIN_INFO_FOUND] });

  // Location info state: have (best or discovered) | best (resolved best) | nothave
  if (q.locationInfoState === 'have') and.push(HAS_LOCATIONINFO_ANY);
  else if (q.locationInfoState === 'best') and.push(HAS_LOCATIONINFO_BEST);
  else if (q.locationInfoState === 'nothave') and.push({ $nor: [HAS_LOCATIONINFO_ANY] });

  // LinkedIn info state: have (processed) | best (found profile with a location) | nothave
  if (q.linkedinInfoState === 'have') and.push(HAS_LINKEDIN_INFO);
  else if (q.linkedinInfoState === 'best') and.push(HAS_LINKEDIN_BEST);
  else if (q.linkedinInfoState === 'nothave') and.push({ $nor: [HAS_LINKEDIN_INFO] });

  // Free-text match (start/contain/end/exact) against the resolved "best" value:
  //   locationInfoValue → locationInfo.best
  //   linkedinInfoValue → a FOUND LinkedIn profile's location (linkedinText)
  if (q.locationInfoValue) {
    and.push({ 'locationInfo.best': { $regex: matchRegex(q.locationInfoValue, q.locationInfoMatch), $options: 'i' } });
  }
  if (q.linkedinInfoValue) {
    and.push({
      'linkedinInfo.profiles': {
        $elemMatch: {
          status: 'found',
          'location.linkedinText': { $regex: matchRegex(q.linkedinInfoValue, q.linkedinInfoMatch), $options: 'i' },
        },
      },
    });
  }

  // Per-field presence toggles: <field>Has = 'yes' | 'no'
  for (const [field, cond] of Object.entries(PRESENCE_FIELDS)) {
    const v = q[`${field}Has`];
    if (v === 'yes') and.push(cond);
    else if (v === 'no') and.push({ $nor: [cond] });
  }

  return { $and: and };
}

/**
 * Unified Deep Search results — users found across ALL deep searches, with detailed filters.
 * GET /api/deep-searches/users?page&limit&username&location&locationInfo&email&minFollowers&maxFollowers
 *   &locationHas|locationInfoHas = yes|no
 *   &emailHas|linkedinHas|xHas|facebookHas|instagramHas|youtubeHas|tiktokHas|discordHas|telegramHas|whatsappHas|phoneHas = yes|no
 * NOTE: must be declared before '/deep-searches/:id' so "users" isn't read as an id.
 */
router.get('/deep-searches/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = buildDeepUserFilter(req.query);

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ extractedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalSearches = await DeepSearch.countDocuments();

    res.json({
      users,
      totalSearches,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`Error fetching unified deep-search users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// ===== LinkedIn enrichment via the Apify actor =====

// Hard cap on how many profiles one actor run handles (keeps a single request bounded).
const MAX_LINKEDIN_BATCH = 100;

/**
 * Run a batch of user docs through the Apify actor and persist results onto
 * `linkedinInfo`. A user may have SEVERAL LinkedIn URLs — every URL is checked and
 * stored in `linkedinInfo.profiles[]`; `linkedinInfo.status` rolls up to 'found' if
 * any of them resolved. All URLs across all users go out in ONE actor run.
 * Returns { processed, found, notFound, skipped, results } (counts are per user).
 */
async function enrichUserDocs(users) {
  // Collect every usable LinkedIn URL per user (a user may have multiple).
  const targets = []; // { user, urls: [originalUrl, ...] }
  for (const user of users) {
    const urls = apifyService.allLinkedInUrls(user);
    if (urls.length) targets.push({ user, urls });
  }
  if (targets.length === 0) {
    return { processed: 0, found: 0, notFound: 0, skipped: users.length, results: [] };
  }

  // One actor run for the union of all URLs (scheme-normalized so Apify accepts them).
  const allUrls = targets.flatMap((t) => t.urls.map((u) => apifyService.toQueryUrl(u)));
  const { byUrl, queriedSlugs } = await apifyService.enrichLinkedInProfiles(allUrls);

  const results = [];
  let found = 0;
  let notFound = 0;
  let skippedUnsent = 0; // users whose URLs weren't sent (a chunk failed) → leave eligible
  for (const { user, urls } of targets) {
    // Only the URLs actually SENT to Apify (completed chunks). If a later chunk failed,
    // unsent users are left untouched so they're retried WITHOUT re-charging the
    // already-paid ones.
    const sentUrls = urls.filter((u) => queriedSlugs.has(apifyService.linkedInPath(u)));
    if (sentUrls.length === 0) {
      skippedUnsent += 1;
      continue;
    }

    // Build one profile entry per sent URL. Match by profile-URL slug (linkedInPath) —
    // the actor reorders rows, so we can't rely on position.
    const profiles = sentUrls.map((u) => {
      const matched = byUrl.get(apifyService.linkedInPath(u));
      if (matched) return { ...matched, sourceUrl: u };
      return {
        sourceUrl: u,
        status: 'not_found',
        fullName: null,
        profileUrl: null,
        headline: null,
        location: null,
        connectionsCount: null,
        followerCount: null,
      };
    });
    const anyFound = profiles.some((p) => p.status === 'found');
    const info = { status: anyFound ? 'found' : 'not_found', profiles, updatedAt: new Date() };

    await User.findByIdAndUpdate(user._id, { $set: { linkedinInfo: info } }, { runValidators: true });

    if (anyFound) found += 1;
    else notFound += 1;
    results.push({ userId: user._id, username: user.username, status: info.status, linkedinInfo: info });
  }

  return {
    processed: results.length,
    found,
    notFound,
    skipped: users.length - targets.length + skippedUnsent,
    results,
  };
}

/**
 * LinkedIn enrichment coverage stats for the current filter context.
 * GET /api/deep-searches/users/linkedin-stats?<same filters as the users list>
 * The linkedin enrichment toggles (linkedinInfoHas/Found) are ignored so the counts
 * stay stable as the user flips those filters. Declared before '/deep-searches/:id'.
 */
router.get('/deep-searches/users/linkedin-stats', async (req, res) => {
  try {
    const q = { ...req.query };
    delete q.linkedinInfoHas;
    delete q.linkedinInfoFound;
    delete q.linkedinInfoState;
    delete q.linkedinInfoValue;
    delete q.linkedinInfoMatch;
    const base = buildDeepUserFilter(q);

    const withUrl = await User.countDocuments({ $and: [base, HAS_USABLE_LINKEDIN_URL] });
    const processed = await User.countDocuments({ $and: [base, HAS_USABLE_LINKEDIN_URL, HAS_LINKEDIN_INFO] });
    const found = await User.countDocuments({ $and: [base, HAS_USABLE_LINKEDIN_URL, HAS_LINKEDIN_INFO_FOUND] });

    res.json({
      withLinkedinUrl: withUrl,
      processed,
      found,
      notFound: Math.max(0, processed - found),
      unprocessed: Math.max(0, withUrl - processed),
    });
  } catch (error) {
    logger.error(`Error computing LinkedIn stats: ${error.message}`);
    res.status(500).json({ error: 'Failed to compute LinkedIn stats' });
  }
});

/**
 * Enrich deep-search users with LinkedIn profile data via the Apify actor.
 * POST /api/deep-searches/users/enrich-linkedin
 * Body (one of):
 *   { ids: [userId, ...] }        — enrich exactly these users (explicit selection)
 *   { filter: {...}, max?: 25 }   — enrich up to `max` UNPROCESSED users (have a URL,
 *                                   no linkedinInfo yet) matching the given filter params;
 *                                   returns `remaining` so the UI can loop to drain the set.
 * Runs all selected URLs through Apify in ONE actor run. Declared before '/deep-searches/:id'.
 *
 * Guarded so only ONE enrichment runs at a time in this process: two overlapping requests
 * (two tabs, a double-click, or bulk + per-page) can't both select the same users and
 * issue duplicate PAID Apify calls. Mirrors `runningIterativeSearches`.
 */
router.post('/deep-searches/users/enrich-linkedin', async (req, res) => {
  if (enrichInProgress) {
    return res.status(409).json({ error: 'Another LinkedIn enrichment is already running. Please wait for it to finish.' });
  }
  enrichInProgress = true;
  try {
    const { ids, filter, max } = req.body || {};

    // Mode A: explicit ids.
    if (Array.isArray(ids) && ids.length > 0) {
      const users = await User.find({ _id: { $in: ids.slice(0, MAX_LINKEDIN_BATCH) } });
      const out = await enrichUserDocs(users);
      if (out.processed === 0) {
        return res.status(400).json({ error: 'None of the selected users have a LinkedIn URL to enrich' });
      }
      return res.json({ message: 'LinkedIn enrichment complete', mode: 'ids', requested: ids.length, ...out });
    }

    // Mode B: filter-driven bulk. Two sub-modes matching the filter:
    //   default → drain UNPROCESSED users (have a URL, never enriched)
    //   retry   → re-process users already enriched but NOT found (not_found/error)
    if (filter && typeof filter === 'object') {
      const batch = Math.min(MAX_LINKEDIN_BATCH, Math.max(1, parseInt(max, 10) || 15));
      const retry = req.body?.mode === 'retry';
      const q = { ...filter };
      delete q.linkedinInfoHas;
      delete q.linkedinInfoFound;
      delete q.linkedinInfoState;
      delete q.linkedinInfoValue;
      delete q.linkedinInfoMatch;
      const base = buildDeepUserFilter(q);

      let targetFilter;
      let sort;
      if (retry) {
        // `before` (cutoff timestamp from the client, captured when the run started)
        // guarantees one clean sweep: each re-processed user gets a newer updatedAt
        // and drops below the cutoff, so the set drains even if it stays not_found.
        const before = req.body?.before ? new Date(req.body.before) : new Date();
        targetFilter = {
          $and: [
            base,
            HAS_USABLE_LINKEDIN_URL,
            HAS_LINKEDIN_INFO,
            { $nor: [HAS_LINKEDIN_INFO_FOUND] },
            { 'linkedinInfo.updatedAt': { $lt: before } },
          ],
        };
        sort = { 'linkedinInfo.updatedAt': 1 }; // oldest-tried first
      } else {
        targetFilter = { $and: [base, HAS_USABLE_LINKEDIN_URL, { $nor: [HAS_LINKEDIN_INFO] }] };
        sort = { extractedAt: -1 };
      }

      const users = await User.find(targetFilter).sort(sort).limit(batch);
      if (users.length === 0) {
        return res.json({ message: 'Nothing to enrich', mode: retry ? 'retry' : 'filter', processed: 0, found: 0, notFound: 0, skipped: 0, results: [], handled: 0, remaining: 0 });
      }
      const out = await enrichUserDocs(users);

      // Drain only users that have NO usable URL (so the loop progresses past them).
      // Users left UNSENT by a mid-run chunk failure DO have a URL and are intentionally
      // left eligible (no marker) so they're retried without re-charging already-paid
      // profiles. Retry mode targets already carry a URL, so nothing to drain there.
      let drainedNoUrl = 0;
      if (!retry) {
        const stuck = users.filter((u) => apifyService.allLinkedInUrls(u).length === 0);
        if (stuck.length) {
          await User.updateMany(
            { _id: { $in: stuck.map((u) => u._id) } },
            { $set: { linkedinInfo: { status: 'error', profiles: [], updatedAt: new Date() } } }
          );
          drainedNoUrl = stuck.length;
        }
      }

      // `handled` = users that actually left the target set this batch (written results +
      // no-URL drains). When 0 (e.g. a persistent partial failure), the client loop stops.
      const handled = out.processed + drainedNoUrl;
      const remaining = await User.countDocuments(targetFilter);
      return res.json({ message: 'LinkedIn enrichment complete', mode: retry ? 'retry' : 'filter', ...out, handled, remaining });
    }

    return res.status(400).json({ error: 'Provide ids[] or filter{}' });
  } catch (error) {
    if (error.code === 'NO_APIFY_TOKEN') {
      return res.status(400).json({ error: error.message });
    }
    logger.error(`Error enriching LinkedIn profiles: ${error.message}`);
    res.status(500).json({ error: 'Failed to enrich LinkedIn profiles' });
  } finally {
    enrichInProgress = false;
  }
});

/**
 * Save a RocketReach-derived location onto a deep-search user.
 * PATCH /api/deep-searches/users/:id/rocketreach-location
 * Body: { value, linkedinUrl, status }
 *   - status 'found'      → value is the location string (required)
 *   - status 'not_found'  → RocketReach had no result; value is cleared
 *   - status 'error'      → lookup failed for this profile; value is cleared (recorded so resume skips it)
 * Used by the RocketReach Chrome extension to persist enrichment. Writes only the
 * isolated `locationInfo.rocketreach` sub-document; never touches `location` or `discovered`.
 */
router.patch('/deep-searches/users/:id/rocketreach-location', async (req, res) => {
  try {
    const { value, linkedinUrl, status } = req.body || {};
    const ALLOWED = ['found', 'not_found', 'error'];
    const normalizedStatus = ALLOWED.includes(status) ? status : 'found';

    if (normalizedStatus === 'found' && !String(value || '').trim()) {
      return res.status(400).json({ error: 'value is required when status is "found"' });
    }

    const rocketreach = {
      value: normalizedStatus === 'found' ? String(value).trim() : '',
      linkedinUrl: String(linkedinUrl || '').trim(),
      status: normalizedStatus,
      updatedAt: new Date(),
    };

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { 'locationInfo.rocketreach': rocketreach } },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    requestLogService.logDBOperation(
      'User.findByIdAndUpdate',
      { userId: String(user._id), status: normalizedStatus },
      'update',
      0,
      true,
      null
    );

    res.json({
      message: 'RocketReach location saved',
      userId: user._id,
      username: user.username,
      rocketreach: user.locationInfo?.rocketreach,
    });
  } catch (error) {
    logger.error(`Error saving RocketReach location: ${error.message}`);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

/**
 * Create new iterative search
 * POST /api/deep-searches
 * Body: { fromDate, toDate }
 */
router.post('/deep-searches', async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['fromDate', 'toDate'],
      });
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);

    if (from > to) {
      return res.status(400).json({
        error: 'Invalid date range',
        message: 'fromDate must be before toDate',
      });
    }

    // Calculate total days
    const totalDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    // Each day is split into per-term buckets; progress is tracked at the bucket level.
    const termSet = 'alnum2';
    const termCount = iterativeSearchService.generateTerms(termSet).length;
    const totalBuckets = totalDays * termCount;

    const searchId = uuidv4();
    const search = new DeepSearch({
      searchId,
      status: 'pending',
      dateRange: {
        fromDate: from,
        toDate: to,
      },
      totalDays,
      daysProcessed: 0,
      currentIteration: 0,
      termSet,
      totalBuckets,
      bucketsProcessed: 0,
      excludedLocations: [],
      lastFoundLocations: [],
    });

    await search.save();

    requestLogService.logDBOperation(
      'DeepSearch.save',
      { searchId, totalDays, totalBuckets },
      'create',
      0,
      true,
      null
    );

    logger.info(`Iterative search created: ${searchId} (${totalDays} days × ${termCount} terms = ${totalBuckets} buckets)`);

    res.status(201).json(serializeSearch(search));
  } catch (error) {
    logger.error(`Error creating iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to create search' });
  }
});

/**
 * Get iterative search by ID with users
 * GET /api/deep-searches/:id/users
 */
router.get('/deep-searches/:id/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Find by either searchId or MongoDB _id
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Get users from this search
    const total = await User.countDocuments({ 
      'searchIterationHistory.searchId': search._id 
    });

    const users = await User.find({ 
      'searchIterationHistory.searchId': search._id 
    })
      .skip(skip)
      .limit(limit);

    requestLogService.logDBOperation(
      'User.find',
      { searchId: search.searchId, count: users.length },
      'find',
      0,
      true,
      null
    );

    res.json({
      search: serializeSearch(search),
      users,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`Error fetching iterative search users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * Per-search overview metrics for the detail "view" page — a quick "shape of this
 * search's haul": coverage of email/LinkedIn, enrichment progress, and top locations.
 * GET /api/deep-searches/:id/overview
 */
router.get('/deep-searches/:id/overview', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [{ _id: req.params.id }, { searchId: req.params.id }],
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    const scoped = { 'searchIterationHistory.searchId': search._id };
    const withCond = (cond) => User.countDocuments({ $and: [scoped, cond] });

    // Per-user location for Top locations: user.location first, else the user's first
    // FOUND LinkedIn profile location (linkedinText). locationInfo is intentionally ignored.
    const chosenLoc = {
      $let: {
        vars: { gh: { $trim: { input: { $ifNull: ['$location', ''] } } } },
        in: {
          $cond: [
            { $gt: [{ $strLenCP: '$$gh' }, 0] },
            '$$gh',
            {
              $let: {
                vars: {
                  found: {
                    $filter: {
                      input: { $ifNull: ['$linkedinInfo.profiles', []] },
                      as: 'p',
                      cond: { $eq: ['$$p.status', 'found'] },
                    },
                  },
                },
                in: { $ifNull: [{ $arrayElemAt: ['$$found.location.linkedinText', 0] }, ''] },
              },
            },
          ],
        },
      },
    };
    // Heuristic US match (not exact, but useful): "United States", "USA", "U.S.", or a ", US" suffix.
    const US_REGEX = 'united states|u\\.?s\\.?a\\.?|\\bus\\b';

    const [total, withEmail, withLinkedin, withLinkedinUrl, enriched, found, locAgg] =
      await Promise.all([
        User.countDocuments(scoped),
        withCond(PRESENCE_FIELDS.email),
        withCond(PRESENCE_FIELDS.linkedin),
        withCond(HAS_USABLE_LINKEDIN_URL),
        withCond(HAS_LINKEDIN_INFO),
        withCond(HAS_LINKEDIN_INFO_FOUND),
        User.aggregate([
          { $match: scoped },
          { $addFields: { chosenLoc: chosenLoc } },
          {
            $facet: {
              top: [
                { $match: { chosenLoc: { $nin: [null, ''] } } },
                { $group: { _id: '$chosenLoc', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 6 },
              ],
              us: [
                { $match: { chosenLoc: { $regex: US_REGEX, $options: 'i' } } },
                { $count: 'count' },
              ],
            },
          },
        ]),
      ]);

    const facet = locAgg[0] || { top: [], us: [] };

    res.json({
      total,
      withEmail,
      withLinkedin,
      withLinkedinUrl,
      enriched,
      found,
      usCount: facet.us[0]?.count || 0,
      topLocations: (facet.top || []).map((l) => ({ location: l._id, count: l.count })),
    });
  } catch (error) {
    logger.error(`Error computing search overview: ${error.message}`);
    res.status(500).json({ error: 'Failed to compute overview' });
  }
});

/**
 * Get iterative search by ID
 * GET /api/deep-searches/:id
 */
router.get('/deep-searches/:id', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    res.json(serializeSearch(search));
  } catch (error) {
    logger.error(`Error fetching iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch search' });
  }
});

/**
 * Start iterative search execution
 * POST /api/deep-searches/:id/start
 */
router.post('/deep-searches/:id/start', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (search.status === 'in_progress') {
      return res.status(400).json({ error: 'Search is already running' });
    }

    if (search.status === 'completed') {
      return res.status(400).json({ error: 'Search is already completed' });
    }

    // Agent system: generate per-bucket tasks; the manager's agents drain the queue.
    // (No token check here — agents wait on the shared rate limiter when tokens are busy.)
    search.status = 'in_progress';
    search.startedAt = new Date();
    search.pausedAt = null;
    search.error = null;
    search.control = { desired: 'run', requestedAt: new Date() };
    await search.save();

    const totalBuckets = await taskQueue.generateTasksForSearch(search);

    logger.info(`Deep search started: ${search.searchId} — ${totalBuckets} bucket tasks queued`);

    res.json({
      searchId: search.searchId,
      status: search.status,
      totalBuckets,
      message: 'Search started — tasks queued for agents',
    });
  } catch (error) {
    logger.error(`Error starting iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to start search' });
  }
});

/**
 * Pause iterative search
 * POST /api/deep-searches/:id/pause
 */
router.post('/deep-searches/:id/pause', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Pause = hold pending tasks + set desired state. In-flight tasks finish.
    const held = await taskQueue.pauseSearch(search._id);
    await DeepSearch.updateOne({ _id: search._id }, { $set: { pausedAt: new Date() } });

    logger.info(`Deep search paused: ${search.searchId} (${held} tasks held)`);

    res.json({
      searchId: search.searchId,
      status: 'paused',
      message: 'Search paused',
    });
  } catch (error) {
    logger.error(`Error pausing iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to pause search' });
  }
});

/**
 * Resume iterative search
 * POST /api/deep-searches/:id/resume
 */
router.post('/deep-searches/:id/resume', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Any not-completed search can be resumed (failed, paused, pending, or a stuck
    // in_progress left over from a restart). The launch guard below rejects a search
    // that is genuinely still running in this process.
    if (search.status === 'completed') {
      return res.status(400).json({
        error: 'Cannot resume search',
        message: 'Search is already completed',
        currentStatus: search.status,
      });
    }

    // If the search never had tasks generated (e.g. created but never started),
    // generate them now; otherwise release any held tasks back to the queue.
    const existingTasks = await Task.countDocuments({ searchId: search._id });
    if (existingTasks === 0) {
      search.status = 'in_progress';
      search.startedAt = search.startedAt || new Date();
      search.resumedAt = new Date();
      search.error = null;
      search.control = { desired: 'run', requestedAt: new Date() };
      await search.save();
      await taskQueue.generateTasksForSearch(search);
    } else {
      await taskQueue.resumeSearch(search._id);
      await DeepSearch.updateOne({ _id: search._id }, { $set: { resumedAt: new Date(), error: null } });
    }

    logger.info(`Deep search resumed: ${search.searchId}`);

    res.json({
      searchId: search.searchId,
      status: 'in_progress',
      message: 'Search resumed — tasks queued for agents',
    });
  } catch (error) {
    logger.error(`Error resuming iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to resume search' });
  }
});

/**
 * Delete iterative search and associated data
 * DELETE /api/deep-searches/:id
 */
router.delete('/deep-searches/:id', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Cancel queued tasks first so agents stop picking them up, then delete.
    await taskQueue.stopSearch(search._id);
    const deletedTasks = await Task.deleteMany({ searchId: search._id });

    // Delete associated logs
    const deletedLogs = await DeepSearchLog.deleteMany({
      searchId: search._id
    });

    // Delete search
    await DeepSearch.deleteOne({ _id: search._id });
    logger.info(`Deleted ${deletedTasks.deletedCount} tasks for ${search.searchId}`);

    requestLogService.logDBOperation(
      'DeepSearch.deleteOne',
      { searchId: search.searchId, deletedLogs: deletedLogs.deletedCount },
      'delete',
      0,
      true,
      null
    );

    logger.info(`Iterative search deleted: ${search.searchId}`);

    res.json({
      message: 'Search deleted',
      searchId: search.searchId,
      deletedLogs: deletedLogs.deletedCount,
    });
  } catch (error) {
    logger.error(`Error deleting iterative search: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete search' });
  }
});

/**
 * Get iterative search logs
 * GET /api/deep-searches/:id/logs
 */
router.get('/deep-searches/:id/logs', async (req, res) => {
  try {
    const search = await DeepSearch.findOne({
      $or: [
        { _id: req.params.id },
        { searchId: req.params.id },
      ],
    });

    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const logs = await DeepSearchLog.find({ searchId: search._id })
      .sort({ date: 1 });

    res.json({
      searchId: search.searchId,
      totalLogs: logs.length,
      logs,
    });
  } catch (error) {
    logger.error(`Error fetching iterative search logs: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

module.exports = router;
