// js/config.js
// IMPORTANT: ES module

export const CONFIG = {
  UI: {
  NOTIFICATION_DURATION: 3500
},
  // Mainnet config: Arbitrum One
  NETWORK: {
    // Новый формат (для wallet.js)
    chainId: 42161,
    chainName: 'Arbitrum One',
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://arbiscan.io'],

    // Старый формат (если где-то используется)
    name: 'Arbitrum One',
    chainIdHex: '0xa4b1',
    chainIdDecimal: 42161,
    blockExplorer: 'https://arbiscan.io',
  },

  // Core addresses
  USDT_ADDRESS: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  TOKEN_ADDRESS: '0x161296CD7F742220f727e1B4Ccc02cAEc71Ed2C6',

  // New explicit keys (for future integration)
  ANTIRUB_ADDRESS: '0x18D1d662371AD5732Ef996A054bd7672ab626368',
  VAULT_ADDRESS: '0xE5dB8Bc105775EDa8A68B5B0aA17f91F492f102B',
  PRESALE_ADDRESS: '0x44960eDa62860Fb54C143f742122619c25a129d1',
  ORACLE_ADDRESS: '0xC15fFAA8D6835e3238c9B73428edb6A56cb3AF89',
};
