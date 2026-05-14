/**
 * Logger Utility
 * Handles logging to console and files
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, '../../logs');
    this.ensureLogDir();
    this.logFile = path.join(this.logDir, `search-${new Date().toISOString().split('T')[0]}.log`);
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  log(level, message) {
    const timestamp = this.getTimestamp();
    const formatted = `[${timestamp}] [${level}] ${message}`;

    console.log(formatted);

    // Write to file
    try {
      fs.appendFileSync(this.logFile, formatted + '\n');
    } catch (error) {
      console.error('Error writing to log file:', error.message);
    }
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

  getLogFile() {
    return this.logFile;
  }
}

module.exports = Logger;
