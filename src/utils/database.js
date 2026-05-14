/**
 * MongoDB Connection Manager
 */

const mongoose = require('mongoose');
const Logger = require('./logger');

const logger = new Logger();

class Database {
  static async connect(mongoUri) {
    try {
      const uri = mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/github-user-research';

      await mongoose.connect(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });

      logger.info(`Connected to MongoDB: ${uri}`);
      return true;
    } catch (error) {
      logger.error(`Failed to connect to MongoDB: ${error.message}`);
      throw error;
    }
  }

  static async disconnect() {
    try {
      await mongoose.disconnect();
      logger.info('Disconnected from MongoDB');
    } catch (error) {
      logger.error(`Failed to disconnect from MongoDB: ${error.message}`);
    }
  }

  static isConnected() {
    return mongoose.connection.readyState === 1;
  }
}

module.exports = Database;
