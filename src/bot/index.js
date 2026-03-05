import { Bot, session } from 'grammy';
import { WalletDatabase } from '../storage/Database.js';
import { RpcPool } from '../rpc/RpcPool.js';
import { WalletEngine } from '../engines/wallet/WalletEngine.js';
import { Encryption } from '../engines/wallet/Encryption.js';
import { GasEngine } from '../engines/gas/GasEngine.js';
import { TxEngine } from '../engines/tx/TxEngine.js';
import { ContractResolver } from '../engines/mint/ContractResolver.js';
import { SimEngine } from '../engines/mint/SimEngine.js';
import { MintEngine } from '../engines/mint/MintEngine.js';
import { MonitorEngine } from '../engines/monitor/MonitorEngine.js';
import { MerkleEngine } from '../engines/strategy/MerkleEngine.js';
import { StrategyEngine } from '../engines/strategy/StrategyEngine.js';
import { getChain } from '../config/chains.js';
import pino from 'pino';

const logger = pino({ name: 'TelegramBot' });

export class NFTMintBot {
  constructor(botToken, allowedUserIds, dbPassword) {
    if (!botToken) {
      throw new Error('BOT_TOKEN is required');
    }

    if (!allowedUserIds || allowedUserIds.length === 0) {
      throw new Error('ALLOWED_USER_IDS is required');
    }

    this.bot = new Bot(botToken);
    this.allowedUserIds = new Set(
      allowedUserIds
        .map(id => parseInt(id, 10))
        .filter(id => !isNaN(id))
    );
    
    if (this.allowedUserIds.size === 0) {
      throw new Error('No valid user IDs in ALLOWED_USER_IDS');
    }
    
    this.db = new WalletDatabase();
    this.encryption = new Encryption(dbPassword);
    
    this.sessions = new Map();
    this.sessionCleanupInterval = null;
    this.commandCooldowns = new Map(); // userId -> lastCommandTime
    
    this._setupMiddleware();
    this._setupCommands();
    
    logger.info(`Bot initialized for ${this.allowedUserIds.size} authorized users`);
  }

  _setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;

      if (!userId || !this.allowedUserIds.has(userId)) {
        logger.warn(`Unauthorized access attempt from user ${userId}`);
        return;
      }

      // Rate limiting: 500ms cooldown between commands
      const now = Date.now();
      const lastCommandTime = this.commandCooldowns.get(userId) || 0;
      if (now - lastCommandTime < 500) {
        logger.debug(`Rate limit triggered for user ${userId}`);
        return; // Silently ignore rapid commands
      }
      this.commandCooldowns.set(userId, now);

      if (!this.sessions.has(userId)) {
        const savedSession = this.db.getSession(userId.toString());
        
        this.sessions.set(userId, {
          userId,
          activeChain: savedSession?.activeChain || 'ethereum',
          activeContract: savedSession?.activeContract || null,
          rpcPool: null,
          engines: {},
          mintStatus: null,
          pendingTimeouts: []
        });
      }

      ctx.session = this.sessions.get(userId);
      ctx.session.lastActivity = Date.now();
      ctx.db = this.db;
      ctx.ensureEngines = async () => {
        await this._ensureEngines(ctx);
      };

