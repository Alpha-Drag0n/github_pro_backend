/**
 * Username Lookup Service (database)
 * ----------------------------------
 * Backs the "Username Search" page: given a list of usernames, find those users
 * in the stored `User` collection (populated by Quick Search and Deep Search) and
 * return one fully-merged profile per username.
 *
 * Why merge? The collection's only unique constraint is the COMPOUND index
 * { username, searchId } (userModel.js), so the SAME GitHub username is stored as
 * a SEPARATE document for every search that found it. Different searches carry
 * different enrichment — Quick Search contributes emails / emailMetadata / readme,
 * Deep Search contributes contactInfo / socialProfiles / locationInfo / linkedinInfo.
 * To answer "show me this user" we gather every document for the username and union
 * them into a single, most-complete record. Nothing is fetched from GitHub.
 */

const User = require('../models/userModel');
const Logger = require('../utils/logger');

const logger = new Logger();

const MAX_USERNAMES = 200; // cap per request

const SOCIAL_KEYS = ['linkedin', 'x', 'facebook', 'instagram', 'youtube', 'tiktok'];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const nonEmpty = (v) =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/** Most-recent-first sort key for a stored User document. */
function recencyKey(d) {
  return new Date(d.extractedAt || d.updatedAt || d.createdAt || 0).getTime();
}

/**
 * Normalise + de-duplicate (case-insensitive) the requested usernames. Accepts a
 * raw string or an array, and tolerates `@handle` and full github.com/<user> URLs.
 * @param {string|string[]} input
 * @returns {string[]} unique usernames in first-seen order
 */
function normaliseUsernames(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    let name = String(raw).trim();
    if (!name) continue;
    name = name.replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    name = name.split(/[/?#]/)[0];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** First non-empty value of `field` across docs (docs already recent-first). */
function pickScalar(docs, field) {
  for (const d of docs) {
    if (nonEmpty(d[field])) return d[field];
  }
  return null;
}

/**
 * Union a list of contact/social items, de-duped by `keyFn`, merging their
 * `sources` arrays. First occurrence (recent-first) wins for the other props.
 */
function mergeWithSources(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    if (!it) continue;
    const key = (keyFn(it) || '').toString();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...it, sources: Array.from(new Set(it.sources || [])) });
    } else if (it.sources?.length) {
      prev.sources = Array.from(new Set([...(prev.sources || []), ...it.sources]));
    }
  }
  return Array.from(map.values());
}

/**
 * Build one unified, de-duplicated email list from all three storage shapes:
 * legacy emails[String], legacy emailMetadata[], and contactInfo.emails[].
 * @returns {{email,sources:string[],lastUsed:(Date|null),confidence:(string|null)}[]}
 */
function buildEmailList(docs) {
  const map = new Map(); // lower(email) -> aggregate
  const add = (rawEmail, source, lastUsed, confidence) => {
    if (!rawEmail) return;
    const email = String(rawEmail).trim();
    if (!email) return;
    const key = email.toLowerCase();
    const cur = map.get(key) || { email, sources: new Set(), lastUsed: null, confidence: null };
    if (source) {
      (Array.isArray(source) ? source : [source]).forEach((s) => s && cur.sources.add(s));
    }
    if (lastUsed && (!cur.lastUsed || new Date(lastUsed) > new Date(cur.lastUsed))) {
      cur.lastUsed = lastUsed;
    }
    if (confidence && !cur.confidence) cur.confidence = confidence;
    map.set(key, cur);
  };

  for (const d of docs) {
    (d.emails || []).forEach((e) => add(e, null, null, null));
    (d.emailMetadata || []).forEach((m) => add(m.email, m.source, m.lastUsed, null));
    (d.contactInfo?.emails || []).forEach((m) => add(m.email || m.value, m.sources, null, m.confidence));
  }

  return Array.from(map.values())
    .map((v) => ({
      email: v.email,
      sources: Array.from(v.sources),
      lastUsed: v.lastUsed,
      confidence: v.confidence,
    }))
    .sort((a, b) => {
      // Most recently used first; addresses with no date sink to the bottom.
      if (!a.lastUsed && !b.lastUsed) return 0;
      if (!a.lastUsed) return 1;
      if (!b.lastUsed) return -1;
      return new Date(b.lastUsed) - new Date(a.lastUsed);
    });
}

