import { ethers } from 'ethers';
import { EIP_SLOTS, COMMON_MINT_FUNCTIONS, COMMON_STATE_VARS } from '../../config/constants.js';
import { resolveEtherscanConfig } from '../../config/chains.js';
import { SeaDropEngine } from './SeaDropEngine.js';
import pino from 'pino';

const logger = pino({ name: 'ContractResolver' });

export class ContractResolver {
  constructor(rpcPool, chain) {
    this.rpcPool = rpcPool;
    this.chain = chain;
    this.etherscanConfig = resolveEtherscanConfig(chain);
  }

  async resolveImplementation(proxyAddress) {
    try {
      const eip1967Impl = await this.rpcPool.send('eth_getStorageAt', [
        proxyAddress,
        EIP_SLOTS.EIP1967_IMPLEMENTATION,
        'latest'
      ]);

      if (eip1967Impl && eip1967Impl !== '0x' + '0'.repeat(64)) {
        const implAddress = '0x' + eip1967Impl.slice(-40);
        // Validate implementation is not zero address
        if (implAddress === '0x' + '0'.repeat(40)) {
          logger.warn(`EIP-1967 implementation is zero address for ${proxyAddress}`);
        } else {
          logger.info(`EIP-1967 proxy detected: ${proxyAddress} -> ${implAddress}`);
          return implAddress;
        }
      }

      const eip1822Impl = await this.rpcPool.send('eth_getStorageAt', [
        proxyAddress,
        EIP_SLOTS.EIP1822_IMPLEMENTATION,
        'latest'
      ]);

      if (eip1822Impl && eip1822Impl !== '0x' + '0'.repeat(64)) {
        const implAddress = '0x' + eip1822Impl.slice(-40);
        // Validate implementation is not zero address
        if (implAddress === '0x' + '0'.repeat(40)) {
          logger.warn(`EIP-1822 implementation is zero address for ${proxyAddress}`);
        } else {
          logger.info(`EIP-1822 proxy detected: ${proxyAddress} -> ${implAddress}`);
          return implAddress;
        }
      }

      logger.debug(`No proxy detected for ${proxyAddress}`);
      return proxyAddress;

    } catch (error) {
      logger.warn(`Proxy detection failed: ${error.message}`);
      return proxyAddress;
    }
  }

