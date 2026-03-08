import { ethers } from 'ethers';
import pino from 'pino';

const logger = pino({ name: 'SeaDropEngine' });

// Known SeaDrop v1 contract address (same deployment across EVM chains)
const SEADROP_V1_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

// IPFS gateways for allowlist fetching (tried in order)
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

// ── SeaDrop contract ABI (minimal, covers read + mint) ──────────────
const SEADROP_ABI = [
  // Read
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getAllowListMerkleRoot(address nftContract) view returns (bytes32)',
  'function getCreatorPayoutAddress(address nftContract) view returns (address)',
  'function getAllowList(address nftContract) view returns (tuple(bytes32 merkleRoot, string[] publicKeyURIs, string allowListURI))',
  // Mint
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable',
];

// ── ERC721SeaDrop NFT-side ABI ──────────────────────────────────────
const NFT_SEADROP_ABI = [
  'function getSeaDrops() view returns (address[])',
  'function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)',
  'function maxSupply() view returns (uint256)',
];

// ── ABI indicator names that signal a SeaDrop contract ──────────────
const SEADROP_INDICATORS = [
  'mintseadrop',
  'getseadrops',
  'configuredseadrop',
  'updateseadrop',
  'updateallowlist',
  'updatepublicdrop',
];

export class SeaDropEngine {
  constructor(rpcPool, chainId) {
    this.rpcPool = rpcPool;
    this.chainId = chainId;
    // Per-NFT caches (keyed by nftAddress.toLowerCase())
    this._seaDropAddresses = new Map();
    this._publicDropCache = new Map();
    this._feeRecipientCache = new Map();
    this._allowListCache = new Map();
  }

  // ── Detection ─────────────────────────────────────────────────────

  /**
   * Returns true if the given ABI belongs to a SeaDrop-enabled NFT contract.
   */
  static isSeaDropContract(abi) {
    if (!Array.isArray(abi)) return false;
    const names = abi
      .filter(item => item.type === 'function')
      .map(f => (f.name || '').toLowerCase());
    return SEADROP_INDICATORS.some(ind => names.includes(ind));
  }

  // ── Initialisation ────────────────────────────────────────────────

  /**
   * Resolve the SeaDrop contract address for a given NFT.
   * Tries on-chain getSeaDrops() first, falls back to the known v1 address.
   */
  async resolveSeaDropAddress(nftContractAddress) {
    const key = nftContractAddress.toLowerCase();
    if (this._seaDropAddresses.has(key)) {
      return this._seaDropAddresses.get(key);
    }

    let seaDropAddr = SEADROP_V1_ADDRESS;

    try {
      const addrs = await this.rpcPool.execute(provider => {
        const c = new ethers.Contract(nftContractAddress, NFT_SEADROP_ABI, provider);
        return c.getSeaDrops();
      });
      if (addrs && addrs.length > 0) {
        seaDropAddr = addrs[0];
        logger.info(`getSeaDrops() → ${seaDropAddr}`);
      }
    } catch (err) {
      logger.warn(`getSeaDrops() failed for ${nftContractAddress}, using known v1 address: ${err.message}`);
    }

    this._seaDropAddresses.set(key, seaDropAddr);
    return seaDropAddr;
  }

  // ── Read helpers ──────────────────────────────────────────────────

  /**
   * Fetch the public-drop configuration from the SeaDrop contract.
   */
  async getPublicDrop(nftContractAddress) {
    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);

    const result = await this.rpcPool.execute(provider => {
      const c = new ethers.Contract(seaDrop, SEADROP_ABI, provider);
      return c.getPublicDrop(nftContractAddress);
    });

    const info = {
      mintPrice: result.mintPrice,                              // BigInt (wei)
      startTime: Number(result.startTime),
      endTime: Number(result.endTime),
      maxTotalMintableByWallet: Number(result.maxTotalMintableByWallet),
      feeBps: Number(result.feeBps),
      restrictFeeRecipients: result.restrictFeeRecipients,
      isActive: this._isDropActive(Number(result.startTime), Number(result.endTime)),
    };

