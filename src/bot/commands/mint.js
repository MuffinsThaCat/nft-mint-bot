import { ethers } from 'ethers';
import { getChain } from '../../config/chains.js';
import pino from 'pino';

const logger = pino({ name: 'MintCommands' });

export function registerMintCommands(bot) {
  bot.command('history', async (ctx) => {
    const limit = parseInt(ctx.match?.trim(), 10) || 10;
    
    if (limit < 1 || limit > 50) {
      await ctx.reply('❌ Usage: /history [count]\nCount must be between 1-50 (default: 10)');
      return;
    }

    try {
      const txHistory = ctx.db.getTxHistory(limit);

      if (txHistory.length === 0) {
        await ctx.reply('No transaction history found.');
        return;
      }

      let message = `*📜 Transaction History (${txHistory.length})*\n\n`;
      
      for (const tx of txHistory) {
        const date = tx.created_at ? new Date(tx.created_at).toLocaleString() : 'Unknown';
        message += `${tx.status === 1 ? '✅' : '❌'} \`${tx.tx_hash.substring(0, 16)}...\`\n`;
        message += `   Chain: ${tx.chain_id} | Block: ${tx.block_number || 'Pending'}\n`;
        message += `   ${date}\n\n`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });

    } catch (error) {
      await ctx.reply(`❌ Failed to fetch history: ${error.message}`);
    }
  });

  bot.command('analyze', async (ctx) => {
    const contractAddress = ctx.match?.trim();
    
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      await ctx.reply('❌ Invalid address. Usage: /analyze <contract_address>');
      return;
    }

    const statusMsg = await ctx.reply('🔍 Analyzing contract...');

    try {
      await ctx.ensureEngines();
      
      const analysis = await ctx.session.engines.contractResolver.analyzeContract(contractAddress);

      if (!analysis || !analysis.mintFunction) {
        throw new Error('Contract analysis failed - unable to detect mint function');
      }

      let report;

      if (analysis.isSeaDrop) {
        // ── SeaDrop-specific analysis ────────────────────────────
        const sd = await ctx.session.engines.seaDropEngine.analyze(contractAddress);

        const priceStr = sd.publicDrop
          ? ethers.formatEther(sd.publicDrop.mintPrice) + ' ETH'
          : 'Unknown';
        const activeStr = sd.publicDrop == null ? '⚠️ Unknown' : sd.publicDrop.isActive ? '✅ Active' : '❌ Not active';
        const startStr = sd.publicDrop?.startTime
          ? new Date(sd.publicDrop.startTime * 1000).toUTCString()
          : 'Unknown';
        const endStr = sd.publicDrop?.endTime && sd.publicDrop.endTime !== 0
          ? new Date(sd.publicDrop.endTime * 1000).toUTCString()
          : 'No end';
        const maxPerWallet = sd.publicDrop?.maxTotalMintableByWallet === 0 ? 'Unlimited' : (sd.publicDrop?.maxTotalMintableByWallet ?? 'Unknown');
        const feeBps = sd.publicDrop?.feeBps != null ? (sd.publicDrop.feeBps / 100).toFixed(1) + '%' : 'Unknown';

        report = `
*📊 Contract Analysis — SeaDrop*

Address: \`${analysis.address}\`
${analysis.isProxy ? `Implementation: \`${analysis.implementationAddress}\`` : ''}
Type: ${analysis.ercType || 'Unknown'}

🌊 *SeaDrop Detected*
SeaDrop Contract: \`${sd.seaDropAddress}\`

*Public Mint*
Status: ${activeStr}
Price: ${priceStr}
Max Per Wallet: ${maxPerWallet}
Fee: ${feeBps}
Start: ${startStr}
End: ${endStr}

*Fee Recipients*
${sd.feeRecipients.length > 0 ? sd.feeRecipients.map(r => `  \`${r}\``).join('\n') : '❌ None configured'}

*Allowlist*
${sd.allowList.hasMerkleRoot ? `✅ Active (root: \`${sd.allowList.merkleRoot.substring(0, 18)}...\`)` : '❌ No allowlist'}
${sd.allowList.allowListURI ? `URI: ${sd.allowList.allowListURI.length > 60 ? sd.allowList.allowListURI.substring(0, 60) + '...' : sd.allowList.allowListURI}` : ''}

${sd.mintStats ? `*Supply*\nMinted: ${sd.mintStats.currentTotalSupply} / ${sd.mintStats.maxSupply}` : ''}

*Actions*
/setcontract ${contractAddress} - Set as active
/watch ${contractAddress} - Monitor until mint opens
`;
      } else {
        // ── Standard contract analysis ───────────────────────────
        report = `
*📊 Contract Analysis*

Address: \`${analysis.address}\`
${analysis.isProxy ? `Implementation: \`${analysis.implementationAddress}\`` : ''}
Type: ${analysis.ercType || 'Unknown'}

