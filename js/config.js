export const CONFIG = {
  // -----------------------------
  // UI
  // -----------------------------
  UI: {
    NOTIFICATION_DURATION: 5000,
  },

  // -----------------------------
  // Oracle
  // -----------------------------
  ORACLE_DECIMALS: 6, // rate = price * 1e6 (единый стандарт по проекту)

  // -----------------------------
  // Network
  // -----------------------------
 NETWORK: {
  // Switched primary read-only RPC to a more stable public endpoint
  readOnlyRpcUrl: 'https://rpc.ankr.com/arbitrum',
  walletRpcUrls: [
    'https://arb1.arbitrum.io/rpc',
    'https://rpc.ankr.com/arbitrum',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.llamarpc.com',
    // Add your Alchemy key if available:
    // 'https://arb-mainnet.g.alchemy.com/v2/<key>',
  ],
  chainId: 42161,
  chainIdHex: '0xa4b1',
  blockExplorerUrls: ['https://arbiscan.io'],
},

  // -----------------------------
  // Core addresses
  // -----------------------------
  USDT_ADDRESS: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  TOKEN_ADDRESS: '0x161296CD7F742220f727e1B4Ccc02cAEc71Ed2C6',
  TOKEN_DECIMALS: 6,

  // -----------------------------
  // Other contracts
  // -----------------------------

  ANTIRUB_ADDRESS: '0x18D1d662371AD5732Ef996A054bd7672ab626368',
  VAULT_ADDRESS:   '0x41983921104099F6e6E18b26120bf6B4037D199B',
  PRESALE_ADDRESS:'0x986833160f8E9636A6383BfAb5BeF35739edA1eC',
  ORACLE_ADDRESS: '0xC15fFAA8D6835e3238c9B73428edb6A56cb3AF89',
  ORACLE_RATE_DECIMALS: 6,
  UNISWAP_V2_ROUTER_ADDRESS: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',

  TX_CONFIRMATIONS: 1,
}

