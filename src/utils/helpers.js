/**
 * Helper Functions
 */

/**
 * Sleep function for rate limiting
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract emails from text
 * @param {string} text - Text to search for emails
 * @returns {Array<string>} Array of unique emails found
 */
function extractEmailsFromText(text) {
  if (!text) return [];

  // Email regex pattern
  const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const matches = text.match(emailPattern) || [];

  // Remove duplicates and return
  return [...new Set(matches)];
}

/**
 * Write JSON file
 * @param {string} filePath - File path
 * @param {Object} data - Data to write
 */
function writeJsonFile(filePath, data) {
  const fs = require('fs');
  const dir = require('path').dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Read JSON file
 * @param {string} filePath - File path
 * @returns {Object} Parsed JSON data
 */
function readJsonFile(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  sleep,
  extractEmailsFromText,
  writeJsonFile,
  readJsonFile,
};
