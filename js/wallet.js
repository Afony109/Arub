/**
 * wallet.js — Multi-wallet connection layer (EIP-6963 + WalletConnect) — HARDENED
 * Fixes:
 *  - Prevents double eth_requestAccounts calls (-32002 "already pending")
 *  - If -32002 occurs, waits for eth_accounts to become available
 *  - Single selected provider only (never window.ethereum for signing/tx)
 *
 * Exposes:
 *   initWalletModule()
 *   getAvailableWallets()
 *   connectWallet(options?)
 *   disconnectWallet()
 *   addTokenToWallet('ARUB'|'USDT')
 *   isWalletConnected(), getAddress(), getEthersProvider(), getSigner(), getEip1193Provider()
 *
 * Globals:
 *   window.walletState = { provider, signer, address, eip1193, wallet }
 *   window.provider, window.signer, window.userAddress, window.selectedAddress
 *
 * Events:
 *   wallet:connected (CustomEvent, detail: {address, wallet})
 *   wallet:disconnected (Event)
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification } from './ui.js';

console.log('[WALLET] wallet.js loaded, build:', Date.now());

// -----------------------------
// Internal state (single source of truth)
// -----------------------------
let selectedEip1193 = null;
let ethersProvider = null;
let signer = null;
let currentAddress = null;

// Prevent double connect
let isConnecting = false;

// EIP-6963 registry
const discoveredWallets = new Map(); // rdns -> { rdns, name, icon, provider }

// WalletConnect provider reference (for cleanup)
let wcProvider = null;

// -----------------------------
// Utils
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertConfig() {
  if (!CONFIG?.NETWORK?.chainId) throw new Error('CONFIG.NETWORK.chainId is missing');
  if (!CONFIG?.NETWORK?.chainName) throw new Error('CONFIG.NETWORK.chainName is missing');
  if (!CONFIG?.NETWORK?.rpcUrls?.[0]) throw new Error('CONFIG.NETWORK.rpcUrls[0] is missing');
  if (!CONFIG?.NETWORK?.nativeCurrency) throw new Error('CONFIG.NETWORK.nativeCurrency is missing');
}

function toHexChainId(chainIdDec) {
  return '0x' + Number(chainIdDec).toString(16);
}

function isHexChainIdMatch(chainIdHex, targetChainIdDec) {
  if (!chainIdHex) return false;
  const v = parseInt(chainIdHex, 16);
  return v === Number(targetChainIdDec);
}

function getActiveWalletInfo() {
  const m = selectedEip1193?.__arub_meta || {};
  return { type: m.type || null, name: m.name || null, rdns: m.rdns || null };
}

function publishGlobals() {
  window.walletState = {
    provider: ethersProvider,
    signer,
    address: currentAddress,
    eip1193: selectedEip1193,
    wallet: getActiveWalletInfo()
  };

  window.provider = ethersProvider;
  window.signer = signer;
  window.userAddress = currentAddress;
  window.selectedAddress = currentAddress;
}

function clearGlobals() {
  window.walletState = null;
  window.provider = null;
  window.signer = null;
  window.userAddress = null;
  window.selectedAddress = null;
}

function dispatchConnected() {
  window.dispatchEvent(new CustomEvent('wallet:connected', {
    detail: { address: currentAddress, wallet: getActiveWalletInfo() }
  }));
}

function dispatchDisconnected() {
  window.dispatchEvent(new Event('wallet:disconnected'));
}

// -----------------------------
// Provider request helper (NEVER uses window.ethereum)
// -----------------------------
async function pRequest(method, params = []) {
  if (!selectedEip1193?.request) throw new Error('No selected EIP-1193 provider');
  return await selectedEip1193.request({ method, params });
}

/**
 * If user double-clicks connect, MetaMask returns -32002.
 * In that case we can just wait for eth_accounts to appear.
 */
