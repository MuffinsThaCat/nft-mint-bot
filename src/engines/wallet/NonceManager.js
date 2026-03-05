import pino from 'pino';

const logger = pino({ name: 'NonceManager' });

export class NonceManager {
  constructor() {
    this.nonces = new Map();
    this.locks = new Map(); // Per-address locks
  }

  async initialize(address, rpcPool) {
    const nonce = await rpcPool.getTransactionCount(address, 'pending');
    this.nonces.set(address.toLowerCase(), nonce);
    logger.info(`Initialized nonce for ${address}: ${nonce}`);
    return nonce;
  }

  async initializeMultiple(addresses, rpcPool) {
    const promises = addresses.map(addr => this.initialize(addr, rpcPool));
    await Promise.all(promises);
  }

  getNonce(address) {
    const addr = address.toLowerCase();
    const nonce = this.nonces.get(addr);
    
    if (nonce === undefined) {
      throw new Error(`Nonce not initialized for ${address}. Call initialize() first.`);
    }
    
    return nonce;
  }

  async getAndIncrement(address) {
    const addr = address.toLowerCase();
    
    // Acquire lock for this address
    while (this.locks.get(addr)) {
      try {
        await this.locks.get(addr);
      } catch (error) {
        // If lock promise rejected, it's been cleaned up, continue
        logger.warn(`Lock promise rejected for ${addr}: ${error.message}`);
        break;
      }
    }
    
    let releaseLock;
    const lockPromise = new Promise(resolve => { releaseLock = resolve; });
    this.locks.set(addr, lockPromise);
    
    try {
      const nonce = this.getNonce(addr);
      this.nonces.set(addr, nonce + 1);
      logger.debug(`Nonce for ${address}: ${nonce} -> ${nonce + 1}`);
      return nonce;
    } finally {
      this.locks.delete(addr);
      releaseLock();
    }
  }

  decrement(address) {
    const addr = address.toLowerCase();
    const currentNonce = this.nonces.get(addr);
    
    if (currentNonce === undefined) {
      logger.warn(`Cannot decrement nonce for ${address}, nonce not initialized`);
      return false;
    }
    
    if (currentNonce === 0) {
      logger.warn(`Cannot decrement nonce for ${address}, already at 0`);
      return false;
    }
    
    this.nonces.set(addr, currentNonce - 1);
    logger.info(`Nonce decremented for ${address}: ${currentNonce} -> ${currentNonce - 1}`);
    return true;
  }

  set(address, nonce) {
    this.nonces.set(address.toLowerCase(), nonce);
  }

  reset(address) {
    const addr = address.toLowerCase();
    this.nonces.delete(addr);
    this.locks.delete(addr);
  }

  resetAll() {
    this.nonces.clear();
    this.locks.clear();
  }

  getAll() {
    return Object.fromEntries(this.nonces);
  }

  has(address) {
    return this.nonces.has(address.toLowerCase());
  }
}
