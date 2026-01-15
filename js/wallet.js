// wallet.js — FINAL (EIP-6963 only, NO WalletConnect)
//
// Pure browser ESM (no bundlers).
// - Lists injected wallets via EIP-6963 (MetaMask / Trust / Phantom / Uniswap / Bybit ...)
// - Connects to the конкретный provider выбранного кошелька
// - Auto-switches to Arbitrum One (42161) with add-chain fallback
//
// Requires:
// - ethers v5.7.2 ESM
// - CONFIG from ./config.js with CONFIG.NETWORK fields

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { getStoredLang } from './i18n.js';

const WALLET_I18N = {
  ru: {
    switch_failed: 'Перемкніть мережу на Arbitrum One у гаманці та повторіть дію.',
    wallet_connected: 'Гаманець підключено: {{address}}',
    wallet_disconnected: 'Гаманець відключено',
  },
  en: {
    switch_failed: 'Switch to Arbitrum One in your wallet and try again.',
    wallet_connected: 'Wallet connected: {{address}}',
    wallet_disconnected: 'Wallet disconnected',
  },
};

function wt(key, vars) {
  const lang = (getStoredLang?.() || 'ru');
  const dict = WALLET_I18N[lang] || WALLET_I18N.ru;
  let out = dict[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(vars[k]));
    });
  }
  return out;
}

// -----------------------------
// State
// -----------------------------
let selectedEip1193 = null;
let ethersProvider = null;
let signer = null;

let currentAddress = null;
let currentChainId = null;

let isConnecting = false;

// -----------------------------
// EIP-6963 store
// -----------------------------
const eip6963Store = {
  inited: false,
  // key: uuid(string) -> entry
  map: new Map(),
};

function requestEip6963Providers() {
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch (_) {}
}

function makeEip6963Key(detail) {
  const info = detail?.info || {};
  if (info.uuid) return info.uuid;
  // fallback (rare)
  return `${info.rdns || 'rdns:unknown'}|${info.name || 'name:unknown'}|${info.icon || 'icon:unknown'}`;
}

function makeEip6963IdFromUuid(uuid) {
  return `eip6963:${uuid}`;
}

