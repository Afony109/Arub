/**
 * contracts.js — Read-only contracts (stable via RPC)
 *
 * Exports required by app.js:
 *   - initReadOnlyContracts()
 *   - getArubPrice()
 *   - getTotalSupplyArub()
 *
 * Optional exports for trading.js:
 *   - getReadOnlyPresale()
 *   - getReadOnlyProvider()
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

// init latch (prevents parallel init)
let roInitPromise = null;

// cached oracle value (fallback)
let lastGoodArubPriceInfo = null;

// -----------------------------
// Helpers
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC_URL = "https://rpc.antirub.com";
const RPC_KEY = "8f2b9c3a7e1d4c0b9a6f2c1d7e8b4a0f5c9d2e1a3b7c6d8e9f0a1b2c3d4e5f6";

async function rpcFetch(payload) {
  return callWithRetry(async () => {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-antirub-key": RPC_KEY, // 🔐 ключ добавляется ТОЛЬКО ЗДЕСЬ
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status}`);
    }

    const json = await res.json();

    if (json?.error) {
      throw new Error(json.error.message || "RPC error");
    }

    return json.result;
  });
}

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

  // 1) Всегда пробуем ваш proxy первым
  const urls = [RPC_PROXY_URL, ...(rpcUrls || [])];

  for (const url of urls) {
    try {
      const ARB_ONE = { name: 'arbitrum', chainId: 42161 };

      // 2) Для proxy добавляем заголовок, для остальных — как было
      const connection =
        url === RPC_PROXY_URL
          ? { url: RPC_PROXY_URL, headers: { 'x-antirub-key': RPC_PROXY_KEY } }
          : url;

      const provider = new ethers.providers.JsonRpcProvider(connection, ARB_ONE);

      await callWithRetry(
        () => withTimeout(provider.getBlockNumber(), 2500, `RPC timeout: ${url}`),
        triesPerRpc,
        250
      );

      console.log('[RPC] selected', url === RPC_PROXY_URL ? `${url} (proxy)` : url);
      return { url, provider, via: url === RPC_PROXY_URL ? 'proxy' : 'rpc' };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);

      const isBrowserBlocked =
        msg.includes('CORS') ||
        msg.includes('Access-Control-Allow-Origin') ||
        msg.includes('Failed to fetch') ||
        msg.includes('ERR_FAILED') ||
        msg.includes('NetworkError');

      console.warn(isBrowserBlocked ? '[RPC] skipped (browser blocked)' : '[RPC] failed', url, msg);
    }
  }

  // 3) Fallback: injected provider (кошелёк), если вообще ничего не работает
  if (window.ethereum?.request) {
    console.warn('[RPC] no RPC worked; fallback to injected provider');
    const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    return { url: null, provider, via: 'wallet' };
  }

  throw lastErr || new Error('No working RPC endpoints');
}

function assertConfig() {
  const walletRpcs = CONFIG?.NETWORK?.walletRpcUrls;
  const readOnlyRpc = CONFIG?.NETWORK?.readOnlyRpcUrl;

  if (!Array.isArray(walletRpcs) || walletRpcs.length === 0) {
    throw new Error('CONFIG.NETWORK.walletRpcUrls missing/empty');
  }

  if (!readOnlyRpc || typeof readOnlyRpc !== 'string') {
    throw new Error('CONFIG.NETWORK.readOnlyRpcUrl missing');
  }

  if (!CONFIG?.TOKEN_ADDRESS) throw new Error('CONFIG.TOKEN_ADDRESS missing');
  if (!CONFIG?.ORACLE_ADDRESS) throw new Error('CONFIG.ORACLE_ADDRESS missing');
  if (!CONFIG?.PRESALE_ADDRESS) throw new Error('CONFIG.PRESALE_ADDRESS missing');

  return {
    walletRpcs,
    readOnlyRpc
  };
}
// -----------------------------
// Public: init read-only contracts
// -----------------------------
export async function initReadOnlyContracts() {
  if (roProvider && roToken && roOracle && roPresale) return true;

  // latch to prevent parallel inits
  if (roInitPromise) {
    await roInitPromise;
    return true;
  }

  roInitPromise = (async () => {
    const rpcUrls = assertConfig();
    const { url, provider, via } = await pickWorkingRpc(rpcUrls, 2);

    roProvider = provider;

    roToken   = new ethers.Contract(CONFIG.TOKEN_ADDRESS,   ERC20_ABI,        roProvider);
    roOracle  = new ethers.Contract(CONFIG.ORACLE_ADDRESS,  ORACLE_ABI,       roProvider);
    roPresale = new ethers.Contract(CONFIG.PRESALE_ADDRESS, PRESALE_READ_ABI, roProvider);

    console.log('[CONTRACTS] read-only initialized', { via, rpc: url });
  })();

  try {
    await roInitPromise;
    try { window.dispatchEvent(new Event('contractsInitialized')); } catch (_) {}
    return true;
  } finally {
    // keep promise (optional). If you want re-init after failure, reset on error.
    // Here we keep it if init succeeded; on failure it will throw before this line.
  }
}

// -----------------------------
// Optional getters for other modules
// -----------------------------
export function getReadOnlyProvider() {
  return roProvider;
}

export async function getReadOnlyPresale() {
  // Fast path
  if (roPresale) return roPresale;

  // Ensure single init in flight (no parallel init storms)
  if (!roInitPromise) {
    roInitPromise = initReadOnlyContracts().catch((e) => {
      // allow retry on next call if init failed
      roInitPromise = null;
      throw e;
    });
  }

  await roInitPromise;
  return roPresale;
}

// -----------------------------
// Required by app.js: getArubPrice()
// Oracle: getRate() returns (rate, updatedAt)
// We return rate as number (scaled by ORACLE_DECIMALS; default 6)
// -----------------------------
export async function getArubPrice() {
  if (!roOracle) await initReadOnlyContracts();

  try {
    const { rate, updatedAt } = await callWithRetry(async () => {
      const [rate, updatedAt] = await roOracle.getRate(); // (uint256,uint256)
      return { rate, updatedAt: Number(updatedAt) };
    }, 3, 400);

    const decimals = Number(CONFIG?.ORACLE_DECIMALS ?? 6);
    const price = Number(ethers.utils.formatUnits(rate, decimals));

    const info = {
      price,
      updatedAt,
      isFallback: false,
      isStale: false,
    };

    if (Number.isFinite(price) && price > 0) {
      lastGoodArubPriceInfo = info;
    }

    return info;
  } catch (e) {
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
  if (!roToken) await initReadOnlyContracts();

  return await callWithRetry(async () => {
    return await roToken.totalSupply();
  }, 3, 350);
}
