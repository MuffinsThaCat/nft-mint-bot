import { ethers } from 'ethers';
import pino from 'pino';

const logger = pino({ name: 'MerkleEngine' });

export class MerkleEngine {
  constructor(db) {
    this.db = db;
    this.proofs = new Map();
  }

  loadProofsFromCSV(csvData) {
    const lines = csvData.trim().split('\n');
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
    
    const addressIdx = headers.findIndex(h => h.includes('address'));
    const proofIdx = headers.findIndex(h => h.includes('proof'));

    if (addressIdx === -1 || proofIdx === -1) {
      throw new Error('CSV must contain "address" and "proof" columns');
    }

    let loaded = 0;
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      const address = parts[addressIdx]?.trim();
      const proofStr = parts[proofIdx]?.trim();

      if (!address || !proofStr) continue;

      try {
        const proof = JSON.parse(proofStr);
        
        if (!Array.isArray(proof) || !proof.every(p => typeof p === 'string' && p.startsWith('0x'))) {
          logger.warn(`Invalid proof format for ${address}, skipping`);
          continue;
        }

        this.proofs.set(address.toLowerCase(), proof);
        this.db.saveMerkleProof(address, proof);
        loaded++;

      } catch (error) {
        logger.warn(`Failed to parse proof for ${address}: ${error.message}`);
      }
    }

    logger.info(`Loaded ${loaded} Merkle proofs from CSV`);
    return loaded;
  }

  loadProofsFromJSON(jsonData) {
    let data;
    
    try {
      data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    } catch (error) {
      throw new Error('Invalid JSON format');
    }

    if (Array.isArray(data)) {
      let loaded = 0;
      
      for (const entry of data) {
        const address = entry.address || entry.wallet;
        const proof = entry.proof;

        if (!address || !proof) continue;

        this.proofs.set(address.toLowerCase(), proof);
        this.db.saveMerkleProof(address, proof);
        loaded++;
      }

      logger.info(`Loaded ${loaded} Merkle proofs from JSON array`);
      return loaded;

    } else if (typeof data === 'object') {
      let loaded = 0;
      
      for (const [address, proof] of Object.entries(data)) {
        if (!Array.isArray(proof)) continue;

        this.proofs.set(address.toLowerCase(), proof);
        this.db.saveMerkleProof(address, proof);
        loaded++;
      }

      logger.info(`Loaded ${loaded} Merkle proofs from JSON object`);
      return loaded;
    }

    throw new Error('JSON must be array or object');
  }

  async fetchProofsFromAPI(apiUrl, walletAddresses) {
    logger.info(`Fetching proofs from API: ${apiUrl}`);
    
    let loaded = 0;
    const maxRetries = 3;
    const baseDelay = 500; // ms

    for (const address of walletAddresses) {
      let retries = 0;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          const url = apiUrl.includes('{address}') 
            ? apiUrl.replace('{address}', address)
            : `${apiUrl}/${address}`;

          // Add timeout to prevent hanging on unresponsive servers
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
          
          let response;
          try {
            response = await fetch(url, { signal: controller.signal });
          } finally {
            clearTimeout(timeoutId);
          }
          
          if (response.status === 429) {
            // Rate limited - exponential backoff
            const delay = baseDelay * Math.pow(2, retries);
            logger.warn(`Rate limited for ${address}, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            retries++;
            continue;
          }
          
          if (!response.ok) {
            logger.warn(`API returned ${response.status} for ${address}`);
            break; // Don't retry on non-rate-limit errors
          }

          const data = await response.json();
          const proof = data.proof || data.merkleProof || data;

          if (!Array.isArray(proof)) {
            logger.warn(`Invalid proof format from API for ${address}`);
            break;
          }

          this.proofs.set(address.toLowerCase(), proof);
          this.db.saveMerkleProof(address, proof);
          loaded++;
          success = true;

          // Rate limiting - wait between successful requests
          await new Promise(resolve => setTimeout(resolve, 250));

        } catch (error) {
          logger.error(`Failed to fetch proof for ${address} (attempt ${retries + 1}): ${error.message}`);
          retries++;
          if (retries < maxRetries) {
            const delay = baseDelay * Math.pow(2, retries);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }

    logger.info(`Loaded ${loaded} proofs from API`);
    return loaded;
  }

  loadFromDatabase() {
    const wallets = this.db.getAllWallets();
    let loaded = 0;

    for (const wallet of wallets) {
      const proofData = this.db.getMerkleProof(wallet.address);
      
      if (proofData) {
        this.proofs.set(wallet.address.toLowerCase(), proofData.proof);
        loaded++;
      }
    }

    logger.info(`Loaded ${loaded} proofs from database`);
    return loaded;
  }

  getProof(address) {
    return this.proofs.get(address.toLowerCase()) || null;
  }

  hasProof(address) {
    return this.proofs.has(address.toLowerCase());
  }

  checkWhitelistStatus(walletAddresses) {
    const status = walletAddresses.map(address => ({
      address,
      whitelisted: this.hasProof(address),
      proof: this.getProof(address)
    }));

    const whitelisted = status.filter(s => s.whitelisted);
    const notWhitelisted = status.filter(s => !s.whitelisted);

    logger.info(`Whitelist check: ${whitelisted.length} whitelisted, ${notWhitelisted.length} not whitelisted`);

    return {
      total: status.length,
      whitelisted: whitelisted.length,
      notWhitelisted: notWhitelisted.length,
      details: status
    };
  }

  getProofsForMint(walletAddresses) {
    const proofs = {};
    
    for (const address of walletAddresses) {
      const proof = this.getProof(address);
      if (proof) {
        proofs[address.toLowerCase()] = proof;
      }
    }

    return proofs;
  }

  verifyProofLocally(address, proof, merkleRoot) {
    try {
      // Validate inputs
      if (!Array.isArray(proof)) {
        throw new Error('Proof must be an array');
      }
      
      if (!merkleRoot || typeof merkleRoot !== 'string' || !merkleRoot.startsWith('0x')) {
        throw new Error('Invalid merkle root format');
      }
      
      // Validate each proof element
      for (const element of proof) {
        if (typeof element !== 'string' || !element.startsWith('0x') || element.length !== 66) {
          throw new Error(`Invalid proof element: ${element} (must be 0x-prefixed 32-byte hex)`);
        }
      }
      
      const leaf = ethers.keccak256(ethers.solidityPacked(['address'], [address]));
      let computedHash = leaf;

      for (const proofElement of proof) {
        // Compare as BigInt for correct ordering
        const hashBigInt = BigInt(computedHash);
        const elementBigInt = BigInt(proofElement);
        
        if (hashBigInt < elementBigInt) {
          computedHash = ethers.keccak256(
            ethers.solidityPacked(['bytes32', 'bytes32'], [computedHash, proofElement])
          );
        } else {
          computedHash = ethers.keccak256(
            ethers.solidityPacked(['bytes32', 'bytes32'], [proofElement, computedHash])
          );
        }
      }

      const valid = computedHash.toLowerCase() === merkleRoot.toLowerCase();
      
      logger.debug(`Proof verification for ${address}: ${valid ? 'VALID' : 'INVALID'}`);
      
      return valid;

    } catch (error) {
      logger.error(`Proof verification failed: ${error.message}`);
      return false;
    }
  }

  clearAll() {
    this.proofs.clear();
    this.db.clearMerkleProofs();
    logger.info('Cleared all Merkle proofs');
  }

  getStats() {
    return {
      totalProofs: this.proofs.size,
      addresses: Array.from(this.proofs.keys())
    };
  }
}
