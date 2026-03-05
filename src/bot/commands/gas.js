import { ethers } from 'ethers';

export function registerGasCommands(bot) {
  bot.command('gas', async (ctx) => {
    const statusMsg = await ctx.reply('⛽ Fetching current gas prices...');

    try {
      await ctx.ensureEngines();

      const analysis = await ctx.session.engines.gasEngine.feeHistory.analyze();

      const report = `
⛽ *Current Gas Prices*

Base Fee: ${ethers.formatUnits(analysis.currentBaseFee, 'gwei')} gwei
Projected: ${ethers.formatUnits(analysis.projectedBaseFee, 'gwei')} gwei
Trend: ${analysis.trend === 'rising' ? '📈' : analysis.trend === 'falling' ? '📉' : '➡️'} ${analysis.trend}

Priority Fee (Median): ${ethers.formatUnits(analysis.medianPriorityFee, 'gwei')} gwei
Priority Fee (Aggressive): ${ethers.formatUnits(analysis.aggressivePriorityFee, 'gwei')} gwei

*Recommended Total*
Auto: ~${ethers.formatUnits(analysis.projectedBaseFee * 15n / 10n + analysis.medianPriorityFee, 'gwei')} gwei
Aggressive: ~${ethers.formatUnits(analysis.projectedBaseFee * 2n + analysis.aggressivePriorityFee, 'gwei')} gwei

Current mode: ${ctx.session.engines.gasEngine.mode}
`;

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, report, { parse_mode: 'Markdown' });

    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed: ${error.message}`);
    }
  });

  bot.command('setgas', async (ctx) => {
    const mode = ctx.match?.trim().toLowerCase();

    if (!['auto', 'aggressive', 'manual'].includes(mode)) {
      await ctx.reply(
        '⛽ *Gas Modes*\n\n' +
        '**auto** - Smart prediction based on network trend\n' +
        '**aggressive** - 2x multiplier for competitive mints\n' +
        '**manual** - Set your own values\n\n' +
        'Usage: /setgas <mode>',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await ctx.ensureEngines();

    if (mode === 'manual') {
      await ctx.reply(
        '⛽ Manual mode enabled\n\n' +
        'Set gas with:\n' +
        '/setmanualgas <maxFeeGwei> <priorityGwei>\n\n' +
        'Example: /setmanualgas 50 2'
      );
    } else {
      ctx.session.engines.gasEngine.setMode(mode);
      await ctx.reply(`✅ Gas mode set to: ${mode}`);
    }
  });

  bot.command('setmanualgas', async (ctx) => {
    const parts = ctx.match?.trim().split(' ');

    if (!parts || parts.length !== 2) {
      await ctx.reply('❌ Usage: /setmanualgas <maxFeeGwei> <priorityGwei>\nExample: /setmanualgas 50 2');
      return;
    }

    const maxFee = parseFloat(parts[0]);
    const priority = parseFloat(parts[1]);

    if (isNaN(maxFee) || isNaN(priority) || !isFinite(maxFee) || !isFinite(priority) || maxFee <= 0 || priority <= 0) {
      await ctx.reply('❌ Invalid values. Both must be positive finite numbers.');
      return;
    }
    
    if (maxFee < priority) {
      await ctx.reply('❌ Max fee must be greater than or equal to priority fee.');
      return;
    }

    // Safety: prevent setting unreasonably high gas prices
    const maxReasonableGwei = 10000; // 10k gwei ceiling
    if (maxFee > maxReasonableGwei || priority > maxReasonableGwei) {
      await ctx.reply(`❌ Gas values too high (max ${maxReasonableGwei} gwei). This would waste ETH.\nIf you really need higher gas, adjust this limit in the code.`);
      return;
    }

    await ctx.ensureEngines();
    ctx.session.engines.gasEngine.setMode('manual');
    ctx.session.engines.gasEngine.setManualParams(maxFee, priority);

    await ctx.reply(
      `✅ Manual gas set:\n\n` +
      `Max Fee: ${maxFee} gwei\n` +
      `Priority: ${priority} gwei`
    );
  });

  bot.command('setmaxgas', async (ctx) => {
    const maxGwei = parseFloat(ctx.match?.trim());

    if (isNaN(maxGwei) || maxGwei <= 0) {
      await ctx.reply('❌ Usage: /setmaxgas <gwei>\nExample: /setmaxgas 100');
      return;
    }

    await ctx.ensureEngines();
    ctx.session.engines.gasEngine.setMaxGasCeiling(maxGwei);

    await ctx.reply(
      `✅ Gas ceiling set to ${maxGwei} gwei\n\n` +
      `Mint will be blocked if gas exceeds this limit`
    );
  });
}
