export const CHAINS = {
  ethereum: {
    id: 1,
    name: "Ethereum",
    shortName: "ETH",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}",
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com"
    ],
    flashbotsRpc: "https://rpc.flashbots.net",
    blockExplorer: "https://etherscan.io",
    blockTime: 12000,
    eip1559: true,
    etherscanApi: "https://api.etherscan.io/api",
    etherscanApiKey: "${ETHERSCAN_API_KEY}"
  },
  
  base: {
    id: 8453,
    name: "Base",
    shortName: "BASE",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}",
      "https://mainnet.base.org",
      "https://base.publicnode.com",
      "https://rpc.ankr.com/base"
    ],
    blockExplorer: "https://basescan.org",
    blockTime: 2000,
    eip1559: true,
    etherscanApi: "https://api.basescan.org/api",
    etherscanApiKey: "${BASESCAN_API_KEY}"
  },
  
  arbitrum: {
    id: 42161,
    name: "Arbitrum",
    shortName: "ARB",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}",
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.publicnode.com",
      "https://rpc.ankr.com/arbitrum"
    ],
    blockExplorer: "https://arbiscan.io",
    blockTime: 250,
    eip1559: true,
    etherscanApi: "https://api.arbiscan.io/api",
    etherscanApiKey: "${ARBISCAN_API_KEY}"
  },
  
  polygon: {
    id: 137,
    name: "Polygon",
    shortName: "MATIC",
    nativeCurrency: { symbol: "MATIC", decimals: 18 },
    rpcUrls: [
      "https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}",
      "https://polygon-rpc.com",
      "https://polygon.publicnode.com",
      "https://rpc.ankr.com/polygon"
    ],
    blockExplorer: "https://polygonscan.com",
    blockTime: 2000,
    eip1559: true,
    etherscanApi: "https://api.polygonscan.com/api",
    etherscanApiKey: "${POLYGONSCAN_API_KEY}"
  },
  
  optimism: {
    id: 10,
    name: "Optimism",
    shortName: "OP",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}",
      "https://mainnet.optimism.io",
      "https://optimism.publicnode.com",
      "https://rpc.ankr.com/optimism"
    ],
    blockExplorer: "https://optimistic.etherscan.io",
    blockTime: 2000,
    eip1559: true,
    etherscanApi: "https://api-optimistic.etherscan.io/api",
    etherscanApiKey: "${OPTIMISTIC_ETHERSCAN_API_KEY}"
  }
};

export function getChain(nameOrId) {
  // Validate input type
  if (typeof nameOrId !== 'number' && typeof nameOrId !== 'string') {
    throw new Error(`Invalid chain identifier type: ${typeof nameOrId}. Must be number or string.`);
  }
  
  let chain;
  
  if (typeof nameOrId === 'number') {
    chain = Object.values(CHAINS).find(c => c.id === nameOrId);
  } else {
    chain = CHAINS[nameOrId.toLowerCase()];
  }
  
  if (!chain) {
    throw new Error(`Unknown chain: ${nameOrId}. Supported chains: ${Object.keys(CHAINS).join(', ')}`);
  }
  
  return chain;
}

export function resolveRpcUrl(url) {
  const replacements = {
    '${ALCHEMY_KEY}': process.env.ALCHEMY_KEY,
    '${QUICKNODE_KEY}': process.env.QUICKNODE_KEY,
    '${INFURA_KEY}': process.env.INFURA_KEY
  };

  let result = url;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (url.includes(placeholder)) {
      if (!value) {
        throw new Error(`${placeholder.replace(/[${}]/g, '')} is required but not set in environment variables for URL: ${url}`);
      }
      result = result.replace(placeholder, value);
    }
  }
  
  return result;
}

export function resolveEtherscanConfig(chain) {
  // Etherscan V2 API — single endpoint for all chains, chainid parameter
  // One ETHERSCAN_API_KEY works across every supported chain in V2.
  // Fall back to chain-specific keys for users who still have them.
  const CHAIN_KEY_ENV = {
    1:     'ETHERSCAN_API_KEY',
    8453:  'BASESCAN_API_KEY',
    42161: 'ARBISCAN_API_KEY',
    137:   'POLYGONSCAN_API_KEY',
    10:    'OPTIMISTIC_ETHERSCAN_API_KEY',
  };

  const apiKey = process.env.ETHERSCAN_API_KEY
    || process.env[CHAIN_KEY_ENV[chain.id]]
    || '';

  return {
    apiUrl: 'https://api.etherscan.io/v2/api',
    chainId: chain.id,
    apiKey
  };
}
