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

// -----------------------------
// EIP-6963 store (robust)
// -----------------------------
const eip6963Store = {
  inited: false,
  // key -> entry
  map: new Map(),
};

function makeEip6963Key(detail) {
  // EIP-6963 обычно даёт info.uuid. Если нет — используем устойчивый составной ключ.
  const info = detail?.info || {};
  return (
    info.uuid ||
    `${info.rdns || 'rdns:unknown'}|${info.name || 'name:unknown'}|${info.icon || 'icon:unknown'}`
  );
}

export function initWalletModule() {
  if (eip6963Store.inited) return;
  eip6963Store.inited = true;

  // 1) Collect announcements
  window.addEventListener('eip6963:announceProvider', (event) => {
    try {
      const detail = event?.detail;
      if (!detail?.provider) return;

      const key = makeEip6963Key(detail);
      eip6963Store.map.set(key, {
        walletId: `eip6963:${detail?.info?.name || detail?.info?.rdns || 'wallet'}`,
        entryId: key,
        entryName: detail?.info?.name || 'Wallet',
        type: 'eip6963',
        rdns: detail?.info?.rdns || '',
        info: detail?.info || {},
        provider: detail.provider,
      });
    } catch (e) {
      console.warn('[wallet] eip6963 announceProvider handler failed:', e?.message || e);
    }
  });

  // 2) Request providers (this triggers announceProvider in many wallets)
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch (e) {
    console.warn('[wallet] eip6963 requestProvider failed:', e?.message || e);
  }

  console.log('[wallet] initWalletModule: eip6963 init ok');
}

export function getAvailableWallets() {
  const out = [];

  // A) EIP-6963 wallets (MetaMask, Rabby, Trust, Bybit, etc.)
  for (const entry of eip6963Store.map.values()) {
    out.push({
      walletId: entry.walletId,
      entryId: entry.entryId,
      entryName: entry.entryName,
      type: entry.type,
      rdns: entry.rdns || '',
    });
  }

  // B) Legacy injected provider fallback (older wallets expose window.ethereum only)
  // Do NOT let this collapse EIP-6963 entries; it is just a fallback.
  if (window.ethereum && out.length === 0) {
    out.push({
      walletId: 'injected:ethereum',
      entryId: 'injected:ethereum',
      entryName: 'Injected',
      type: 'injected',
      rdns: '',
    });
  }

  return out;
}

// Optional helper to fetch provider by walletId/entryId
export function getEip1193ProviderById(walletIdOrEntryId) {
  for (const entry of eip6963Store.map.values()) {
    if (entry.walletId === walletIdOrEntryId || entry.entryId === walletIdOrEntryId) {
      return entry.provider;
    }
  }
  if (walletIdOrEntryId === 'injected:ethereum') return window.ethereum;
  return null;
}

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
    try {
      window.dispatchEvent(new CustomEvent('walletStateChanged', { detail: window.walletState }));
    } catch (_) {}
    return;
  }

  // chainId: пытаемся получить из провайдера (быстрее/надежнее чем ethers.getNetwork в некоторых кошельках)
  let chainId = currentChainId ?? null;
  try {
    const hex = await selectedEip1193.request({ method: 'eth_chainId' });
    const parsed = Number.parseInt(hex, 16);
    chainId = Number.isFinite(parsed) ? parsed : chainId;
  } catch (e) {
    // оставляем что было в currentChainId
  }

  currentChainId = chainId;

  // address: синхронизируем из eth_accounts (если доступно)
  let addr = currentAddress ?? null;
  try {
    const accs = await selectedEip1193.request({ method: 'eth_accounts' });
    if (Array.isArray(accs) && accs[0]) addr = accs[0];
  } catch (e) {
    // оставляем что было в currentAddress
  }

  // нормализуем checksum, если есть ethers
  try {
    if (addr) addr = ethers.utils.getAddress(addr);
  } catch (_) {}

  currentAddress = addr;

  // ВАЖНО: НЕ создаём тут ethersProvider/signer заново, только публикуем то, что уже есть
 window.walletState = {
    provider: ethersProvider || null,
    signer: signer || null,
    address: currentAddress || null,
    chainId: currentChainId ?? null,
    eip1193: selectedEip1193
  };

  try {
    window.dispatchEvent(new CustomEvent('walletStateChanged', { detail: window.walletState }));
  } catch (_) {}

  console.log('[wallet] publishGlobals', window.walletState);
}

