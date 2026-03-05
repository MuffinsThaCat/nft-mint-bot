import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import pino from 'pino';

const logger = pino({ name: 'Database' });

export class WalletDatabase {
  constructor(dbPath = './data/wallets.db') {
    this.isOpen = false;
    this.dbPath = dbPath;
    this._initDatabase();
  }

  _initDatabase() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initTables();
    this.isOpen = true;
  }

  _ensureOpen() {
    if (!this.isOpen) {
      throw new Error('Database is closed. Cannot perform operations.');
    }
  }

  _retryWrite(fn, maxRetries = 3) {
    this._ensureOpen();
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return fn();
      } catch (error) {
        lastError = error;
        if (error.message?.includes('SQLITE_BUSY') || error.message?.includes('database is locked')) {
          logger.warn(`Database locked, retry ${attempt + 1}/${maxRetries}`);
          // Exponential backoff: 10ms, 20ms, 40ms
          const delay = 10 * Math.pow(2, attempt);
          const start = Date.now();
          while (Date.now() - start < delay) {} // Synchronous delay
        } else {
          throw error; // Non-lock error, throw immediately
        }
      }
    }
    throw lastError;
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE NOT NULL,
        encrypted_key TEXT NOT NULL,
        label TEXT,
        wallet_group TEXT,
        hd_index INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT PRIMARY KEY,
        active_chain TEXT,
        active_contract TEXT,
        settings TEXT
      );

      CREATE TABLE IF NOT EXISTS tx_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        contract_address TEXT,
        chain_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        token_id TEXT,
        gas_used TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        rules_json TEXT NOT NULL,
        active INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rpc_stats (
        provider_url TEXT PRIMARY KEY,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        total_latency INTEGER DEFAULT 0,
        last_updated INTEGER
      );

      CREATE TABLE IF NOT EXISTS merkle_proofs (
        wallet_address TEXT PRIMARY KEY,
        proof_json TEXT NOT NULL,
        whitelist_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tx_wallet ON tx_history(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_tx_chain ON tx_history(chain_id);
      CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON tx_history(timestamp DESC);
    `);

    logger.info('Database tables initialized');
  }

  // Wallets
  saveWallet(address, encryptedKey, label = null, group = null, hdIndex = null) {
    return this._retryWrite(() => {
      const stmt = this.db.prepare(`
        INSERT INTO wallets (address, encrypted_key, label, wallet_group, hd_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      return stmt.run(
        address.toLowerCase(),
        encryptedKey,
        label,
        group,
        hdIndex,
        Date.now()
      );
    });
  }

  saveWalletsBatch(wallets) {
    if (!Array.isArray(wallets) || wallets.length === 0) {
      throw new Error('Wallets must be a non-empty array');
    }
    
    return this._retryWrite(() => {
      const stmt = this.db.prepare(`
        INSERT INTO wallets (address, encrypted_key, label, wallet_group, hd_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      const transaction = this.db.transaction((walletsData) => {
        for (const wallet of walletsData) {
          stmt.run(
            wallet.address.toLowerCase(),
            wallet.encryptedKey,
            wallet.label || null,
            wallet.group || null,
            wallet.hdIndex || null,
            Date.now()
          );
        }
      });
      
      return transaction(wallets);
    });
  }

  getWallet(address) {
    this._ensureOpen();
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE address = ?');
    return stmt.get(address.toLowerCase());
  }

  getAllWallets() {
    this._ensureOpen();
    const stmt = this.db.prepare('SELECT * FROM wallets ORDER BY created_at ASC');
    return stmt.all();
  }

  updateWalletLabel(address, label) {
    this._ensureOpen();
    const stmt = this.db.prepare('UPDATE wallets SET label = ? WHERE address = ?');
    return stmt.run(label, address.toLowerCase());
  }

  deleteWallet(address) {
    this._ensureOpen();
    const stmt = this.db.prepare('DELETE FROM wallets WHERE address = ?');
    return stmt.run(address.toLowerCase());
  }

  // Sessions
  saveSession(userId, data) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (user_id, active_chain, active_contract, settings)
      VALUES (?, ?, ?, ?)
    `);
    
    return stmt.run(
      userId,
      data.activeChain || null,
      data.activeContract || null,
      JSON.stringify(data.settings || {})
    );
  }

  getSession(userId) {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE user_id = ?');
    const row = stmt.get(userId);
    
    if (!row) return null;
    
    let settings = {};
    try {
      settings = JSON.parse(row.settings || '{}');
    } catch (error) {
      logger.error(`Critical: Failed to parse settings for user ${userId}: ${error.message}`);
      // Don't silently discard - throw to alert of corruption
      throw new Error(`Corrupted session data for user ${userId}. Database may need recovery.`);
    }
    
    return {
      userId: row.user_id,
      activeChain: row.active_chain,
      activeContract: row.active_contract,
      settings
    };
  }

  // Transaction History
  saveTx(txData) {
    const stmt = this.db.prepare(`
      INSERT INTO tx_history 
      (tx_hash, wallet_address, contract_address, chain_id, status, token_id, gas_used, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
      txData.hash,
      txData.wallet.toLowerCase(),
      txData.contract?.toLowerCase() || null,
      txData.chainId,
      txData.status,
      txData.tokenId || null,
      txData.gasUsed || null,
      Date.now()
    );
  }

  updateTxStatus(txHash, status, tokenId = null, gasUsed = null) {
    const stmt = this.db.prepare(`
      UPDATE tx_history 
      SET status = ?, token_id = ?, gas_used = ?
      WHERE tx_hash = ?
    `);
    
    return stmt.run(status, tokenId, gasUsed, txHash);
  }

  getTxHistory(limit = 100, walletAddress = null) {
    let query = 'SELECT * FROM tx_history';
    const params = [];
    
    if (walletAddress) {
      query += ' WHERE wallet_address = ?';
      params.push(walletAddress.toLowerCase());
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  // Merkle Proofs
  saveMerkleProof(walletAddress, proof, whitelistId = null) {
    // Validate proof format
    if (!Array.isArray(proof)) {
      throw new Error('Merkle proof must be an array');
    }
    
    for (const element of proof) {
      if (typeof element !== 'string' || !element.startsWith('0x')) {
        throw new Error('Invalid proof element format');
      }
    }
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO merkle_proofs (wallet_address, proof_json, whitelist_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    return stmt.run(
      walletAddress.toLowerCase(),
      JSON.stringify(proof),
      whitelistId,
      Date.now()
    );
  }

  getMerkleProof(walletAddress) {
    const stmt = this.db.prepare('SELECT * FROM merkle_proofs WHERE wallet_address = ?');
    const row = stmt.get(walletAddress.toLowerCase());
    
    if (!row) return null;
    
    try {
      const proof = JSON.parse(row.proof_json);
      
      // Validate parsed proof
      if (!Array.isArray(proof)) {
        throw new Error('Parsed proof is not an array');
      }
      
      return {
        address: row.wallet_address,
        proof,
        whitelistId: row.whitelist_id
      };
    } catch (error) {
      logger.error(`Failed to parse merkle proof for ${walletAddress}: ${error.message}`);
      throw new Error(`Corrupted merkle proof data for ${walletAddress}`);
    }
  }

  clearMerkleProofs() {
    const stmt = this.db.prepare('DELETE FROM merkle_proofs');
    return stmt.run();
  }

  // Strategies
  saveStrategy(name, rulesJson, active = 1) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO strategies (name, rules_json, active)
      VALUES (?, ?, ?)
    `);
    return stmt.run(name, rulesJson, active);
  }

  getStrategy(name) {
    const stmt = this.db.prepare('SELECT * FROM strategies WHERE name = ?');
    return stmt.get(name);
  }

  getAllStrategies() {
    const stmt = this.db.prepare('SELECT * FROM strategies');
    return stmt.all();
  }

  listStrategies() {
    const stmt = this.db.prepare('SELECT name, active FROM strategies');
    return stmt.all();
  }

  deleteStrategy(name) {
    const stmt = this.db.prepare('DELETE FROM strategies WHERE name = ?');
    return stmt.run(name);
  }

  // Cleanup
  close() {
    if (this.isOpen) {
      this.db.close();
      this.isOpen = false;
      logger.info('Database closed');
    }
  }
}
