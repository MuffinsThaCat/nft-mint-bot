import { ethers } from 'ethers';
import { GAS } from '../../config/constants.js';
import pino from 'pino';

const logger = pino({ name: 'FeeHistory' });

export class FeeHistory {
  constructor(rpcPool) {
    this.rpcPool = rpcPool;
  }

  async analyze() {
    const blockCount = GAS.BASE_FEE_HISTORY_BLOCKS;
    
    const feeHistory = await this.rpcPool.send('eth_feeHistory', [
      `0x${blockCount.toString(16)}`,
      'latest',
      [25, 50, 75]
    ]);

    // Validate response structure
    if (!feeHistory || !Array.isArray(feeHistory.baseFeePerGas)) {
      throw new Error('Invalid fee history response - missing baseFeePerGas');
    }
    
    if (!Array.isArray(feeHistory.reward) || feeHistory.reward.length === 0) {
      throw new Error('Invalid fee history response - missing reward data');
    }

    let baseFees, priorityFees;
    
    try {
      baseFees = feeHistory.baseFeePerGas.map(fee => BigInt(fee));
    } catch (error) {
      throw new Error(`Invalid baseFeePerGas format: ${error.message}`);
    }
    
    try {
      priorityFees = feeHistory.reward.map(block => {
        if (!Array.isArray(block) || block.length < 3) {
          throw new Error('Invalid reward array structure');
        }
        return block.map(fee => BigInt(fee));
      });
    } catch (error) {
      throw new Error(`Invalid reward fee format: ${error.message}`);
    }

    const trend = this._calculateTrend(baseFees);
    const projectedBaseFee = this._projectBaseFee(baseFees, trend);
    const medianPriorityFee = this._calculateMedianPriorityFee(priorityFees, 50);
    const aggressivePriorityFee = this._calculateMedianPriorityFee(priorityFees, 75);

    logger.debug(`Base fee trend: ${trend}, current: ${baseFees[baseFees.length - 1]}, projected: ${projectedBaseFee}`);

    return {
      currentBaseFee: baseFees[baseFees.length - 1],
      projectedBaseFee,
      trend,
      medianPriorityFee,
      aggressivePriorityFee,
      baseFeeHistory: baseFees
    };
  }

  _calculateTrend(baseFees) {
    if (baseFees.length < 2) return 'stable';

    const recentFees = baseFees.slice(-5);
    let increases = 0;
    let decreases = 0;

    for (let i = 1; i < recentFees.length; i++) {
      if (recentFees[i] > recentFees[i - 1]) increases++;
      else if (recentFees[i] < recentFees[i - 1]) decreases++;
    }

    if (increases > decreases * 2) return 'rising';
    if (decreases > increases * 2) return 'falling';
    return 'stable';
  }

  _projectBaseFee(baseFees, trend) {
    const current = baseFees[baseFees.length - 1];

    if (trend === 'stable' || trend === 'falling') {
      return current;
    }

    // Rising trend: project 2-3 blocks ahead at 12.5% max increase per block
    const blocksAhead = 3;
    let projected = current;
    
    // Prevent overflow: if current is already extremely high, return it capped
    const MAX_BASE_FEE = 10000n * 1000000000n; // 10k gwei (unrealistic but safe ceiling)
    if (projected > MAX_BASE_FEE) {
      return MAX_BASE_FEE;
    }
    
    for (let i = 0; i < blocksAhead; i++) {
      projected = (projected * 1125n) / 1000n; // 12.5% increase
      
      // Cap at max to prevent overflow
      if (projected > MAX_BASE_FEE) {
        return MAX_BASE_FEE;
      }
    }

    return projected;
  }

  _calculateMedianPriorityFee(priorityFees, percentileIndex) {
    // Map percentile index to array position (25->0, 50->1, 75->2)
    const arrayIndex = percentileIndex === 25 ? 0 : percentileIndex === 50 ? 1 : 2;
    const fees = priorityFees.map(block => block[arrayIndex]);
    
    if (fees.length === 0) {
      throw new Error('Cannot calculate median of empty fee array');
    }
    
    fees.sort((a, b) => Number(a - b));
    
    const mid = Math.floor(fees.length / 2);
    return fees.length % 2 === 0
      ? (fees[mid - 1] + fees[mid]) / 2n
      : fees[mid];
  }

  async getCurrentBaseFee() {
    const block = await this.rpcPool.getBlock('latest');
    
    if (!block || block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
      throw new Error('Chain does not support EIP-1559 or block data unavailable');
    }
    
    return block.baseFeePerGas;
  }
}
