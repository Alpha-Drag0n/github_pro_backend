/**
 * Coordinates GitHub token assignment across concurrent searches.
 */

const TokenSelector = require('./tokenSelector');
const Logger = require('../utils/logger');

const logger = new Logger();

/** @type {Map<string, string>} searchId -> tokenId */
const searchAssignments = new Map();

/** @type {Map<string, string>} tokenId -> searchId (exclusive holder while search runs) */
const tokenHolders = new Map();

function normalizeId(id) {
  return id?.toString();
}

function releaseTokenForSearch(searchId) {
  const sid = normalizeId(searchId);
  const tokenId = searchAssignments.get(sid);
  if (!tokenId) {
    return;
  }
  if (tokenHolders.get(tokenId) === sid) {
    tokenHolders.delete(tokenId);
  }
  searchAssignments.delete(sid);
  logger.debug(`Released token assignment for search ${sid}`);
}

function assign(searchId, token) {
  const sid = normalizeId(searchId);
  const tid = normalizeId(token._id);
  releaseTokenForSearch(sid);
  searchAssignments.set(sid, tid);
  tokenHolders.set(tid, sid);
}

/**
 * Prefer a token not held by another search; fall back to round-robin by searchId.
 */
async function assignTokenForSearch(searchId) {
  const tokens = await TokenSelector.getTokensByCreatedAt();
  if (tokens.length === 0) {
    return null;
  }

  const sid = normalizeId(searchId);

  for (const token of tokens) {
    const tid = normalizeId(token._id);
    if (!tokenHolders.has(tid)) {
      assign(sid, token);
      logger.info(`Assigned token ${token.name} to search ${sid}`);
      return token;
    }
  }

  const index =
    Math.abs(sid.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % tokens.length;
  const token = tokens[index];
  assign(sid, token);
  logger.warn(
    `All tokens in use - search ${sid} shares token ${token.name} (index ${index + 1}/${tokens.length})`
  );
  return token;
}

/**
 * Next token in createdAt order for this search; skips tokens held by other searches when possible.
 */
async function selectNextTokenForSearch(currentTokenId, searchId) {
  const tokens = await TokenSelector.getTokensByCreatedAt();
  if (tokens.length === 0) {
    return { token: null, fullCycle: false };
  }

  const sid = normalizeId(searchId);
  const currentIdx = currentTokenId
    ? tokens.findIndex((t) => normalizeId(t._id) === normalizeId(currentTokenId))
    : -1;

  for (let step = 1; step <= tokens.length; step++) {
    const nextIdx = currentIdx < 0 ? step - 1 : (currentIdx + step) % tokens.length;
    const candidate = tokens[nextIdx];
    const tid = normalizeId(candidate._id);
    const holder = tokenHolders.get(tid);

    if (!holder || holder === sid) {
      const fullCycle =
        tokens.length === 1 ||
        (currentIdx >= 0 && currentIdx === tokens.length - 1 && nextIdx === 0);
      assign(sid, candidate);
      return { token: candidate, fullCycle };
    }
  }

  const result = await TokenSelector.selectNextToken(currentTokenId);
  if (result.token) {
    assign(sid, result.token);
  }
  return result;
}

function getAssignedTokenId(searchId) {
  return searchAssignments.get(normalizeId(searchId)) || null;
}

module.exports = {
  assignTokenForSearch,
  selectNextTokenForSearch,
  releaseTokenForSearch,
  getAssignedTokenId,
};
