import { ethers } from 'ethers';
import { MINT } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'MintEngine' });

export class MintEngine {
  constructor(walletEngine, txEngine, gasEngine, simEngine) {
    this.walletEngine = walletEngine;
    this.txEngine = txEngine;
    this.gasEngine = gasEngine;
    this.simEngine = simEngine;
    this.killSwitch = false;
  }

  enableKillSwitch() {
    this.killSwitch = true;
    logger.warn('🛑 KILL SWITCH ACTIVATED - All mints will be aborted');
  }

  disableKillSwitch() {
    this.killSwitch = false;
    logger.info('✅ Kill switch disabled');
  }

  async prepareForMint(contractAddress, mintCalldata, mintPrice, walletAddresses) {
    logger.info(`Preparing mint for ${walletAddresses.length} wallets...`);

    const checks = {
      contractCallable: await this.simEngine.checkContractCallable(contractAddress),
      simulations: await this.simEngine.simulateBatch(
        contractAddress,
        mintCalldata,
        walletAddresses,
        mintPrice
      ),
      balances: []
    };

    if (!checks.contractCallable.callable) {
      throw new Error(`Contract not callable: ${checks.contractCallable.reason}`);
    }

    // Check if any simulations succeeded to get gas estimate
    if (checks.simulations.successful.length === 0) {
      logger.warn('No successful simulations, using default gas estimate');
    }
    
    const gasEstimate = checks.simulations.successful[0]?.gas || 300000n;
    const gasParams = await this.gasEngine.getGasParams(gasEstimate);
    
    // Use appropriate gas parameter based on mode (EIP-1559 vs legacy)
    const gasPrice = gasParams.maxFeePerGas || gasParams.gasPrice;
    if (!gasPrice) {
      throw new Error('Gas params missing both maxFeePerGas and gasPrice');
    }
    
    const gasCost = gasEstimate * gasPrice;
    // Use basis points (110% = 1100 bps) to avoid floating point precision loss
    const bufferBps = 1100; // 110% as basis points
    const totalRequired = mintPrice + (gasCost * BigInt(bufferBps) / 1000n);

    for (const address of walletAddresses) {
      const balanceCheck = await this.simEngine.checkWalletBalance(address, totalRequired);
      checks.balances.push({
        address,
        ...balanceCheck
      });
    }

    const report = this.simEngine.generateSimulationReport(
      checks.simulations.successful.concat(checks.simulations.failed),
      checks.balances
    );

    logger.info(`Pre-flight check: ${report.passed}/${report.totalWallets} passed`);

    return {
      ready: report.ready,
      report,
      checks,
      gasParams,
      gasEstimate
    };
  }

