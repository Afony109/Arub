/**
 * presale.js — Write-layer for Presale BUY (USDT approve -> Presale.buy)
 *
 * Goals:
 * - Keep read-only dashboard/oracle code in contracts.js (no conflicts with app.js)
 * - Put ONLY presale BUY flow here
 * - Work with ethers v5 ESM + your existing wallet.js
 *
 * Exports:
 *   initPresaleWrite()
 *   getPresaleWriteContracts()
 *   quoteArubForUsdt(usdtAmountHuman)
 *   buyWithUsdt(usdtAmountHuman, opts?)
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { ERC20_ABI, PRESALE_ABI } from './abis.js';
import { isWalletConnected, getSigner, getAddress } from './wallet.js';

// -----------------------------
// State
// -----------------------------
let usdt = null;        // ethers.Contract (signer)
let presale = null;     // ethers.Contract (signer)
let usdtDecimals = null;

// -----------------------------
// Internals
// -----------------------------
function assertConfig() {
  if (!CONFIG?.USDT_ADDRESS) throw new Error('CONFIG.USDT_ADDRESS is missing');
  if (!CONFIG?.PRESALE_ADDRESS) throw new Error('CONFIG.PRESALE_ADDRESS is missing');
}

function toBN(amountHuman, decimals) {
  // ethers.utils.parseUnits expects a string
  return ethers.utils.parseUnits(String(amountHuman), decimals);
}

// -----------------------------
// Public
// -----------------------------
export function getPresaleWriteContracts() {
  return {
    usdt,
    presale,
    usdtDecimals,
    isInitialized: Boolean(usdt && presale),
  };
}

export async function initPresaleWrite() {
  assertConfig();

  if (!isWalletConnected()) {
    // Not throwing here allows UI to call init safely before connect
    return false;
  }

  const signer = getSigner?.();
  if (!signer) return false;

  usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, signer);
  presale = new ethers.Contract(CONFIG.PRESALE_ADDRESS, PRESALE_ABI, signer);

  // Decimals: cache once. USDT on Arbitrum is 6, but we read it to be safe.
  if (usdtDecimals == null) {
    try {
      usdtDecimals = await usdt.decimals();
    } catch (_) {
      usdtDecimals = 6;
    }
  }

  return true;
}

export async function quoteArubForUsdt(usdtAmountHuman) {
  // Uses presale.getTokenAmount(usdtAmount) if present
  const ok = await initPresaleWrite();
  if (!ok) throw new Error('Wallet not connected or signer not ready');

  if (!presale?.getTokenAmount) {
    throw new Error('Presale contract does not expose getTokenAmount()');
  }

  const amt = Number(usdtAmountHuman);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid USDT amount');

  const usdtAmountBN = toBN(amt, usdtDecimals ?? 6);
  return await presale.getTokenAmount(usdtAmountBN); // returns token amount (token decimals are defined in contract)
}

export async function buyWithUsdt(usdtAmountHuman, opts = {}) {
  /**
   * opts:
   *  - confirmations: number (default CONFIG.TX_CONFIRMATIONS || 1)
   *  - onStatus: (stage: string, payload?: any) => void
   *
   * stages:
   *  - 'init'
   *  - 'check_paused'
   *  - 'check_allowance'
   *  - 'approve_submitted'
   *  - 'approve_confirmed'
   *  - 'buy_submitted'
   *  - 'buy_confirmed'
   */
  const confirmations = Number.isFinite(opts.confirmations)
    ? opts.confirmations
    : (CONFIG.TX_CONFIRMATIONS ?? 1);

  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;

  const ok = await initPresaleWrite();
  if (!ok) throw new Error('Wallet not connected or signer not ready');

  const user = getAddress?.();
  if (!user) throw new Error('Wallet address not available');

  const amt = Number(usdtAmountHuman);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid USDT amount');

  onStatus?.('init');

  // Optional pause check if contract has paused()
  if (presale?.paused) {
    onStatus?.('check_paused');
    const paused = await presale.paused();
    if (paused) throw new Error('Presale is paused');
  }

  const usdtAmountBN = toBN(amt, usdtDecimals ?? 6);

  // Allowance check
  onStatus?.('check_allowance');
  const allowance = await usdt.allowance(user, CONFIG.PRESALE_ADDRESS);

  if (allowance.lt(usdtAmountBN)) {
    const txApprove = await usdt.approve(CONFIG.PRESALE_ADDRESS, usdtAmountBN);
    onStatus?.('approve_submitted', { hash: txApprove.hash });
    await txApprove.wait(confirmations);
    onStatus?.('approve_confirmed', { hash: txApprove.hash });
  }

  // BUY
  const txBuy = await presale.buy(usdtAmountBN);
  onStatus?.('buy_submitted', { hash: txBuy.hash });
  const receipt = await txBuy.wait(confirmations);
  onStatus?.('buy_confirmed', { hash: txBuy.hash, receipt });

  return receipt;
}
// -----------------------------
// Quote helpers for UI
// -----------------------------
let roProvider = null;
let roToken = null;
let tokenDecimals = null;

function getReadOnlyProvider() {
  if (roProvider) return roProvider;
  const rpc = CONFIG?.NETWORK?.rpcUrls?.[0];
  if (!rpc) throw new Error('CONFIG.NETWORK.rpcUrls[0] missing');
  roProvider = new ethers.providers.JsonRpcProvider(rpc);
  return roProvider;
}

async function getTokenDecimals() {
  if (tokenDecimals != null) return tokenDecimals;

  if (!CONFIG?.TOKEN_ADDRESS) throw new Error('CONFIG.TOKEN_ADDRESS missing');
  roToken = roToken || new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, getReadOnlyProvider());

  try {
    tokenDecimals = await roToken.decimals();
  } catch (_) {
    tokenDecimals = 18; // fallback
  }
  return tokenDecimals;
}

/**
 * Returns formatted quote string, e.g. "123.4567 ARUB"
 * - maxFrac controls UI display only (no rounding on-chain).
 */
export async function quoteArubFormatted(usdtAmountHuman, maxFrac = 6) {
  const bn = await quoteArubForUsdt(usdtAmountHuman); // BigNumber
  const dec = await getTokenDecimals();
  const full = ethers.utils.formatUnits(bn, dec);

  // Trim to maxFrac for UI
  if (!Number.isFinite(maxFrac) || maxFrac < 0) return `${full} ARUB`;

  const [i, f = ''] = String(full).split('.');
  const f2 = f.slice(0, maxFrac);
  const trimmed = f2.length ? `${i}.${f2}` : i;

  return `${trimmed} ARUB`;
}
