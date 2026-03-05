import pino from 'pino';

const logger = pino({ name: 'StrategyEngine' });

export class StrategyEngine {
  constructor(db) {
    this.db = db;
    this.rules = {
      maxGasGwei: null,
      minSupplyRemaining: null,
      whitelistOnly: false,
      autoStart: false,
      scheduledBlock: null,
      scheduledTime: null
    };
    this.activeScheduleHandle = null; // Store timeout/interval for cleanup
  }

  setRule(key, value) {
    if (!(key in this.rules)) {
      throw new Error(`Invalid rule: ${key}`);
    }

    this.rules[key] = value;
    logger.info(`Rule set: ${key} = ${value}`);
  }

  getRule(key) {
    return this.rules[key];
  }

  getAllRules() {
    return { ...this.rules };
  }

  clearRules() {
    this.rules = {
      maxGasGwei: null,
      minSupplyRemaining: null,
      whitelistOnly: false,
      autoStart: false,
      scheduledBlock: null,
      scheduledTime: null
    };
    logger.info('All rules cleared');
  }

  async evaluateRules(context) {
    const violations = [];

    if (this.rules.maxGasGwei !== null) {
      const currentGasGwei = parseFloat(context.currentGasGwei);
      
      if (isNaN(currentGasGwei)) {
        violations.push({
          rule: 'maxGasGwei',
          reason: `Invalid gas price value: ${context.currentGasGwei}`,
          severity: 'critical'
        });
      } else if (currentGasGwei > this.rules.maxGasGwei) {
        violations.push({
          rule: 'maxGasGwei',
          reason: `Current gas ${currentGasGwei} gwei exceeds limit of ${this.rules.maxGasGwei} gwei`,
          severity: 'critical'
        });
      }
    }

    if (this.rules.minSupplyRemaining !== null && context.supplyData) {
      const { totalSupply, maxSupply } = context.supplyData;
      
      // Skip check if unlimited supply (maxSupply is 0 or null)
      if (maxSupply && maxSupply > 0) {
        // Handle oversold contracts (totalSupply > maxSupply)
        if (totalSupply > maxSupply) {
          violations.push({
            rule: 'minSupplyRemaining',
            reason: `Contract oversold: ${totalSupply} minted but max supply is ${maxSupply}`,
            severity: 'critical'
          });
        } else {
          const remaining = maxSupply - totalSupply;

          if (remaining < this.rules.minSupplyRemaining) {
            violations.push({
              rule: 'minSupplyRemaining',
              reason: `Only ${remaining} NFTs remaining, below minimum of ${this.rules.minSupplyRemaining}`,
              severity: 'warning'
            });
          }
        }
      }
    }

    if (this.rules.whitelistOnly && context.whitelistStatus) {
      const { notWhitelisted } = context.whitelistStatus;
      
      if (notWhitelisted > 0) {
        violations.push({
          rule: 'whitelistOnly',
          reason: `${notWhitelisted} wallets not whitelisted, but whitelistOnly mode is enabled`,
          severity: 'warning'
        });
      }
    }

    const allowed = violations.filter(v => v.severity === 'critical').length === 0;

    logger.info(`Rule evaluation: ${allowed ? 'PASSED' : 'FAILED'} (${violations.length} violations)`);

    return {
      allowed,
      violations
    };
  }

  scheduleForBlock(blockNumber) {
    this.rules.scheduledBlock = blockNumber;
    this.rules.scheduledTime = null;
    logger.info(`Scheduled for block ${blockNumber}`);
  }

  scheduleForTime(timestamp) {
    const now = Date.now();
    if (timestamp <= now) {
      throw new Error(`Scheduled time must be in the future. Provided: ${new Date(timestamp).toISOString()}, Now: ${new Date(now).toISOString()}`);
    }
    
    this.rules.scheduledTime = timestamp;
    this.rules.scheduledBlock = null;
    logger.info(`Scheduled for ${new Date(timestamp).toISOString()}`);
  }

  clearSchedule() {
    this._cancelActiveSchedule();
    this.rules.scheduledBlock = null;
    this.rules.scheduledTime = null;
    logger.info('Schedule cleared');
  }

  _cancelActiveSchedule() {
    if (this.activeScheduleHandle !== null) {
      // clearTimeout works for both setTimeout and setInterval handles
      clearTimeout(this.activeScheduleHandle);
      this.activeScheduleHandle = null;
      logger.debug('Cancelled active schedule handle');
    }
  }

  isScheduled() {
    return this.rules.scheduledBlock !== null || this.rules.scheduledTime !== null;
  }

  shouldExecuteNow(currentBlock, currentTime) {
    if (this.rules.scheduledBlock !== null) {
      return currentBlock >= this.rules.scheduledBlock;
    }

    if (this.rules.scheduledTime !== null) {
      return currentTime >= this.rules.scheduledTime;
    }

    return this.rules.autoStart;
  }

