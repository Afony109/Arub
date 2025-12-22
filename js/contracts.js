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
// Oracle: function getRate() returns (rate, updatedAt)
// We return ONLY "rate" as BigNumber (rate is scaled by 1e6).
// -----------------------------
const ORACLE_PRICE_CACHE_KEY = 'arub_oracle_price_cache_v1';

// Сколько секунд считаем допустимой "старыми" данные оракула.
// Под арбитраж можно поставить выше, но я бы начал с 300–900 сек.
const ORACLE_STALE_AFTER_SEC = 600; // 10 минут

function readOracleCache() {
  try {
    const raw = localStorage.getItem(ORACLE_PRICE_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!Number.isFinite(obj.price)) return null;
    // updatedAtSec может быть null (если раньше не сохраняли)
    return obj;
  } catch {
    return null;
  }
}

function writeOracleCache(payload) {
  try {
    localStorage.setItem(ORACLE_PRICE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export async function getArubPrice() {
  if (!roOracle) initReadOnlyContracts();

  const fetchedAtMs = Date.now();

  try {
    const { rate, updatedAt } = await callWithRetry(async () => {
      const [rate, updatedAt] = await roOracle.getRate();
      return { rate, updatedAt };
    }, 3, 400);

    // ВАЖНО: rate/updatedAt могут быть BigNumber (ethers v5). Приводим updatedAt к секундам.
    const updatedAtSec = updatedAt?.toNumber ? updatedAt.toNumber() : Number(updatedAt);

    // Здесь предполагается, что далее в проекте ты приводишь rate к Number "price".
    // Если rate уже Number — оставим как есть. Если BigNumber — приведи по твоим decimals.
    // ВНИМАНИЕ: точное преобразование зависит от того, что возвращает ваш oracle.
    const ORACLE_DECIMALS = Number(CONFIG?.ORACLE_DECIMALS ?? 6);
    const price = Number(ethers.utils.formatUnits(rate, ORACLE_DECIMALS));

    // Если price не конечный — считаем это ошибкой чтения
    if (!Number.isFinite(price)) throw new Error('Oracle returned non-finite price');

    const isStale =
      Number.isFinite(updatedAtSec)
        ? (Math.floor(fetchedAtMs / 1000) - updatedAtSec) > ORACLE_STALE_AFTER_SEC
        : false;

    // Сохраняем кэш последней успешной цены (даже если stale — это всё равно "последняя успешная")
    writeOracleCache({
      price,
      updatedAtSec: Number.isFinite(updatedAtSec) ? updatedAtSec : null,
      fetchedAtMs
    });

    return {
      price,
      updatedAtSec: Number.isFinite(updatedAtSec) ? updatedAtSec : null,
      fetchedAtMs,
      isFallback: false,
      isStale
    };
  } catch (e) {
    const cached = readOracleCache();

    if (cached?.price != null) {
      const cachedUpdatedAtSec = cached.updatedAtSec;
      const isStale =
        Number.isFinite(cachedUpdatedAtSec)
          ? (Math.floor(fetchedAtMs / 1000) - cachedUpdatedAtSec) > ORACLE_STALE_AFTER_SEC
          : true; // если не знаем updatedAt — лучше считать stale

      return {
        price: cached.price,
        updatedAtSec: Number.isFinite(cachedUpdatedAtSec) ? cachedUpdatedAtSec : null,
        fetchedAtMs,
        isFallback: true,
        isStale
      };
    }

    // Если кэша нет — пробрасываем ошибку выше
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