// -----------------------------
// Init
// -----------------------------
export function initWalletModule() {
  if (eip6963Store.inited) return;
  eip6963Store.inited = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    try {
      const detail = event?.detail;
      if (!detail?.provider) return;

      const info = detail.info || {};
      const uuid = makeEip6963Key(detail);
      const id = makeEip6963IdFromUuid(uuid);

      eip6963Store.map.set(uuid, {
        walletId: id,          // stable id used by UI + connect
        entryId: id,           // same to avoid mismatches
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

  // expose helpers for legacy UI code (optional)
  try { publishWalletHelpersToWindow(); } catch (_) {}

  requestEip6963Providers();
  console.log('[wallet] initWalletModule: eip6963 init ok');
}

// -----------------------------
// Public: list wallets for dropdown
// -----------------------------
export function getAvailableWallets() {
  // nudge discovery every time (announce приходит асинхронно)
  requestEip6963Providers();

  const out = [];

  try {
    for (const e of eip6963Store.map.values()) {
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
    console.warn('[wallet] getAvailableWallets failed:', e?.message || e);
  }

  // fallback: single injected if EIP-6963 returns nothing
  if (out.length === 0 && window.ethereum?.request) {
    out.push({
      walletId: 'injected:ethereum',
      entryId: 'injected:ethereum',
      entryName: 'Injected',
      type: 'injected',
      rdns: '',
      icon: '',
    });
  }

  out.sort((a, b) => String(a.entryName || '').localeCompare(String(b.entryName || '')));
  return out;
}

// -----------------------------
// Provider lookup
// -----------------------------
export function getEip1193ProviderById(walletIdOrEntryId) {
  if (!walletIdOrEntryId) return null;

  if (walletIdOrEntryId === 'injected:ethereum') {
    return window.ethereum?.request ? window.ethereum : null;
  }

  const s = String(walletIdOrEntryId);

  if (s.startsWith('eip6963:')) {
    const uuid = s.slice('eip6963:'.length);
    const entry = eip6963Store.map.get(uuid);
    return entry?.provider || null;
  }

  // fallback: maybe passed raw uuid
  const entry = eip6963Store.map.get(s);
  return entry?.provider || null;
}

// -----------------------------
// Provider listeners
// -----------------------------
function attachProviderListeners() {
  const p = selectedEip1193;
  if (!p?.on) return;

  try {
    p.on('accountsChanged', onAccountsChanged);
    p.on('chainChanged', onChainChanged);
    p.on('disconnect', onDisconnect);
  } catch (_) {}
}

function detachProviderListeners() {
  const p = selectedEip1193;
  if (!p?.removeListener) return;

  try {
    p.removeListener('accountsChanged', onAccountsChanged);
    p.removeListener('chainChanged', onChainChanged);
    p.removeListener('disconnect', onDisconnect);
  } catch (_) {}
}

async function onAccountsChanged(accounts) {
  try {
    const acc = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
    currentAddress = acc ? ethers.utils.getAddress(acc) : null;
    await publishGlobals();
    // legacy
    window.dispatchEvent(new Event('walletChanged'));
  } catch (e) {
    console.warn('[wallet] accountsChanged handler failed:', e?.message || e);
  }
}

async function onChainChanged(chainIdHex) {
  try {
    const parsed = Number.parseInt(String(chainIdHex), 16);
    currentChainId = Number.isFinite(parsed) ? parsed : currentChainId;
    await publishGlobals();
    // legacy
    window.dispatchEvent(new Event('walletChanged'));
  } catch (e) {
    console.warn('[wallet] chainChanged handler failed:', e?.message || e);
  }
}

async function onDisconnect() {
  try {
    await disconnectWallet();
  } catch (_) {}
}

// -----------------------------
// Helpers
// -----------------------------
function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

function emit(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (_) {}
}

// -----------------------------
// Publish globals
// -----------------------------
export async function publishGlobals() {
  try {
    const state = {
      provider: ethersProvider || null,
      signer: signer || null,
      address: currentAddress || null,
      chainId: currentChainId || null,
      eip1193: selectedEip1193 || null,
    };

    window.walletState = state;

    // основной сигнал для UI/trading
    window.dispatchEvent(new Event('walletStateChanged'));

    // полезные именованные события (не ломают код, если никто не слушает)
    if (state.address && state.signer) emit('wallet:state', state);

    console.log('[wallet] publishGlobals', state);
    return state;
  } catch (e) {
    console.warn('[wallet] publishGlobals failed:', e?.message || e);
    return null;
  }
}

// ==============================
// Network switch helper (exported)
// ==============================
export async function trySwitchToArbitrum() {
  const prov = selectedEip1193 || window.ethereum;
  if (!prov?.request) return false;

  const chainIdHex = String(CONFIG?.NETWORK?.chainIdHex || '0xa4b1');
  const chainIdDec = Number(CONFIG?.NETWORK?.chainId || 42161);

  // if already correct - ok
  try {
    const hex = await prov.request({ method: 'eth_chainId' });
    const cid = Number.parseInt(String(hex), 16);
    if (cid === chainIdDec) return true;
  } catch (_) {}

  try {
    // 1) try switch
    await prov.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
    return true;
  } catch (e) {
    const code = e?.code;
    const msg = String(e?.message || '').toLowerCase();

    // 4902: chain not added OR wallet-specific message
    if (code === 4902 || msg.includes('unrecognized chain') || msg.includes('unknown chain')) {
      try {
        await prov.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chainIdHex,
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: (CONFIG?.NETWORK?.walletRpcUrls?.length
              ? CONFIG.NETWORK.walletRpcUrls
              : [CONFIG?.NETWORK?.readOnlyRpcUrl]).filter(Boolean),
            blockExplorerUrls: CONFIG?.NETWORK?.blockExplorerUrls || ['https://arbiscan.io'],
          }],
        });

        // after add: switch again (важно!)
        await prov.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        });

        return true;
      } catch (e2) {
        console.warn('[wallet] wallet_addEthereumChain failed:', e2?.message || e2);
        return false;
      }
    }

    console.warn('[wallet] wallet_switchEthereumChain failed:', e?.message || e);
    return false;
  } finally {
    // best-effort refresh walletState
    try { await publishGlobals(); } catch (_) {}
  }
}

// expose helper for legacy UI code that calls window.trySwitchToArbitrum
export function publishWalletHelpersToWindow() {
  try { window.trySwitchToArbitrum = trySwitchToArbitrum; } catch (_) {}
}

