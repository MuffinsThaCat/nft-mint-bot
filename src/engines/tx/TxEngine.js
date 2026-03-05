import { ethers } from 'ethers';
import { GAS } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'TxEngine' });

export class TxEngine {
  constructor(rpcPool, nonceManager, db) {
    this.rpcPool = rpcPool;
    this.nonceManager = nonceManager;
    this.db = db;
    this.pendingTxs = new Map();
    this.activeMonitors = new Map();
    this.rbfAttempts = new Map();
    this.maxPendingTxs = 1000; // Prevent unbounded growth
  }

  _evictOldestPendingTx() {
    if (this.pendingTxs.size >= this.maxPendingTxs) {
      const firstKey = this.pendingTxs.keys().next().value;
      this.pendingTxs.delete(firstKey);
      logger.warn(`Evicted oldest pending tx ${firstKey} due to size limit`);
    }
  }

  async broadcastTransaction(wallet, txParams, chainId) {
    const nonce = await this.nonceManager.getAndIncrement(wallet.address);
    
    const tx = {
      ...txParams,
      nonce,
      chainId
    };

    let signedTx;
    try {
      signedTx = await wallet.signTransaction(tx);
    } catch (error) {
      this.nonceManager.decrement(wallet.address);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }

    try {
      const response = await this.rpcPool.broadcastTransaction(signedTx);
      
      logger.info(`Broadcast transaction: ${response.hash}`);

      this._evictOldestPendingTx(); // Check size limit before adding
      this.pendingTxs.set(response.hash, {
        hash: response.hash,
        wallet: wallet.address,
        nonce,
        gasParams: {
          maxFeePerGas: txParams.maxFeePerGas || txParams.gasPrice,
          maxPriorityFeePerGas: txParams.maxPriorityFeePerGas
        },
        timestamp: Date.now(),
        contract: txParams.to,
        chainId,
        // Store complete tx params for RBF
        txParams: {
          to: txParams.to,
          data: txParams.data,
          value: txParams.value
        }
      });

      this.db.saveTx({
        hash: response.hash,
        wallet: wallet.address,
        contract: txParams.to,
        chainId,
        status: 'pending'
      });

      logger.info(`Tx broadcast: ${response.hash} from ${wallet.address} (nonce: ${nonce})`);
      
      return response;

    } catch (error) {
      this.nonceManager.decrement(wallet.address);
      logger.error(`Broadcast failed for ${wallet.address}: ${error.message}`);
      throw error;
    }
  }

  async broadcastBatch(wallets, txParamsArray, chainId) {
    const results = await Promise.allSettled(
      wallets.map((wallet, i) => 
        this.broadcastTransaction(wallet, txParamsArray[i], chainId)
      )
    );

    const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    
    // Map failed results with correct original index
    const failed = [];
    results.forEach((r, originalIndex) => {
      if (r.status === 'rejected') {
        failed.push({
          wallet: wallets[originalIndex].address,
          error: r.reason.message
        });
      }
    });

    logger.info(`Batch broadcast: ${successful.length} success, ${failed.length} failed`);

    return { successful, failed };
  }

