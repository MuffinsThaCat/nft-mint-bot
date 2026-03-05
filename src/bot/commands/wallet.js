import { ethers } from 'ethers';
import pino from 'pino';

const logger = pino({ name: 'WalletCommands' });

export function registerWalletCommands(bot) {
  bot.command('genwallets', async (ctx) => {
    const count = parseInt(ctx.match?.trim(), 10);
    
    if (!count || isNaN(count) || count < 1 || count > 100) {
      await ctx.reply('❌ Invalid count. Usage: /genwallets <1-100>');
      return;
    }

    const statusMsg = await ctx.reply(`🔨 Generating ${count} wallets...`);

    try {
      await ctx.ensureEngines();

      const result = ctx.session.engines.walletEngine.generateWallets(count);

      const message = `
✅ *Generated ${count} wallets*

🔐 *MNEMONIC (SAVE THIS SECURELY)*
\`${result.mnemonic}\`

⚠️ *CRITICAL*
• This message will be deleted in 60 seconds
• Save your mnemonic NOW
• Anyone with this can access your funds
• Bot has encrypted copies

Wallets: ${result.wallets.slice(0, 5).map(w => `\`${w.address}\``).join('\n')}
${count > 5 ? `\n...and ${count - 5} more` : ''}

Use /wallets to see all
`;

      const msg = await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, message, { parse_mode: 'Markdown' });

      // Store timeout for cleanup
      const deleteTimeout = setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await ctx.reply('🗑️ Mnemonic message deleted for security');
        } catch (error) {
          logger.error(`Failed to delete mnemonic message: ${error.message}`);
        }
      }, 60000); // Delete after 1 minute
      
      // Add to pending timeouts for cleanup
      if (!ctx.session.pendingTimeouts) ctx.session.pendingTimeouts = [];
      ctx.session.pendingTimeouts.push(deleteTimeout);

    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed: ${error.message}`);
    }
  });

  bot.command('importwallets', async (ctx) => {
    await ctx.reply(
      '📥 *Import Wallets*\n\n' +
      'Reply to this message with a file containing:\n\n' +
      '**Option 1: Mnemonic**\n' +
      'One line with 12 or 24 words\n\n' +
      '**Option 2: Private Keys**\n' +
      'One private key per line\n\n' +
      '⚠️ File will be immediately deleted after import',
      { parse_mode: 'Markdown' }
    );

    ctx.session.awaitingWalletImport = true;
    
    // Auto-clear flag after 5 minutes
    const clearTimeout = setTimeout(() => {
      if (ctx.session.awaitingWalletImport) {
        ctx.session.awaitingWalletImport = false;
        logger.info('Auto-cleared awaitingWalletImport flag due to timeout');
      }
    }, 300000);
    
    if (!ctx.session.pendingTimeouts) ctx.session.pendingTimeouts = [];
    ctx.session.pendingTimeouts.push(clearTimeout);
  });

  bot.on('message:document', async (ctx) => {
    if (!ctx.session.awaitingWalletImport) return;

    const statusMsg = await ctx.reply('📥 Importing wallets...');

    try {
      await ctx.deleteMessage();

      const file = await ctx.getFile();
      
      // Use Grammy's download method instead of constructing URL with token
      const fileBuffer = await file.download();
      const content = fileBuffer.toString('utf-8');

      await ctx.ensureEngines();

      const lines = content.trim().split('\n').map(l => l.trim()).filter(l => l);

      let imported = [];

      if (lines.length === 1 && lines[0].split(' ').length >= 12) {
        const mnemonic = lines[0];
        
        // Validate mnemonic is valid BIP39
        if (!ethers.Mnemonic.isValidMnemonic(mnemonic)) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ Invalid mnemonic phrase. Please check the words and try again.`
          );
          ctx.session.awaitingWalletImport = false;
          return;
        }
        
        // Import first 10 wallets from mnemonic (hardcoded safe default)
        const importCount = 10;
        imported = ctx.session.engines.walletEngine.importFromMnemonic(mnemonic, importCount);
        
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `✅ Imported ${imported.length} wallets from mnemonic`
        );
      } else {
        // Limit private key imports to prevent excessive processing
        if (lines.length > 100) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ Too many private keys (${lines.length}). Maximum 100 keys allowed per import.`
          );
          ctx.session.awaitingWalletImport = false;
          return;
        }
        
        // Validate private keys before importing
        const invalidKeys = lines.filter(line => {
          // Private key must be 64 hex chars (optionally prefixed with 0x)
          const cleaned = line.startsWith('0x') ? line.slice(2) : line;
          return !/^[0-9a-fA-F]{64}$/.test(cleaned);
        });
        
        if (invalidKeys.length > 0) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ Invalid private key format detected. Each key must be 64 hex characters (with optional 0x prefix).\nFirst invalid: ${invalidKeys[0].substring(0, 20)}...`
          );
          ctx.session.awaitingWalletImport = false;
          return;
        }
        
        imported = ctx.session.engines.walletEngine.importFromPrivateKeys(lines);
        
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `✅ Imported ${imported.length} wallets from private keys`
        );
      }

      // Clear flag on success
      ctx.session.awaitingWalletImport = false;

      // Reload wallets into memory immediately after import
      const loadedCount = await ctx.session.engines.walletEngine.loadWalletsIntoMemory(ctx.session.rpcPool);
      logger.info(`Reloaded ${loadedCount} wallets into memory after import`);

    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Import failed: ${error.message}`);
      // Clear flag on error
      ctx.session.awaitingWalletImport = false;
    }
  });

  bot.command('fund', async (ctx) => {
    const amountStr = ctx.match?.trim();
    const amount = parseFloat(amountStr);
    
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Usage: /fund <eth_amount>\nExample: /fund 0.01');
      return;
    }

    await ctx.reply(
      `💰 *Fund Distribution*\n\n` +
      `Amount per wallet: ${amount} ETH\n\n` +
      `Send this exact amount from your master wallet:\n` +
      `\`<your_master_wallet_address>\`\n\n` +
      `Then use /confirmdist to proceed`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('sweep', async (ctx) => {
    const toAddress = ctx.match?.trim();
    
    if (!toAddress || !ethers.isAddress(toAddress)) {
      await ctx.reply('❌ Invalid address. Usage: /sweep <destination_address>');
      return;
    }

    // Show confirmation
    await ctx.ensureEngines();
    const walletCount = Array.from(ctx.session.engines.walletEngine.activeWallets.keys()).length;
    
    await ctx.reply(
      `⚠️ *SWEEP CONFIRMATION*\n\n` +
      `This will sweep ETH from ${walletCount} wallets to:\n` +
      `\`${toAddress}\`\n\n` +
      `Type /confirmsweep to proceed`,
      { parse_mode: 'Markdown' }
    );
    
    ctx.session.pendingSweep = toAddress;
    
    // Auto-clear pending sweep after 2 minutes
    const clearTimeout = setTimeout(() => {
      if (ctx.session.pendingSweep) {
        ctx.session.pendingSweep = null;
        logger.info('Auto-cleared pendingSweep flag due to timeout');
      }
    }, 120000);
    
    if (!ctx.session.pendingTimeouts) ctx.session.pendingTimeouts = [];
    ctx.session.pendingTimeouts.push(clearTimeout);
  });

  bot.command('confirmsweep', async (ctx) => {
    const toAddress = ctx.session.pendingSweep;
    
    if (!toAddress) {
      await ctx.reply('❌ No pending sweep. Use /sweep <address> first.');
      return;
    }

    const statusMsg = await ctx.reply('🧹 Sweeping all wallets...');

    try {
      await ctx.ensureEngines();
      
      // Validate that wallets are loaded into memory
      if (!ctx.session.engines.walletEngine.activeWallets || ctx.session.engines.walletEngine.activeWallets.size === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          '❌ No wallets loaded in memory. Use /wallets to load them first.'
        );
        return;
      }

      const gasParams = await ctx.session.engines.gasEngine.getGasParams();

      const results = await ctx.session.engines.walletEngine.sweepETH(
        toAddress,
        ctx.session.rpcPool,
        gasParams
      );
      
      ctx.session.pendingSweep = null;

      const successful = results.filter(r => r.status === 'pending');
      const failed = results.filter(r => r.status === 'failed');
      const skipped = results.filter(r => r.status === 'skipped');

      const report = `
✅ *Sweep Complete*

Swept: ${successful.length}
Failed: ${failed.length}
Skipped: ${skipped.length} (low balance)

${successful.length > 0 ? `\nTotal swept: ${successful.reduce((sum, r) => {
  const amt = parseFloat(r.amount);
  if (isNaN(amt) || !isFinite(amt)) {
    logger.warn(`Invalid amount in sweep result: ${r.amount}`);
    return sum;
  }
  return sum + amt;
}, 0).toFixed(4)} ETH` : ''}

${successful.slice(0, 5).map(r => `\`${r.hash.substring(0, 16)}...\` (${r.amount} ETH)`).join('\n')}
`;

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });

    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Sweep failed: ${error.message}`);
    }
  });

  bot.command('label', async (ctx) => {
    const input = ctx.match?.trim();
    
    if (!input) {
      await ctx.reply('❌ Usage: /label <address> <label_name>\nExample: /label 0x123... Main Wallet');
      return;
    }

    // Split on first space only to allow multi-word labels
    const parts = input.split(' ');
    if (parts.length < 2) {
      await ctx.reply('❌ Usage: /label <address> <label_name>\nExample: /label 0x123... Main Wallet');
      return;
    }

    const address = parts[0];
    const label = parts.slice(1).join(' ');

    if (!ethers.isAddress(address)) {
      await ctx.reply('❌ Invalid address');
      return;
    }

    try {
      await ctx.ensureEngines();
      ctx.session.engines.walletEngine.updateLabel(address, label);
      await ctx.reply(`✅ Labeled ${address.substring(0, 10)}... as "${label}"`);
    } catch (error) {
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });
}
