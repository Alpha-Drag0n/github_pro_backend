/**
 * Logger Utility
 * Logs to the console only. Persistent logs live in the database (requestLog / healthLog /
 * agent events collections), so nothing is written to disk.
 */

class Logger {
  getTimestamp() {
    return new Date().toISOString();
  }

  log(level, message) {
    console.log(`[${this.getTimestamp()}] [${level}] ${message}`);
  }

  info(message) {
    this.log('INFO', message);
  }

  error(message) {
    this.log('ERROR', message);
  }

  warn(message) {
    this.log('WARN', message);
  }

  debug(message) {
    this.log('DEBUG', message);
  }
}

module.exports = Logger;
