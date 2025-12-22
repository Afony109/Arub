/**
 * wallet.js — Multi-wallet connection layer (EIP-6963 + Injected + WalletConnect) — HARDENED
 *
 * Key fixes:
 *  - Never uses window.ethereum for signing/tx once a provider is selected
 *  - connectWallet(chosen) uses chosen._provider directly (no re-lookup -> no "Trust selects MetaMask" chaos)
 *  - Handles -32002 pending request by waiting for eth_accounts
 *  - Requires explicit selection when >1 wallet is available (EIP-6963 + injected + WalletConnect)
 *
 * Public API:
 *   initWalletModule()
 *   getAvailableWallets()
 *   getAvailableWalletsAsync(waitMs?)
 *   connectWallet(chosen?)              // chosen is an entry returned by getAvailableWallets()
 *   disconnectWallet()
 *   addTokenToWallet('ARUB'|'USDT')
 *   isWalletConnected(), getAddress(), getEthersProvider(), getSigner(), getEip1193Provider()
 *
 * Globals:
 *   window.walletState = { provider, signer, address, eip1193, wallet, chainId }
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
let selectedEip1193 = null;     // EIP-1193 provider object
let ethersProvider = null;      // ethers Web3Provider
let signer = null;
let currentAddress = null;
let currentChainId = null;

let isConnecting = false;

// EIP-6963 registry
const discoveredWallets = new Map(); // rdns -> { rdns, name, icon, provider }

// WalletConnect provider reference (cleanup)
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
  return { type: m.type || null, name: m.name || null, rdns: m.rdns || null, id: m.id || null };
}

function publishGlobals() {
  window.walletState = {
    provider: ethersProvider,
    signer,
    address: currentAddress,
    eip1193: selectedEip1193,
    wallet: getActiveWalletInfo(),
    chainId: currentChainId
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
 * If user double-clicks connect, some wallets return -32002.
 * Then we wait for eth_accounts to become available.
 */
