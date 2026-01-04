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

// -----------------------------
// EIP-6963 multi-injected registry
// -----------------------------
const EIP6963 = {
  ready: false,
  byId: new Map(),        // key: "eip6963:<uuid>" -> { info, provider }
  list: [],               // normalized list for UI
  _bound: false,
};

function normalize6963Entry(detail) {
  const info = detail?.info || {};
  const uuid = info.uuid || crypto?.randomUUID?.() || String(Math.random());
  const id = `eip6963:${uuid}`;
  return {
    id,
    uuid,
    name: info.name || 'Injected Wallet',
    rdns: info.rdns || '',
    icon: info.icon || '',
    type: 'injected',
  };
}


function bindEip6963() {
  if (EIP6963._bound) return;
  EIP6963._bound = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    try {
      const detail = event?.detail;
      if (!detail?.provider || !detail?.info?.uuid) return;

      const norm = normalize6963Entry(detail);
      EIP6963.byId.set(norm.id, { info: detail.info, provider: detail.provider, norm });
      rebuildEip6963List();
      EIP6963.ready = true;
    } catch (e) {
      console.warn('[wallet] eip6963 announce handler error:', e?.message || e);
    }
  });
}

function rebuildEip6963List() {
  // уникализация + стабильная сортировка (по имени)
  const arr = [];
  for (const v of EIP6963.byId.values()) arr.push(v.norm);

  arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  EIP6963.list = arr;
}

function requestEip6963Providers() {
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch (_) {}
}

function makeEip6963Key(detail) {
  const info = detail?.info || {};
  // EIP-6963: uuid — единственный нормальный стабильный идентификатор
  if (info.uuid) return info.uuid;

  // fallback (редкий случай): делаем максимально устойчивый ключ
  return `${info.rdns || 'rdns:unknown'}|${info.name || 'name:unknown'}|${info.icon || 'icon:unknown'}`;
}


export function initWalletModule() {
  if (eip6963Store.inited) return;
  eip6963Store.inited = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    try {
      const detail = event?.detail;
      if (!detail?.provider) return;

      const info = detail.info || {};
      const uuid = makeEip6963Key(detail);

      // единый формат идентификаторов
      const id = `eip6963:${uuid}`;

      eip6963Store.map.set(uuid, {
        walletId: id,                 // UI передаёт это в connectWallet({ walletId })
        entryId: id,                  // и это тоже, чтобы не было рассинхрона
        entryName: info.name || 'Wallet',
        type: 'eip6963',
        rdns: info.rdns || '',
        icon: info.icon || '',
        info,
        provider: detail.provider,
      });
    } catch (e) {
      console.warn('[wallet] eip6963 announceProvider handler failed:', e?.message || e);
    }
  });

  // инициируем discovery
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch (e) {
    console.warn('[wallet] eip6963 requestProvider failed:', e?.message || e);
  }

  console.log('[wallet] initWalletModule: eip6963 init ok');
}

export function getAvailableWallets() {
  // дергаем discovery каждый раз (announce асинхронный)
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

  const out = [];

  // EIP-6963
  try {
    const entries = Array.from(eip6963Store?.map?.values?.() || []);
    for (const e of entries) {
      if (!e?.walletId || !e?.provider) continue;

      out.push({
        walletId: e.walletId,
        entryId: e.entryId,
        entryName: e.entryName,
        type: 'eip6963',
        rdns: e.rdns || '',
        icon: e.icon || '',
      });
    }
  } catch (e) {
    console.warn('[wallet] getAvailableWallets eip6963 read failed:', e?.message || e);
  }

  // WalletConnect (если используете)
  out.push({
    walletId: 'walletconnect',
    entryId: 'walletconnect',
    entryName: 'WalletConnect',
    type: 'walletconnect',
    rdns: 'walletconnect',
    icon: '',
  });

  // fallback injected (если вообще ничего нет)
  if (out.length === 1 && out[0].type === 'walletconnect' && window.ethereum?.request) {
    out.push({
      walletId: 'injected:ethereum',
      entryId: 'injected:ethereum',
      entryName: 'Injected',
      type: 'injected',
      rdns: '',
      icon: '',
    });
  }

  out.sort((a, b) => (a.entryName || '').localeCompare(b.entryName || ''));
  return out;
}