async function requestAccountsSafe() {
  try {
    return await pRequest('eth_requestAccounts');
  } catch (err) {
    if (err?.code === -32002) {
      // wait for accounts to become available
      const maxWaitMs = 4000;
      const step = 200;
      let waited = 0;

      while (waited < maxWaitMs) {
        await sleep(step);
        waited += step;

        let acc = null;
        try { acc = await pRequest('eth_accounts'); } catch (_) {}
        if (acc?.[0]) return acc;
      }
    }
    throw err;
  }
}

async function ensureNetwork() {
  assertConfig();

  let chainIdHex = null;
  try { chainIdHex = await pRequest('eth_chainId'); } catch (_) {}

  const targetHex = toHexChainId(CONFIG.NETWORK.chainId);

  if (chainIdHex && isHexChainIdMatch(chainIdHex, CONFIG.NETWORK.chainId)) return;

  // try switch
  try {
    await pRequest('wallet_switchEthereumChain', [{ chainId: targetHex }]);
    return;
  } catch (err) {
    // fallthrough to add
    if (err?.code !== 4902) console.warn('[WALLET] switch chain failed:', err);
  }

  // add chain
  await pRequest('wallet_addEthereumChain', [{
    chainId: targetHex,
    chainName: CONFIG.NETWORK.chainName,
    rpcUrls: CONFIG.NETWORK.rpcUrls,
    nativeCurrency: CONFIG.NETWORK.nativeCurrency,
    blockExplorerUrls: CONFIG.NETWORK.blockExplorerUrls || []
  }]);
}

function wireProviderEvents(provider) {
  if (!provider?.on) return;

  try { provider.removeListener?.('accountsChanged', onAccountsChanged); } catch (_) {}
  try { provider.removeListener?.('chainChanged', onChainChanged); } catch (_) {}
  try { provider.removeListener?.('disconnect', onDisconnect); } catch (_) {}

  provider.on('accountsChanged', onAccountsChanged);
  provider.on('chainChanged', onChainChanged);
  provider.on('disconnect', onDisconnect);
}

async function onAccountsChanged(accounts) {
  const a = Array.isArray(accounts) ? accounts[0] : null;
  currentAddress = a ? ethers.utils.getAddress(a) : null;

  if (!currentAddress) {
    await disconnectWallet();
    return;
  }

  ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
  signer = ethersProvider.getSigner();

  publishGlobals();

  if (typeof window.onWalletConnected === 'function') {
    window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
  }
  dispatchConnected();
}

async function onChainChanged() {
  try {
    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();
    currentAddress = ethers.utils.getAddress(await signer.getAddress());

    await ensureNetwork();

    publishGlobals();

    if (typeof window.onWalletConnected === 'function') {
      window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
    }
    dispatchConnected();
  } catch (e) {
    console.warn('[WALLET] chainChanged handling error:', e);
  }
}

async function onDisconnect() {
  await disconnectWallet();
}

function setSelectedProvider(provider, meta = {}) {
  selectedEip1193 = provider;
  selectedEip1193.__arub_meta = meta;

  ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
  signer = ethersProvider.getSigner();

  wireProviderEvents(selectedEip1193);
}

// -----------------------------
// EIP-6963 discovery
// -----------------------------
let _discoveryReady = false;

function setupEip6963Discovery() {
  if (_discoveryReady) return;
  _discoveryReady = true;

  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event?.detail;
    if (!detail?.info?.rdns || !detail?.provider) return;

    const rdns = detail.info.rdns;
    discoveredWallets.set(rdns, {
      rdns,
      name: detail.info.name || rdns,
      icon: detail.info.icon || null,
      provider: detail.provider
    });
  });

  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/**
 * Legacy injected fallback (ONLY for listing/selection)
 */
function getLegacyInjectedEntries() {
  const eth = window.ethereum;
  if (!eth) return [];

  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.map((p, idx) => {
      const name =
        p.isMetaMask ? 'MetaMask' :
        p.isTrust ? 'Trust Wallet' :
        p.isRabby ? 'Rabby' :
        `Injected #${idx + 1}`;
      return { id: `legacy:${idx}`, name, icon: null, type: 'injected-fallback', _provider: p };
    });
  }

  const name =
    eth.isMetaMask ? 'MetaMask' :
    eth.isTrust ? 'Trust Wallet' :
    eth.isRabby ? 'Rabby' :
    'Injected Wallet';
  return [{ id: 'legacy:single', name, icon: null, type: 'injected-fallback', _provider: eth }];
}