async function requestAccountsSafe() {
  try {
    return await pRequest('eth_requestAccounts');
  } catch (err) {
    if (err?.code === -32002) {
      const maxWaitMs = 5000;
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

  // refresh chainId best-effort
  try {
    const hex = await selectedEip1193.request({ method: 'eth_chainId' });
    currentChainId = hex ? parseInt(hex, 16) : currentChainId;
  } catch (_) {}

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

    // refresh chainId best-effort
    try {
      const hex = await selectedEip1193.request({ method: 'eth_chainId' });
      currentChainId = hex ? parseInt(hex, 16) : currentChainId;
    } catch (_) {
      try {
        const net = await ethersProvider.getNetwork();
        currentChainId = net?.chainId ?? currentChainId;
      } catch (_) {}
    }

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
  if (!provider?.request) throw new Error('Selected provider has no request()');
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

// -----------------------------
// Legacy injected providers (for listing)
// -----------------------------
function getInjectedProviders() {
  const eth = window.ethereum;
  if (!eth) return [];
  if (Array.isArray(eth.providers) && eth.providers.length) return eth.providers;
  return [eth];
}

function detectInjectedLabel(p, idx) {
  const isTrust = !!(p?.isTrust || p?.isTrustWallet);
  const isBybit = !!(p?.isBybitWallet || p?.isBybit || p?.isBybitWeb3);
  const isRabby = !!p?.isRabby;
  const isCoinbase = !!p?.isCoinbaseWallet;
  const isMetaMask = !!p?.isMetaMask;

  if (isTrust) return 'Trust Wallet';
  if (isBybit) return 'Bybit Wallet';
  if (isRabby) return 'Rabby';
  if (isCoinbase) return 'Coinbase Wallet';
  if (isMetaMask) return 'MetaMask';
  return `Injected #${idx + 1}`;
}

function getLegacyInjectedEntries() {
  const providers = getInjectedProviders();
  if (!providers.length) return [];

  return providers.map((p, idx) => ({
    // IMPORTANT: id may be unstable across reloads, but we do NOT re-lookup by id.
    // We pass the provider object to UI and connectWallet uses chosen._provider.
    id: `legacy:${idx}`,
    name: detectInjectedLabel(p, idx),
    icon: null,
    type: 'injected-fallback',
    _provider: p
  }));
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

function countAvailableChoices() {
  const eip = discoveredWallets.size;
  const inj = getLegacyInjectedEntries().length;
  const wc = CONFIG?.WALLETCONNECT_PROJECT_ID ? 1 : 0;
  return { eip, inj, wc, total: eip + inj + wc };
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

  // EIP-6963 wallets (include provider directly)
  for (const w of discoveredWallets.values()) {
    list.push({
      id: w.rdns,
      name: w.name,
      icon: w.icon,
      type: 'eip6963',
      _provider: w.provider
    });
  }

  // Legacy injected wallets (include provider directly)
  for (const w of getLegacyInjectedEntries()) {
    list.push({
      id: w.id,
      name: w.name,
      icon: null,
      type: w.type,
      _provider: w._provider
    });
  }

  // WalletConnect entry (provider created on connect)
  if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
    list.push({ id: 'walletconnect', name: 'WalletConnect', icon: null, type: 'walletconnect' });
  }

  return list;
}

export async function getAvailableWalletsAsync(waitMs = 250) {
  setupEip6963Discovery();
  await new Promise(r => setTimeout(r, waitMs));
  return getAvailableWallets();
}

export async function connectWallet(chosen = null) {
  assertConfig();
  setupEip6963Discovery();

  if (isConnecting) return;
  isConnecting = true;

  try {
    await waitForWalletsIfNeeded(900);

    // 1) Require selection if there is more than one available choice
    const hasChoice = !!(chosen && chosen.type);

    if (!hasChoice) {
      const { total, eip, inj, wc } = countAvailableChoices();

      if (total === 0) throw new Error('NO_WALLETS_FOUND');
      if (total > 1) throw new Error('WALLET_SELECTION_REQUIRED');

      // Exactly one -> autoselect
      if (eip === 1) {
        const only = Array.from(discoveredWallets.values())[0];
        chosen = { type: 'eip6963', id: only.rdns, name: only.name, _provider: only.provider };
      } else if (inj === 1) {
        const only = getLegacyInjectedEntries()[0];
        chosen = { type: 'injected-fallback', id: only.id, name: only.name, _provider: only._provider };
      } else if (wc === 1) {
        chosen = { type: 'walletconnect', id: 'walletconnect', name: 'WalletConnect' };
      } else {
        throw new Error('WALLET_SELECTION_REQUIRED');
      }
    }

    // 2) Select provider strictly by chosen (NO re-lookup by id)
    if (chosen.type === 'eip6963') {
      const p = chosen._provider || discoveredWallets.get(chosen.id)?.provider;
      if (!p?.request) throw new Error('EIP-6963 provider not found');

      setSelectedProvider(p, {
        type: 'eip6963',
        name: chosen.name || discoveredWallets.get(chosen.id)?.name || chosen.id,
        rdns: chosen.id,
        id: chosen.id
      });

      const accounts = await requestAccountsSafe();
      if (!accounts?.[0]) throw new Error('No accounts returned');

      await ensureNetwork();
      currentAddress = ethers.utils.getAddress(accounts[0]);
    }

    else if (chosen.type === 'injected-fallback') {
      const p = chosen._provider;
      if (!p?.request) throw new Error('Injected provider not found');

      setSelectedProvider(p, {
        type: 'injected-fallback',
        name: chosen.name || 'Injected Wallet',
        rdns: null,
        id: chosen.id
      });

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

      setSelectedProvider(wcProvider, {
        type: 'walletconnect',
        name: 'WalletConnect',
        rdns: null,
        id: 'walletconnect'
      });

      let accounts = null;
      try { accounts = await pRequest('eth_accounts'); } catch (_) {}
      if (!accounts?.[0]) accounts = await requestAccountsSafe();
      if (!accounts?.[0]) throw new Error('No accounts returned');

      currentAddress = ethers.utils.getAddress(accounts[0]);
      await ensureNetwork();
    }

    else {
      throw new Error(`Unsupported wallet type: ${chosen.type}`);
    }

    // 3) Finalize chainId + publish globals
    let chainId = null;
    try {
      const hex = await selectedEip1193.request({ method: 'eth_chainId' });
      chainId = hex ? parseInt(hex, 16) : null;
    } catch (_) {
      try {
        const net = await ethersProvider.getNetwork();
        chainId = net?.chainId ?? null;
      } catch (_) {}
    }
    currentChainId = chainId;

    console.log('[WALLET] connected', {
      wallet: getActiveWalletInfo(),
      address: currentAddress,
      chainId: currentChainId,
      providerFlags: {
        isMetaMask: !!selectedEip1193?.isMetaMask,
        isTrust: !!(selectedEip1193?.isTrust || selectedEip1193?.isTrustWallet),
        isBybit: !!(selectedEip1193?.isBybitWallet || selectedEip1193?.isBybit || selectedEip1193?.isBybitWeb3)
      }
    });

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
    currentChainId = null;

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
