/**
 * GitHub User Research Tool
 * Main entry point
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const UserSearchService = require('./services/userSearchService');
const EmailExtractorService = require('./services/emailExtractorService');
const Logger = require('./utils/logger');
const { writeJsonFile, sleep } = require('./utils/helpers');
const path = require('path');
const config = require('../config/searchConfig');

const logger = new Logger();

async function main() {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is not set. Please check your .env file.');
    }

    logger.info('================================');
    logger.info('GitHub User Research Tool Started');
    logger.info('================================');
    logger.info(`Account Type: ${config.accountType}`);
    logger.info(`Locations: ${config.locations.join(', ')}`);
    logger.info(`Date Range: ${config.startYear}-${config.endYear}`);
    logger.info('================================');

    // Step 1: Search for users
    logger.info('Step 1: Searching for users...');
    const searchService = new UserSearchService(githubToken);
    const foundUsers = await searchService.executeSearch();

    logger.info(`Step 1 Complete: Found ${foundUsers.length} users`);

    // Step 2: Extract emails from each user
    logger.info('Step 2: Extracting emails for found users...');
    const emailExtractor = new EmailExtractorService(githubToken);
    const usersWithEmails = [];

    for (let i = 0; i < foundUsers.length; i++) {
      try {
        const user = foundUsers[i];
        logger.info(`Processing user ${i + 1}/${foundUsers.length}: ${user.login}`);

        const userData = await emailExtractor.extractEmailsForUser(user);
        usersWithEmails.push(userData);

        // Rate limiting
        await sleep(config.rateLimitDelay);
      } catch (error) {
        logger.error(`Error processing user: ${error.message}`);
      }
    }

    logger.info(`Step 2 Complete: Processed ${usersWithEmails.length} users`);

    // Step 3: Save results
    logger.info('Step 3: Saving results...');
    const outputDir = path.join(__dirname, '../output');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Save user data
    const usersOutputPath = path.join(outputDir, `users-${timestamp}.json`);
    writeJsonFile(usersOutputPath, usersWithEmails);
    logger.info(`Users data saved to: ${usersOutputPath}`);

    // Save search log
    const searchLog = searchService.getSearchLog();
    const logOutputPath = path.join(outputDir, `search-log-${timestamp}.json`);
    writeJsonFile(logOutputPath, searchLog);
    logger.info(`Search log saved to: ${logOutputPath}`);

    // Save summary
    const summary = {
      totalUsersFound: foundUsers.length,
      totalUsersProcessed: usersWithEmails.length,
      totalEmailsExtracted: usersWithEmails.reduce((acc, u) => acc + u.emails.length, 0),
      searchParameters: {
        accountType: config.accountType,
        locations: config.locations,
        startYear: config.startYear,
        endYear: config.endYear,
      },
      generatedAt: new Date().toISOString(),
      outputFiles: {
        users: usersOutputPath,
        searchLog: logOutputPath,
      },
    };

    const summaryPath = path.join(outputDir, `summary-${timestamp}.json`);
    writeJsonFile(summaryPath, summary);
    logger.info(`Summary saved to: ${summaryPath}`);

    logger.info('================================');
    logger.info('GitHub User Research Tool Completed Successfully');
    logger.info('================================');
    logger.info(`\nResults Summary:`);
    logger.info(`- Users Found: ${summary.totalUsersFound}`);
    logger.info(`- Users Processed: ${summary.totalUsersProcessed}`);
    logger.info(`- Total Emails Extracted: ${summary.totalEmailsExtracted}`);
    logger.info(`- Output Directory: ${outputDir}`);
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