*Mint Function*
Name: \`${analysis.mintFunction.name}\`
Inputs: ${analysis.mintFunction.inputs?.length || 0}
${analysis.mintFunction.inputs?.map(i => `  • ${i.name || 'arg'} (${i.type})`).join('\n') || 'None'}

*Contract State*
Price: ${analysis.state?.mintPrice || 'Unknown'}
Max Supply: ${analysis.state?.maxSupply || 'Unknown'}
Paused: ${analysis.state?.paused === null ? 'Unknown' : analysis.state?.paused ? '❌ Yes' : '✅ No'}
Max Per Wallet: ${analysis.state?.maxPerWallet || 'Unknown'}
Whitelist: ${analysis.state?.supportsWhitelist ? '✅ Supported' : '❌ Not detected'}

*Actions*
/setcontract ${contractAddress} - Set as active
/watch ${contractAddress} - Monitor until mint opens
`;
      }

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });

    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ Analysis failed\n\nContract: \`${contractAddress}\`\nChain: ${ctx.session.activeChain}\n\nError: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.command('setcontract', async (ctx) => {
    const contractAddress = ctx.match?.trim();
    
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      await ctx.reply('❌ Invalid address. Usage: /setcontract <address>');
      return;
    }

    ctx.session.activeContract = contractAddress;
    ctx.db.saveSession(ctx.session.userId.toString(), {
      activeChain: ctx.session.activeChain,
      activeContract: contractAddress
    });

    await ctx.reply(`✅ Active contract set to:\n\`${contractAddress}\``);
  });

  bot.command('simulate', async (ctx) => {
    if (!ctx.session.activeContract) {
      await ctx.reply('❌ No active contract. Use /setcontract <address> first.');
      return;
    }

    const statusMsg = await ctx.reply('🧪 Running simulation...');

    try {
      await ctx.ensureEngines();

      const analysis = await ctx.session.engines.contractResolver.analyzeContract(ctx.session.activeContract);
      const wallets = Array.from(ctx.session.engines.walletEngine.activeWallets.keys());

      if (wallets.length === 0) {
        throw new Error('No wallets available. Generate or import wallets first.');
      }

      let simTarget, calldata, mintPrice;

      if (analysis.isSeaDrop) {
        // ── SeaDrop path: simulate against SeaDrop contract ──────
        const sdMint = await ctx.session.engines.seaDropEngine.buildPublicMintCalldata(
          ctx.session.activeContract, 1
        );
        simTarget = sdMint.to;
        calldata  = sdMint.calldata;
        mintPrice = sdMint.value;
      } else {
        // ── Standard path ────────────────────────────────────────
        const mintArgs = await ctx.session.engines.contractResolver.detectMintArguments(
          ctx.session.activeContract,
          analysis.abi,
          analysis.mintFunction,
          wallets[0]
        );
        calldata  = ctx.session.engines.contractResolver.buildMintCalldata(analysis.mintFunction, mintArgs);
        simTarget = ctx.session.activeContract;
        mintPrice = analysis.state.mintPriceWei ? BigInt(analysis.state.mintPriceWei) : 0n;
      }

      const simResults = await ctx.session.engines.simEngine.simulateBatch(
        simTarget,
        calldata,
        wallets,
        mintPrice
      );

      if (simResults.successful.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ All simulations failed. Check contract configuration and wallet balances.`
        );
        return;
      }

      const estimatedGas = simResults.successful[0]?.gas || 300000n;
      const gasParams = await ctx.session.engines.gasEngine.getGasParams(estimatedGas);

      if (!gasParams.maxFeePerGas && !gasParams.gasPrice) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ Failed to get gas parameters. Check network connection.`
        );
        return;
      }

      const gasCost = estimatedGas * (gasParams.maxFeePerGas || gasParams.gasPrice);
      const totalCost = mintPrice + gasCost;

      const balanceChecks = [];
      for (const address of wallets.slice(0, 5)) {
        try {
          const check = await ctx.session.engines.simEngine.checkWalletBalance(address, totalCost);
          balanceChecks.push(check);
        } catch (error) {
          logger.warn(`Failed to check balance for ${address}: ${error.message}`);
          balanceChecks.push({
            sufficient: false,
            balance: 'Error',
            required: ethers.formatEther(totalCost),
            shortfall: 'unknown',
            error: error.message
          });
        }
      }

      const report = `
*🧪 Simulation Results${analysis.isSeaDrop ? ' (SeaDrop)' : ''}*

Total Wallets: ${wallets.length}
✅ Passed: ${simResults.successful.length}
❌ Failed: ${simResults.failed.length}
${analysis.isSeaDrop ? `\nTarget: \`${simTarget}\` (SeaDrop)` : ''}

*Cost Per Wallet*
Mint Price: ${ethers.formatEther(mintPrice)} ETH
Est Gas: ${ethers.formatEther(gasCost)} ETH
Total: ${ethers.formatEther(totalCost)} ETH

*Balance Check (first 5)*
${balanceChecks.map(b => 
  `${b.sufficient ? '✅' : '❌'} ${b.balance} ETH ${!b.sufficient ? `(need ${b.shortfall} more)` : ''}`
).join('\n')}

${simResults.failed.length > 0 ? `\n*Failures*\n${simResults.failed.slice(0, 3).map(f => `• ${f.error}`).join('\n')}` : ''}

${simResults.allPassed && balanceChecks.every(b => b.sufficient) ? '\n✅ *READY TO MINT*' : '\n⚠️ *Issues detected - review above*'}
`;

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });

    } catch (error) {
      const walletCount = ctx.session.engines?.walletEngine?.activeWallets?.size || 0;
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ Simulation failed\n\nContract: \`${ctx.session.activeContract}\`\nChain: ${ctx.session.activeChain}\nWallets: ${walletCount}\n\nError: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.command('mintall', async (ctx) => {
    if (!ctx.session.activeContract) {
      await ctx.reply('❌ No active contract. Use /setcontract <address> first.');
      return;
    }

    await ctx.reply('🚀 *PREPARING MINT*\n\nAnalyzing contract and preparing wallets...', { parse_mode: 'Markdown' });

    try {
      await ctx.ensureEngines();

      const analysis = await ctx.session.engines.contractResolver.analyzeContract(ctx.session.activeContract);
      const wallets = Array.from(ctx.session.engines.walletEngine.activeWallets.keys());

      if (wallets.length === 0) {
        throw new Error('No wallets available. Generate or import wallets first.');
      }

      let mintTarget, calldata, mintPrice;

      if (analysis.isSeaDrop) {
        // ── SeaDrop path ─────────────────────────────────────────
        // Public mint: same calldata for all wallets (minterIfNotPayer = 0x0 → msg.sender)
        const sdMint = await ctx.session.engines.seaDropEngine.buildPublicMintCalldata(
          ctx.session.activeContract, 1
        );
        mintTarget = sdMint.to;       // SeaDrop contract, NOT the NFT
        calldata   = sdMint.calldata;
        mintPrice  = sdMint.value;

        logger.info(`SeaDrop mint: target=${mintTarget}, feeRecipient=${sdMint.feeRecipient}, price=${ethers.formatEther(mintPrice)} ETH`);
      } else {
        // ── Standard path ────────────────────────────────────────
        const mintArgs = await ctx.session.engines.contractResolver.detectMintArguments(
          ctx.session.activeContract,
          analysis.abi,
          analysis.mintFunction,
          wallets[0]
        );
        calldata   = ctx.session.engines.contractResolver.buildMintCalldata(analysis.mintFunction, mintArgs);
        mintTarget = ctx.session.activeContract;
        mintPrice  = analysis.state.mintPriceWei ? BigInt(analysis.state.mintPriceWei) : 0n;
      }

      const prep = await ctx.session.engines.mintEngine.prepareForMint(
        mintTarget,
        calldata,
        mintPrice,
        wallets
      );

      if (!prep.ready) {
        await ctx.reply(
          `⚠️ *Pre-flight check FAILED*\n\n${prep.report.passed}/${prep.report.totalWallets} passed\n\nIssues:\n${JSON.stringify(prep.report.failureReasons, null, 2)}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await ctx.reply(
        `✅ *Pre-flight check PASSED${analysis.isSeaDrop ? ' (SeaDrop)' : ''}*\n\n` +
        `${prep.report.passed}/${prep.report.totalWallets} wallets ready\n` +
        `${analysis.isSeaDrop ? `Target: \`${mintTarget}\`\n` : ''}` +
        `\nStarting mint in 3 seconds...\n\nUse /stop to cancel`,
        { parse_mode: 'Markdown' }
      );

      // Configurable delay via env var, default 3s
      let delayMs = parseInt(process.env.MINT_DELAY_MS, 10) || 3000;
      // Validate bounds: must be positive and reasonable (max 60s)
      if (isNaN(delayMs) || delayMs < 100 || delayMs > 60000) {
        logger.warn(`Invalid MINT_DELAY_MS: ${delayMs}, using default 3000ms`);
        delayMs = 3000;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));

      const progressMsg = await ctx.reply('🚀 *MINT IN PROGRESS*\n\nPending: 0\nConfirmed: 0\nFailed: 0', { parse_mode: 'Markdown' });

      const chain = getChain(ctx.session.activeChain);

      const results = await ctx.session.engines.mintEngine.mintAll(
        mintTarget,
        calldata,
        mintPrice,
        chain.id,
        prep.gasParams,
        async (progress) => {
          const status = `
🚀 *MINT ${progress.phase === 'broadcasting' ? 'BROADCASTING' : 'CONFIRMING'}*

Pending: ${progress.pending.length}
Confirmed: ${progress.confirmed.length}
Failed: ${progress.failed.length}
Total: ${progress.total}
`;
          try {
            await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, status, { parse_mode: 'Markdown' });
          } catch (error) {
            // Telegram API errors during rapid updates (message not modified, rate limit, etc.)
            // Log but don't fail the mint operation
            logger.debug(`Progress update failed: ${error.message}`);
          }
        }
      );

      // Stop all transaction monitoring
      ctx.session.engines.txEngine.stopAllMonitoring();
      
      const finalReport = `
✅ *MINT COMPLETE${analysis.isSeaDrop ? ' (SeaDrop)' : ''}*

Total: ${results.total}
Confirmed: ${results.confirmed.length}
Failed: ${results.failed.length}

${results.confirmed.length > 0 ? `\n*Confirmed Transactions*\n${results.confirmed.slice(0, 5).map(tx => `\`${tx.hash.substring(0, 16)}...\``).join('\n')}` : ''}

${results.failed.length > 0 ? `\n*Failed*\n${results.failed.slice(0, 3).map(f => `• ${f.error || 'Unknown'}`).join('\n')}` : ''}

View on ${chain.blockExplorer}
`;

      await ctx.reply(finalReport, { parse_mode: 'Markdown' });

    } catch (error) {
      // Stop monitoring on error too
      if (ctx.session.engines?.txEngine) {
        ctx.session.engines.txEngine.stopAllMonitoring();
      }
      
      const walletCount = ctx.session.engines?.walletEngine?.activeWallets?.size || 0;
      await ctx.reply(
        `❌ *Mint failed*\n\n` +
        `Contract: \`${ctx.session.activeContract}\`\n` +
        `Chain: ${ctx.session.activeChain}\n` +
        `Wallets: ${walletCount}\n\n` +
        `Error: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.command('stop', async (ctx) => {
    await ctx.ensureEngines();
    ctx.session.engines.mintEngine.enableKillSwitch();
    await ctx.reply('🛑 *KILL SWITCH ACTIVATED*\n\nAll pending mints will be aborted.\n\nUse /resume to re-enable minting.', { parse_mode: 'Markdown' });
  });

  bot.command('resume', async (ctx) => {
    await ctx.ensureEngines();
    ctx.session.engines.mintEngine.disableKillSwitch();
    await ctx.reply('✅ *KILL SWITCH DISABLED*\n\nMinting is now enabled.', { parse_mode: 'Markdown' });
  });

  bot.command('clearwatchers', async (ctx) => {
    try {
      await ctx.ensureEngines();
      ctx.session.engines.monitorEngine.stopAll();
      await ctx.reply('✅ Stopped all active watchers');
    } catch (error) {
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  bot.command('unwatch', async (ctx) => {
    const contractAddress = ctx.match?.trim();
    
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      await ctx.reply('❌ Invalid address. Usage: /unwatch <contract_address>');
      return;
    }

    try {
      await ctx.ensureEngines();
      ctx.session.engines.monitorEngine.stopWatching(contractAddress);
      await ctx.reply(`✅ Stopped watching \`${contractAddress}\``, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  bot.command('watch', async (ctx) => {
    const contractAddress = ctx.match?.trim();
    
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      await ctx.reply('❌ Invalid address. Usage: /watch <contract_address>');
      return;
    }

    const statusMsg = await ctx.reply('👁️ Setting up watcher...');

    try {
      await ctx.ensureEngines();

      const analysis = await ctx.session.engines.contractResolver.analyzeContract(contractAddress);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `👁️ *Watching contract*\n\nAddress: \`${contractAddress}\`\nCurrent state: ${analysis.state.paused ? 'Paused ❌' : 'Active ✅'}\n\nWill notify when mint opens...\n\nUse /unwatch ${contractAddress} to stop`,
        { parse_mode: 'Markdown' }
      );

      ctx.session.engines.monitorEngine.watchContract(contractAddress, analysis.abi, {
        onMintOpen: async (data) => {
          try {
            await ctx.reply(
              `🚀 *MINT OPENED!*\n\nContract: \`${contractAddress}\`\nBlock: ${data.block}\n\nUse /mintall to execute!`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            logger.error(`Failed to send mint opened notification: ${error.message}`);
          }
        },
        onStateChange: async (change) => {
          try {
            await ctx.reply(
              `📊 State change: ${change.property} changed\nBlock: ${change.block}`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            logger.error(`Failed to send state change notification: ${error.message}`);
          }
        }
      });

    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ Watch failed: ${error.message}`
      );
    }
  });
}
