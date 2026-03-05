import { MONITOR } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'MonitorEngine' });

export class MonitorEngine {
  constructor(rpcPool, contractResolver) {
    this.rpcPool = rpcPool;
    this.contractResolver = contractResolver;
    this.watchers = new Map();
    this.isRunning = false;
  }

  async watchContract(contractAddress, abi, callbacks = {}) {
    const watchId = contractAddress.toLowerCase();

    if (this.watchers.has(watchId)) {
      logger.warn(`Already watching contract ${contractAddress}`);
      return;
    }

    const initialState = {};

    const watcher = {
      address: contractAddress,
      abi,
      callbacks,
      state: initialState,
      lastCheckTime: null,
      interval: null,
      consecutiveErrors: 0,
      maxConsecutiveErrors: 5
    };

    watcher.interval = setInterval(async () => {
      try {
        await this._checkForChanges(watcher);
        watcher.consecutiveErrors = 0; // Reset on success
      } catch (error) {
        watcher.consecutiveErrors++;
        logger.error(`Watcher error for ${contractAddress} (${watcher.consecutiveErrors}/${watcher.maxConsecutiveErrors}): ${error.message}`);
        
        // Stop interval after max consecutive errors
        if (watcher.consecutiveErrors >= watcher.maxConsecutiveErrors) {
          logger.error(`Stopping watcher for ${contractAddress} due to repeated failures`);
          this.stopWatching(watchId);
          if (watcher.callbacks.onError) {
            watcher.callbacks.onError(new Error('Watcher stopped due to repeated failures'));
          }
          return;
        }
        
        if (watcher.callbacks.onError) {
          watcher.callbacks.onError(error);
        }
      }
    }, MONITOR.BLOCK_POLL_INTERVAL_MS);

    this.watchers.set(watchId, watcher);
    this.isRunning = true;

    return watchId;
  }

  async _checkForChanges(watcher) {
    // Only fetch block number if enough time has passed (use half of poll interval as throttle)
    const now = Date.now();
    const throttleMs = MONITOR.BLOCK_POLL_INTERVAL_MS / 2;
    if (watcher.lastCheckTime && now - watcher.lastCheckTime < throttleMs) {
      return; // Skip if checked too recently
    }
    
    const currentBlock = await this.rpcPool.getBlockNumber();
    watcher.lastCheckTime = now;

    // Handle reorg: if block number decreased, reset state
    if (watcher.lastBlock && currentBlock < watcher.lastBlock) {
      logger.warn(`Chain reorg detected: ${watcher.lastBlock} -> ${currentBlock}`);
      watcher.lastBlock = currentBlock;
      watcher.state = {}; // Reset state to re-check
      return;
    }

    // Update lastBlock even if no change to prevent getting stuck
    const previousBlock = watcher.lastBlock;
    watcher.lastBlock = currentBlock;

    if (previousBlock !== undefined && currentBlock <= previousBlock) {
      return; // No new blocks
    }

    const newState = await this.contractResolver.readContractState(watcher.address, watcher.abi);

    for (const [key, newValue] of Object.entries(newState)) {
      const oldValue = watcher.state[key];

      if (oldValue === undefined) {
        watcher.state[key] = newValue;
        continue;
      }

      if (this._hasChanged(oldValue, newValue)) {
        logger.info(`State change detected in ${watcher.address}: ${key} changed`);

        if (watcher.callbacks.onStateChange) {
          watcher.callbacks.onStateChange({
            contract: watcher.address,
            property: key,
            oldValue,
            newValue,
            block: currentBlock
          });
        }

        if (key === 'paused' && newValue === false && oldValue === true) {
          logger.info('🚀 MINT OPENED - Contract unpaused!');
          
          if (watcher.callbacks.onMintOpen) {
            watcher.callbacks.onMintOpen({
              contract: watcher.address,
              block: currentBlock
            });
          }
        }

        watcher.state[key] = newValue;
      }
    }
  }

  _hasChanged(oldValue, newValue) {
    if (oldValue === null || newValue === null) return oldValue !== newValue;
    
    if (typeof oldValue === 'bigint' || typeof newValue === 'bigint') {
      return oldValue.toString() !== newValue.toString();
    }

    return oldValue !== newValue;
  }

  stopWatching(contractAddress) {
    const watchId = contractAddress.toLowerCase();
    const watcher = this.watchers.get(watchId);

    if (!watcher) {
      logger.warn(`Not watching ${contractAddress}`);
      return false;
    }

    if (watcher.interval) {
      clearInterval(watcher.interval);
      watcher.interval = null;
    }

    this.watchers.delete(watchId);
    logger.info(`Stopped watching ${contractAddress}`);

    if (this.watchers.size === 0) {
      this.isRunning = false;
    }

    return true;
  }

  stopAll() {
    // Create array copy to avoid modifying Map during iteration
    const watchIds = Array.from(this.watchers.keys());
    for (const watchId of watchIds) {
      this.stopWatching(watchId);
    }
    logger.info('Stopped all watchers');
  }

  getWatchStatus(contractAddress) {
    const watchId = contractAddress.toLowerCase();
    const watcher = this.watchers.get(watchId);

    if (!watcher) {
      return { watching: false };
    }

    return {
      watching: true,
      address: watcher.address,
      lastBlock: watcher.lastBlock,
      state: watcher.state
    };
  }

  getAllWatchers() {
    return Array.from(this.watchers.values()).map(w => ({
      address: w.address,
      lastBlock: w.lastBlock,
      state: w.state
    }));
  }

  waitForMintOpen(contractAddress, abi, timeoutMs = 3600000) {
    return new Promise((resolve, reject) => {
      let timeoutHandle;
      
      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        this.stopWatching(contractAddress);
      };

      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for mint to open'));
      }, timeoutMs);

      // Call async function without await in Promise executor
      this.watchContract(contractAddress, abi, {
        onMintOpen: (data) => {
          cleanup();
          resolve(data);
        },
        onStateChange: (change) => {
          logger.info(`State update: ${change.property} = ${change.newValue}`);
        },
        onError: (error) => {
          cleanup();
          reject(error);
        }
      }).catch(error => {
        cleanup();
        reject(error);
      });
    });
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      watchersActive: this.watchers.size,
      watchers: this.getAllWatchers().map(w => ({
        address: w.address,
        lastBlock: w.lastBlock,
        paused: w.state.paused
      }))
    };
  }
}