/** Union LinkedIn enrichment profiles across docs, de-duped by canonical URL. */
function mergeLinkedin(docs) {
  const profiles = [];
  const seen = new Set();
  let anyFound = false;
  let updatedAt = null;

  for (const d of docs) {
    const info = d.linkedinInfo;
    if (!info) continue;
    if (info.updatedAt && (!updatedAt || new Date(info.updatedAt) > new Date(updatedAt))) {
      updatedAt = info.updatedAt;
    }
    for (const p of info.profiles || []) {
      const key = (p.profileUrl || p.sourceUrl || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      profiles.push(p);
      if (p.status === 'found') anyFound = true;
    }
    if (info.status === 'found') anyFound = true;
  }

  const fallbackStatus = docs.map((d) => d.linkedinInfo?.status).find(nonEmpty) || null;
  if (profiles.length === 0 && !anyFound) {
    return fallbackStatus ? { status: fallbackStatus, profiles: [], updatedAt } : null;
  }
  return { status: anyFound ? 'found' : fallbackStatus || 'not_found', profiles, updatedAt };
}

/** Merge every stored document for one username into a single rich profile. */
function mergeUser(rawDocs) {
  const docs = [...rawDocs].sort((a, b) => recencyKey(b) - recencyKey(a)); // recent-first
  const flat = (sel) => docs.flatMap((d) => sel(d) || []);

  const emailList = buildEmailList(docs);

  const contactInfo = {
    emails: mergeWithSources(flat((d) => d.contactInfo?.emails), (e) => (e.email || e.value || '').toLowerCase()),
    phone: mergeWithSources(flat((d) => d.contactInfo?.phone), (p) => p.number || p.value || ''),
    discord: mergeWithSources(flat((d) => d.contactInfo?.discord), (x) => (x.handle || x.value || '').toLowerCase()),
    telegram: mergeWithSources(flat((d) => d.contactInfo?.telegram), (x) => (x.username || x.value || '').toLowerCase()),
    whatsapp: mergeWithSources(flat((d) => d.contactInfo?.whatsapp), (x) => x.phone || x.value || ''),
  };

  const socialProfiles = {};
  for (const key of SOCIAL_KEYS) {
    socialProfiles[key] = mergeWithSources(
      flat((d) => d.socialProfiles?.[key]),
      (s) => (s.url || s.handle || '').toLowerCase()
    );
  }

  const rocketreach =
    docs.map((d) => d.locationInfo?.rocketreach).find((r) => r && (r.status === 'found' || nonEmpty(r.value))) ||
    docs.map((d) => d.locationInfo?.rocketreach).find(nonEmpty) ||
    null;

  const locationInfo = {
    best: docs.map((d) => d.locationInfo?.best).find(nonEmpty) || null,
    profile: docs.map((d) => d.locationInfo?.profile).find(nonEmpty) || null,
    discovered: mergeWithSources(flat((d) => d.locationInfo?.discovered), (x) => (x.value || '').toLowerCase()),
    rocketreach,
  };

  const hasDeep = docs.some((d) => (d.searchIterationHistory || []).length > 0);
  const hasQuick = docs.some((d) => !((d.searchIterationHistory || []).length > 0));

  return {
    username: docs[0].username,
    status: 'found',
    recordCount: docs.length,
    foundBy: hasDeep && hasQuick ? 'both' : hasDeep ? 'deep' : 'quick',
    searchIds: Array.from(new Set(docs.map((d) => d.searchId).filter(Boolean))),
    extractedAt: docs[0].extractedAt || docs[0].updatedAt || docs[0].createdAt || null,

    displayName: pickScalar(docs, 'displayName'),
    name: pickScalar(docs, 'name'),
    githubUrl: pickScalar(docs, 'githubUrl') || `https://github.com/${docs[0].username}`,
    avatar_url: pickScalar(docs, 'avatar_url'),
    bio: pickScalar(docs, 'bio'),
    company: pickScalar(docs, 'company'),
    blog: pickScalar(docs, 'blog'),
    publicEmail: pickScalar(docs, 'publicEmail'),
    twitter_username: pickScalar(docs, 'twitter_username'),
    location: pickScalar(docs, 'location'),
    followers: pickScalar(docs, 'followers'),
    following: pickScalar(docs, 'following'),
    public_repos: pickScalar(docs, 'public_repos'),
    github_created_at: pickScalar(docs, 'github_created_at'),
    github_updated_at: pickScalar(docs, 'github_updated_at'),
    readme: pickScalar(docs, 'readme'),

    emailList,
    emails: emailList.map((e) => e.email),
    contactInfo,
    socialProfiles,
    locationInfo,
    linkedinInfo: mergeLinkedin(docs),
  };
}

/**
 * Look up a batch of usernames against the stored User collection.
 * @param {string|string[]} input
 * @returns {Promise<{results: object[], stats: object, notFound: string[], limit: number}>}
 */
async function lookupUsernames(input) {
  const requested = normaliseUsernames(input);
  if (requested.length === 0) {
    const err = new Error('Provide at least one username');
    err.code = 'NO_INPUT';
    throw err;
  }

  const capped = requested.slice(0, MAX_USERNAMES);
  const truncated = requested.length - capped.length;

  // Fast path: exact, case-sensitive $in (index-backed on `username`).
  let docs = await User.find({ username: { $in: capped } }).lean();

  // Case-insensitive fallback only for the usernames the fast path missed.
  const haveLower = new Set(docs.map((d) => d.username.toLowerCase()));
  const misses = capped.filter((u) => !haveLower.has(u.toLowerCase()));
  if (misses.length > 0) {
    const ors = misses.map((u) => ({ username: { $regex: `^${escapeRegex(u)}$`, $options: 'i' } }));
    const more = await User.find({ $or: ors }).lean();
    docs = docs.concat(more);
  }

  // De-dupe documents by _id (defensive — fast path + fallback shouldn't overlap).
  const byId = new Map();
  for (const d of docs) byId.set(String(d._id), d);
  docs = Array.from(byId.values());

  // Group every document by lowercased username.
  const groups = new Map();
  for (const d of docs) {
    const key = d.username.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  // Build results in the order the user requested them.
  const results = [];
  const notFound = [];
  for (const u of capped) {
    const group = groups.get(u.toLowerCase());
    if (group && group.length) {
      results.push(mergeUser(group));
    } else {
      results.push({ username: u, status: 'not_found' });
      notFound.push(u);
    }
  }

  const found = results.filter((r) => r.status === 'found');
  const stats = {
    requested: requested.length,
    processed: capped.length,
    truncated,
    matched: found.length,
    notFound: notFound.length,
    totalRecords: docs.length,
    withEmail: found.filter((r) => r.emails.length > 0).length,
    totalEmails: found.reduce((n, r) => n + r.emails.length, 0),
  };

  return { results, stats, notFound, limit: MAX_USERNAMES };
}

module.exports = { lookupUsernames, normaliseUsernames, mergeUser, MAX_USERNAMES };
