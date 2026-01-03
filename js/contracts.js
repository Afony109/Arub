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
 *   - getReadOnlyProviderAsync()
 *   - getReadOnlyProviderSync()
*/

import { ERC20_ABI, ORACLE_ABI, PRESALE_READ_ABI } from './abis.js';
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';

console.log('[CONTRACTS] contracts.js loaded, build:', Date.now());
console.log('[CONTRACTS] module loaded:', import.meta.url);

// -----------------------------
// State
// -----------------------------
var roProvider = null;
var roToken = null;
var roOracle = null;
var roPresale = null;

// init latch (prevents parallel init)
var roInitPromise = null;

// cached oracle value (fallback)
var lastGoodArubPriceInfo = null;

// -----------------------------
// Helpers
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// callWithRetry / withTimeout / isBrowserNetworkBlock / probeProvider / normalizeUrl / uniq / ensureChainId
// ... (ваши функции как вы прислали)

// pickWorkingRpc (ваша улучшенная версия)
// initReadOnlyContracts (ваша версия)
// getReadOnlyProviderAsync / getReadOnlyProviderSync
// getReadOnlyPresale / getArubPrice / getTotalSupplyArub ...

console.log('[CONTRACTS] FILE MARKER: contracts.js active', location.href);


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

function withTimeout(promise, ms, msg = 'Timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}

function isBrowserNetworkBlock(msg) {
  const s = String(msg || '');
  return (
    s.includes('CORS') ||
    s.includes('Access-Control-Allow-Origin') ||
    s.includes('Failed to fetch') ||
    s.includes('ERR_FAILED') ||
    s.includes('NetworkError') ||
    s.includes('fetch') && s.includes('TypeError')
  );
}

async function probeProvider(provider, urlLabel, tries = 2) {
  // Minimal probe: blockNumber + eth_call
  // (chainId проверяем отдельно в ensureChainId, чтобы не делать eth_chainId дважды)
  for (let i = 0; i < tries; i++) {
    try {
      // A) block number
      const pBn = provider.getBlockNumber();
      const bn = await withTimeout(pBn, 2500, `RPC timeout (blockNumber): ${urlLabel}`);
      if (typeof bn !== 'number') throw new Error(`RPC bad blockNumber: ${urlLabel}`);

      // B) lightweight eth_call (проверка, что eth_call не режется)
      const pCall = provider.send('eth_call', [
        { to: '0x0000000000000000000000000000000000000000', data: '0x' },
        'latest',
      ]);
      await withTimeout(pCall, 2500, `RPC timeout (eth_call): ${urlLabel}`);

      return true;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

// Module-level cache
let _picked = null;        // { url, provider, via }
let _pickedKey = null;     // cache key for invalidation

function normalizeUrl(u) {
  return String(u || '').trim();
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = normalizeUrl(v);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}


async function ensureChainId(provider, expectedChainId, urlLabel) {
  const exp = Number(expectedChainId);

  if (!Number.isFinite(exp)) {
    throw new Error(`Invalid expectedChainId: ${expectedChainId} (${urlLabel})`);
  }

  // 1) Прямой eth_chainId + timeout
  try {
    const p = provider.send('eth_chainId', []);
    const hex = await withTimeout(p, 2500, `RPC timeout (chainId): ${urlLabel}`);

    const got = Number.parseInt(hex, 16);
    if (Number.isFinite(got) && got !== exp) {
      throw new Error(`RPC chainId mismatch: expected ${exp}, got ${got} (${urlLabel})`);
    }
    return true;
  } catch (_) {
    // fallback ниже
  }

  // 2) Fallback: getNetwork() + timeout
  const pNet = provider.getNetwork();
  const net = await withTimeout(pNet, 2500, `RPC timeout (getNetwork): ${urlLabel}`);

  const got = Number(net?.chainId);
  if (Number.isFinite(got) && got !== exp) {
    throw new Error(`RPC chainId mismatch: expected ${exp}, got ${got} (${urlLabel})`);
  }
  return true;
}

// -----------------------------
// Module-level cache (как у вас)
// -----------------------------

async function probeRpcUrl(url, timeoutMs = 3500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.result) throw new Error('Bad JSON-RPC response');
    return true;
  } finally {
    clearTimeout(t);
  }
}

/**
 * pickWorkingRpc
 * - prefers CONFIG.NETWORK.readOnlyRpcUrl
 * - falls back to CONFIG.NETWORK.walletRpcUrls[]
 * - then rpcUrls argument (optional)
 * - finally falls back to injected provider (window.ethereum) if nothing works
 *
 /**
 * @param {string[]} rpcUrls optional extra urls
 * @param {number} triesPerRpc retries per endpoint
 * @param {{allowWalletFallback?: boolean}} opts
 * @returns {Promise<{url: string|null, provider: any, via: 'proxy'|'rpc'|'wallet'}>}
 * 
 */

 // -----------------------------
// Local utils (ensure defined in this module)
// -----------------------------
function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function isBadRpcUrl(u) {
  if (!u || typeof u !== 'string') return true;
  const s = u.trim();
  if (!s) return true;

  // Отсекаем явный мусор/плейсхолдеры
  if (s === 'null' || s === 'undefined') return true;

  // Разрешаем http(s). (Если захотите wss/ws — добавьте второй regex)
  if (!/^https?:\/\//i.test(s)) return true;

  return false;
}


export async function pickWorkingRpc(extraRpcs = [], triesPerRpc = 2, opts = {}) {
  const {
    allowWalletFallback = true,
  } = opts;

  const net = CONFIG?.NETWORK || {};
  const chainId = Number(net.chainId ?? 42161);
  const NETWORK = { chainId, name: net.name || 'arbitrum' };

  const readOnly = net.readOnlyRpcUrl;                 // string | undefined
  const walletRpcs = Array.isArray(net.walletRpcUrls) ? net.walletRpcUrls : [];

  // ---- стратегия выбора ----
  // Для read-only в приоритете ваш proxy/readOnlyRpcUrl.
  // Но если он упал/таймаутит, пробуем публичные walletRpcUrls (без injected fallback, если allowWalletFallback=false).
  const baseUrls = uniq([
    ...(readOnly ? [readOnly] : []), // 1) proxy первым
    ...walletRpcs,                   // 2) всегда как fallback
    ...extraRpcs,                    // 3) дополнительные
  ]).filter((u) => !isBadRpcUrl(u));

  if (baseUrls.length === 0) {
    if (allowWalletFallback && window.ethereum?.request) {
      console.warn('[RPC] no URLs configured; fallback to injected provider');
      const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
      _picked = { url: null, provider, via: 'wallet' };
      _pickedKey = JSON.stringify({ chainId, readOnly: readOnly || '', urls: [] });
      return _picked;
    }
    throw new Error(
      'No RPC URLs configured. Set CONFIG.NETWORK.readOnlyRpcUrl and/or CONFIG.NETWORK.walletRpcUrls.'
    );
  }

  const key = JSON.stringify({ chainId, readOnly: readOnly || '', urls: baseUrls });
  if (_picked?.provider && _pickedKey === key) return _picked;

  let lastErr = null;

  for (const url of baseUrls) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url, NETWORK);

      // 1) минимальная “живость” RPC (без chainId, чтобы не дублировать)
      await probeProvider(provider, url, triesPerRpc);

      // 2) строгая проверка сети (с таймаутом)
      await ensureChainId(provider, chainId, url);

      const via =
        (readOnly && url === readOnly) ? 'proxy'
        : 'rpc';

      console.log('[RPC] selected', via === 'proxy' ? `${url} (proxy)` : url);

      _picked = { url, provider, via };
      _pickedKey = key;
      return _picked;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);

      console.warn(
        isBrowserNetworkBlock(msg) ? '[RPC] skipped (browser blocked)' : '[RPC] failed',
        url,
        msg
      );
    }
  }

  if (allowWalletFallback && window.ethereum?.request) {
    console.warn('[RPC] no RPC worked; fallback to injected provider');
    const provider = new ethers.providers.Web3Provider(window.ethereum, 'any');

    // Non-fatal chain check (логируем, но не падаем)
    try {
      const pNet = provider.getNetwork();
      const n = await withTimeout(pNet, 2500, 'RPC timeout (injected getNetwork)');
      if (Number(n.chainId) !== Number(chainId)) {
        console.warn('[RPC] injected chain mismatch', { expected: chainId, got: n.chainId });
      }
    } catch (_) {}

    _picked = { url: null, provider, via: 'wallet' };
    _pickedKey = key;
    return _picked;
  }

  throw lastErr || new Error('No working RPC endpoints');
}

