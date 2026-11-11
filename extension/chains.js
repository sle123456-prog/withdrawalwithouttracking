// 支持的 EVM 主流链。tokens 为预置代币（合约地址小写），其他代币可在界面里填合约地址。
// l1Oracle：OP Stack / Scroll 等 L2 额外收取 L1 数据费，用预言机估算后预留。
const OP_ORACLE = '0x420000000000000000000000000000000000000f';

const CHAINS = [
  {
    id: 1, name: 'Ethereum', symbol: 'ETH',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    explorer: 'https://etherscan.io',
    tokens: {
      USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
    },
  },
  {
    id: 56, name: 'BNB Smart Chain', symbol: 'BNB',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    explorer: 'https://bscscan.com',
    tokens: {
      USDT: '0x55d398326f99059ff775485246999027b3197955',
      USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    },
  },
  {
    id: 137, name: 'Polygon', symbol: 'POL',
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
    tokens: {
      USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    },
  },
  {
    id: 42161, name: 'Arbitrum One', symbol: 'ETH',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    tokens: {
      USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    },
  },
  {
    id: 10, name: 'Optimism', symbol: 'ETH', l1Oracle: OP_ORACLE,
    rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    explorer: 'https://optimistic.etherscan.io',
    tokens: {
      USDT: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
      USDC: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    },
  },
  {
    id: 8453, name: 'Base', symbol: 'ETH', l1Oracle: OP_ORACLE,
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    tokens: {
      USDT: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
      USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    },
  },
  {
    id: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX',
    rpcs: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
    explorer: 'https://snowtrace.io',
    tokens: {
      USDT: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
      USDC: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    },
  },
  {
    id: 59144, name: 'Linea', symbol: 'ETH',
    rpcs: ['https://linea-rpc.publicnode.com', 'https://rpc.linea.build'],
    explorer: 'https://lineascan.build',
    tokens: {
      USDT: '0xa219439258ca9da29e9cc4ce5596924745e12b93',
      USDC: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
    },
  },
  {
    id: 324, name: 'zkSync Era', symbol: 'ETH',
    rpcs: ['https://mainnet.era.zksync.io'],
    explorer: 'https://explorer.zksync.io',
    tokens: {},
  },
  {
    id: 534352, name: 'Scroll', symbol: 'ETH',
    l1Oracle: '0x5300000000000000000000000000000000000002',
    rpcs: ['https://scroll-rpc.publicnode.com', 'https://rpc.scroll.io'],
    explorer: 'https://scrollscan.com',
    tokens: {},
  },
  {
    id: 5000, name: 'Mantle', symbol: 'MNT',
    rpcs: ['https://mantle-rpc.publicnode.com', 'https://rpc.mantle.xyz'],
    explorer: 'https://mantlescan.xyz',
    tokens: {},
  },
  {
    id: 100, name: 'Gnosis', symbol: 'xDAI',
    rpcs: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
    explorer: 'https://gnosisscan.io',
    tokens: {},
  },
];
