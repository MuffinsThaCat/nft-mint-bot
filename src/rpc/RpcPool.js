import { ethers } from 'ethers';
import { CircuitBreaker } from './CircuitBreaker.js';
import { resolveRpcUrl } from '../config/chains.js';
import { RPC } from '../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'RpcPool' });

export class RpcPool {
  constructor(chain) {
    this.chain = chain;
    this.providers = [];
    this.currentIndex = 0;
    this.activeRequests = 0;
    this.requestQueue = [];
    this.stats = new Map();
    
    this._initProviders();
  }

  _initProviders() {
    for (const rpcUrl of this.chain.rpcUrls) {
      try {
        const resolvedUrl = resolveRpcUrl(rpcUrl);
        
        // resolveRpcUrl now throws if placeholder can't be resolved, so no need to check again
        const provider = new ethers.JsonRpcProvider(resolvedUrl, this.chain.id, {
          staticNetwork: true,
          batchMaxCount: 1
        });
        
        const breaker = new CircuitBreaker(resolvedUrl);
        
        this.providers.push({
          url: resolvedUrl,
          provider,
          breaker,
          isPrimary: rpcUrl.includes('alchemy') || rpcUrl.includes('quicknode')
        });
        
        this.stats.set(resolvedUrl, {
          successCount: 0,
          failCount: 0,
          totalLatency: 0,
          avgLatency: 0
        });
        
        logger.info(`Initialized RPC provider: ${resolvedUrl.substring(0, 50)}...`);
      } catch (error) {
        logger.warn(`Failed to init provider ${resolvedUrl}: ${error.message}`);
      }
    }
    
    if (this.providers.length === 0) {
      throw new Error('No valid RPC providers initialized');
    }
    
    // Sort: primary providers first, then fallbacks
    this.providers.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return 0;
    });
  }

  async execute(fn) {
    // Rate limiting queue
    if (this.activeRequests >= RPC.MAX_CONCURRENT_REQUESTS) {
      await new Promise(resolve => this.requestQueue.push(resolve));
    }
    
    this.activeRequests++;
    
    try {
      return await this._executeWithRetry(fn);
    } finally {
      this.activeRequests--;
      
      // Release next queued request if any
      if (this.requestQueue.length > 0) {
        const next = this.requestQueue.shift();
        if (next && typeof next === 'function') {
          next();
        }
      }
    }
  }

  async _executeWithRetry(fn, attemptsMade = 0) {
    const providerInfo = this._getNextProvider();
    
    if (!providerInfo) {
      throw new Error('All RPC providers are unavailable');
    }
    
    const { provider, breaker, url } = providerInfo;
    const stats = this.stats.get(url);
    
    // Defensive: ensure stats exist (should always exist but guard against edge cases)
    if (!stats) {
      logger.error(`Stats not found for provider ${url} - this should not happen`);
      throw new Error('Internal error: provider stats missing');
    }
    
    const startTime = Date.now();
    
    let timeoutHandle;
    try {
      const result = await Promise.race([
        breaker.execute(() => fn(provider)),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('RPC timeout')), RPC.REQUEST_TIMEOUT_MS);
        })
      ]);
      
      // Clear timeout if request succeeded
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      const latency = Date.now() - startTime;
      stats.successCount++;
      stats.totalLatency += latency;
      stats.avgLatency = stats.totalLatency / stats.successCount;
      
      return result;
      
    } catch (error) {
      // Clear timeout on error to prevent memory leak
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      const latency = Date.now() - startTime;
      stats.failCount++;
      
      logger.warn(`RPC request failed on ${url.substring(0, 50)}: ${error.message}`);
      
      if (attemptsMade < RPC.RETRY_ATTEMPTS - 1) {
        // Exponential backoff: 1s, 2s, 4s
        const backoffDelay = RPC.RETRY_DELAY_MS * Math.pow(2, attemptsMade);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        // Retry with next provider, not same one
        return this._executeWithRetry(fn, attemptsMade + 1);
      }
      
      throw error;
    }
  }

  _getNextProvider() {
    // Try all providers in round-robin, skip unavailable
    const startIndex = this.currentIndex;
    
    do {
      const providerInfo = this.providers[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.providers.length;
      
      if (providerInfo.breaker.isAvailable()) {
        return providerInfo;
      }
      
    } while (this.currentIndex !== startIndex);
    
    return null;
  }

  getProvider() {
    const providerInfo = this._getNextProvider();
    if (!providerInfo) {
      throw new Error('No available RPC providers');
    }
    return providerInfo.provider;
  }

  async getFeeData() {
    return this.execute(provider => provider.getFeeData());
  }

  async getBlock(blockTag) {
    return this.execute(provider => provider.getBlock(blockTag));
  }

  async getBlockNumber() {
    return this.execute(provider => provider.getBlockNumber());
  }

  async getTransaction(txHash) {
    return this.execute(provider => provider.getTransaction(txHash));
  }

  async getTransactionReceipt(txHash) {
    return this.execute(provider => provider.getTransactionReceipt(txHash));
  }

  async getTransactionCount(address, blockTag = 'latest') {
    return this.execute(provider => provider.getTransactionCount(address, blockTag));
  }

  async getBalance(address, blockTag = 'latest') {
    return this.execute(provider => provider.getBalance(address, blockTag));
  }

  async call(transaction, blockTag = 'latest') {
    return this.execute(provider => provider.call(transaction, blockTag));
  }

  async estimateGas(transaction) {
    return this.execute(provider => provider.estimateGas(transaction));
  }

  async broadcastTransaction(signedTx) {
    return this.execute(provider => provider.broadcastTransaction(signedTx));
  }

  async send(method, params) {
    return this.execute(provider => provider.send(method, params));
  }

  getStats() {
    const stats = [];
    for (const [url, data] of this.stats.entries()) {
      const providerInfo = this.providers.find(p => p.url === url);
      stats.push({
        url: url.substring(0, 60) + '...',
        isPrimary: providerInfo?.isPrimary || false,
        state: providerInfo?.breaker.getStatus().state || 'UNKNOWN',
        successCount: data.successCount,
        failCount: data.failCount,
        avgLatency: Math.round(data.avgLatency) + 'ms'
      });
    }
    return stats;
  }

  resetCircuitBreakers() {
    for (const providerInfo of this.providers) {
      providerInfo.breaker.reset();
    }
  }
}