/**
 * Async provider getter (preferred): always returns a provider (or throws)
 * Note: for read-only contracts we usually disable wallet fallback to avoid mixed data sources.
 */

export function getReadOnlyProviderSync() {
  // Может быть null до initReadOnlyContracts().
  // Использовать только для read-only вызовов.
  return roProvider;
}

export async function getReadOnlyProviderAsync() {
  await initReadOnlyContracts();
  return roProvider;
}

function assertConfig() {
  const net = CONFIG?.NETWORK || {};
  const readOnlyRpc = net.readOnlyRpcUrl;
  const walletRpcs = net.walletRpcUrls;

  const hasReadOnly = typeof readOnlyRpc === 'string' && readOnlyRpc.trim().length > 0;
  const hasWalletRpcs = Array.isArray(walletRpcs) && walletRpcs.length > 0;

  // Достаточно либо proxy, либо массива публичных RPC
  if (!hasReadOnly && !hasWalletRpcs) {
    throw new Error(
      'No RPC URLs configured. Set CONFIG.NETWORK.readOnlyRpcUrl and/or CONFIG.NETWORK.walletRpcUrls.'
    );
  }

  if (walletRpcs != null && !Array.isArray(walletRpcs)) {
    throw new Error('CONFIG.NETWORK.walletRpcUrls must be an array if provided');
  }

  if (!CONFIG?.TOKEN_ADDRESS) throw new Error('CONFIG.TOKEN_ADDRESS missing');
  if (!CONFIG?.ORACLE_ADDRESS) throw new Error('CONFIG.ORACLE_ADDRESS missing');
  if (!CONFIG?.PRESALE_ADDRESS) throw new Error('CONFIG.PRESALE_ADDRESS missing');

  return true;
}

