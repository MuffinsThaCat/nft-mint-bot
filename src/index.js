import 'dotenv/config';
import { NFTMintBot } from './bot/index.js';
import { Encryption } from './engines/wallet/Encryption.js';
import { registerMintCommands } from './bot/commands/mint.js';
import { registerWalletCommands } from './bot/commands/wallet.js';
import { registerGasCommands } from './bot/commands/gas.js';
import pino from 'pino';
import readline from 'readline';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname'
    }
  } : undefined
});

async function promptForPassword() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Enter database encryption password (min 12 chars): ', (password) => {
      rl.close();
      resolve(password);
    });
  });
}

async function main() {
  logger.info('🤖 NFT Mint Bot Starting...');

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS?.split(',').map(id => id.trim());
  let DB_PASSWORD = process.env.DB_PASSWORD;

  if (!BOT_TOKEN) {
    logger.error('BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!ALLOWED_USER_IDS || ALLOWED_USER_IDS.length === 0) {
    logger.error('ALLOWED_USER_IDS environment variable is required (comma-separated user IDs)');
    process.exit(1);
  }

  if (!DB_PASSWORD) {
    logger.warn('DB_PASSWORD not set in environment, prompting...');
    DB_PASSWORD = await promptForPassword();
  }

  try {
    Encryption.validatePassword(DB_PASSWORD);
  } catch (error) {
    logger.error(`Password validation failed: ${error.message}`);
    process.exit(1);
  }

  logger.info(`Authorized users: ${ALLOWED_USER_IDS.join(', ')}`);

  const bot = new NFTMintBot(BOT_TOKEN, ALLOWED_USER_IDS, DB_PASSWORD);

  registerMintCommands(bot.bot);
  registerWalletCommands(bot.bot);
  registerGasCommands(bot.bot);

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    logger.error(error.stack);
    try {
      await bot.stop();
    } catch (stopError) {
      logger.error(`Error during cleanup: ${stopError.message}`);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    try {
      await bot.stop();
    } catch (stopError) {
      logger.error(`Error during cleanup: ${stopError.message}`);
    }
    process.exit(1);
  });

  await bot.start();
  
  logger.info('✅ Bot is running and ready to receive commands');
  logger.info('Press Ctrl+C to stop');
}

main().catch((error) => {
  logger.error(`Fatal error: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