    this._publicDropCache.set(nftContractAddress.toLowerCase(), info);
    return info;
  }

  /**
   * Get the list of pre-approved fee recipients for this NFT on SeaDrop.
   */
  async getAllowedFeeRecipients(nftContractAddress) {
    const key = nftContractAddress.toLowerCase();
    if (this._feeRecipientCache.has(key)) {
      return this._feeRecipientCache.get(key);
    }

    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);

    const recipients = await this.rpcPool.execute(provider => {
      const c = new ethers.Contract(seaDrop, SEADROP_ABI, provider);
      return c.getAllowedFeeRecipients(nftContractAddress);
    });

    if (!recipients || recipients.length === 0) {
      throw new Error(
        'No allowed fee recipients configured on SeaDrop for this contract. ' +
        'The project must call updateAllowedFeeRecipient() first.'
      );
    }

    const list = [...recipients]; // plain array copy
    this._feeRecipientCache.set(key, list);
    logger.info(`Fee recipients for ${nftContractAddress}: ${list.length} found`);
    return list;
  }

  /**
   * Fetch AllowList data (merkle root + URI) from the SeaDrop contract.
   */
  async getAllowListData(nftContractAddress) {
    const key = nftContractAddress.toLowerCase();
    if (this._allowListCache.has(key)) {
      return this._allowListCache.get(key);
    }

    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);

    try {
      const data = await this.rpcPool.execute(provider => {
        const c = new ethers.Contract(seaDrop, SEADROP_ABI, provider);
        return c.getAllowList(nftContractAddress);
      });

      const zeroRoot = '0x' + '0'.repeat(64);
      const info = {
        merkleRoot: data.merkleRoot === zeroRoot ? null : data.merkleRoot,
        publicKeyURIs: data.publicKeyURIs || [],
        allowListURI: data.allowListURI || null,
      };

      this._allowListCache.set(key, info);
      return info;
    } catch (err) {
      // Older SeaDrop versions may not have getAllowList — fall back to root only
      logger.warn(`getAllowList() failed, trying getAllowListMerkleRoot(): ${err.message}`);

      try {
        const root = await this.rpcPool.execute(provider => {
          const c = new ethers.Contract(seaDrop, SEADROP_ABI, provider);
          return c.getAllowListMerkleRoot(nftContractAddress);
        });

        const zeroRoot = '0x' + '0'.repeat(64);
        const info = {
          merkleRoot: (!root || root === zeroRoot) ? null : root,
          publicKeyURIs: [],
          allowListURI: null,
        };

        this._allowListCache.set(key, info);
        return info;
      } catch (rootErr) {
        logger.warn(`getAllowListMerkleRoot() also failed: ${rootErr.message}`);
        return { merkleRoot: null, publicKeyURIs: [], allowListURI: null };
      }
    }
  }

  /**
   * Get mint stats for a specific minter from the NFT contract.
   */
  async getMintStats(nftContractAddress, minterAddress) {
    try {
      const result = await this.rpcPool.execute(provider => {
        const c = new ethers.Contract(nftContractAddress, NFT_SEADROP_ABI, provider);
        return c.getMintStats(minterAddress);
      });
      return {
        minterNumMinted: Number(result.minterNumMinted),
        currentTotalSupply: Number(result.currentTotalSupply),
        maxSupply: Number(result.maxSupply),
      };
    } catch (err) {
      logger.warn(`getMintStats() failed: ${err.message}`);
      return null;
    }
  }

  // ── Allowlist URI fetching ────────────────────────────────────────

  /**
   * Fetch the allowlist JSON from IPFS / HTTP and return the parsed array.
   * Each entry is expected to have at least { address, proof, ...mintParams }.
   */
  async fetchAllowList(uri) {
    if (!uri) throw new Error('No allowlist URI available for this contract');

    const urls = this._resolveUri(uri);

    let lastError;
    for (const url of urls) {
      try {
        logger.info(`Fetching allowlist from ${url.substring(0, 80)}...`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        let data;
        try {
          const response = await fetch(url, { signal: controller.signal });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          data = await response.json();
        } finally {
          clearTimeout(timeout);
        }

        if (!Array.isArray(data)) {
          throw new Error('Allowlist JSON is not an array');
        }

        logger.info(`Allowlist fetched: ${data.length} entries`);
        return data;
      } catch (err) {
        lastError = err;
        logger.warn(`Allowlist fetch failed from ${url.substring(0, 60)}: ${err.message}`);
      }
    }

    throw new Error(`Failed to fetch allowlist from all sources: ${lastError?.message}`);
  }

  /**
   * Look up a single wallet's proof + MintParams from a fetched allowlist.
   */
  findWalletInAllowList(allowList, walletAddress) {
    const target = walletAddress.toLowerCase();
    const entry = allowList.find(e => {
      const addr = (e.address || e.wallet || '').toLowerCase();
      return addr === target;
    });

    if (!entry) return null;

    return {
      proof: entry.proof || [],
      mintParams: {
        mintPrice: BigInt(entry.mintPrice ?? entry.mint_price ?? '0'),
        maxTotalMintableByWallet: Number(entry.maxTotalMintableByWallet ?? entry.max_mints ?? 0),
        startTime: Number(entry.startTime ?? entry.start_time ?? 0),
        endTime: Number(entry.endTime ?? entry.end_time ?? 0),
        dropStageIndex: Number(entry.dropStageIndex ?? entry.drop_stage_index ?? 1),
        maxTokenSupplyForStage: Number(entry.maxTokenSupplyForStage ?? entry.max_supply_stage ?? 0),
        feeBps: Number(entry.feeBps ?? entry.fee_bps ?? 0),
        restrictFeeRecipients: Boolean(entry.restrictFeeRecipients ?? entry.restrict_fee_recipients ?? true),
      },
    };
  }

  // ── Calldata builders ─────────────────────────────────────────────

  /**
   * Build calldata + tx target for a **public** SeaDrop mint.
   *
   * Uses address(0) for minterIfNotPayer so msg.sender is the minter.
   * This means the same calldata works for every wallet.
   */
  async buildPublicMintCalldata(nftContractAddress, quantity = 1) {
    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);
    const feeRecipients = await this.getAllowedFeeRecipients(nftContractAddress);
    const publicDrop = this._publicDropCache.get(nftContractAddress.toLowerCase())
      || await this.getPublicDrop(nftContractAddress);

    const iface = new ethers.Interface(SEADROP_ABI);
    const calldata = iface.encodeFunctionData('mintPublic', [
      nftContractAddress,
      feeRecipients[0],                 // first approved fee recipient
      ethers.ZeroAddress,               // minterIfNotPayer = 0 → msg.sender
      quantity,
    ]);

    const mintPricePerUnit = typeof publicDrop.mintPrice === 'bigint'
      ? publicDrop.mintPrice
      : BigInt(publicDrop.mintPrice.toString());
    const totalValue = mintPricePerUnit * BigInt(quantity);

    return {
      to: seaDrop,                       // tx goes to SeaDrop, NOT the NFT
      calldata,
      value: totalValue,
      feeRecipient: feeRecipients[0],
      type: 'seadrop-public',
    };
  }

  /**
   * Build **per-wallet** calldata for an allowlist SeaDrop mint.
   *
   * Returns an array of { wallet, to, calldata, value } — one per wallet
   * that has a matching proof. Wallets without proofs are skipped.
   */
  async buildAllowListMintCalldata(nftContractAddress, walletAddresses, allowList, quantity = 1) {
    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);
    const feeRecipients = await this.getAllowedFeeRecipients(nftContractAddress);
    const feeRecipient = feeRecipients[0];
    const iface = new ethers.Interface(SEADROP_ABI);

    const results = [];
    const skipped = [];

    for (const wallet of walletAddresses) {
      const entry = this.findWalletInAllowList(allowList, wallet);
      if (!entry) {
        skipped.push(wallet);
        continue;
      }

      const calldata = iface.encodeFunctionData('mintAllowList', [
        nftContractAddress,
        feeRecipient,
        ethers.ZeroAddress,              // msg.sender = minter
        quantity,
        [
          entry.mintParams.mintPrice,
          entry.mintParams.maxTotalMintableByWallet,
          entry.mintParams.startTime,
          entry.mintParams.endTime,
          entry.mintParams.dropStageIndex,
          entry.mintParams.maxTokenSupplyForStage,
          entry.mintParams.feeBps,
          entry.mintParams.restrictFeeRecipients,
        ],
        entry.proof,
      ]);

      const totalValue = entry.mintParams.mintPrice * BigInt(quantity);

      results.push({ wallet, to: seaDrop, calldata, value: totalValue });
    }

    if (skipped.length > 0) {
      logger.warn(`${skipped.length} wallets had no allowlist entry and were skipped`);
    }

    return { perWallet: results, skipped };
  }

  // ── Full analysis ─────────────────────────────────────────────────

  /**
   * Run a complete SeaDrop analysis for display in /analyze.
   */
  async analyze(nftContractAddress) {
    const seaDrop = await this.resolveSeaDropAddress(nftContractAddress);

    let publicDrop = null;
    try {
      publicDrop = await this.getPublicDrop(nftContractAddress);
    } catch (err) {
      logger.warn(`getPublicDrop failed: ${err.message}`);
    }

    let feeRecipients = [];
    try {
      feeRecipients = await this.getAllowedFeeRecipients(nftContractAddress);
    } catch (err) {
      logger.warn(`getAllowedFeeRecipients failed: ${err.message}`);
    }

    const allowListData = await this.getAllowListData(nftContractAddress);

    let mintStats = null;
    try {
      // Use zero address for a general stats check
      mintStats = await this.getMintStats(nftContractAddress, ethers.ZeroAddress);
    } catch (_) { /* optional */ }

    return {
      isSeaDrop: true,
      seaDropAddress: seaDrop,
      publicDrop,
      feeRecipients,
      allowList: {
        hasMerkleRoot: allowListData.merkleRoot !== null,
        merkleRoot: allowListData.merkleRoot,
        allowListURI: allowListData.allowListURI,
      },
      mintStats,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _isDropActive(startTime, endTime) {
    const now = Math.floor(Date.now() / 1000);
    return now >= startTime && (endTime === 0 || now <= endTime);
  }

  /**
   * Turn an IPFS or HTTP URI into a list of fetchable URLs.
   */
  _resolveUri(uri) {
    if (uri.startsWith('ipfs://')) {
      const cid = uri.replace('ipfs://', '');
      return IPFS_GATEWAYS.map(gw => gw + cid);
    }
    if (uri.startsWith('ar://')) {
      return [`https://arweave.net/${uri.replace('ar://', '')}`];
    }
    // Plain HTTP(S)
    return [uri];
  }

  clearCaches() {
    this._seaDropAddresses.clear();
    this._publicDropCache.clear();
    this._feeRecipientCache.clear();
    this._allowListCache.clear();
  }
}