function dispatchWalletState() {
  const ws = window.walletState || {};
  window.dispatchEvent(new CustomEvent('wallet:state', { detail: ws }));

  // для совместимости, если где-то уже ждёте другой ивент
  if (ws?.address && ws?.signer) {
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: ws }));
  } else {
    window.dispatchEvent(new CustomEvent('wallet:disconnected', { detail: ws }));
  }
}

console.log('[wallet] publishGlobals', window.walletState);
dispatchWalletState();

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
// Public API
// -----------------------------

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

    // ✅ robust: ищем по walletId (а не по id)
    const entry = wallets.find(w => w.walletId === walletId);
    if (!entry) throw new Error('No wallet selected');

    console.log('[wallet] connect start', {
      walletId,
      entryId: entry.entryId,
      entryName: entry.entryName,
      type: entry.type,
      rdns: entry.rdns
    });

    // 1) Получаем EIP-1193 провайдер (localSelected) и делаем requestAccounts
    if (entry.type === 'walletconnect') {
      const { default: EthereumProvider } = await import(
        'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js'
      );

      localWc = await EthereumProvider.init({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        chains: [Number(CONFIG.NETWORK.chainId)],
        rpcMap: {
          [Number(CONFIG.NETWORK.chainId)]: (CONFIG.NETWORK.walletRpcUrls?.[0] || CONFIG.NETWORK.readOnlyRpcUrl),
        },
      });

      localSelected = localWc;

      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts timeout'
      );
    } else if (entry.type === 'eip6963') {
      // ✅ берём provider по entryId (надежнее), fallback по walletId
      const prov =
        getEip1193ProviderById(entry.entryId) ||
        getEip1193ProviderById(entry.walletId);

      if (!prov?.request) throw new Error('Selected wallet provider not found');

      localSelected = prov;

      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts'
      );
    } else if (entry.type === 'injected') {
      // fallback для старых кошельков
      const prov = window.ethereum;
      if (!prov?.request) throw new Error('Injected provider not found');

      localSelected = prov;

      await withTimeout(
        localSelected.request({ method: 'eth_requestAccounts' }),
        20000,
        'eth_requestAccounts'
      );
    } else {
      throw new Error(`Unsupported wallet type: ${entry.type}`);
    }

    // если была старая сессия/провайдер — аккуратно снять слушатели
    detachProviderListeners();

    // 2) Фиксируем выбранный провайдер в состоянии модуля
    selectedEip1193 = localSelected;
    wcProvider = localWc || wcProvider;

    // 3) Теперь безопасно строим ethers provider/signer и читаем address/chainId
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();

    const addr = await signer.getAddress();
    currentAddress = addr ? ethers.utils.getAddress(addr) : null;

    // chainId берём из провайдера (бывает надежнее, чем getNetwork у некоторых кошельков)
    let cid = null;
    try {
      const hex = await selectedEip1193.request({ method: 'eth_chainId' });
      const parsed = Number.parseInt(hex, 16);
      cid = Number.isFinite(parsed) ? parsed : null;
    } catch (_) {}

    if (cid) {
      currentChainId = cid;
    } else {
      const net = await ethersProvider.getNetwork();
      currentChainId = net?.chainId ?? null;
    }

    // 4) Листенеры ставим после selectedEip1193
    attachProviderListeners();

    console.log('[wallet] before publishGlobals', {
      walletId,
      address: currentAddress,
      chainId: currentChainId
    });

    // 5) Публикуем глобальное состояние (walletState)
    await publishGlobals();

    // Подстраховка: берём chainId из walletState если он там точнее
    currentChainId = window.walletState?.chainId ?? currentChainId;

    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');

    // ваш текущий dispatchConnected использует currentAddress/currentChainId
    dispatchConnected();

    // совместимость со старым кодом
    window.dispatchEvent(new Event('walletChanged'));

    return currentAddress;
  } catch (e) {
    // cleanup WalletConnect, если он создавался в этой попытке
    try {
      if (localWc) {
        await localWc.disconnect?.();
        await localWc.close?.();
      }
    } catch (_) {}

    // сброс локального состояния
    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentChainId = null;
    currentAddress = null;
    wcProvider = null;

    // и публикуем сброс, чтобы UI тоже сбросился
    try { await publishGlobals(); } catch (_) {}

    throw e;
  } finally {
    isConnecting = false;
  }
}