  async waitForSchedule(rpcPool, timeoutMs = 3600000) {
    if (!this.isScheduled()) {
      throw new Error('No schedule set');
    }

    if (this.rules.scheduledBlock !== null) {
      logger.info(`Waiting for block ${this.rules.scheduledBlock}...`);

      return new Promise((resolve, reject) => {
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 5;
        let checkInterval;
        
        const timeoutHandle = setTimeout(() => {
          if (checkInterval) clearInterval(checkInterval);
          this.activeScheduleHandle = null;
          reject(new Error('Timeout waiting for scheduled block'));
        }, timeoutMs);

        checkInterval = setInterval(async () => {
          try {
            const currentBlock = await rpcPool.getBlockNumber();
            consecutiveErrors = 0; // Reset on success
            
            if (currentBlock >= this.rules.scheduledBlock) {
              clearInterval(checkInterval);
              clearTimeout(timeoutHandle);
              this.activeScheduleHandle = null;
              logger.info(`Block ${this.rules.scheduledBlock} reached!`);
              resolve({ type: 'block', target: this.rules.scheduledBlock, current: currentBlock });
            }
          } catch (error) {
            consecutiveErrors++;
            logger.error(`Error checking block (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`);
            
            if (consecutiveErrors >= maxConsecutiveErrors) {
              clearInterval(checkInterval);
              clearTimeout(timeoutHandle);
              this.activeScheduleHandle = null;
              reject(new Error(`Failed after ${maxConsecutiveErrors} consecutive errors`));
            }
          }
        }, 1000);
        
        // Store interval handle for cleanup
        this.activeScheduleHandle = checkInterval;
      });
    }

    if (this.rules.scheduledTime !== null) {
      const targetTime = this.rules.scheduledTime;
      const now = Date.now();
      const delay = targetTime - now;

      if (delay <= 0) {
        logger.info('Scheduled time already passed, executing now');
        return { type: 'time', target: targetTime, current: now };
      }

      // setTimeout has a max delay of 2147483647 ms (~24.8 days)
      const MAX_TIMEOUT_MS = 2147483647;
      
      if (delay > MAX_TIMEOUT_MS) {
        logger.warn(`Delay ${Math.floor(delay / 1000)}s exceeds setTimeout max, using polling instead`);
        
        return new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (Date.now() >= targetTime) {
              clearInterval(checkInterval);
              this.activeScheduleHandle = null;
              logger.info('Scheduled time reached!');
              resolve({ type: 'time', target: targetTime, current: Date.now() });
            }
          }, 60000); // Check every minute for long delays
          
          // Store interval for cleanup
          this.activeScheduleHandle = checkInterval;
        });
      }

      logger.info(`Waiting ${Math.floor(delay / 1000)}s until ${new Date(targetTime).toISOString()}`);

      return new Promise((resolve) => {
        const timeoutHandle = setTimeout(() => {
          this.activeScheduleHandle = null;
          logger.info('Scheduled time reached!');
          resolve({ type: 'time', target: targetTime, current: Date.now() });
        }, delay);
        
        // Store timeout for cleanup
        this.activeScheduleHandle = timeoutHandle;
      });
    }
  }

  saveStrategy(name) {
    try {
      this.db.saveStrategy(name, JSON.stringify(this.rules), 1);
      logger.info(`Strategy "${name}" saved`);
      return true;
    } catch (error) {
      logger.error(`Failed to save strategy: ${error.message}`);
      return false;
    }
  }

  loadStrategy(name) {
    try {
      const row = this.db.getStrategy(name);

      if (!row) {
        throw new Error(`Strategy "${name}" not found`);
      }

      const loadedRules = JSON.parse(row.rules_json);
      
      // Validate schema
      const requiredKeys = ['maxGasGwei', 'minSupplyRemaining', 'whitelistOnly', 'autoStart', 'scheduledBlock', 'scheduledTime'];
      const isValid = requiredKeys.every(key => key in loadedRules);
      
      if (!isValid) {
        throw new Error(`Invalid strategy schema - missing required fields`);
      }
      
      // Validate types
      if (loadedRules.maxGasGwei !== null && typeof loadedRules.maxGasGwei !== 'number') {
        throw new Error(`Invalid maxGasGwei type`);
      }
      if (typeof loadedRules.whitelistOnly !== 'boolean' || typeof loadedRules.autoStart !== 'boolean') {
        throw new Error(`Invalid boolean field type`);
      }
      
      this.rules = loadedRules;
      logger.info(`Strategy "${name}" loaded`);
      return true;
    } catch (error) {
      logger.error(`Failed to load strategy: ${error.message}`);
      return false;
    }
  }

  listStrategies() {
    try {
      return this.db.listStrategies();
    } catch (error) {
      logger.error(`Failed to list strategies: ${error.message}`);
      return [];
    }
  }

  getStats() {
    return {
      rules: this.rules,
      scheduled: this.isScheduled(),
      scheduledFor: this.rules.scheduledBlock 
        ? `Block ${this.rules.scheduledBlock}`
        : this.rules.scheduledTime
        ? new Date(this.rules.scheduledTime).toISOString()
        : null
    };
  }
}
