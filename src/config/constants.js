export const CIRCUIT_BREAKER = {
  FAILURE_THRESHOLD: 3,
  COOLDOWN_MS: 30000,
  HALF_OPEN_TEST_DELAY_MS: 30000
};

export const RPC = {
  MAX_CONCURRENT_REQUESTS: 10,
  REQUEST_TIMEOUT_MS: 15000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000
};

// Validate GAS constants at module load time
const validateGasConstants = () => {
  const constants = {
    BASE_FEE_HISTORY_BLOCKS: 10,
    BASE_FEE_MULTIPLIER_AUTO: 1.5,
    BASE_FEE_MULTIPLIER_AGGRESSIVE: 2.0,
    PRIORITY_FEE_PERCENTILE: 50,
    PRIORITY_FEE_PERCENTILE_AGGRESSIVE: 90,
    MAX_PRIORITY_FEE_WARNING_GWEI: 10,
    RBF_MULTIPLIER: 1.15,
    RBF_MAX_ATTEMPTS: 3,
    RBF_STUCK_TIMEOUT_MS: 30000,
    GAS_LIMIT_BUFFER: 1.2
  };
  
  // Validate multipliers are > 1.0
  if (constants.BASE_FEE_MULTIPLIER_AUTO <= 1.0 || constants.BASE_FEE_MULTIPLIER_AGGRESSIVE <= 1.0) {
    throw new Error('BASE_FEE_MULTIPLIER values must be greater than 1.0');
  }
  
  if (constants.RBF_MULTIPLIER <= 1.0 || constants.GAS_LIMIT_BUFFER <= 1.0) {
    throw new Error('RBF_MULTIPLIER and GAS_LIMIT_BUFFER must be greater than 1.0');
  }
  
  return constants;
};

export const GAS = validateGasConstants();

export const WALLET = {
  HD_PATH: "m/44'/60'/0'/0",
  ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  PBKDF2_ITERATIONS: 100000,
  PBKDF2_KEYLEN: 32,
  PBKDF2_DIGEST: 'sha512'
};

const parseBatchSize = () => {
  const envValue = parseInt(process.env.MINT_BATCH_SIZE, 10);
  if (!isNaN(envValue) && envValue > 0 && envValue <= 100) {
    return envValue;
  }
  return 5; // Default
};

export const MINT = {
  BATCH_SIZE: parseBatchSize(),
  CONFIRMATION_BLOCKS: 1,
  DRY_RUN_TIMEOUT_MS: 10000,
  MIN_WALLET_BALANCE_BUFFER: 1.1
};

export const MONITOR = {
  BLOCK_POLL_INTERVAL_MS: 1000,
  STATUS_UPDATE_INTERVAL_MS: 3000
};

export const EIP_SLOTS = {
  EIP1967_IMPLEMENTATION: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  EIP1822_IMPLEMENTATION: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7'
};

export const COMMON_MINT_FUNCTIONS = [
  'mint',
  'publicMint',
  'claim',
  'safeMint',
  'mintNFT',
  'purchase',
  'buy',
  'mintSeaDrop',
  'mintPublic',
  'mintAllowList',
];

export const COMMON_STATE_VARS = {
  price: ['mintPrice', 'price', 'cost', 'PUBLIC_PRICE'],
  supply: ['maxSupply', 'MAX_SUPPLY', 'totalSupply'],
  paused: ['paused', 'mintActive', 'saleIsActive', 'publicSaleActive'],
  limit: ['maxPerWallet', 'walletLimit', 'MAX_PER_WALLET']
};
