/**
 * wallet.js — Multi-wallet connection layer (EIP-6963 + WalletConnect)
 * CLEAN & STABLE VERSION
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification } from './ui.js';

// -----------------------------
// Internal state (single source of truth)
// -----------------------------
let selectedEip1193 = null;
let ethersProvider = null;
let signer = null;
let currentAddress = null;
let currentChainId = null;
let isConnecting = false;

// WalletConnect provider
let wcProvider = null;

// EIP-6963 registry
const discoveredWallets = new Map();

// -----------------------------
// Utils
// -----------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function publishGlobals() {
  window.walletState = {
    provider: ethersProvider,
    signer,
    address: currentAddress,
    chainId: currentChainId,
    eip1193: selectedEip1193
  };
}

function clearGlobals() {
  window.walletState = null;
}

function dispatchConnected() {
  window.dispatchEvent(new CustomEvent('wallet:connected', {
    detail: { address: currentAddress, chainId: currentChainId }
  }));
}

function dispatchDisconnected() {
  window.dispatchEvent(new Event('wallet:disconnected'));
}

async function pRequest(method, params = []) {
  if (!selectedEip1193?.request) {
    throw new Error('No selected EIP-1193 provider');
  }
  return selectedEip1193.request({ method, params });
}

// -----------------------------
// EIP-6963 discovery
// -----------------------------
let discoveryReady = false;

function setupEip6963Discovery() {
  if (discoveryReady) return;
  discoveryReady = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    const { info, provider } = event.detail || {};
    if (!info?.rdns || !provider) return;

    discoveredWallets.set(info.rdns, {
      id: info.rdns,
      name: info.name || info.rdns,
      icon: info.icon || null,
      type: 'eip6963',
      provider
    });
  });

  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// -----------------------------
// Legacy injected
// -----------------------------
function getLegacyInjectedEntries() {
  const eth = window.ethereum;
  if (!eth) return [];

  if (Array.isArray(eth.providers)) {
    return eth.providers.map((p, i) => ({
      id: `legacy:${i}`,
      name: p.isMetaMask ? 'MetaMask' : `Injected #${i + 1}`,
      type: 'injected',
      provider: p
    }));
  }

  return [{
    id: 'legacy',
    name: eth.isMetaMask ? 'MetaMask' : 'Injected Wallet',
    type: 'injected',
    provider: eth
  }];
}

// -----------------------------
// Public API
// -----------------------------
export function initWalletModule() {
  setupEip6963Discovery();
  console.log('[WALLET] initWalletModule');
}
function detectWalletBrand(provider, fallbackName = 'Wallet') {
  // EIP-1193 vendor hints (order matters)
  if (provider?.isBybitWallet) return 'Bybit Wallet';
  if (provider?.isOkxWallet) return 'OKX Wallet';
  if (provider?.isRabby) return 'Rabby Wallet';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider?.isTrust || provider?.isTrustWallet) return 'Trust Wallet';
  if (provider?.isPhantom) return 'Phantom';
  if (provider?.isBraveWallet) return 'Brave Wallet';
  if (provider?.isUniswapWallet || provider?.isUniswapExtension) return 'Uniswap Extension';

  // MetaMask is commonly emulated; treat as MetaMask only if not a known emulator
  if (provider?.isMetaMask) return 'MetaMask';

  // fallback to whatever EIP-6963 metadata says
  return fallbackName || 'Wallet';
}

function pickEip6963Fields(w) {
  // Support multiple shapes just in case your discoveredWallets store differs.
  // Expected: { rdns, name, icon, provider } OR { info: { rdns, name, icon }, provider }
  const rdns = w?.rdns || w?.info?.rdns || w?.metadata?.rdns || '';
  const metaName = w?.name || w?.info?.name || w?.metadata?.name || '';
  const icon = w?.icon || w?.info?.icon || w?.metadata?.icon || null;
  const provider = w?.provider || w?.info?.provider || w?.eip1193Provider || null;

  return { rdns, metaName, icon, provider };
}

export function getAvailableWallets() {
  const list = [];
  const seen = new Set();

  // -------------------------
  // EIP-6963 discovered wallets
  // -------------------------
  for (const w of discoveredWallets.values()) {
    const { rdns, metaName, icon, provider } = pickEip6963Fields(w);

    // Brand-detected name (prevents "MetaMask" label opening Bybit, etc.)
    const name = detectWalletBrand(provider, metaName || 'Wallet');

    // Stable unique id
    const id = rdns ? `eip6963:${rdns}` : `eip6963:${name.toLowerCase()}`;

    // Dedup by id and by display name (case-insensitive)
    const nameKey = `name:${name.toLowerCase()}`;
    if (seen.has(id) || seen.has(nameKey)) continue;
    seen.add(id);
    seen.add(nameKey);

    list.push({
      id,
      name,
      icon,
      type: 'eip6963',
      _provider: provider,
      _meta: { rdns, name }
    });
  }

  // -------------------------
  // Legacy injected wallets
  // -------------------------
  for (const w of getLegacyInjectedEntries()) {
    const prov = w?._provider || w?.provider || null;

    // Prefer detected brand name over w.name if provider hints exist
    const detectedName = detectWalletBrand(prov, w?.name || 'Injected');
    const name = (detectedName || w?.name || 'Injected').trim();

    const id = `legacy:${(w?.id || name).toLowerCase()}`;
    const nameKey = `name:${name.toLowerCase()}`;

    // If an EIP-6963 wallet with same brand/name already exists, skip legacy duplicate
    if (seen.has(nameKey) || seen.has(id)) continue;
    seen.add(nameKey);
    seen.add(id);

    list.push({
      id,
      name,
      icon: null,
      type: w?.type || 'injected',
      _provider: prov,
      _meta: { name }
    });
  }

  // -------------------------
  // WalletConnect
  // -------------------------
  if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
    list.push({
      id: 'walletconnect',
      name: 'WalletConnect',
      icon: null,
      type: 'walletconnect'
    });
  }

  return list;
}


 export async function connectWallet({ walletId = null } = {}) {
  if (isConnecting) {
    if (currentAddress) return currentAddress;

    // Вариант A (рекомендую для UX): не кидать ошибку, а сказать “занято”
    // throw new Error('Wallet connection already in progress');

    // Вариант B: мягко вернуть null, а UI покажет уведомление
    throw new Error('Wallet connection already in progress');
  }

  isConnecting = true;

  // важно: локально запоминаем какой провайдер начали подключать,
  // чтобы в catch можно было корректно “прибраться”
  let localSelected = null;
  let localWc = null;

  try {
    const wallets = getAvailableWallets();

    if (!walletId) throw new Error('No wallet selected');

    const entry = wallets.find(w => w.id === walletId);
    if (!entry) throw new Error('No wallet selected');

    if (entry.type === 'walletconnect') {
      const { default: EthereumProvider } = await import(
        'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js'
      );

      localWc = await EthereumProvider.init({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        chains: [Number(CONFIG.NETWORK.chainId)],
        rpcMap: { [CONFIG.NETWORK.chainId]: CONFIG.NETWORK.rpcUrls[0] }
      });

      // ключевое: connect может “висеть”, поэтому ограничиваем по времени
      await withTimeout(localWc.connect(), 25000, 'WalletConnect connect');

      localSelected = localWc;
    } else {
      const prov = entry._provider || entry.provider;
      if (!prov) throw new Error('Selected wallet provider not found');

      localSelected = prov;

      // тоже ограничиваем по времени — иногда Metamask/Trust могут зависнуть,
      // если пользователь просто закрыл окно
      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts'
      );
    }

    // сохраняем в глобальные только после успешного connect/requestAccounts
    selectedEip1193 = localSelected;
    wcProvider = localWc || wcProvider;

    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();
    currentAddress = ethers.utils.getAddress(await signer.getAddress());

    const net = await ethersProvider.getNetwork();
    currentChainId = net.chainId;

    publishGlobals();
    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');
    dispatchConnected();

    return currentAddress;
    } catch (e) {
    // Определяем "user rejected" (MetaMask/Trust/EIP-1193)
    const msg = (e?.message || '').toLowerCase();
    const code = e?.code;
    const isUserRejected =
      code === 4001 ||
      msg.includes('user rejected') ||
      msg.includes('rejected the request') ||
      msg.includes('request rejected') ||
      msg.includes('action_rejected');

    // Уборка WalletConnect инстанса, если он был создан в этой попытке
    try {
      if (localWc) {
        await localWc.disconnect?.();
        await localWc.close?.();
      }
    } catch (_) {}

    // ВАЖНО: при любой неуспешной попытке не оставляем "полуподключённое" состояние
    // (иначе следующий выбор кошелька может упираться в неконсистентные глобалы)
    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentChainId = null;
    currentAddress = null;

    // Дополнительно: если это был отказ/отмена, не держим глобальный wcProvider
    // чтобы следующая попытка стартовала "с чистого листа"
    if (isUserRejected) {
      wcProvider = null;
    }

    throw e;
  } finally {

    isConnecting = false;
  }
}

function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// UI-обёртка: сюда должен приходить walletId из клика по пункту кошелька
export function connectWalletUI(walletId) {
  return connectWallet({ walletId });
}


export async function disconnectWallet() {
  try {
    if (wcProvider?.disconnect) await wcProvider.disconnect();
  } catch (_) {}

  selectedEip1193 = null;
  ethersProvider = null;
  signer = null;
  currentAddress = null;
  currentChainId = null;

  clearGlobals();
  showNotification?.('Wallet disconnected', 'info');
  dispatchDisconnected();
}

export function isWalletConnected() {
  return !!currentAddress;
}

export function getAddress() {
  return currentAddress;
}

export function getSigner() {
  return signer;
}

export function getEthersProvider() {
  return ethersProvider;
}

// Добавление токена в кошелёк (MetaMask/Trust/Rabby и т.п.)
export async function addTokenToWallet(symbol) {
  if (!selectedEip1193?.request) {
    throw new Error('Wallet not connected');
  }

  const sym = String(symbol || '').toUpperCase();

  // ВАЖНО: decimals должны соответствовать контракту
  // USDT на Arbitrum = 6
  // ARUB — укажите фактические decimals вашего токена (если у него 18 — поставьте 18)
  const token =
    sym === 'USDT'
      ? {
          address: CONFIG.USDT_ADDRESS,
          symbol: 'USDT',
          decimals: 6,
          image: CONFIG.USDT_IMAGE || undefined
        }
      : sym === 'ARUB'
      ? {
          address: CONFIG.TOKEN_ADDRESS,
          symbol: 'ARUB',
          decimals: Number(CONFIG.TOKEN_DECIMALS ?? 6),
          image: CONFIG.ARUB_IMAGE || undefined
        }
      : null;

  if (!token?.address) {
    throw new Error(`Unknown token symbol: ${symbol}`);
  }

  const ok = await selectedEip1193.request({
    method: 'wallet_watchAsset',
    params: {
      type: 'ERC20',
      options: {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        image: token.image
      }
    }
  });

  try {
    if (ok) showNotification?.(`${token.symbol} added to wallet`, 'success');
    else showNotification?.(`${token.symbol} was not added`, 'info');
  } catch (_) {}

  return ok;
}

/**
 * wallet.js — Multi-wallet connection layer (EIP-6963 + WalletConnect)
 * CLEAN & STABLE VERSION
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification } from './ui.js';

// -----------------------------
// Internal state (single source of truth)
// -----------------------------
let selectedEip1193 = null;
let ethersProvider = null;
let signer = null;
let currentAddress = null;
let currentChainId = null;
let isConnecting = false;

// WalletConnect provider
let wcProvider = null;

// EIP-6963 registry
const discoveredWallets = new Map();

// -----------------------------
// Utils
// -----------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function publishGlobals() {
  window.walletState = {
    provider: ethersProvider,
    signer,
    address: currentAddress,
    chainId: currentChainId,
    eip1193: selectedEip1193
  };
}

function clearGlobals() {
  window.walletState = null;
}

function dispatchConnected() {
  window.dispatchEvent(new CustomEvent('wallet:connected', {
    detail: { address: currentAddress, chainId: currentChainId }
  }));
}

function dispatchDisconnected() {
  window.dispatchEvent(new Event('wallet:disconnected'));
}

async function pRequest(method, params = []) {
  if (!selectedEip1193?.request) {
    throw new Error('No selected EIP-1193 provider');
  }
  return selectedEip1193.request({ method, params });
}

// -----------------------------
// EIP-6963 discovery
// -----------------------------
let discoveryReady = false;

function setupEip6963Discovery() {
  if (discoveryReady) return;
  discoveryReady = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    const { info, provider } = event.detail || {};
    if (!info?.rdns || !provider) return;

    discoveredWallets.set(info.rdns, {
      id: info.rdns,
      name: info.name || info.rdns,
      icon: info.icon || null,
      type: 'eip6963',
      provider
    });
  });

  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// -----------------------------
// Legacy injected
// -----------------------------
function getLegacyInjectedEntries() {
  const eth = window.ethereum;
  if (!eth) return [];

  if (Array.isArray(eth.providers)) {
    return eth.providers.map((p, i) => ({
      id: `legacy:${i}`,
      name: p.isMetaMask ? 'MetaMask' : `Injected #${i + 1}`,
      type: 'injected',
      provider: p
    }));
  }

  return [{
    id: 'legacy',
    name: eth.isMetaMask ? 'MetaMask' : 'Injected Wallet',
    type: 'injected',
    provider: eth
  }];
}

// -----------------------------
// Public API
// -----------------------------
export function initWalletModule() {
  setupEip6963Discovery();
  console.log('[WALLET] initWalletModule');
}
function detectWalletBrand(provider, fallbackName = 'Wallet') {
  // EIP-1193 vendor hints (order matters)
  if (provider?.isBybitWallet) return 'Bybit Wallet';
  if (provider?.isOkxWallet) return 'OKX Wallet';
  if (provider?.isRabby) return 'Rabby Wallet';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider?.isTrust || provider?.isTrustWallet) return 'Trust Wallet';
  if (provider?.isPhantom) return 'Phantom';
  if (provider?.isBraveWallet) return 'Brave Wallet';
  if (provider?.isUniswapWallet || provider?.isUniswapExtension) return 'Uniswap Extension';

  // MetaMask is commonly emulated; treat as MetaMask only if not a known emulator
  if (provider?.isMetaMask) return 'MetaMask';

  // fallback to whatever EIP-6963 metadata says
  return fallbackName || 'Wallet';
}

function pickEip6963Fields(w) {
  // Support multiple shapes just in case your discoveredWallets store differs.
  // Expected: { rdns, name, icon, provider } OR { info: { rdns, name, icon }, provider }
  const rdns = w?.rdns || w?.info?.rdns || w?.metadata?.rdns || '';
  const metaName = w?.name || w?.info?.name || w?.metadata?.name || '';
  const icon = w?.icon || w?.info?.icon || w?.metadata?.icon || null;
  const provider = w?.provider || w?.info?.provider || w?.eip1193Provider || null;

  return { rdns, metaName, icon, provider };
}

export function getAvailableWallets() {
  const list = [];
  const seen = new Set();

  // -------------------------
  // EIP-6963 discovered wallets
  // -------------------------
  for (const w of discoveredWallets.values()) {
    const { rdns, metaName, icon, provider } = pickEip6963Fields(w);

    // Brand-detected name (prevents "MetaMask" label opening Bybit, etc.)
    const name = detectWalletBrand(provider, metaName || 'Wallet');

    // Stable unique id
    const id = rdns ? `eip6963:${rdns}` : `eip6963:${name.toLowerCase()}`;

    // Dedup by id and by display name (case-insensitive)
    const nameKey = `name:${name.toLowerCase()}`;
    if (seen.has(id) || seen.has(nameKey)) continue;
    seen.add(id);
    seen.add(nameKey);

    list.push({
      id,
      name,
      icon,
      type: 'eip6963',
      _provider: provider,
      _meta: { rdns, name }
    });
  }

  // -------------------------
  // Legacy injected wallets
  // -------------------------
  for (const w of getLegacyInjectedEntries()) {
    const prov = w?._provider || w?.provider || null;

    // Prefer detected brand name over w.name if provider hints exist
    const detectedName = detectWalletBrand(prov, w?.name || 'Injected');
    const name = (detectedName || w?.name || 'Injected').trim();

    const id = `legacy:${(w?.id || name).toLowerCase()}`;
    const nameKey = `name:${name.toLowerCase()}`;

    // If an EIP-6963 wallet with same brand/name already exists, skip legacy duplicate
    if (seen.has(nameKey) || seen.has(id)) continue;
    seen.add(nameKey);
    seen.add(id);

    list.push({
      id,
      name,
      icon: null,
      type: w?.type || 'injected',
      _provider: prov,
      _meta: { name }
    });
  }

  // -------------------------
  // WalletConnect
  // -------------------------
  if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
    list.push({
      id: 'walletconnect',
      name: 'WalletConnect',
      icon: null,
      type: 'walletconnect'
    });
  }

  return list;
}


 export async function connectWallet({ walletId = null } = {}) {
  if (isConnecting) {
    if (currentAddress) return currentAddress;
    throw new Error('Wallet connection already in progress');
  }

  isConnecting = true;

  try {
    const wallets = getAvailableWallets();

    if (!walletId) throw new Error('No wallet selected');

    const entry = wallets.find(w => w.id === walletId);
    if (!entry) throw new Error('No wallet selected');

    if (entry.type === 'walletconnect') {
      const { default: EthereumProvider } = await import(
        'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js'
      );

      wcProvider = await EthereumProvider.init({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        chains: [Number(CONFIG.NETWORK.chainId)],
        rpcMap: { [CONFIG.NETWORK.chainId]: CONFIG.NETWORK.rpcUrls[0] }
      });

      await wcProvider.connect();
      selectedEip1193 = wcProvider;
    } else {
      const prov = entry._provider || entry.provider;
      if (!prov) throw new Error('Selected wallet provider not found');

      selectedEip1193 = prov;

      // ВАЖНО: request на выбранном провайдере
      await selectedEip1193.request({ method: 'eth_requestAccounts' });
    }

    // <-- эти строки должны быть ПОСЛЕ if/else, а не внутри else
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();
    currentAddress = ethers.utils.getAddress(await signer.getAddress());

    const net = await ethersProvider.getNetwork();
    currentChainId = net.chainId;

    publishGlobals();
    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');
    dispatchConnected();

    return currentAddress;
  } finally {
    isConnecting = false;
  }
}


// UI-обёртка: сюда должен приходить walletId из клика по пункту кошелька
export function connectWalletUI(walletId) {
  return connectWallet({ walletId });
}


export async function disconnectWallet() {
  try {
    if (wcProvider?.disconnect) await wcProvider.disconnect();
  } catch (_) {}

  selectedEip1193 = null;
  ethersProvider = null;
  signer = null;
  currentAddress = null;
  currentChainId = null;

  clearGlobals();
  showNotification?.('Wallet disconnected', 'info');
  dispatchDisconnected();
}

export function isWalletConnected() {
  return !!currentAddress;
}

export function getAddress() {
  return currentAddress;
}

export function getSigner() {
  return signer;
}

export function getEthersProvider() {
  return ethersProvider;
}

// Добавление токена в кошелёк (MetaMask/Trust/Rabby и т.п.)
export async function addTokenToWallet(symbol) {
  if (!selectedEip1193?.request) {
    throw new Error('Wallet not connected');
  }

  const sym = String(symbol || '').toUpperCase();

  // ВАЖНО: decimals должны соответствовать контракту
  // USDT на Arbitrum = 6
  // ARUB — укажите фактические decimals вашего токена (если у него 18 — поставьте 18)
  const token =
    sym === 'USDT'
      ? {
          address: CONFIG.USDT_ADDRESS,
          symbol: 'USDT',
          decimals: 6,
          image: CONFIG.USDT_IMAGE || undefined
        }
      : sym === 'ARUB'
      ? {
          address: CONFIG.TOKEN_ADDRESS,
          symbol: 'ARUB',
          decimals: Number(CONFIG.TOKEN_DECIMALS ?? 6),
          image: CONFIG.ARUB_IMAGE || undefined
        }
      : null;

  if (!token?.address) {
    throw new Error(`Unknown token symbol: ${symbol}`);
  }

  const ok = await selectedEip1193.request({
    method: 'wallet_watchAsset',
    params: {
      type: 'ERC20',
      options: {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        image: token.image
      }
    }
  });

  try {
    if (ok) showNotification?.(`${token.symbol} added to wallet`, 'success');
    else showNotification?.(`${token.symbol} was not added`, 'info');
  } catch (_) {}

  return ok;
}