// Optional helper to fetch provider by walletId/entryId
export function getEip1193ProviderById(walletIdOrEntryId) {
  if (!walletIdOrEntryId) return null;

  if (walletIdOrEntryId === 'injected:ethereum') {
    return window.ethereum?.request ? window.ethereum : null;
  }

  if (walletIdOrEntryId.startsWith('eip6963:')) {
    const uuid = walletIdOrEntryId.slice('eip6963:'.length);
    const entry = eip6963Store.map.get(uuid);
    return entry?.provider || null;
  }

  // fallback: если вдруг передали "uuid" без префикса
  const entry = eip6963Store.map.get(walletIdOrEntryId);
  return entry?.provider || null;
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
  // Prevent parallel connects
  if (isConnecting) {
    if (currentAddress) return currentAddress;
    throw new Error('Wallet connection already in progress');
  }
  isConnecting = true;

  let localSelected = null;
  let localWc = null;

  const resetState = async () => {
    // снимаем слушателей со старого провайдера
    try { detachProviderListeners(); } catch (_) {}

    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentChainId = null;
    currentAddress = null;

    try {
      if (wcProvider) {
        await wcProvider.disconnect?.();
        await wcProvider.close?.();
      }
    } catch (_) {}
    wcProvider = null;

    try { await publishGlobals(); } catch (_) {}
  };

  const pickEntry = async () => {
    // ВАЖНО: EIP-6963 объявления приходят асинхронно.
    // Если render сработал “раньше” — список может быть пустым.
    // Поэтому делаем короткую попытку “подождать и обновить”.
    let wallets = [];
    try { wallets = getAvailableWallets() || []; } catch (_) { wallets = []; }

    // если не нашли — подождём чуть-чуть и попробуем ещё раз
    if ((!Array.isArray(wallets) || wallets.length === 0) && typeof window !== 'undefined') {
      await new Promise(r => setTimeout(r, 150));
      try { wallets = getAvailableWallets() || []; } catch (_) { wallets = []; }
    }

    if (!walletId) throw new Error('No wallet selected');

    let entry = Array.isArray(wallets) ? wallets.find(w => w.walletId === walletId) : null;

    // Подстраховка: некоторые реализации кладут id в entryId (а walletId остаётся “eip6963:…”)
    if (!entry && Array.isArray(wallets)) {
      entry = wallets.find(w => w.entryId === walletId);
    }

    if (!entry) {
      // Доп. подстраховка именно под EIP-6963:
      // иногда UI передаёт "eip6963:<uuid>", а в entries хранится другой ключ.
      if (String(walletId).startsWith('eip6963')) {
        const prov =
          getEip1193ProviderById(walletId) ||
          getEip1193ProviderById(`eip6963:${walletId.split(':')[1] || ''}`);

        if (prov?.request) {
          return {
            walletId,
            entryId: walletId,
            entryName: 'Injected',
            type: 'eip6963',
            rdns: ''
          };
        }
      }
      throw new Error('No wallet selected');
    }

    return entry;
  };

  try {
    const entry = await pickEntry();

    console.log('[wallet] connect start', {
      walletId,
      entryId: entry.entryId,
      entryName: entry.entryName,
      type: entry.type,
      rdns: entry.rdns
    });

    // -----------------------------
    // 1) pick provider + accounts
    // -----------------------------
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
        60000,
        'eth_requestAccounts (walletconnect)'
      );
    } else if (entry.type === 'eip6963') {
      const prov =
        getEip1193ProviderById(entry.entryId) ||
        getEip1193ProviderById(entry.walletId);

      if (!prov?.request) throw new Error('Selected wallet provider not found');
      localSelected = prov;

      // сначала без попапа
      let accs = [];
      try { accs = await localSelected.request({ method: 'eth_accounts' }); } catch (_) { accs = []; }

      // если нет доступа — просим доступ
      if (!Array.isArray(accs) || accs.length === 0) {
        await withTimeout(
          localSelected.request({ method: 'eth_requestAccounts' }),
          60000,
          'eth_requestAccounts'
        );
      }
    } else if (entry.type === 'injected') {
      const prov = window.ethereum;
      if (!prov?.request) throw new Error('Injected provider not found');
      localSelected = prov;

      let accs = [];
      try { accs = await localSelected.request({ method: 'eth_accounts' }); } catch (_) { accs = []; }

      if (!Array.isArray(accs) || accs.length === 0) {
        await withTimeout(
          localSelected.request({ method: 'eth_requestAccounts' }),
          60000,
          'eth_requestAccounts'
        );
      }
    } else {
      throw new Error(`Unsupported wallet type: ${entry.type}`);
    }

    // -----------------------------
    // 2) swap listeners + set selected
    // -----------------------------
    detachProviderListeners();

    selectedEip1193 = localSelected;

    // ВАЖНО: wcProvider должен быть ровно тем экземпляром, который мы создали,
    // иначе disconnect может бить не туда.
    wcProvider = localWc || null;

    // -----------------------------
    // 3) ethers provider/signer + address/chainId
    // -----------------------------
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();

    const addr = await signer.getAddress();
    currentAddress = addr ? ethers.utils.getAddress(addr) : null;

    // chainId (prefer eth_chainId)
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

    attachProviderListeners();

    console.log('[wallet] before publishGlobals', {
      walletId,
      address: currentAddress,
      chainId: currentChainId
    });

    // -----------------------------
    // 4) publish globals
    // -----------------------------
    await publishGlobals();

    // -----------------------------
    // 5) auto switch to Arbitrum (ONCE)
    // -----------------------------
    try {
      const expected = Number(CONFIG.NETWORK.chainId);
      const actual = Number(window.walletState?.chainId ?? currentChainId);

      if (Number.isFinite(expected) && Number.isFinite(actual) && actual !== expected) {
        const ok = await trySwitchToArbitrum();

        if (ok) {
          await publishGlobals();
        } else {
          showNotification?.(
            'Переключіть мережу на Arbitrum One у гаманці та повторіть дію.',
            'warning'
          );
        }
      }
    } catch (e) {
      console.warn('[wallet] auto switch failed:', e?.message || e);
    }

    // Подстраховка
    currentChainId = window.walletState?.chainId ?? currentChainId;

    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');
    dispatchConnected();
    window.dispatchEvent(new Event('walletChanged'));

    return currentAddress;
  } catch (e) {
    // cleanup WalletConnect instance created in this attempt
    try {
      if (localWc) {
        await localWc.disconnect?.();
        await localWc.close?.();
      }
    } catch (_) {}

    await resetState();
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
  // 1) WalletConnect cleanup (if used)
  try {
    if (wcProvider) {
      await wcProvider.disconnect?.();
      await wcProvider.close?.();
    }
  } catch (_) {}

  // 2) remove listeners from previous provider
  try {
    detachProviderListeners();
  } catch (_) {}

  // 3) reset internal state
  selectedEip1193 = null;
  ethersProvider = null;
  signer = null;
  currentAddress = null;
  currentChainId = null;
  wcProvider = null;

  // 4) reset globals
  clearGlobals(); // window.walletState = null

  // 5) IMPORTANT: notify UI/modules (trading listens to walletStateChanged)
  // publishGlobals() in your code dispatches walletStateChanged even when no provider selected
  try {
    await publishGlobals();
  } catch (_) {
    // fallback: at least dispatch the event
    try {
      window.dispatchEvent(new CustomEvent('walletStateChanged', { detail: window.walletState }));
    } catch (_) {}
  }

  // 6) optional legacy/custom events
  try { dispatchDisconnected(); } catch (_) {}

  try {
    showNotification?.('Wallet disconnected', 'info');
  } catch (_) {}
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

window.trySwitchToArbitrum = trySwitchToArbitrum;