async function waitForWalletsIfNeeded(maxWaitMs = 1200) {
  if (discoveredWallets.size > 0 || getLegacyInjectedEntries().length > 0) return;

  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

  const step = 150;
  let waited = 0;
  while (waited < maxWaitMs) {
    await sleep(step);
    waited += step;
    if (discoveredWallets.size > 0 || getLegacyInjectedEntries().length > 0) return;
  }
}

// -----------------------------
// Public API
// -----------------------------
export function initWalletModule() {
  setupEip6963Discovery();
  console.log('[WALLET] initWalletModule: discovery enabled');
}

export function getAvailableWallets() {
  const list = [];

  for (const w of discoveredWallets.values()) {
    list.push({ id: w.rdns, name: w.name, icon: w.icon, type: 'eip6963' });
  }

  for (const w of getLegacyInjectedEntries()) {
    list.push({ id: w.id, name: w.name, icon: null, type: w.type });
  }

  if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
    list.push({ id: 'walletconnect', name: 'WalletConnect', icon: null, type: 'walletconnect' });
  }

  return list;
}

export async function connectWallet(options = {}) {
  const { walletId = null, autoSelect = true } = options;

  if (isConnecting) {
    // If already connected — just return address; if in-flight — avoid second requestAccounts
    if (currentAddress) return currentAddress;
    throw new Error('Wallet connection is already in progress. Please wait.');
  }

  isConnecting = true;

  try {
    assertConfig();

    // If already connected, reuse
    if (currentAddress && selectedEip1193) {
      publishGlobals();
      dispatchConnected();
      return currentAddress;
    }

    await waitForWalletsIfNeeded(1200);

    const wallets = getAvailableWallets();
    if (!wallets.length) throw new Error('No wallets found (no injected wallets and WalletConnect not configured)');

    let chosen = null;

    if (walletId) {
      chosen = wallets.find(w => w.id === walletId) || null;
    } else if (autoSelect) {
      const injected = wallets.filter(w => w.type !== 'walletconnect');
      if (injected.length === 1) chosen = injected[0];
    }

    if (!chosen) {
      const lines = wallets.map((w, i) => `${i + 1}) ${w.name} [${w.type}]`).join('\n');
      const pick = window.prompt(`Select wallet:\n${lines}\n\nEnter number:`);
      const idx = Number(pick) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= wallets.length) throw new Error('Wallet selection cancelled');
      chosen = wallets[idx];
    }

    if (chosen.type === 'eip6963') {
      const w = discoveredWallets.get(chosen.id);
      if (!w?.provider) throw new Error('Selected wallet provider not available');

      setSelectedProvider(w.provider, { type: 'eip6963', name: chosen.name, rdns: chosen.id });

      const accounts = await requestAccountsSafe();
      if (!accounts?.[0]) throw new Error('No accounts returned');

      await ensureNetwork();
      currentAddress = ethers.utils.getAddress(accounts[0]);
    }

    else if (chosen.type === 'injected-fallback') {
      const legacy = getLegacyInjectedEntries();
      const entry = legacy.find(x => x.id === chosen.id);
      if (!entry?._provider) throw new Error('Injected provider not found');

      setSelectedProvider(entry._provider, { type: 'injected-fallback', name: chosen.name, rdns: null });

      const accounts = await requestAccountsSafe();
      if (!accounts?.[0]) throw new Error('No accounts returned');

      await ensureNetwork();
      currentAddress = ethers.utils.getAddress(accounts[0]);
    }

    else if (chosen.type === 'walletconnect') {
      if (!CONFIG.WALLETCONNECT_PROJECT_ID) throw new Error('CONFIG.WALLETCONNECT_PROJECT_ID is missing for WalletConnect');

      const { default: EthereumProvider } = await import(
        'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js'
      );

      wcProvider = await EthereumProvider.init({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        chains: [Number(CONFIG.NETWORK.chainId)],
        optionalChains: CONFIG?.WALLETCONNECT_OPTIONAL_CHAINS || [],
        showQrModal: true,
        rpcMap: { [Number(CONFIG.NETWORK.chainId)]: CONFIG.NETWORK.rpcUrls[0] },
        metadata: CONFIG?.WALLETCONNECT_METADATA || undefined
      });

      await wcProvider.connect();

      setSelectedProvider(wcProvider, { type: 'walletconnect', name: 'WalletConnect', rdns: null });

      // WC often has eth_accounts immediately
      let accounts = null;
      try { accounts = await pRequest('eth_accounts'); } catch (_) {}
      if (!accounts?.[0]) accounts = await requestAccountsSafe();
      if (!accounts?.[0]) throw new Error('No accounts returned');

      currentAddress = ethers.utils.getAddress(accounts[0]);
      await ensureNetwork();
    }
      const provider = new ethers.providers.Web3Provider(eip1193Provider);
const signer = provider.getSigner();
const address = await signer.getAddress();

// ОБЯЗАТЕЛЬНО получаем сеть
const network = await provider.getNetwork();

window.walletState = {
  address,
  signer,
  provider,
  chainId: network.chainId
};

console.log('[WALLET] connected', {
  address,
  chainId: network.chainId
});

    else {
      throw new Error(`Unsupported wallet type: ${chosen.type}`);
    }

    ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
    signer = ethersProvider.getSigner();

    publishGlobals();

    showNotification?.(`Wallet connected: ${currentAddress}`, 'success');

    if (typeof window.onWalletConnected === 'function') {
      window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
    }
    dispatchConnected();

    return currentAddress;
  } catch (err) {
    console.error('[WALLET] connectWallet error:', err);
    showNotification?.(err?.message || 'Wallet connect failed', 'error');
    throw err;
  } finally {
    isConnecting = false;
  }
}

