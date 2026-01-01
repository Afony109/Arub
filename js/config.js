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
    chainId: 42161,
    chainIdDec: 42161,
    chainIdHex: '0xA4B1',

    chainName: 'Arbitrum One',

    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },

   rpcUrls: [
  'https://arbitrum-one.publicnode.com',
  'https://arbitrum.blockpi.network/v1/rpc/public',
  'https://1rpc.io/arb',
  'https://arb1.arbitrum.io/rpc'
],


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

  TX_CONFIRMATIONS: 1,
};
