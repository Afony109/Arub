/**
 * abis.js
 *
 * Centralized ABIs for frontend (ES module)
 * Must be accessible at /js/abis.js
 *
 * Project notes:
 *  - USDT decimals = 6
 *  - ARUB decimals = 6
 *  - UI flow: Presale-centric (buy/unlock/redeem/debt/fees)
 */

// --------------------------------------------------
// Minimal ERC20 ABI (balance/allowance/approve + transfers)
// --------------------------------------------------
export const ERC20_ABI_MIN = [
  // Read
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",

  // Write
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",

  // Events
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];

// --------------------------------------------------
// Exported ERC20 ABI (generic token reads)
// --------------------------------------------------
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// --------------------------------------------------
// Oracle ABI (если используется contracts.js)
// --------------------------------------------------
export const ORACLE_ABI = [
  "function getRate() view returns (uint256,uint256)",
  "function currentRate() view returns (uint256)",
  "function usdRub() view returns (uint256)",
  "function lastRate() view returns (uint256)",
  "function lastUpdatedAt() view returns (uint256)",
];

// --------------------------------------------------
// USDT ABI (ERC20, 6 decimals)
// --------------------------------------------------
export const USDT_ABI = [
  ...ERC20_ABI_MIN,
];
// --------------------------------------------------
// ARUB Token ABI (6 decimals + conversions)
// --------------------------------------------------
// --------------------------------------------------
// ARUB Token ABI (6 decimals + conversions)
// --------------------------------------------------
export const ARUB_ABI = [
  ...ERC20_ABI_MIN,

  // Conversion helpers (USDT 6dec <-> ARUB 6dec)
  "function calculateArubAmount(uint256 usdtAmount) view returns (uint256)",
  "function calculateUsdtAmount(uint256 arubAmount) view returns (uint256)",

  // Mint/Burn (restricted; UI обычно не вызывает напрямую)
  "function mintTo(address to, uint256 amount) external",
  "function burnFrom(address from, uint256 amount) external",

  // wrappers (если используете их в других контрактах)
  "function mint(address to, uint256 amount) external",
  "function burn(address from, uint256 amount) external",

  // Optional reads
  "function oracle() view returns (address)",
  "function maxSupply() view returns (uint256)",
];

// --------------------------------------------------
// ARUBVault ABI (если реально используется в UI)
// --------------------------------------------------
export const VAULT_ABI = [
  // ERC20 shares
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",

  // Vault core
  "function deposit(uint256 arubAmount)",
  "function withdraw(uint256 shares)",

  // Views
  "function totalAssetsArubEq() view returns (uint256)",
  "function asset() view returns (address)",

  // Events
  "event Deposit(address indexed user, uint256 arubAmount, uint256 shares)",
  "event Withdraw(address indexed user, uint256 shares, uint256 arubAmount)",
];

// --------------------------------------------------
// Presale READ ABI (ARUBPresale.sol, UUPS)
// ВАЖНО: redeem лимитируется redeemableBalance(user)
// --------------------------------------------------
export const PRESALE_READ_ABI = [
  // status
  "function paused() view returns (bool)",

  // constants / tiers
  "function DISCOUNT_MAX_BUYERS() view returns (uint256)",
  "function getDiscountPercent() view returns (uint256)",
  "function totalDiscountBuyers() view returns (uint256)",
  "function isDiscountBuyer(address) view returns (bool)",
  "function discountUsed(address) view returns (uint256)",

  // locks
  "function totalDeposited(address) view returns (uint256)",
  "function lockedPrincipalArub(address) view returns (uint256)",
  "function lockedBonusArub(address) view returns (uint256)",
  "function lockedDepositUntil(address) view returns (uint256)",
  "function getRemainingLockTime(address) view returns (uint256)",
  "function getMyLockedInfo() view returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)",

  // fee helpers
  "function getUserSellFeeBps(address user) view returns (uint256)",
  "function getMySellFeeBps() view returns (uint256)",
  "function getCurrentSellFeeBps(address user) view returns (uint256)",
  "function getNextFeeDropETA(address user) view returns (uint256 secondsToNext, uint256 nextFeeBps)",

  // debt
  "function debtUsdtEquivalent(address) view returns (uint256)",
  "function totalDebtUsdtEquivalent() view returns (uint256)",

  // redeem allowance (KEY!)
  "function redeemableBalance(address) view returns (uint256)",

  // optional reads
  "function accumulatedFees() view returns (uint256)",
  "function maxPurchasePerTx() view returns (uint256)",
  "function maxPurchasePerWallet() view returns (uint256)",
];

// --------------------------------------------------
// Presale WRITE ABI
// --------------------------------------------------
export const PRESALE_WRITE_ABI = [
  "function buyWithUSDT(uint256 amount, bool withBonus) external",
  "function unlockDeposit() external",
  "function redeemForUSDT(uint256 arubAmount) external",
  "function claimDebt() external",
];