export async function disconnectWallet() {
  try {
    if (wcProvider) {
      try { await wcProvider.disconnect?.(); } catch (_) {}
      wcProvider = null;
    }

    try { selectedEip1193?.disconnect?.(); } catch (_) {}

    selectedEip1193 = null;
    ethersProvider = null;
    signer = null;
    currentAddress = null;

    clearGlobals();

    showNotification?.('Wallet disconnected', 'info');
    if (typeof window.onWalletDisconnected === 'function') window.onWalletDisconnected();
    dispatchDisconnected();
  } catch (err) {
    console.warn('[WALLET] disconnectWallet error:', err);
  } finally {
    isConnecting = false;
  }
}

export function isWalletConnected() { return !!currentAddress && !!selectedEip1193; }
export function getAddress() { return currentAddress; }
export function getEthersProvider() { return ethersProvider; }
export function getSigner() { return signer; }
export function getEip1193Provider() { return selectedEip1193; }

export async function addTokenToWallet(symbol) {
  try {
    if (!selectedEip1193) throw new Error('Wallet not connected');

    const token =
      symbol === 'ARUB' ? CONFIG?.ARUB_TOKEN :
      symbol === 'USDT' ? CONFIG?.USDT_TOKEN :
      null;

    if (!token?.address || !token?.symbol || token?.decimals == null) {
      throw new Error(`Token config missing for ${symbol}. Expected CONFIG.ARUB_TOKEN / CONFIG.USDT_TOKEN`);
    }

    const ok = await pRequest('wallet_watchAsset', [{
      type: 'ERC20',
      options: {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        image: token.image || undefined
      }
    }]);

    if (ok) showNotification?.(`${token.symbol} added to wallet`, 'success');
    else showNotification?.(`${token.symbol} was not added`, 'info');

    return ok;
  } catch (err) {
    console.error('[WALLET] addTokenToWallet error:', err);
    showNotification?.(err?.message || 'Add token failed', 'error');
    throw err;
  }
}