let roChainId = null;

// -----------------------------
// Public: init read-only contracts (race-free, retryable)
// -----------------------------
export async function initReadOnlyContracts() {
  const expected = Number(CONFIG?.NETWORK?.chainId ?? 42161);

  // Если уже инициализировано — убедимся, что сеть правильная
  if (roProvider && roToken && roOracle && roPresale) {
    try {
      const net = await roProvider.getNetwork();
      const got = Number(net?.chainId ?? 0);
      if (got === expected) return true;

      console.warn('[CONTRACTS] cached read-only provider on wrong chain, resetting', {
        expected,
        got
      });
    } catch (_) {
      console.warn('[CONTRACTS] cached read-only provider unreachable, resetting');
    }

    // сброс кэша, чтобы переинициализироваться
    roProvider = null;
    roToken = null;
    roOracle = null;
    roPresale = null;
  }

  if (roInitPromise) {
    await roInitPromise;
    return true;
  }

  roInitPromise = (async () => {
    assertConfig();

    // выбираем рабочий RPC (без wallet fallback)
    const { url, provider, via } = await pickWorkingRpc([], 2, { allowWalletFallback: false });
    roProvider = provider;

    // ✅ жёсткая проверка сети
    let net;
    try {
      net = await roProvider.getNetwork();
    } catch (e) {
      throw new Error('[CONTRACTS] Read-only RPC unreachable (getNetwork failed)');
    }

    const got = Number(net?.chainId ?? 0);
    if (got !== expected) {
      throw new Error(`[CONTRACTS] RPC chain mismatch: expected ${expected}, got ${got}`);
    }

    // контракты read-only
    roToken   = new ethers.Contract(CONFIG.TOKEN_ADDRESS,   ERC20_ABI,        roProvider);
    roOracle  = new ethers.Contract(CONFIG.ORACLE_ADDRESS,  ORACLE_ABI,       roProvider);
    roPresale = new ethers.Contract(CONFIG.PRESALE_ADDRESS, PRESALE_READ_ABI, roProvider);

    console.log('[CONTRACTS] read-only initialized', { via, rpc: url, chainId: got });

    try { window.dispatchEvent(new Event('contractsInitialized')); } catch (_) {}
    return true;
  })();

  try {
    await roInitPromise;
    return true;
  } catch (e) {
    // allow retry later + обязательно чистим состояние
    roInitPromise = null;

    roProvider = null;
    roToken = null;
    roOracle = null;
    roPresale = null;

    console.error('[CONTRACTS] initReadOnlyContracts failed:', e?.message || e);
    throw e;
  }
}


// -----------------------------
// Optional getters for other modules
// -----------------------------
export function getReadOnlyTokenSync()  { return roToken; }
export function getReadOnlyOracleSync() { return roOracle; }
export function getReadOnlyPresaleSync(){ return roPresale; }

// Async getters (ensure init)
export async function getReadOnlyToken() {
  if (!roToken) await initReadOnlyContracts();
  return roToken;
}

export async function getReadOnlyOracle() {
  if (!roOracle) await initReadOnlyContracts();
  return roOracle;
}

export async function getReadOnlyPresale() {
  if (!roPresale) await initReadOnlyContracts();
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
