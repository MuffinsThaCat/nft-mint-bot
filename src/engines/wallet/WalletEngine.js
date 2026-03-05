import { ethers } from 'ethers';
import crypto from 'crypto';
import { HDWallet } from './HDWallet.js';
import { Encryption } from './Encryption.js';
import { NonceManager } from './NonceManager.js';
import { WalletDatabase } from '../../storage/Database.js';
import { MINT } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'WalletEngine' });

export class WalletEngine {
  constructor(db, encryption) {
    this.db = db;
    this.encryption = encryption;
    this.nonceManager = new NonceManager();
    this.activeWallets = new Map();
  }

  generateWallets(count, label = null, group = null) {
    if (count < 1) {
      throw new Error('Count must be at least 1');
    }

    if (count > 100) {
      throw new Error('Count must not exceed 100 wallets');
    }

    // Use timestamp + crypto random to prevent index collision in concurrent generation
    const randomOffset = crypto.randomInt(0, 10000);
    const baseIndex = (Date.now() % 100000) + randomOffset;
    const hdWallet = HDWallet.generate();
    const wallets = hdWallet.deriveMultiple(count, baseIndex);
    const mnemonic = hdWallet.getMnemonic();
    
    // Prepare batch data
    const batchData = wallets.map(wallet => {
      const encryptedData = this.encryption.encrypt(wallet.privateKey);
      return {
        address: wallet.address,
        encryptedKey: JSON.stringify(encryptedData),
        label,
        group,
        hdIndex: wallet.index
      };
    });
    
    // Atomic batch insert
    this.db.saveWalletsBatch(batchData);
    
    const saved = wallets.map(wallet => ({
      address: wallet.address,
      index: wallet.index,
      path: wallet.path
    }));
    
    logger.info(`Generated ${count} wallets`);
    
    return {
      wallets: saved,
      mnemonic,
      needsReload: true // Signal that activeWallets needs reloading
    };
  }

