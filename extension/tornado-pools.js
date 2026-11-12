/* Tornado Cash Classic deployment allowlist.
 * Source: tornadocash/tornado-classic-ui @ a83fae0772c8da084c0e76b3a756b456f5b9f5bb, networkConfig.js (MIT).
 * Addresses are fixed deployment identifiers; each pool is also checked on-chain before use.
 */
(function (root) {
  'use strict';
  const networks = {
  "1": {
    "currency": "eth",
    "deployedBlock": 9116966,
    "subdomain": "mainnet-tornado",
    "tokens": {
      "eth": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "1": "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936",
          "10": "0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF",
          "100": "0xA160cdAB225685dA1d56aa342Ad8841c3b53f291",
          "0.1": "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc"
        }
      },
      "dai": {
        "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        "decimals": 18,
        "instances": {
          "100": "0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3",
          "1000": "0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144",
          "10000": "0x07687e702b410Fa43f4cB4Af7FA097918ffD2730",
          "100000": "0x23773E65ed146A459791799d01336DB287f25334"
        }
      },
      "usdc": {
        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "decimals": 6,
        "instances": {
          "100": "0xd96f2B1c14Db8458374d9Aca76E26c3D18364307",
          "1000": "0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D",
          "10000": "",
          "100000": ""
        }
      },
      "usdt": {
        "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "decimals": 6,
        "instances": {
          "100": "0x169AD27A470D064DEDE56a2D3ff727986b15D52B",
          "1000": "0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f",
          "10000": "",
          "100000": ""
        }
      }
    }
  },
  "10": {
    "currency": "eth",
    "deployedBlock": 2243689,
    "subdomain": "optimism-tornado",
    "tokens": {
      "eth": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "1": "0xd47438C816c9E7f2E2888E060936a499Af9582b3",
          "10": "0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "0.1": "0x84443CFd09A48AF6eF360C6976C5392aC5023a1F"
        }
      }
    }
  },
  "56": {
    "currency": "bnb",
    "deployedBlock": 8158799,
    "subdomain": "bsc-tornado",
    "tokens": {
      "bnb": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "1": "0xd47438C816c9E7f2E2888E060936a499Af9582b3",
          "10": "0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "0.1": "0x84443CFd09A48AF6eF360C6976C5392aC5023a1F"
        }
      }
    }
  },
  "100": {
    "currency": "xdai",
    "deployedBlock": 17754561,
    "subdomain": "gnosis-tornado",
    "tokens": {
      "xdai": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "1000": "0xdf231d99Ff8b6c6CBF4E9B9a945CBAcEF9339178",
          "10000": "0xaf4c0B70B2Ea9FB7487C7CbB37aDa259579fe040",
          "100000": "0xa5C2254e4253490C54cef0a4347fddb8f75A4998"
        }
      }
    }
  },
  "137": {
    "currency": "matic",
    "deployedBlock": 16257962,
    "subdomain": "polygon-tornado",
    "tokens": {
      "matic": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "1000": "0xdf231d99Ff8b6c6CBF4E9B9a945CBAcEF9339178",
          "10000": "0xaf4c0B70B2Ea9FB7487C7CbB37aDa259579fe040",
          "100000": "0xa5C2254e4253490C54cef0a4347fddb8f75A4998"
        }
      }
    }
  },
  "42161": {
    "currency": "eth",
    "deployedBlock": 3430648,
    "subdomain": "arbitrum-tornado",
    "tokens": {
      "eth": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "1": "0xd47438C816c9E7f2E2888E060936a499Af9582b3",
          "10": "0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "0.1": "0x84443CFd09A48AF6eF360C6976C5392aC5023a1F"
        }
      }
    }
  },
  "43114": {
    "currency": "avax",
    "deployedBlock": 4429818,
    "subdomain": "avalanche-tornado",
    "tokens": {
      "avax": {
        "address": "native",
        "decimals": 18,
        "instances": {
          "10": "0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
          "100": "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
          "500": "0xaf8d1839c3c67cf571aa74B5c12398d4901147B3"
        }
      }
    }
  }
};
  const registry = Object.freeze({
    chainId: 1,
    address: '0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2',
    aggregator: '0xE8F47A78A6D52D317D0D2FFFac56739fE14D1b49',
    deployedBlock: 14173129,
    minimumStake: '40000000000000000000',
    subdomains: ['mainnet-tornado', 'bsc-tornado', 'polygon-tornado', 'optimism-tornado', 'arbitrum-tornado', 'gnosis-tornado', 'avalanche-tornado', 'goerli-tornado'],
  });
  function getPools(chainId, asset = 'native') {
    const network = networks[Number(chainId)];
    if (!network) return [];
    const wanted = String(asset).toLowerCase();
    const entry = Object.entries(network.tokens).find(([currency, token]) =>
      wanted === 'native' ? currency === network.currency : String(token.address).toLowerCase() === wanted);
    if (!entry) return [];
    const [currency, token] = entry;
    return Object.entries(token.instances).filter(([, address]) => !!address).map(([amount, address]) => ({
      address, amount, currency, decimals: token.decimals, deployedBlock: network.deployedBlock, chainId: Number(chainId),
    })).sort((a, b) => Number(b.amount) - Number(a.amount));
  }
  const api = Object.freeze({ getPools, registry, REGISTRY: registry, networks });
  root.TornadoPools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? window : globalThis);

