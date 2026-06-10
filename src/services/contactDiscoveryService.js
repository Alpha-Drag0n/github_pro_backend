/**
 * Contact Discovery Service
 *
 * Deep contact/social extraction for a GitHub account: scans the profile text AND every
 * (non-fork) repository's description and full raw README, extracts contacts and social
 * profiles, and records the EXACT source URL for each finding (the README's blob URL, or
 * the repository URL for a description). Nothing in the README is skipped — the raw markdown
 * (including HTML comments and hidden <details> blocks) is fed to the extractor.
 */

const ContactPatternExtractor = require('./contactPatternExtractor');
const Logger = require('../utils/logger');

const logger = new Logger();

// Max repos to scan per user (newest first). 0 = unlimited (scan EVERY repo). Forks are
// skipped by default because a fork's README is the upstream project's content, not this user's.
const MAX_REPOS = parseInt(process.env.CONTACT_MAX_REPOS || '0', 10);
const INCLUDE_FORKS = process.env.CONTACT_INCLUDE_FORKS === 'true';

/**
 * @param {object} client   - GitHubClient (carries the active token)
 * @param {string} username - GitHub login
 * @param {object} [opts]
 * @param {object} [opts.profile] - already-fetched profile ({ bio, blog, company })
 * @param {string} [opts.tag]     - log prefix, e.g. a searchId
 * @param {function} [opts.rotate] - async (reason) => newClient|null. Called on a 401/403/429
 *        during the scan; should rotate the token and return a fresh GitHubClient (or null to
 *        give up). When omitted, token errors just skip that call (best-effort).
 * @returns {Promise<{ contactInfo, socialProfiles, summary, repositoriesChecked, repositoriesScanned, repoLog }>}
 */
async function discoverContacts(client, username, opts = {}) {
  const { profile = null, tag = '', rotate = null } = opts;
  const prefix = `[Contacts]${tag ? ` ${tag}` : ''}`;
  const profileUrl = `https://github.com/${username}`;

  let activeClient = client;
  const isTokenError = (e) => [401, 403, 429].includes(e?.response?.status);
  // Per-call rotation cap: rotate to dodge a rate-limited token, but don't stall the whole
  // search on one repo if every token is throttled — skip it and move on.
  const MAX_ROTATIONS = 8;

  // Run a GitHub call, rotating the token and retrying on auth/rate-limit errors.
  const withRotation = async (fn) => {
    let rotations = 0;
    while (true) {
      try {
        return await fn(activeClient);
      } catch (error) {
        if (rotate && isTokenError(error) && rotations < MAX_ROTATIONS) {
          rotations += 1;
          const next = await rotate(`contact-scan ${error.response?.status}: ${error.message}`);
          if (next) {
            activeClient = next;
            continue;
          }
        }
        throw error;
      }
    }
  };

  /** @type {Array<{text: string, source: string}>} */
  const sources = [];

  // ---- Profile-level text ----
  if (profile) {
    if (profile.bio) sources.push({ text: profile.bio, source: `${profileUrl} (bio)` });
    if (profile.blog) sources.push({ text: profile.blog, source: `${profileUrl} (blog)` });
    if (profile.company) sources.push({ text: profile.company, source: `${profileUrl} (company)` });
  }

  // ---- Repositories ----
  let repos = [];
  try {
    repos = await withRotation((c) => c.getUserRepos(username));
  } catch (error) {
    logger.warn(`${prefix} could not list repos for ${username}: ${error.message}`);
  }

  let candidates = INCLUDE_FORKS ? repos : repos.filter((r) => !r.fork);
  if (MAX_REPOS > 0) {
    candidates = candidates.slice(0, MAX_REPOS);
  }

  logger.info(
    `${prefix} scanning ${username}: ${repos.length} repos found, ${candidates.length} to scan` +
      `${INCLUDE_FORKS ? '' : ' (forks skipped)'}`
  );

  const repoLog = [];

  for (const repo of candidates) {
    // Description → repository URL
    if (repo.description) {
      sources.push({ text: repo.description, source: `${repo.html_url} (description)` });
    }

    // README → exact blob URL, full raw content
    try {
      const readme = await withRotation((c) => c.getReadmeWithMeta(username, repo.name));
      if (readme && readme.content) {
        const readmeUrl = readme.htmlUrl || `${repo.html_url}#readme`;
        sources.push({ text: readme.content, source: readmeUrl });

        // Per-repo diagnostic: what this README yielded on its own.
        const one = ContactPatternExtractor.buildUserContactData([{ text: readme.content, source: readmeUrl }]);
        const hits =
          one.summary.emails + one.summary.phone + one.summary.discord +
          one.summary.telegram + one.summary.whatsapp + one.summary.social;
        if (hits > 0) {
          repoLog.push({ url: readmeUrl, ...one.summary });
          logger.info(
            `${prefix} ${username} ${readmeUrl} → emails=${one.summary.emails} ` +
              `social=${one.summary.social} discord=${one.summary.discord} ` +
              `telegram=${one.summary.telegram} whatsapp=${one.summary.whatsapp} phone=${one.summary.phone}`
          );
        }
      }
    } catch (error) {
      logger.debug(`${prefix} README fetch failed for ${username}/${repo.name}: ${error.message}`);
    }
  }

  // ---- Consolidate across all sources (sources[] on each item hold the exact URLs) ----
  const { contactInfo, socialProfiles, summary } = ContactPatternExtractor.buildUserContactData(sources);

  logger.info(
    `${prefix} ${username} TOTAL → emails=${summary.emails} phone=${summary.phone} ` +
      `discord=${summary.discord} telegram=${summary.telegram} whatsapp=${summary.whatsapp} ` +
      `social=${summary.social} (from ${candidates.length} repos + profile)`
  );

  return {
    contactInfo,
    socialProfiles,
    summary,
    repositoriesChecked: repos.length,
    repositoriesScanned: candidates.length,
    repoLog,
  };
}

module.exports = { discoverContacts };