  async waitForConfirmation(txHash, confirmations = 1, timeoutMs = 120000) {
    const startTime = Date.now();
    const pendingTx = this.pendingTxs.get(txHash);

    logger.info(`Waiting for ${confirmations} confirmations: ${txHash}`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const receipt = await this.rpcPool.getTransactionReceipt(txHash);
        
        if (receipt) {
          // Validate receipt has blockNumber (pending transactions won't have it)
          if (!receipt.blockNumber) {
            logger.debug(`Receipt for ${txHash} has no blockNumber yet (still pending)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          
          const currentBlock = await this.rpcPool.getBlockNumber();
          const confirmationCount = Math.max(0, currentBlock - receipt.blockNumber + 1);

          if (confirmationCount >= confirmations) {
            this.pendingTxs.delete(txHash);
            
            const status = receipt.status === 1 ? 'confirmed' : 'failed';
            
            // Resync nonce on failure to handle nonce gaps
            if (status === 'failed' && pendingTx) {
              await this._resyncNonce(pendingTx.wallet);
            }
            
            this.db.updateTxStatus(
              txHash,
              status,
              this._extractTokenId(receipt),
              receipt.gasUsed?.toString()
            );

            logger.info(`Transaction ${txHash} ${status} with ${confirmationCount} confirmations`);

            return {
              status,
              receipt,
              confirmations: confirmationCount
            };
          }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        logger.warn(`Error checking tx ${txHash}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Cleanup on timeout and resync nonce
    if (pendingTx) {
      await this._resyncNonce(pendingTx.wallet);
    }
    this.pendingTxs.delete(txHash);
    throw new Error(`Transaction ${txHash} not confirmed within ${timeoutMs}ms`);
  }

  async _resyncNonce(walletAddress) {
    try {
      const networkNonce = await this.rpcPool.getTransactionCount(walletAddress, 'pending');
      this.nonceManager.set(walletAddress, networkNonce);
      logger.info(`Resynced nonce for ${walletAddress}: ${networkNonce}`);
    } catch (error) {
      logger.error(`Failed to resync nonce for ${walletAddress}: ${error.message}`);
    }
  }

  async checkIfStuck(txHash) {
    const pendingTx = this.pendingTxs.get(txHash);
    if (!pendingTx) return false;

    const timePending = Date.now() - pendingTx.timestamp;
    
    if (timePending < GAS.RBF_STUCK_TIMEOUT_MS) {
      return false;
    }

    const tx = await this.rpcPool.getTransaction(txHash);
    
    if (!tx) {
      logger.warn(`Tx ${txHash} not found in mempool, may have been dropped`);
      return true;
    }

    const receipt = await this.rpcPool.getTransactionReceipt(txHash);
    if (receipt) {
      return false;
    }

    logger.info(`Tx ${txHash} stuck for ${Math.floor(timePending / 1000)}s`);
    return true;
  }

  async replaceByFee(txHash, wallet, gasEngine) {
    const pendingTx = this.pendingTxs.get(txHash);
    
    if (!pendingTx) {
      throw new Error(`No pending tx found: ${txHash}`);
    }

    const attempts = this.rbfAttempts.get(txHash) || 0;
    
    if (attempts >= GAS.RBF_MAX_ATTEMPTS) {
      logger.error(`Max RBF attempts reached for ${txHash}`);
      throw new Error(`Max RBF attempts (${GAS.RBF_MAX_ATTEMPTS}) exceeded`);
    }

    const newGasParams = gasEngine.calculateRBFGas(pendingTx.gasParams);

    // Use stored tx params for accurate RBF
    if (!pendingTx.txParams) {
      throw new Error(`Incomplete pending tx data for ${txHash} - cannot RBF`);
    }

    const rbfTx = {
      to: pendingTx.txParams.to,
      data: pendingTx.txParams.data,
      value: pendingTx.txParams.value,
      nonce: pendingTx.nonce,
      chainId: pendingTx.chainId,
      ...newGasParams
    };

    const signedTx = await wallet.signTransaction(rbfTx);
    const response = await this.rpcPool.broadcastTransaction(signedTx);

    this.pendingTxs.delete(txHash);
    this.pendingTxs.set(response.hash, {
      ...pendingTx,
      hash: response.hash,
      gasParams: newGasParams,
      timestamp: Date.now(),
      replacedTx: txHash
    });

    this.rbfAttempts.set(response.hash, attempts + 1);

    this.db.saveTx({
      hash: response.hash,
      wallet: wallet.address,
      contract: pendingTx.txParams.to,
      chainId: pendingTx.chainId,
      status: 'rbf_replacement'
    });

    logger.info(`RBF replacement: ${txHash} -> ${response.hash} (attempt ${attempts + 1})`);

    return response;
  }

  /**
   * Monitor a transaction and automatically trigger RBF if it gets stuck
   * @param {string} txHash - Transaction hash to monitor
   * @param {Wallet} wallet - Wallet that created the transaction
   * @param {GasEngine} gasEngine - Gas engine for RBF calculations
   * @returns {NodeJS.Timer} Interval handle (stored in activeMonitors, cleanup via stopMonitoring)
   */
  async monitorAndRBF(txHash, wallet, gasEngine) {
    const checkInterval = setInterval(async () => {
      try {
        // Check receipt first to exit early if already confirmed
        const receipt = await this.rpcPool.getTransactionReceipt(txHash);
        if (receipt) {
          clearInterval(checkInterval);
          this.activeMonitors.delete(txHash);
          logger.info(`Transaction ${txHash} confirmed, stopping monitor`);
          return;
        }
        
        const isStuck = await this.checkIfStuck(txHash);
        
        if (isStuck) {
          clearInterval(checkInterval);
          this.activeMonitors.delete(txHash);
          
          try {
            const newTx = await this.replaceByFee(txHash, wallet, gasEngine);
            logger.info(`Auto-RBF triggered: ${txHash} -> ${newTx.hash}`);
            // Start monitoring the new transaction
            this.monitorAndRBF(newTx.hash, wallet, gasEngine);
          } catch (error) {
            logger.error(`Auto-RBF failed: ${error.message}`);
          }
        }

      } catch (error) {
        logger.error(`Monitor error for ${txHash}: ${error.message}`);
      }
    }, 10000);

    this.activeMonitors.set(txHash, checkInterval);
    return checkInterval;
  }

  stopMonitoring(txHash) {
    const interval = this.activeMonitors.get(txHash);
    if (interval) {
      clearInterval(interval);
      this.activeMonitors.delete(txHash);
      logger.info(`Stopped monitoring ${txHash}`);
      return true;
    }
    return false;
  }

  stopAllMonitoring() {
    for (const [txHash, interval] of this.activeMonitors) {
      clearInterval(interval);
    }
    this.activeMonitors.clear();
    logger.info('Stopped all transaction monitoring');
  }

  _extractTokenId(receipt) {
    try {
      // Extract all Transfer events for multi-token mints
      const transferEvents = receipt.logs.filter(log => 
        log.topics[0] === ethers.id('Transfer(address,address,uint256)')
      );
      
      if (transferEvents.length === 0) return null;
      
      const tokenIds = transferEvents
        .filter(event => event.topics && event.topics.length >= 4)
        .map(event => {
          try {
            return BigInt(event.topics[3]).toString();
          } catch (error) {
            logger.warn(`Failed to parse token ID from topic: ${error.message}`);
            return null;
          }
        })
        .filter(id => id !== null);
      
      // Return array if multiple, single value if one
      return tokenIds.length === 1 ? tokenIds[0] : tokenIds;
    } catch (error) {
      logger.warn(`Could not extract token ID: ${error.message}`);
    }
    return null;
  }

  getPendingTxs() {
    return Array.from(this.pendingTxs.values());
  }

  cancelMonitoring(txHash) {
    this.pendingTxs.delete(txHash);
    this.rbfAttempts.delete(txHash);
  }

  getStats() {
    return {
      pendingCount: this.pendingTxs.size,
      rbfAttempts: Object.fromEntries(this.rbfAttempts)
    };
  }
}
