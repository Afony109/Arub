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

async function readChainIdHex(eth) {
  // вернёт строку вида "0xa4b1"
  return await eth.request({ method: 'eth_chainId' });
}

function hexToInt(hex) {
  return parseInt(hex, 16);
}

async function publishGlobals() {
  // если провайдер не выбран — сброс состояния
  if (!selectedEip1193) {
    window.walletState = null;
    return;
  }

  // ВАЖНО: 'any' позволяет ethers корректно переживать chainChanged
  // и не фиксировать сеть на момент создания.
  try {
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();
  } catch (e) {
    console.warn('[wallet] failed to build Web3Provider/signer', e);
    ethersProvider = null;
    signer = null;
  }

  // chainId: всегда пытаемся получить из провайдера
  let chainId = null;
  try {
    const hex = await selectedEip1193.request({ method: 'eth_chainId' });
    const parsed = Number.parseInt(hex, 16);
    chainId = Number.isFinite(parsed) ? parsed : null;
  } catch (e) {
    console.warn('[wallet] failed to fetch chainId from provider', e);
    chainId = null;
  }

  currentChainId = chainId;

  // address: если у вас currentAddress ведётся отдельно — ок.
  // Но безопаснее синхронизировать из eth_accounts (не обязательно, но полезно).
  // Если не хотите — уберите этот блок.
  try {
    const accs = await selectedEip1193.request({ method: 'eth_accounts' });
    if (Array.isArray(accs) && accs[0]) currentAddress = accs[0];
  } catch (e) {
    // игнорируем
  }

  window.walletState = {
    provider: ethersProvider || null,
    signer: signer || null,
    address: currentAddress || null,
    chainId: chainId,
    eip1193: selectedEip1193
  };

  try {
  window.dispatchEvent(new CustomEvent('walletStateChanged', { detail: window.walletState }));
} catch (_) {}


  console.log('[wallet] publishGlobals', window.walletState);
}

function isPermissionError(e) {
  const msg = (e?.message || '').toLowerCase();
  return msg.includes('does not have permission') || msg.includes('permission');
}

export async function trySwitchToArbitrum() {
  if (!selectedEip1193) throw new Error('Wallet not connected');

  const targetHex = CONFIG.NETWORK.chainIdHex.toLowerCase(); // '0xa4b1'
  const currentHex = (await selectedEip1193.request({ method: 'eth_chainId' }))?.toLowerCase();
  if (currentHex === targetHex) return true;

  try {
    await selectedEip1193.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetHex }],
    });
    await publishGlobals();
    return true;
  } catch (e) {
    // TrustWallet / некоторые режимы WC: переключение запрещено
    if (isPermissionError(e)) {
      // НЕ падаем — просто говорим пользователю переключить вручную
      showNotification('Switch network in your wallet to Arbitrum One, then press "I switched".', 'warning');
      return false;
    }
    // Если сети нет — можно попробовать добавить (если тоже не запрещено)
    if (e?.code === 4902) {
      try {
        await selectedEip1193.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: targetHex,
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: CONFIG.NETWORK.walletRpcUrls,
            blockExplorerUrls: CONFIG.NETWORK.blockExplorerUrls,
          }],
        });
        // повторим switch
        await selectedEip1193.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetHex }],
        });
        await publishGlobals();
        return true;
      } catch (e2) {
        if (isPermissionError(e2)) {
          showNotification('Add/switch network is blocked by wallet. Switch to Arbitrum manually in TrustWallet.', 'warning');
          return false;
        }
        throw e2;
      }
    }
    throw e;
  }
}

// wallet.js

export function isOnArbitrum() {
  return window.walletState?.chainId === CONFIG.NETWORK.chainId;
}

export function requireArbitrumOrThrow(ws = window.walletState) {
  const expected = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  const cid = ws?.chainId ?? null;

  if (!Number.isFinite(expected)) {
    throw new Error('Config error: NETWORK.chainId is invalid');
  }

  if (Number(cid) !== expected) {
    throw new Error(`Wrong network. Please switch to Arbitrum One (${expected}). Current: ${cid ?? 'unknown'}`);
  }
}

function dispatchConnected() {
  const cid = window.walletState?.chainId ?? currentChainId ?? null;

  window.dispatchEvent(
    new CustomEvent('wallet:connected', {
      detail: {
        address: currentAddress,
        chainId: cid
      }
    })
  );
}

function dispatchDisconnected() {
  window.dispatchEvent(new Event('wallet:disconnected'));
}

function clearGlobals() {
  window.walletState = null;
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

  // Ask wallets to announce themselves
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// -----------------------------
// Public API
// -----------------------------
export function initWalletModule() {
  try { setupEip6963Discovery(); } catch (e) {
    console.warn('[WALLET] EIP-6963 discovery skipped:', e);
  }
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

      // ВАЖНО: сначала присваиваем, потом request (раньше тут был баг: localSelected был null)
      localSelected = localWc;

      // connect может “висеть” → ограничиваем по времени
      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts timeout'
      );
    } else {
      const prov = entry._provider || entry.provider;
      if (!prov) throw new Error('Selected wallet provider not found');

      localSelected = prov;

      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts'
      );
    }

    await publishGlobals();


   // сохраняем выбранный провайдер только после успешного requestAccounts
selectedEip1193 = localSelected;
wcProvider = localWc || wcProvider;

ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
signer = ethersProvider.getSigner();
currentAddress = ethers.utils.getAddress(await signer.getAddress());

const net = await ethersProvider.getNetwork();
currentChainId = net.chainId;

// Ставим слушателей ПОСЛЕ того, как selectedEip1193 уже задан
attachProviderListeners();

// Публикуем глобальное состояние
await publishGlobals();

    // Подстрахуемся: если publishGlobals получил chainId напрямую из провайдера
    currentChainId = window.walletState?.chainId ?? currentChainId;

    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');
    dispatchConnected();

    // для совместимости со старым кодом, который слушает "walletChanged"
    window.dispatchEvent(new Event('walletChanged'));

    return currentAddress;
  } catch (e) {
    // Уборка WalletConnect инстанса, если он был создан в этой попытке
    try {
      if (localWc) {
        await localWc.disconnect?.();
        await localWc.close?.();
      }
    } catch (_) {}

    // При любой неуспешной попытке не оставляем "полуподключённое" состояние
    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentChainId = null;
    currentAddress = null;
    wcProvider = null;

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
export function connectWalletUI({ walletId } = {}) {
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
  return !!window.walletState?.address;
}

export function getAddress() {
  return currentAddress;
}

export function getSigner() {
  return signer;
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

const ORACLE_ABI_MIN = [
  "function getRate() view returns (uint256,uint256)",
  "function rate() view returns (uint256)"
];

let listenersAttached = false;

function attachProviderListeners() {
  if (!selectedEip1193) return;
  if (listenersAttached) return;
  if (typeof selectedEip1193.on !== 'function') return;

  listenersAttached = true;

  selectedEip1193.on('chainChanged', (hex) => {
    const parsed = parseInt(hex, 16);
    currentChainId = Number.isFinite(parsed) ? parsed : null;
    publishGlobals().catch(() => {});
  });

  selectedEip1193.on('accountsChanged', (accounts) => {
  const a = accounts?.[0] || null;
  currentAddress = a ? ethers.utils.getAddress(a) : null;
  publishGlobals().catch(() => {});
});
}

function calcDiscount(avgPrice, currentPrice) {
  if (!avgPrice || !currentPrice || currentPrice <= 0) return null;
  return (1 - avgPrice / currentPrice) * 100;
}

export function getEthersProvider() {
  return ethersProvider;
}