  async fetchABI(contractAddress) {
    const implementationAddress = await this.resolveImplementation(contractAddress);

    if (!this.etherscanConfig.apiKey) {
      throw new Error(`Etherscan API key not configured for ${this.chain.name}`);
    }

    const url = `${this.etherscanConfig.apiUrl}?chainid=${this.etherscanConfig.chainId}&module=contract&action=getabi&address=${implementationAddress}&apikey=${this.etherscanConfig.apiKey}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== '1') {
        throw new Error(`Etherscan API error: ${data.result}`);
      }

      let abi;
      try {
        abi = JSON.parse(data.result);
      } catch (parseError) {
        throw new Error(`Invalid ABI format from Etherscan: ${parseError.message}`);
      }

      if (!Array.isArray(abi)) {
        throw new Error('ABI must be an array');
      }
      
      if (abi.length === 0) {
        throw new Error('ABI is empty - contract may not be verified');
      }

      logger.info(`Fetched ABI for ${implementationAddress} (${abi.length} items)`);
      
      return {
        address: contractAddress,
        implementationAddress,
        abi,
        isProxy: contractAddress.toLowerCase() !== implementationAddress.toLowerCase()
      };

    } catch (error) {
      throw new Error(`Failed to fetch ABI: ${error.message}`);
    }
  }

  detectMintFunction(abi) {
    const functions = abi.filter(item => item.type === 'function');
    
    for (const funcName of COMMON_MINT_FUNCTIONS) {
      const match = functions.find(f => 
        f.name && f.name.toLowerCase() === funcName.toLowerCase()
      );
      
      if (match && this._validateFunctionStructure(match)) {
        logger.info(`Mint function detected: ${match.name}`);
        return match;
      }
    }

    const payableFunctions = functions.filter(f => 
      f.stateMutability === 'payable' && this._validateFunctionStructure(f)
    );
    if (payableFunctions.length > 0) {
      logger.warn(`No standard mint function found, using first payable: ${payableFunctions[0].name}`);
      return payableFunctions[0];
    }

    throw new Error('No mint function detected in contract ABI');
  }
  
  _validateFunctionStructure(func) {
    return func.name && 
           func.inputs !== undefined && 
           Array.isArray(func.inputs) &&
           func.stateMutability !== undefined;
  }

  detectERCType(abi) {
    const functions = abi.filter(item => item.type === 'function').map(f => f.name);
    
    const erc721Signatures = ['ownerOf', 'safeTransferFrom', 'tokenURI'];
    const erc1155Signatures = ['balanceOf', 'safeTransferFrom', 'uri'];

    const has721 = erc721Signatures.every(sig => functions.includes(sig));
    const has1155 = erc1155Signatures.every(sig => functions.includes(sig));

    if (has721) return 'ERC-721';
    if (has1155) return 'ERC-1155';
    
    return 'Unknown';
  }

  async readContractState(contractAddress, abi) {
    const iface = new ethers.Interface(abi);
    const state = {};
    let successCount = 0;
    let attemptCount = 0;

    for (const [key, varNames] of Object.entries(COMMON_STATE_VARS)) {
      let found = false;
      for (const varName of varNames) {
        try {
          attemptCount++;
          const fragment = iface.getFunction(varName);
          if (!fragment) continue;

          const data = iface.encodeFunctionData(varName);
          const result = await this.rpcPool.call({
            to: contractAddress,
            data
          });

          const decoded = iface.decodeFunctionResult(varName, result);
          state[key] = decoded[0];
          
          logger.debug(`Read ${varName}: ${decoded[0]}`);
          successCount++;
          found = true;
          break;

        } catch (error) {
          continue;
        }
      }
      if (!found) {
        logger.debug(`Could not read any ${key} variable`);
      }
    }

    if (attemptCount > 0 && successCount === 0) {
      logger.warn(`Failed to read any contract state variables (${attemptCount} attempts)`);
    }

    const hasMerkleRoot = abi.some(item => 
      item.type === 'function' && 
      (item.name === 'merkleRoot' || item.outputs?.some(o => o.type === 'bytes32'))
    );

    state.hasMerkleRoot = hasMerkleRoot;

    return state;
  }

  async analyzeContract(contractAddress) {
    logger.info(`Analyzing contract: ${contractAddress}`);

    const { abi, implementationAddress, isProxy } = await this.fetchABI(contractAddress);
    
    const isSeaDrop = SeaDropEngine.isSeaDropContract(abi);
    const mintFunction = this.detectMintFunction(abi);
    const ercType = this.detectERCType(abi);
    const state = await this.readContractState(contractAddress, abi);

    const analysis = {
      address: contractAddress,
      implementationAddress,
      isProxy,
      abi,
      ercType,
      isSeaDrop,
      mintFunction: {
        name: mintFunction.name,
        inputs: mintFunction.inputs,
        stateMutability: mintFunction.stateMutability
      },
      state: {
        mintPrice: state.price ? ethers.formatEther(state.price) + ' ETH' : 'Unknown',
        mintPriceWei: state.price?.toString(),
        maxSupply: state.supply?.toString(),
        paused: state.paused !== undefined ? !state.paused : null,
        maxPerWallet: state.limit?.toString(),
        supportsWhitelist: state.hasMerkleRoot
      }
    };

    if (isSeaDrop) {
      logger.info(`SeaDrop contract detected — standard mint args will NOT work, use SeaDropEngine`);
    }

    logger.info(`Analysis complete: ${ercType}, mint=${mintFunction.name}, seaDrop=${isSeaDrop}, price=${analysis.state.mintPrice}`);

    return analysis;
  }

  buildMintCalldata(mintFunction, args = []) {
    const iface = new ethers.Interface([mintFunction]);
    return iface.encodeFunctionData(mintFunction.name, args);
  }

  async detectMintArguments(contractAddress, abi, mintFunction, walletAddress) {
    if (!mintFunction.inputs || !Array.isArray(mintFunction.inputs)) {
      throw new Error('Mint function has invalid or missing inputs array');
    }
    
    const args = [];

    for (const input of mintFunction.inputs) {
      if (input.name.toLowerCase().includes('proof') || input.type === 'bytes32[]') {
        args.push([]);
      } else if (input.name.toLowerCase().includes('quantity') || input.name.toLowerCase().includes('amount')) {
        args.push(1);
      } else if (input.type === 'address') {
        args.push(walletAddress);
      } else if (input.type.startsWith('uint')) {
        args.push(1);
      } else if (input.type === 'bytes') {
        args.push('0x');
      } else {
        args.push(0);
      }
    }

    // Validate args length matches inputs length
    if (args.length !== mintFunction.inputs.length) {
      throw new Error(`Args mismatch: generated ${args.length} args but function expects ${mintFunction.inputs.length}`);
    }

    logger.debug(`Auto-detected mint args: ${JSON.stringify(args)}`);
    return args;
  }
}
