/**
 * contracts.js — Read-only contracts (stable via RPC)
 *
 * Exports required by app.js:
 *   - initReadOnlyContracts()
 *   - getArubPrice()
 *   - getTotalSupplyArub()
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { ERC20_ABI, ORACLE_ABI } from './abis.js';

console.log('[CONTRACTS] contracts.js loaded, build:', Date.now());

// -----------------------------
// State
// -----------------------------
let roProvider = null;
let roToken = null;
let roOracle = null;

// -----------------------------
// Helpers
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callWithRetry(fn, tries = 3, delayMs = 350) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

function assertConfig() {
  const rpc = CONFIG?.NETWORK?.rpcUrls?.[0];
  if (!rpc) throw new Error('CONFIG.NETWORK.rpcUrls[0] missing');

  if (!CONFIG?.TOKEN_ADDRESS) throw new Error('CONFIG.TOKEN_ADDRESS missing');
  if (!CONFIG?.ORACLE_ADDRESS) throw new Error('CONFIG.ORACLE_ADDRESS missing');

  return rpc;
}

// -----------------------------
// Public: init read-only contracts
// -----------------------------
export function initReadOnlyContracts() {
  if (roProvider && roToken && roOracle) return true;

  const rpc = assertConfig();

  roProvider = new ethers.providers.JsonRpcProvider(rpc);

  roToken = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, roProvider);
  roOracle = new ethers.Contract(CONFIG.ORACLE_ADDRESS, ORACLE_ABI, roProvider);

  console.log('[CONTRACTS] read-only initialized', {
    rpc,
    token: CONFIG.TOKEN_ADDRESS,
    oracle: CONFIG.ORACLE_ADDRESS
  });

  // Optional compatibility event if you rely on it elsewhere
  try { window.dispatchEvent(new Event('contractsInitialized')); } catch (_) {}

  return true;
}

// -----------------------------
// Required by app.js: getArubPrice()
// Your ArubOracle.sol:
//   function getRate() external view returns (uint256 rate, uint256 updatedAt)
// We return ONLY "rate" as BigNumber (rate is scaled by 1e6).
// -----------------------------
export async function getArubPrice() {
  if (!roOracle) initReadOnlyContracts();

  const { rate } = await callWithRetry(async () => {
    const [rate, updatedAt] = await roOracle.getRate();
    return { rate, updatedAt };
  }, 3, 400);

  return rate;
}

// -----------------------------
// Required by app.js: getTotalSupplyArub()
// ERC20.totalSupply()
// -----------------------------
export async function getTotalSupplyArub() {
  if (!roToken) initReadOnlyContracts();
  return await callWithRetry(async () => {
    return await roToken.totalSupply();
  }, 3, 350);
}
