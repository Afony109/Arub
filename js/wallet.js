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

export function getAvailableWallets() {
  const list = [...discoveredWallets.values()];
  list.push(...getLegacyInjectedEntries());

  if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
    list.push({
      id: 'walletconnect',
      name: 'WalletConnect',
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
    const entry = walletId ? wallets.find(w => w.id === walletId) : null;
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
      if (!entry.provider) throw new Error('Selected wallet provider not found');
      selectedEip1193 = entry.provider;
      await pRequest('eth_requestAccounts');
    }

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

export function connectWalletUI(walletId = null) {
  return connectWallet(walletId ? { walletId } : {});
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