// -----------------------------
// Public connect/disconnect
// -----------------------------
export async function connectWallet({ walletId = null } = {}) {
  if (isConnecting) {
    if (currentAddress) return currentAddress;
    throw new Error('Wallet connection already in progress');
  }
  isConnecting = true;

  try {
    // nudge EIP-6963 before reading list
    requestEip6963Providers();

    const wallets = getAvailableWallets();
    if (!walletId) throw new Error('No wallet selected');

    const entry = wallets.find(w => w.walletId === walletId) || null;
    if (!entry) throw new Error('No wallet selected');

    console.log('[wallet] connect start', {
      walletId,
      entryId: entry.entryId,
      entryName: entry.entryName,
      type: entry.type,
      rdns: entry.rdns
    });

    // pick provider
    let prov = null;

    if (entry.type === 'eip6963') {
      prov = getEip1193ProviderById(entry.entryId) || getEip1193ProviderById(entry.walletId);
    } else if (entry.type === 'injected') {
      prov = window.ethereum;
    } else {
      throw new Error(`Unsupported wallet type: ${entry.type}`);
    }

    if (!prov?.request) throw new Error('Selected wallet provider not found');

    // request accounts: try silent first
    let accs = [];
    try { accs = await prov.request({ method: 'eth_accounts' }); } catch (_) { accs = []; }

    if (!Array.isArray(accs) || accs.length === 0) {
      await withTimeout(prov.request({ method: 'eth_requestAccounts' }), 60000, 'eth_requestAccounts');
    }

    // swap listeners
    detachProviderListeners();

    selectedEip1193 = prov;
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();

    // address
    const addr = await signer.getAddress();
    currentAddress = addr ? ethers.utils.getAddress(addr) : null;

    // chainId (prefer eth_chainId)
    try {
      const hex = await selectedEip1193.request({ method: 'eth_chainId' });
      const parsed = Number.parseInt(String(hex), 16);
      currentChainId = Number.isFinite(parsed) ? parsed : null;
    } catch (_) {
      const net = await ethersProvider.getNetwork();
      currentChainId = net?.chainId ?? null;
    }

    attachProviderListeners();
    await publishGlobals();

    // auto switch to Arbitrum One (once)
    try {
      const expected = Number(CONFIG?.NETWORK?.chainId || 42161);
      const actual = Number(window.walletState?.chainId || currentChainId);

      if (Number.isFinite(expected) && Number.isFinite(actual) && actual !== expected) {
        const ok = await trySwitchToArbitrum();
        if (ok) await publishGlobals();
        else {
          try {
            window.showNotification?.(wt('switch_failed'), 'warning');
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[wallet] auto switch failed:', e?.message || e);
    }

    try { window.showNotification?.(wt('wallet_connected', { address: currentAddress }), 'success'); } catch (_) {}

    emit('wallet:connected', window.walletState);
    // legacy
    window.dispatchEvent(new Event('walletChanged'));

    return currentAddress;
  } catch (e) {
    // reset state on failure
    detachProviderListeners();
    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentChainId = null;
    currentAddress = null;

    try { await publishGlobals(); } catch (_) {}
    throw e;
  } finally {
    isConnecting = false;
  }
}

export async function disconnectWallet() {
  try { detachProviderListeners(); } catch (_) {}

  selectedEip1193 = null;
  ethersProvider = null;
  signer = null;
  currentAddress = null;
  currentChainId = null;

  await publishGlobals();

  try { window.showNotification?.(wt('wallet_disconnected'), 'info'); } catch (_) {}

  emit('wallet:disconnected', window.walletState);
  // legacy
  window.dispatchEvent(new Event('walletChanged'));
}

// Optional getters
export function getEthersProvider() { return ethersProvider; }
export function getSigner() { return signer; }
export function getCurrentAddress() { return currentAddress; }
export function getCurrentChainId() { return currentChainId; }
export function getSelectedEip1193Provider() { return selectedEip1193; }

// ==============================
// Trading helper (required by trading.js)
// ==============================
export function requireArbitrumOrThrow() {
  const ws = window.walletState;

  // 1) Wallet connected?
  if (!ws?.signer || !ws?.address) {
    throw new Error('Wallet not connected');
  }

  // 2) Correct chain?
  const expected = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  const actual = Number(ws?.chainId);

  if (Number.isFinite(expected) && Number.isFinite(actual) && actual !== expected) {
    throw new Error(`Wrong network: switch to Arbitrum One (chainId ${expected})`);
  }

  return true;
}