  importFromMnemonic(mnemonic, count, label = null, group = null) {
    const hdWallet = HDWallet.fromMnemonic(mnemonic);
    const wallets = hdWallet.deriveMultiple(count);
    
    const imported = [];
    for (const wallet of wallets) {
      const encryptedData = this.encryption.encrypt(wallet.privateKey);
      
      try {
        this.db.saveWallet(
          wallet.address,
          JSON.stringify(encryptedData),
          label,
          group,
          wallet.index
        );
        imported.push(wallet.address);
      } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
          logger.warn(`Wallet ${wallet.address} already exists, skipping`);
        } else {
          throw error;
        }
      }
    }
    
    logger.info(`Imported ${imported.length} wallets from mnemonic`);
    return imported;
  }

  importFromPrivateKeys(privateKeys, label = null, group = null) {
    const imported = [];
    
    for (const privateKey of privateKeys) {
      try {
        const wallet = new ethers.Wallet(privateKey);
        const encryptedData = this.encryption.encrypt(privateKey);
        
        this.db.saveWallet(
          wallet.address,
          JSON.stringify(encryptedData),
          label,
          group,
          null
        );
        
        imported.push(wallet.address);
      } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
          logger.warn(`Wallet already exists, skipping`);
        } else {
          logger.error(`Failed to import key: ${error.message}`);
        }
      }
    }
    
    logger.info(`Imported ${imported.length} wallets from private keys`);
    return imported;
  }

  getAllWallets() {
    return this.db.getAllWallets();
  }

  getWallet(address) {
    return this.db.getWallet(address);
  }

  async loadWalletsIntoMemory(rpcPool) {
    const wallets = this.db.getAllWallets();
    let loaded = 0;
    let failed = 0;
    
    for (const walletData of wallets) {
      try {
        // Parse encrypted data if stored as JSON string
        let encryptedData;
        if (typeof walletData.encrypted_key === 'string') {
          try {
            encryptedData = JSON.parse(walletData.encrypted_key);
          } catch (parseError) {
            throw new Error(`Failed to parse encrypted data: ${parseError.message}`);
          }
        } else {
          encryptedData = walletData.encrypted_key;
        }
        
        const decrypted = this.encryption.decrypt(encryptedData);
        const wallet = new ethers.Wallet(decrypted, rpcPool.getProvider());
        
        this.activeWallets.set(wallet.address.toLowerCase(), wallet);
        await this.nonceManager.initialize(wallet.address, rpcPool);
        loaded++;
      } catch (error) {
        logger.error(`Failed to load wallet ${walletData.address}: ${error.message}`);
        failed++;
        // Continue loading other wallets
      }
    }
    
    logger.info(`Loaded ${loaded}/${wallets.length} wallets into memory (${failed} failed)`);
    return loaded;
  }

  getSigningWallet(address) {
    const wallet = this.activeWallets.get(address.toLowerCase());
    if (!wallet) {
      throw new Error(`Wallet ${address} not loaded in memory. Call loadWalletsIntoMemory() first.`);
    }
    return wallet;
  }

  async getBalances(rpcPool) {
    const addresses = Array.from(this.activeWallets.keys());
    const balances = [];
    
    for (const address of addresses) {
      const balance = await rpcPool.getBalance(address);
      balances.push({
        address,
        balance: ethers.formatEther(balance),
        balanceWei: balance.toString()
      });
    }
    
    return balances;
  }

  async distributeETH(fromWallet, amountPerWallet, rpcPool, gasParams) {
    const addresses = Array.from(this.activeWallets.keys());
    const walletWithProvider = fromWallet.connect(rpcPool.getProvider());
    
    const results = [];
    const batchSize = MINT.BATCH_SIZE;
    
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (address) => {
        try {
          // Validate amount is not zero using BigInt
          const amountWei = ethers.parseEther(amountPerWallet.toString());
          if (amountWei === 0n) {
            logger.warn(`Skipping ${address} - amount too small (zero wei)`);
            return null;
          }
          
          const txParams = {
            to: address,
            value: amountWei
          };
          
          // Add EIP-1559 or legacy gas params
          if (gasParams.maxFeePerGas) {
            txParams.maxFeePerGas = gasParams.maxFeePerGas;
            txParams.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
          } else if (gasParams.gasPrice) {
            txParams.gasPrice = gasParams.gasPrice;
          }
          
          const tx = await walletWithProvider.sendTransaction(txParams);
          
          results.push({
            to: address,
            hash: tx.hash,
            status: 'pending'
          });
          
          return tx;
        } catch (error) {
          results.push({
            to: address,
            error: error.message,
            status: 'failed'
          });
          return null;
        }
      });
      
      await Promise.allSettled(batchPromises);
      
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    logger.info(`Distribution complete: ${results.filter(r => r.status === 'pending').length} sent`);
    return results;
  }

  async sweepETH(toAddress, rpcPool, gasParams) {
    // Validate gasParams has at least one gas parameter
    if (!gasParams.maxFeePerGas && !gasParams.gasPrice) {
      throw new Error('gasParams must include either maxFeePerGas or gasPrice');
    }
    
    const addresses = Array.from(this.activeWallets.keys());
    const results = [];
    const batchSize = MINT.BATCH_SIZE;
    
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchPromises = batch.map(async (address) => {
        try {
          const balance = await rpcPool.getBalance(address);
        
          const estimatedGasCost = gasParams.maxFeePerGas ? gasParams.maxFeePerGas * 21000n : gasParams.gasPrice * 21000n;
        
          if (balance <= estimatedGasCost * 2n) {
            return {
              from: address,
              status: 'skipped',
              reason: 'insufficient balance'
            };
          }
        
          const amountToSend = balance - estimatedGasCost;
        
          const wallet = this.getSigningWallet(address);
          const walletWithProvider = wallet.connect(rpcPool.getProvider());
        
          const txParams = {
            to: toAddress,
            value: amountToSend,
            gasLimit: 21000
          };
          
          if (gasParams.maxFeePerGas) {
            txParams.maxFeePerGas = gasParams.maxFeePerGas;
            txParams.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
          } else if (gasParams.gasPrice) {
            txParams.gasPrice = gasParams.gasPrice;
          }
        
          const tx = await walletWithProvider.sendTransaction(txParams);
        
          return {
            from: address,
            hash: tx.hash,
            amount: ethers.formatEther(amountToSend),
            status: 'pending'
          };
        
        } catch (error) {
          return {
            from: address,
            error: error.message,
            status: 'failed'
          };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : r.reason));
      
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    logger.info(`Sweep complete: ${results.filter(r => r.status === 'pending').length} txs sent`);
    return results;
  }

  updateLabel(address, label) {
    return this.db.updateWalletLabel(address, label);
  }

  deleteWallet(address) {
    const addr = address.toLowerCase();
    
    // Remove from memory first
    this.activeWallets.delete(addr);
    this.nonceManager.reset(address);
    
    // Then delete from database
    const result = this.db.deleteWallet(address);
    
    logger.info(`Deleted wallet ${address} from memory and database`);
    return result;
  }

  clearMemory() {
    this.activeWallets.clear();
    this.nonceManager.resetAll();
    logger.info('Cleared all wallets from memory');
  }

  getStats() {
    return {
      totalWallets: this.activeWallets.size,
      loadedInMemory: this.activeWallets.size,
      nonceStatus: this.nonceManager.getAll()
    };
  }
}