      await next();
    });

    this.bot.catch((err) => {
      logger.error(`Bot error: ${err.message}`);
    });
  }

  _setupCommands() {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Welcome to NFT Mint Bot!\n\n` +
        `Use /help to see all available commands\n` +
        `Use /status to see current configuration`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('help', async (ctx) => {
      const helpText = `
*📚 NFT Mint Bot - Commands*

*🔧 Setup*
/chain <name> - Switch chain (ethereum, base, arbitrum, polygon, optimism)
/password - Set encryption password (required first time)

*💼 Wallets*
/genwallets <n> - Generate n new wallets
/importwallets - Import from file (send .txt/.csv after)
/wallets - List all wallets with balances
/label <address> <name> - Label a wallet
/fund <amount> - Distribute ETH to all wallets
/sweep - Collect all ETH back to master wallet

*📊 Contract Analysis*
/analyze <address> - Full contract analysis
/setcontract <address> - Set active mint contract
/watch <address> - Monitor until mint opens
/simulate - Dry run on all wallets

*⛽ Gas*
/gas - Current network gas prices
/setgas <mode> - Set gas mode (auto/aggressive/manual)
/setmaxgas <gwei> - Set gas price ceiling

*🎯 Strategy*
/setrule <key> <value> - Set strategy rule
/rules - View active rules
/schedule <block> - Schedule mint for specific block

*🚀 Mint*
/mintall - Fire all wallets simultaneously
/mint <address> - Fire specific wallet
/stop - Emergency kill switch

*📜 Whitelist*
/uploadwl - Upload whitelist CSV
/wlcheck - Check which wallets are whitelisted

*📈 History*
/history - Recent transaction history
/status - Bot status and statistics
`;
      await ctx.reply(helpText, { parse_mode: 'Markdown' });
    });

    this.bot.command('chain', async (ctx) => {
      const chainName = ctx.match?.toLowerCase();
      
      if (!chainName) {
        await ctx.reply(
          `Current chain: ${ctx.session.activeChain}\n\n` +
          `Available: ethereum, base, arbitrum, polygon, optimism\n\n` +
          `Usage: /chain <name>`
        );
        return;
      }

      try {
        const chain = getChain(chainName);
        
        // Cleanup old engines before switching
        await this._cleanupSession(ctx.session);
        
        // Clear activeWallets from old WalletEngine
        if (ctx.session.engines?.walletEngine) {
          ctx.session.engines.walletEngine.activeWallets.clear();
        }
        
        ctx.session.activeChain = chainName;
        ctx.session.rpcPool = null;
        ctx.session.engines = {}; // Reset all engines
        
        this.db.saveSession(ctx.session.userId.toString(), {
          activeChain: chainName,
          activeContract: ctx.session.activeContract
        });

        await ctx.reply(`✅ Switched to ${chain.name}\n\nAll engines reset for new chain.`);
      } catch (error) {
        await ctx.reply(`❌ ${error.message}`);
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const chain = getChain(ctx.session.activeChain);
        const walletCount = this.db.getAllWallets().length;
        const killSwitchStatus = ctx.session.engines?.mintEngine?.killSwitch ? '🛑 ACTIVE' : '✅ Disabled';
        
        const statusText = `
*🤖 Bot Status*

Chain: ${chain.name}
Wallets: ${walletCount}
Active Contract: ${ctx.session.activeContract || 'None'}
Kill Switch: ${killSwitchStatus}
`;
        
        await ctx.reply(statusText, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error(`Error in /status command: ${error.message}`);
        await ctx.reply(`❌ Error getting status: ${error.message}`);
      }
    });

    this.bot.command('wallets', async (ctx) => {
      try {
        const wallets = this.db.getAllWallets();
        
        if (wallets.length === 0) {
          await ctx.reply('No wallets found. Use /genwallets <n> to create some.');
          return;
        }

        await ctx.ensureEngines();
        const balances = await ctx.session.engines.walletEngine.getBalances(ctx.session.rpcPool);

        let message = `*💼 Your Wallets (${wallets.length})*\n\n`;
        
        for (let i = 0; i < Math.min(wallets.length, 20); i++) {
          const wallet = wallets[i];
          const balance = balances.find(b => b.address.toLowerCase() === wallet.address.toLowerCase());
          
          message += `${i + 1}. \`${wallet.address.substring(0, 10)}...${wallet.address.substring(38)}\`\n`;
          message += `   Balance: ${balance?.balance || '0'} ETH\n`;
          if (wallet.label) message += `   Label: ${wallet.label}\n`;
          message += '\n';
        }

        if (wallets.length > 20) {
          message += `\n_...and ${wallets.length - 20} more_`;
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error(`Error in /wallets command: ${error.message}`);
        await ctx.reply(`❌ Error loading wallets: ${error.message}`);
      }
    });
  }

  async _ensureEngines(ctx) {
    // Make engines accessible for commands
    if (!ctx.session.rpcPool) {
      try {
        const chain = getChain(ctx.session.activeChain);
        ctx.session.rpcPool = new RpcPool(chain);
      } catch (error) {
        // Reset to ethereum if invalid chain
        logger.warn(`Invalid chain ${ctx.session.activeChain}, resetting to ethereum`);
        ctx.session.activeChain = 'ethereum';
        const chain = getChain('ethereum');
        ctx.session.rpcPool = new RpcPool(chain);
      }
    }

    if (!ctx.session.engines.walletEngine) {
      ctx.session.engines.walletEngine = new WalletEngine(
        this.db,
        this.encryption
      );
      await ctx.session.engines.walletEngine.loadWalletsIntoMemory(ctx.session.rpcPool);
    } else {
      // Check if wallets need reload (e.g., after chain switch cleared activeWallets)
      if (ctx.session.engines.walletEngine.activeWallets.size === 0) {
        const walletCount = this.db.getAllWallets().length;
        if (walletCount > 0) {
          logger.info('Reloading wallets into memory after chain switch');
          await ctx.session.engines.walletEngine.loadWalletsIntoMemory(ctx.session.rpcPool);
        }
      }
    }

    if (!ctx.session.engines.gasEngine) {
      const chain = getChain(ctx.session.activeChain);
      ctx.session.engines.gasEngine = new GasEngine(ctx.session.rpcPool, chain);
    }

    if (!ctx.session.engines.txEngine) {
      ctx.session.engines.txEngine = new TxEngine(
        ctx.session.rpcPool,
        ctx.session.engines.walletEngine.nonceManager,
        this.db
      );
    }

    if (!ctx.session.engines.contractResolver) {
      const chain = getChain(ctx.session.activeChain);
      ctx.session.engines.contractResolver = new ContractResolver(ctx.session.rpcPool, chain);
    }

    if (!ctx.session.engines.simEngine) {
      ctx.session.engines.simEngine = new SimEngine(ctx.session.rpcPool);
    }

    if (!ctx.session.engines.mintEngine) {
      ctx.session.engines.mintEngine = new MintEngine(
        ctx.session.engines.walletEngine,
        ctx.session.engines.txEngine,
        ctx.session.engines.gasEngine,
        ctx.session.engines.simEngine
      );
    }

    if (!ctx.session.engines.monitorEngine) {
      ctx.session.engines.monitorEngine = new MonitorEngine(
        ctx.session.rpcPool,
        ctx.session.engines.contractResolver
      );
    }

    if (!ctx.session.engines.merkleEngine) {
      ctx.session.engines.merkleEngine = new MerkleEngine(this.db);
    }

    if (!ctx.session.engines.strategyEngine) {
      ctx.session.engines.strategyEngine = new StrategyEngine(this.db);
    }
  }

  async start() {
    logger.info('Starting Telegram bot...');
    await this.bot.start();
    
    // Start session cleanup interval (check every 5 minutes)
    this.sessionCleanupInterval = setInterval(() => {
      this._cleanupInactiveSessions();
    }, 300000);
    
    logger.info('Bot is running');
  }

  async _cleanupInactiveSessions() {
    const now = Date.now();
    const timeout = 1800000; // 30 minutes
    
    const cleanupPromises = [];
    
    for (const [userId, session] of this.sessions.entries()) {
      if (session.lastActivity && now - session.lastActivity > timeout) {
        logger.info(`Cleaning up inactive session for user ${userId}`);
        const cleanupPromise = this._cleanupSession(session)
          .then(() => {
            this.sessions.delete(userId);
            logger.info(`Session ${userId} cleaned and removed`);
          })
          .catch(err => {
            logger.error(`Error cleaning up session ${userId}: ${err.message}`);
          });
        cleanupPromises.push(cleanupPromise);
      }
    }
    
    // Wait for all cleanups to complete
    await Promise.allSettled(cleanupPromises);
  }

  async stop() {
    logger.info('Stopping bot...');
    
    // Stop session cleanup interval
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = null;
    }
    
    // Cleanup all session engines
    for (const [userId, session] of this.sessions.entries()) {
      try {
        await this._cleanupSession(session);
        logger.info(`Cleaned up session for user ${userId}`);
      } catch (error) {
        logger.error(`Error cleaning up session ${userId}: ${error.message}`);
      }
    }
    
    await this.bot.stop();
    this.db.close();
    logger.info('Bot stopped and all resources cleaned');
  }

  async _cleanupSession(session) {
    if (session.engines) {
      // Stop all monitors
      if (session.engines.monitorEngine) {
        session.engines.monitorEngine.stopAll();
      }
      
      // Stop all transaction monitoring
      if (session.engines.txEngine) {
        session.engines.txEngine.stopAllMonitoring();
      }
      
      // Clear any pending timeouts
      if (session.pendingTimeouts) {
        for (const timeout of session.pendingTimeouts) {
          clearTimeout(timeout);
        }
        session.pendingTimeouts = [];
      }
    }
  }
}
