import { ethers } from 'ethers';
import { MINT } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'SimEngine' });

export class SimEngine {
  constructor(rpcPool) {
    this.rpcPool = rpcPool;
  }

  async simulate(contractAddress, calldata, fromAddress, value = 0n) {
    let timeoutHandle;
    try {
      const result = await Promise.race([
        this.rpcPool.call({
          from: fromAddress,
          to: contractAddress,
          data: calldata,
          value: value
        }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Simulation timeout')), MINT.DRY_RUN_TIMEOUT_MS);
        })
      ]);

      // Clear timeout on success
      if (timeoutHandle) clearTimeout(timeoutHandle);

      logger.info(`✅ Simulation success for ${fromAddress}`);
      
      return {
        success: true,
        result,
        gas: await this._estimateGas(contractAddress, calldata, fromAddress, value)
      };

    } catch (error) {
      // Clear timeout on error
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      const revertReason = this._decodeRevertReason(error);
      
      logger.warn(`❌ Simulation failed for ${fromAddress}: ${revertReason}`);
      
      return {
        success: false,
        error: revertReason,
        rawError: error.message
      };
    }
  }

  async simulateBatch(contractAddress, calldata, walletAddresses, value = 0n) {
    const settledResults = await Promise.allSettled(
      walletAddresses.map(address => 
        this.simulate(contractAddress, calldata, address, value)
      )
    );

    const results = settledResults.map(r => 
      r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message || 'Unknown error' }
    );

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    logger.info(`Batch simulation: ${successful.length} success, ${failed.length} failed`);

    return {
      successful,
      failed,
      allPassed: failed.length === 0
    };
  }

  async _estimateGas(contractAddress, calldata, fromAddress, value) {
    try {
      return await this.rpcPool.estimateGas({
        from: fromAddress,
        to: contractAddress,
        data: calldata,
        value: value
      });
    } catch (error) {
      logger.warn(`Gas estimation failed, using default: ${error.message}`);
      return 300000n;
    }
  }

  _decodeRevertReason(error) {
    try {
      const errorString = error.message || error.toString();

      const commonReasons = {
        'Sale is not active': 'Mint not open yet',
        'Exceeds wallet limit': 'Wallet already minted max amount',
        'Insufficient funds': 'Not enough ETH in wallet',
        'Invalid proof': 'Merkle proof invalid (not whitelisted)',
        'Max supply reached': 'Sold out',
        'Paused': 'Contract is paused',
        'Not whitelisted': 'Address not on whitelist',
        'Incorrect payment': 'Wrong ETH amount sent',
        'Already claimed': 'Wallet already claimed',
        'Exceeds max supply': 'Would exceed max supply',
        // SeaDrop-specific revert reasons
        'InvalidFeeRecipient': 'SeaDrop: wrong fee recipient address',
        'NotActive': 'SeaDrop: drop is not active yet',
        'MintQuantityExceedsMaxMintedPerWallet': 'SeaDrop: exceeds per-wallet mint limit',
        'MintQuantityExceedsMaxSupply': 'SeaDrop: would exceed max supply',
        'IncorrectPayment': 'SeaDrop: incorrect ETH amount (check mint price)',
        'FeeRecipientNotAllowed': 'SeaDrop: fee recipient not in allowed list',
        'InvalidProof': 'SeaDrop: Merkle proof invalid (not on allowlist)',
        'AllowListNotActive': 'SeaDrop: allowlist mint is not active',
        'OnlyINonFungibleSeaDropToken': 'SeaDrop: contract not registered with SeaDrop',
      };

      for (const [pattern, reason] of Object.entries(commonReasons)) {
        if (errorString.toLowerCase().includes(pattern.toLowerCase())) {
          return reason;
        }
      }

      if (errorString.includes('execution reverted')) {
        try {
          const match = errorString.match(/execution reverted: (.+)/);
          if (match) return match[1];
        } catch {}
      }

      if (errorString.includes('0x08c379a0')) {
        try {
          const match = errorString.match(/0x08c379a0([0-9a-fA-F]+)/);
          if (match) {
            try {
              const decoded = ethers.toUtf8String('0x' + match[1]);
              return decoded;
            } catch (utf8Error) {
              // Invalid UTF-8 sequence, fall through to generic error
              logger.debug(`Failed to decode UTF-8 error data: ${utf8Error.message}`);
            }
          }
        } catch {}
      }

      return errorString.substring(0, 100);
    } catch (err) {
      return 'Unknown error (parse failed)';
    }
  }

  async checkContractCallable(contractAddress) {
    try {
      const code = await this.rpcPool.send('eth_getCode', [contractAddress, 'latest']);
      
      if (!code || code === '0x') {
        return {
          callable: false,
          reason: 'No contract code at address (not deployed or EOA)'
        };
      }

      return {
        callable: true
      };

    } catch (error) {
      return {
        callable: false,
        reason: error.message
      };
    }
  }

  async checkWalletBalance(walletAddress, requiredAmount) {
    try {
      const balance = await this.rpcPool.getBalance(walletAddress);
      // Handle both BigInt and numeric types
      const required = typeof requiredAmount === 'bigint' ? requiredAmount : BigInt(requiredAmount);

      if (balance < required) {
        return {
          sufficient: false,
          balance: ethers.formatEther(balance),
          required: ethers.formatEther(required),
          shortfall: ethers.formatEther(required - balance)
        };
      }

      return {
        sufficient: true,
        balance: ethers.formatEther(balance),
        required: ethers.formatEther(required)
      };

    } catch (error) {
      throw new Error(`Failed to check balance: ${error.message}`);
    }
  }

  generateSimulationReport(simResults, walletBalances) {
    const report = {
      timestamp: new Date().toISOString(),
      totalWallets: simResults.length,
      passed: simResults.filter(r => r.success).length,
      failed: simResults.filter(r => !r.success).length,
      failureReasons: {},
      balanceIssues: walletBalances.filter(b => !b.sufficient).length,
      ready: true
    };

    for (const result of simResults.filter(r => !r.success)) {
      const reason = result.error;
      report.failureReasons[reason] = (report.failureReasons[reason] || 0) + 1;
    }

    report.ready = report.failed === 0 && report.balanceIssues === 0;

    return report;
  }
}