  async mintAll(contractAddress, mintCalldata, mintPrice, chainId, gasParams, progressCallback) {
    if (this.killSwitch) {
      throw new Error('Mint aborted: kill switch is active');
    }

    const wallets = Array.from(this.walletEngine.activeWallets.values());
    
    if (wallets.length === 0) {
      throw new Error('No wallets loaded. Call walletEngine.loadWalletsIntoMemory() first.');
    }

    logger.info(`🚀 Starting mint for ${wallets.length} wallets`);

    // Build tx params based on gas params type (EIP-1559 vs legacy)
    const txParams = wallets.map(() => {
      const params = {
        to: contractAddress,
        data: mintCalldata,
        value: mintPrice
      };

      // Add EIP-1559 or legacy gas params
      if (gasParams.maxFeePerGas !== undefined) {
        params.maxFeePerGas = gasParams.maxFeePerGas;
        params.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
      } else if (gasParams.gasPrice !== undefined) {
        params.gasPrice = gasParams.gasPrice;
      } else {
        throw new Error('Gas params must contain either maxFeePerGas or gasPrice');
      }

      if (gasParams.gasLimit) {
        params.gasLimit = gasParams.gasLimit;
      }

      return params;
    });

    const results = {
      total: wallets.length,
      pending: [],
      confirmed: [],
      failed: []
    };

    const batches = [];
    for (let i = 0; i < wallets.length; i += MINT.BATCH_SIZE) {
      batches.push({
        wallets: wallets.slice(i, i + MINT.BATCH_SIZE),
        params: txParams.slice(i, i + MINT.BATCH_SIZE)
      });
    }

    for (const [index, batch] of batches.entries()) {
      if (this.killSwitch) {
        logger.warn('Mint stopped by kill switch');
        break;
      }

      logger.info(`Broadcasting batch ${index + 1}/${batches.length}`);

      const batchResults = await this.txEngine.broadcastBatch(
        batch.wallets,
        batch.params,
        chainId
      );

      results.pending.push(...batchResults.successful);
      results.failed.push(...batchResults.failed);

      if (progressCallback) {
        progressCallback({
          phase: 'broadcasting',
          batchIndex: index + 1,
          totalBatches: batches.length,
          ...results
        });
      }

      if (index < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    logger.info(`Broadcast complete: ${results.pending.length} pending, ${results.failed.length} failed`);

    if (progressCallback) {
      progressCallback({
        phase: 'confirming',
        ...results
      });
    }

    const confirmationPromises = results.pending.map(async (tx) => {
      try {
        const confirmation = await this.txEngine.waitForConfirmation(
          tx.hash,
          MINT.CONFIRMATION_BLOCKS
        );
        
        if (confirmation.status === 'confirmed') {
          results.confirmed.push({
            hash: tx.hash,
            wallet: tx.from,
            tokenId: confirmation.receipt.logs.length > 0 ? 'minted' : null,
            gasUsed: confirmation.receipt.gasUsed.toString()
          });
        } else {
          results.failed.push({
            hash: tx.hash,
            error: 'Transaction reverted'
          });
        }

        if (progressCallback) {
          progressCallback({
            phase: 'confirming',
            ...results
          });
        }

      } catch (error) {
        results.failed.push({
          hash: tx.hash,
          error: error.message
        });
        
        if (progressCallback) {
          progressCallback({
            phase: 'confirming',
            ...results
          });
        }
      }
    });

    const settledResults = await Promise.allSettled(confirmationPromises);
    
    // Check for any unexpected rejections
    const rejections = settledResults.filter(r => r.status === 'rejected');
    if (rejections.length > 0) {
      logger.warn(`${rejections.length} confirmation promises rejected unexpectedly`);
      rejections.forEach(r => logger.error(`Rejection reason: ${r.reason}`));
    }

    logger.info(`✅ Mint complete: ${results.confirmed.length} confirmed, ${results.failed.length} failed`);

    return results;
  }

  async mintSingle(walletAddress, contractAddress, mintCalldata, mintPrice, chainId, gasParams) {
    const wallet = this.walletEngine.getSigningWallet(walletAddress);

    const txParams = {
      to: contractAddress,
      data: mintCalldata,
      value: mintPrice
    };
    
    // Add EIP-1559 or legacy gas params
    if (gasParams.maxFeePerGas !== undefined) {
      txParams.maxFeePerGas = gasParams.maxFeePerGas;
      txParams.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
    } else if (gasParams.gasPrice !== undefined) {
      txParams.gasPrice = gasParams.gasPrice;
    } else {
      throw new Error('Gas params must contain either maxFeePerGas or gasPrice');
    }
    
    if (gasParams.gasLimit) {
      txParams.gasLimit = gasParams.gasLimit;
    }

    const tx = await this.txEngine.broadcastTransaction(wallet, txParams, chainId);
    
    logger.info(`Single mint broadcast: ${tx.hash}`);

    const confirmation = await this.txEngine.waitForConfirmation(tx.hash, MINT.CONFIRMATION_BLOCKS);

    return {
      hash: tx.hash,
      status: confirmation.status,
      receipt: confirmation.receipt
    };
  }

  async scheduleMintForBlock(targetBlock, contractAddress, mintCalldata, mintPrice, chainId, rpcPool, timeoutMs = null) {
    logger.info(`Scheduling mint for block ${targetBlock}`);

    // Calculate timeout based on block time if not provided
    const chain = rpcPool.chain || { blockTime: 12 };
    const MAX_TIMEOUT = 2147483647; // Max setTimeout value (32-bit signed int)
    const calculatedTimeout = targetBlock * chain.blockTime * 1000 * 2; // 2x expected time
    const defaultTimeout = timeoutMs || Math.min(Math.max(3600000, calculatedTimeout), MAX_TIMEOUT);

    return new Promise((resolve, reject) => {
      let checkInterval;
      let timeoutHandle;
      
      // Store cleanup function for external access
      const cleanup = () => {
        if (checkInterval) clearInterval(checkInterval);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for target block'));
      }, defaultTimeout);
      
      checkInterval = setInterval(async () => {
        try {
          if (this.killSwitch) {
            cleanup();
            reject(new Error('Kill switch activated'));
            return;
          }
          
          const currentBlock = await rpcPool.getBlockNumber();
          
          if (currentBlock >= targetBlock) {
            cleanup();
            logger.info(`Target block ${targetBlock} reached!`);
            resolve({ block: currentBlock, ready: true });
          } else {
            logger.debug(`Waiting for block ${targetBlock} (current: ${currentBlock})`);
          }
        } catch (error) {
          cleanup();
          clearTimeout(timeoutHandle);
          reject(error);
        }
      }, 1000);
      
      // Expose cleanup for external cancellation
      this._blockWaitCleanup = cleanup;
    });
  }

  getStats() {
    return {
      killSwitchActive: this.killSwitch,
      gasMode: this.gasEngine.mode,
      walletsLoaded: this.walletEngine.activeWallets.size
    };
  }
}
