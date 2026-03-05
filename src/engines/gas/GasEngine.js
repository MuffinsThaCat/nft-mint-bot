import { ethers } from 'ethers';
import { FeeHistory } from './FeeHistory.js';
import { GAS } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'GasEngine' });

export class GasEngine {
  constructor(rpcPool, chain) {
    this.rpcPool = rpcPool;
    this.chain = chain;
    this.feeHistory = new FeeHistory(rpcPool);
    this.mode = 'auto';
    this.manualParams = null;
    this.maxGasCeiling = null;
  }

  setMode(mode) {
    if (!['auto', 'aggressive', 'manual'].includes(mode)) {
      throw new Error(`Invalid gas mode: ${mode}. Must be auto, aggressive, or manual.`);
    }
    this.mode = mode;
    logger.info(`Gas mode set to: ${mode}`);
  }

  setManualParams(maxFeePerGas, maxPriorityFeePerGas) {
    // Validate inputs are positive numbers
    if (typeof maxFeePerGas !== 'number' || typeof maxPriorityFeePerGas !== 'number') {
      throw new Error('Gas parameters must be numbers');
    }
    
    if (maxFeePerGas <= 0 || maxPriorityFeePerGas <= 0) {
      throw new Error('Gas parameters must be positive');
    }
    
    if (maxFeePerGas < maxPriorityFeePerGas) {
      throw new Error('maxFeePerGas must be >= maxPriorityFeePerGas');
    }
    
    this.manualParams = {
      maxFeePerGas: ethers.parseUnits(maxFeePerGas.toString(), 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(maxPriorityFeePerGas.toString(), 'gwei')
    };
    logger.info(`Manual gas params set: maxFee=${maxFeePerGas}, priority=${maxPriorityFeePerGas}`);
  }

  setMaxGasCeiling(maxGwei) {
    this.maxGasCeiling = ethers.parseUnits(maxGwei.toString(), 'gwei');
    logger.info(`Gas ceiling set: ${maxGwei} gwei`);
  }

  async getGasParams(estimatedGasLimit = null) {
    // Validate chain configuration
    if (!this.chain || typeof this.chain.eip1559 !== 'boolean') {
      throw new Error('Invalid chain configuration - eip1559 flag missing');
    }
    
    if (!this.chain.eip1559) {
      return this._getLegacyGasParams();
    }

    if (this.mode === 'manual') {
      return this._getManualParams(estimatedGasLimit);
    }

    const analysis = await this.feeHistory.analyze();
    
    let maxFeePerGas, maxPriorityFeePerGas;

    if (this.mode === 'auto') {
      // Use integer representation to avoid floating point precision loss
      // 1.2 * 1000 = 1200
      const multiplierInt = Math.round(GAS.BASE_FEE_MULTIPLIER_AUTO * 1000);
      const multiplier = BigInt(multiplierInt);
      maxFeePerGas = (analysis.projectedBaseFee * multiplier) / 1000n;
      maxPriorityFeePerGas = analysis.medianPriorityFee;
    } else if (this.mode === 'aggressive') {
      // Use integer representation to avoid floating point precision loss
      // 1.5 * 1000 = 1500
      const multiplierInt = Math.round(GAS.BASE_FEE_MULTIPLIER_AGGRESSIVE * 1000);
      const multiplier = BigInt(multiplierInt);
      maxFeePerGas = (analysis.projectedBaseFee * multiplier) / 1000n;
      maxPriorityFeePerGas = analysis.aggressivePriorityFee;
    }

    // Check for potential overflow before adding
    const maxSafeGas = ethers.parseUnits('100000', 'gwei'); // 100k gwei safety limit
    if (maxFeePerGas > maxSafeGas || maxPriorityFeePerGas > maxSafeGas) {
      throw new Error('Gas price calculation overflow - network gas too high');
    }

    maxFeePerGas = maxFeePerGas + maxPriorityFeePerGas;

    if (this.maxGasCeiling && maxFeePerGas > this.maxGasCeiling) {
      throw new Error(
        `Gas price ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei exceeds ceiling of ${ethers.formatUnits(this.maxGasCeiling, 'gwei')} gwei`
      );
    }

    if (maxPriorityFeePerGas > ethers.parseUnits(GAS.MAX_PRIORITY_FEE_WARNING_GWEI.toString(), 'gwei')) {
      logger.warn(`Priority fee is unusually high: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);
    }

    let gasLimit = null;
    if (estimatedGasLimit) {
      // Use BigInt arithmetic to avoid precision loss
      const estimated = typeof estimatedGasLimit === 'bigint' ? estimatedGasLimit : BigInt(estimatedGasLimit);
      
      // Check for overflow before multiplication
      const MAX_GAS_LIMIT = 30000000n; // 30M gas (block limit on most chains)
      if (estimated > MAX_GAS_LIMIT) {
        throw new Error(`Gas estimate too large: ${estimatedGasLimit}`);
      }
      
      // Use integer representation: 1.2 * 1000 = 1200
      const bufferInt = BigInt(Math.floor(GAS.GAS_LIMIT_BUFFER * 1000));
      gasLimit = (estimated * bufferInt) / 1000n;
    }

    logger.info(`Gas params (${this.mode}): maxFee=${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei, priority=${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      mode: this.mode
    };
  }

  _getManualParams(estimatedGasLimit) {
    if (!this.manualParams) {
      throw new Error('Manual mode enabled but params not set. Call setManualParams() first.');
    }

    let gasLimit = null;
    if (estimatedGasLimit) {
      // Use BigInt arithmetic to avoid precision loss
      const estimated = typeof estimatedGasLimit === 'bigint' ? estimatedGasLimit : BigInt(estimatedGasLimit);
      const bufferInt = BigInt(Math.floor(GAS.GAS_LIMIT_BUFFER * 1000));
      gasLimit = (estimated * bufferInt) / 1000n;
    }

    return {
      ...this.manualParams,
      gasLimit,
      mode: 'manual'
    };
  }

  async _getLegacyGasParams() {
    const feeData = await this.rpcPool.getFeeData();
    let gasPrice = feeData.gasPrice;

    if (!gasPrice || gasPrice === 0n) {
      throw new Error('Failed to get gas price from RPC - returned null or zero');
    }

    if (this.mode === 'aggressive') {
      gasPrice = (gasPrice * 150n) / 100n;
    }

    if (this.maxGasCeiling && gasPrice > this.maxGasCeiling) {
      throw new Error(
        `Gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei exceeds ceiling of ${ethers.formatUnits(this.maxGasCeiling, 'gwei')} gwei`
      );
    }

    logger.info(`Legacy gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);

    return {
      gasPrice,
      mode: this.mode
    };
  }

  calculateRBFGas(originalParams) {
    if (originalParams.maxFeePerGas) {
      const newMaxFee = (originalParams.maxFeePerGas * BigInt(Math.floor(GAS.RBF_MULTIPLIER * 1000))) / 1000n;
      const newPriority = (originalParams.maxPriorityFeePerGas * BigInt(Math.floor(GAS.RBF_MULTIPLIER * 1000))) / 1000n;

      logger.info(`RBF gas increase: ${ethers.formatUnits(originalParams.maxFeePerGas, 'gwei')} -> ${ethers.formatUnits(newMaxFee, 'gwei')} gwei`);

      return {
        maxFeePerGas: newMaxFee,
        maxPriorityFeePerGas: newPriority,
        gasLimit: originalParams.gasLimit
      };
    } else {
      const newGasPrice = (originalParams.gasPrice * BigInt(Math.floor(GAS.RBF_MULTIPLIER * 1000))) / 1000n;

      logger.info(`RBF gas increase: ${ethers.formatUnits(originalParams.gasPrice, 'gwei')} -> ${ethers.formatUnits(newGasPrice, 'gwei')} gwei`);

      return {
        gasPrice: newGasPrice
      };
    }
  }

  async estimateGasForMint(contractAddress, mintData, fromAddress) {
    try {
      const gasEstimate = await this.rpcPool.estimateGas({
        from: fromAddress,
        to: contractAddress,
        data: mintData.data,
        value: mintData.value
      });

      logger.debug(`Gas estimate for ${contractAddress}: ${gasEstimate}`);
      return gasEstimate;

    } catch (error) {
      logger.warn(`Gas estimation failed: ${error.message}, using default 300k`);
      return 300000n;
    }
  }

  async validateGasParams(gasParams) {
    const currentBaseFee = await this.feeHistory.getCurrentBaseFee();

    if (gasParams.maxFeePerGas && gasParams.maxFeePerGas < currentBaseFee) {
      throw new Error(
        `maxFeePerGas (${ethers.formatUnits(gasParams.maxFeePerGas, 'gwei')} gwei) is below current base fee (${ethers.formatUnits(currentBaseFee, 'gwei')} gwei). Transaction will never be included.`
      );
    }

    return true;
  }

  getStats() {
    return {
      mode: this.mode,
      maxGasCeiling: this.maxGasCeiling ? ethers.formatUnits(this.maxGasCeiling, 'gwei') + ' gwei' : null,
      manualParams: this.manualParams ? {
        maxFee: ethers.formatUnits(this.manualParams.maxFeePerGas, 'gwei') + ' gwei',
        priority: ethers.formatUnits(this.manualParams.maxPriorityFeePerGas, 'gwei') + ' gwei'
      } : null
    };
  }
}
