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
import { ERC20_ABI, ORACLE_ABI, PRESALE_READ_ABI } from './abis.js';

console.log('[CONTRACTS] contracts.js loaded, build:', Date.now());

// -----------------------------
// State
// -----------------------------
let roProvider = null;
let roToken = null;
let roOracle = null;
let roPresale = null;

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

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

async function pickWorkingRpc(rpcUrls, triesPerRpc = 2) {
  let lastErr = null;

  for (const url of rpcUrls) {
    try {
      const ARB_ONE = { name: 'arbitrum', chainId: 42161 };
      const provider = new ethers.providers.JsonRpcProvider(url, ARB_ONE);

      await callWithRetry(
        () => withTimeout(provider.getBlockNumber(), 2500, `RPC timeout: ${url}`),
        triesPerRpc,
        250
      );

      console.log('[RPC] selected', url);
      return { url, provider, via: 'rpc' };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);

      // Эти сообщения характерны для CORS/браузерных блокировок fetch
      const isBrowserBlocked =
        msg.includes('CORS') ||
        msg.includes('Access-Control-Allow-Origin') ||
        msg.includes('Failed to fetch') ||
        msg.includes('ERR_FAILED') ||
        msg.includes('NetworkError');

      console.warn(isBrowserBlocked ? '[RPC] skipped (browser blocked)' : '[RPC] failed', url, msg);
    }
  }

  // Fallback: если ни один публичный RPC не доступен из браузера, но кошелёк есть
  if (window.ethereum?.request) {
    console.warn('[RPC] no public RPC worked; fallback to injected provider');
    const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    return { url: null, provider, via: 'wallet' };
  }

  throw lastErr || new Error('No working RPC endpoints');
}

function assertConfig() {
  const rpcs = CONFIG?.NETWORK?.rpcUrls;
  if (!Array.isArray(rpcs) || rpcs.length === 0) {
    throw new Error('CONFIG.NETWORK.rpcUrls missing/empty');
  }

  if (!CONFIG?.TOKEN_ADDRESS) throw new Error('CONFIG.TOKEN_ADDRESS missing');
  if (!CONFIG?.ORACLE_ADDRESS) throw new Error('CONFIG.ORACLE_ADDRESS missing');
  if (!CONFIG?.PRESALE_ADDRESS) throw new Error('CONFIG.PRESALE_ADDRESS missing');

  return rpcs;
}

// -----------------------------
// Public: init read-only contracts
// -----------------------------
export async function initReadOnlyContracts() {
  if (roProvider && roToken && roOracle && roPresale) return true;

  const rpcUrls = assertConfig();

const { provider: roProvider, via } = await pickWorkingRpc(CONFIG.NETWORK.rpcUrls);
const presaleSim = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, roProvider);

// если via === 'wallet' и вы ловите missing revert data — можно отключить preflight на мобилках

  roToken   = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, roProvider);
  roOracle  = new ethers.Contract(CONFIG.ORACLE_ADDRESS, ORACLE_ABI, roProvider);
  roPresale = new ethers.Contract(CONFIG.PRESALE_ADDRESS, PRESALE_READ_ABI, roProvider);

  console.log('[CONTRACTS] read-only initialized', {
    via,
    rpc: url,
    token: CONFIG.TOKEN_ADDRESS,
    oracle: CONFIG.ORACLE_ADDRESS,
    presale: CONFIG.PRESALE_ADDRESS
  });

  try { window.dispatchEvent(new Event('contractsInitialized')); } catch (_) {}
  return true;
}

export async function getArubPrice() {
  // ВАЖНО: initReadOnlyContracts() почти наверняка async -> нужен await
  if (!roOracle) await initReadOnlyContracts();

  try {
    const { rate, updatedAt } = await callWithRetry(async () => {
      const [rate, updatedAt] = await roOracle.getRate(); // (uint256,uint256)
      return { rate, updatedAt: Number(updatedAt) };
    }, 3, 400);

    const decimals = Number(CONFIG?.ORACLE_DECIMALS ?? 6); // у вас 1e6 scale
    const price = Number(ethers.utils.formatUnits(rate, decimals));

    const info = {
      price,
      updatedAt,
      isFallback: false,
      isStale: false,
    };

    // кэш последнего валидного
    if (Number.isFinite(price) && price > 0) lastGoodArubPriceInfo = info;

    return info;
  } catch (e) {
    // если что-то “обвалилось” — показываем последний хороший курс как cached
    if (lastGoodArubPriceInfo) {
      return { ...lastGoodArubPriceInfo, isFallback: true };
    }
    throw e;
  }
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

export function getReadOnlyPresale() {
  if (!roPresale) initReadOnlyContracts();
  return roPresale;
}

