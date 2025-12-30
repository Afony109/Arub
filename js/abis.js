/**
 * abis.js
 *
 * Centralized ABIs for frontend (ES module)
 * Must be accessible at /js/abis.js
 *
 * Notes:
 *  - USDT decimals = 6
 *  - ARUB decimals = 6
 *  - UI flow: Presale-centric (buy/redeem/locks/fees)
 */

// --------------------------------------------------
// Minimal ERC20 ABI (balance/allowance/approve + transfers)
// --------------------------------------------------
const ERC20_MINIMAL_ABI = [
  // Read
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',

  // Write
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',

  // Events
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// --------------------------------------------------
// Exported ERC20 ABI (used by trading.js / generic token reads)
// --------------------------------------------------
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// --------------------------------------------------
// Oracle ABI (oracl.sol)
// contracts.js uses: getRate()
// --------------------------------------------------
export const ORACLE_ABI = [
  'function getRate() view returns (uint256,uint256)',   // (rate, updatedAt)
  'function currentRate() view returns (uint256)',       // optional
  'function usdRub() view returns (uint256)',            // optional
  'function lastRate() view returns (uint256)',          // optional
  'function lastUpdatedAt() view returns (uint256)',     // optional
];

// --------------------------------------------------
// USDT ABI (ERC20, 6 decimals)
// --------------------------------------------------
export const USDT_ABI = [
  ...ERC20_MINIMAL_ABI,
];

// --------------------------------------------------
// ARUB Token ABI (token.sol) — for UI integrations
// Decimals: 6
// --------------------------------------------------
export const ARUB_ABI = [
  ...ERC20_MINIMAL_ABI,

  // Oracle-linked conversion helpers
  'function calculateArubAmount(uint256 usdtAmount) view returns (uint256)',
  'function calculateUsdtAmount(uint256 arubAmount) view returns (uint256)',

  // Mint/Burn (restricted; UI normally won't call directly, but contracts do)
  'function mintTo(address to, uint256 amount) external',
  'function burnFrom(address from, uint256 amount) external',

  // Presale wrappers (used by presale.sol)
  'function mint(address to, uint256 amount) external',
  'function burn(address from, uint256 amount) external',

  // Optional reads
  'function oracle() view returns (address)',
  'function maxSupply() view returns (uint256)',
];

// --------------------------------------------------
// ARUBVault ABI (ERC20 shares + deposit/withdraw)
// --------------------------------------------------
export const VAULT_ABI = [
  // ---- ERC20 (shares) ----
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',

  // ---- Vault core ----
  'function deposit(uint256 arubAmount)',
  'function withdraw(uint256 shares)',

  // ---- View helpers ----
  'function totalAssetsArubEq() view returns (uint256)',
  'function asset() view returns (address)',

  // ---- Events ----
  'event Deposit(address indexed user, uint256 arubAmount, uint256 shares)',
  'event Withdraw(address indexed user, uint256 shares, uint256 arubAmount)',
];

// --------------------------------------------------
// Presale READ ABI (precale.sol) — used by trading.js (read-only)
// trading.js calls:
//  - getDiscountPercent(), totalDiscountBuyers(), DISCOUNT_MAX_BUYERS()
//  - lockedPrincipalArub(), lockedBonusArub(), lockedDepositUntil()
//  - getRemainingLockTime(), getUserSellFeeBps()
// --------------------------------------------------
export const PRESALE_READ_ABI = [
  'function paused() view returns (bool)',

  // discount
  'function getDiscountPercent() view returns (uint256)',
  'function totalDiscountBuyers() view returns (uint256)',
  'function DISCOUNT_MAX_BUYERS() view returns (uint256)',

  // locks
  'function lockedPrincipalArub(address) view returns (uint256)',
  'function lockedBonusArub(address) view returns (uint256)',
  'function lockedDepositUntil(address) view returns (uint256)',
  'function getRemainingLockTime(address) view returns (uint256)',

  // sell fee
  'function getUserSellFeeBps(address user) view returns (uint256)',

  // optional helpers
  'function totalDeposited(address) view returns (uint256)',
  'function isDiscountBuyer(address) view returns (bool)',
  'function debtUsdtEquivalent(address) view returns (uint256)',
  'function getMyLockedInfo() view returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)',
];

// (Optional) Presale write ABI — not required by your current trading.js import,
// but kept here for consistency if you later unify ABIs.
export const PRESALE_WRITE_ABI = [
  'function buyWithUSDT(uint256 amount, bool withBonus) external',
  'function unlockDeposit() external',
  'function redeemForUSDT(uint256 arubAmount) external',
  'function claimDebt(bool preferredUSDT) external',
  'function getMySellFeeBps() view returns (uint256)',
];