async function requestAccounts(provider) {
  // EIP-1193
  return await provider.request({ method: 'eth_requestAccounts' });
}

async function ensureArbitrum(provider) {
  const targetHex = '0xa4b1';

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetHex }],
    });
    return true;
  } catch (e) {
    // 4902 = chain not added
    if (e?.code === 4902) {
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: targetHex,
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [
              'https://arbitrum-one-rpc.publicnode.com',
              'https://arb1.arbitrum.io/rpc',
            ],
            blockExplorerUrls: ['https://arbiscan.io'],
          }],
        });
        return true;
      } catch (e2) {
        // Trust Wallet иногда не любит addChain → просто вернём false
        return false;
      }
    }
    return false;
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
    if (wcProvider) {
      await wcProvider.disconnect?.();
      await wcProvider.close?.();
    }
  } catch (_) {}

  // снимаем слушателей со старого провайдера
  detachProviderListeners();

  selectedEip1193 = null;
  ethersProvider = null;
  signer = null;
  currentAddress = null;
  currentChainId = null;
  wcProvider = null;

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
let listenersOwner = null;
let onChainChanged = null;
let onAccountsChanged = null;


function attachProviderListeners() {
  if (!selectedEip1193) return;
  if (typeof selectedEip1193.on !== 'function') return;

  // если были слушатели на другом провайдере — снимем
  if (listenersAttached && listenersOwner && listenersOwner !== selectedEip1193) {
    detachProviderListeners();
  }
  if (listenersAttached) return;

  listenersAttached = true;
  listenersOwner = selectedEip1193;

  onChainChanged = (hex) => {
    const parsed = parseInt(hex, 16);
    currentChainId = Number.isFinite(parsed) ? parsed : null;
    publishGlobals().catch(() => {});
  };

  onAccountsChanged = (accounts) => {
    const a = accounts?.[0] || null;
    try {
      currentAddress = a ? ethers.utils.getAddress(a) : null;
    } catch (_) {
      currentAddress = a;
    }
    publishGlobals().catch(() => {});
  };

  selectedEip1193.on('chainChanged', onChainChanged);
  selectedEip1193.on('accountsChanged', onAccountsChanged);
}

function detachProviderListeners() {
  const p = listenersOwner;

  if (!p) {
    listenersAttached = false;
    return;
  }

  const off = p.removeListener?.bind(p) || p.off?.bind(p);
  if (off) {
    if (onChainChanged) off('chainChanged', onChainChanged);
    if (onAccountsChanged) off('accountsChanged', onAccountsChanged);
  }

  listenersOwner = null;
  onChainChanged = null;
  onAccountsChanged = null;
  listenersAttached = false;
}

function calcDiscount(avgPrice, currentPrice) {
  if (!avgPrice || !currentPrice || currentPrice <= 0) return null;
  return (1 - avgPrice / currentPrice) * 100;
}

export function getEthersProvider() {
  return ethersProvider;
}

// -----------------------------
// Publish legacy globals for UI modules that call window.*
// -----------------------------
// ---- publish globals (UI relies on window.*) ----
try {
  window.initWalletModule = initWalletModule;
  window.getAvailableWallets = getAvailableWallets;
  window.connectWallet = connectWallet;
  window.connectWalletUI = connectWalletUI;
  window.disconnectWallet = disconnectWallet;

  console.log('[wallet] globals published', {
    hasGetAvailableWallets: typeof window.getAvailableWallets === 'function',
    hasConnectWallet: typeof window.connectWallet === 'function',
  });
} catch (e) {
  console.warn('[wallet] failed to publish globals', e);
}





