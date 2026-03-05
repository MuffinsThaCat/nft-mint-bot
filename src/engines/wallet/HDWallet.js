import { ethers } from 'ethers';
import { WALLET } from '../../config/constants.js';

export class HDWallet {
  constructor(mnemonic) {
    if (!mnemonic) {
      throw new Error('Mnemonic is required');
    }
    
    if (!ethers.Mnemonic.isValidMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }
    
    this.mnemonic = mnemonic;
    this.hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic);
  }

  static generate() {
    const wallet = ethers.Wallet.createRandom();
    return new HDWallet(wallet.mnemonic.phrase);
  }

  static fromMnemonic(mnemonic) {
    return new HDWallet(mnemonic);
  }

  deriveWallet(index) {
    // Validate index bounds
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('HD index must be a non-negative integer');
    }
    
    if (index > 1000000) {
      throw new Error('HD index exceeds maximum (1,000,000)');
    }
    
    const path = `${WALLET.HD_PATH}/${index}`;
    const wallet = this.hdNode.derivePath(path);
    
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      index,
      path
    };
  }

  deriveMultiple(count, startIndex = 0) {
    // Validate count is positive
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Count must be a positive integer');
    }
    
    // Validate startIndex
    if (!Number.isInteger(startIndex) || startIndex < 0) {
      throw new Error('Start index must be a non-negative integer');
    }
    
    // Check overflow: startIndex + count - 1 must not exceed max
    const lastIndex = startIndex + count - 1;
    if (lastIndex > 1000000) {
      throw new Error(`Derivation range exceeds maximum: ${lastIndex} > 1,000,000`);
    }
    
    const wallets = [];
    for (let i = 0; i < count; i++) {
      wallets.push(this.deriveWallet(startIndex + i));
    }
    return wallets;
  }

  getMnemonic() {
    return this.mnemonic;
  }

  getSigningWallet(index) {
    const walletData = this.deriveWallet(index);
    return new ethers.Wallet(walletData.privateKey);
  }
}
