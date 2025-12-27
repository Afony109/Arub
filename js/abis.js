/**
 * abis.js
 *
 * Centralized ABIs for frontend
 * Compatible with:
 *  - USDT (ERC20, 6 decimals)
 *  - ARUB token (ERC20, 18 decimals)
 *  - ARUBVault (ERC20 shares + deposit/withdraw)
 *
 * IMPORTANT:
 *  - This file MUST be an ES module
 *  - It MUST be accessible at /js/abis.js
 */

// --------------------------------------------------
// Minimal ERC20 ABI (balance, approve, allowance)
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

// js/abis.js
// Minimal ABIs needed by app/contracts/trading

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// ArubOracle @ 0xC15f... (rate = USD/RUB * 1e6)
export const ORACLE_ABI = [
  "function rate() view returns (uint256)",
  "function updatedAt() view returns (uint256)",
  "function usdRub() view returns (uint256)",
  "function currentRate() view returns (uint256)",
  "function getRate() view returns (uint256,uint256)"
];

// --------------------------------------------------
// USDT ABI (ERC20, 6 decimals)
// --------------------------------------------------
export const USDT_ABI = [
  ...ERC20_MINIMAL_ABI,
];
// --------------------------------------------------
// ARUBVault ABI
// Based on ARUBVault.sol
//
// Key facts:
//  - Vault itself is ERC20 (shares)
//  - deposit(uint256 arubAmount)
//  - withdraw(uint256 shares)
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

  // ---- View helpers (from ARUBVault.sol, safe if unused) ----
  'function totalAssetsArubEq() view returns (uint256)',
  'function asset() view returns (address)',

  // ---- Events (optional, but useful) ----
  'event Deposit(address indexed user, uint256 arubAmount, uint256 shares)',
  'event Withdraw(address indexed user, uint256 shares, uint256 arubAmount)',
];

// Presale (custom)
export const PRESALE_ABI = [
  "function buy(uint256 usdtAmount) external",
  "function paused() view returns (bool)",
  "function getTokenAmount(uint256 usdtAmount) view returns (uint256)"
];
export const PRESALE_READ_ABI = [
  "function totalDeposited(address) view returns (uint256)",
  "function lockedPrincipalArub(address) view returns (uint256)",
  "function lockedBonusArub(address) view returns (uint256)",
  "function lockedDepositUntil(address) view returns (uint256)",
  "function getRemainingLockTime(address) view returns (uint256)",
  "function getMyLockedInfo() view returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)",
  "function getDiscountPercent() view returns (uint256)", "function getDiscountPercent() view returns (uint256)",
  "function totalDiscountBuyers() view returns (uint256)",
  "function isDiscountBuyer(address) view returns (bool)",
  "function DISCOUNT_MAX_BUYERS() view returns (uint256)",
];

export const PRESALE_WRITE_ABI = [
  "function buyWithUSDT(uint256 amount, bool withBonus) external",
  "function unlockDeposit() external",
  "function paused() view returns (bool)",
];
