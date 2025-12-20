/**
 * trading.js — Trading UI module (fix: locked placeholder replaced by real UI)
 *
 * Assumptions:
 * - ARUB (token) decimals = 6
 * - USDT decimals = 6
 * - CONFIG.TOKEN_ADDRESS and CONFIG.USDT_ADDRESS exist
 * - wallet.js dispatches events:
 *    - wallet:connected (CustomEvent detail: { address })
 *    - wallet:disconnected (Event)
 *
 * This module:
 * - Renders LOCK placeholder when wallet is not connected
 * - Renders Trading UI when wallet is connected
 * - Refreshes balances via read-only provider
 * - Ensures UI is clickable/enabled
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification, formatTokenAmount } from './ui.js';
import { ERC20_ABI } from './abis.js';
import { buyWithUsdt } from './presale.js';


console.log('[TRADING] trading.js loaded, build:', Date.now());

// -----------------------------
// State
// -----------------------------
let inited = false;
let listenersBound = false;

let tokenRO = null;
let usdtRO = null;

let tokenRW = null;
let usdtRW = null;

const user = {
  address: null,
  provider: null,
  signer: null
};

showNotification?.('...', 'success');

let DECIMALS_ARUB = 6; // fallback until read from token
let DECIMALS_USDT = 6;  // fallback until read from USDT

export const PRESALE_ABI = [
  "function buy(uint256 usdtAmount) external",
  "function getTokenAmount(uint256 usdtAmount) view returns (uint256)",
  "function paused() view returns (bool)"
];

// -----------------------------
// DOM helpers
// -----------------------------
function el(id) { return document.getElementById(id); }

function setText(id, v) {
  const e = el(id);
  if (e) e.textContent = v;
}

function setDisabled(id, disabled) {
  const e = el(id);
  if (e) e.disabled = !!disabled;
}

function getInputValue(id) {
  const e = el(id);
  return e ? String(e.value || '').trim() : '';
}

function getTradingRoot() {
  // Your page uses: <section id="trading"> ... <div id="tradingInterface">
  return el('trading') || el('tradingInterface') || null;
}

function getTradingHost() {
  return el('tradingInterface');
}

// -----------------------------
// Render
// -----------------------------
function renderLocked() {
  const host = getTradingHost();
  if (!host) return;

  host.innerHTML = `
    <div style="text-align:center; padding:50px;">
      <div style="font-size:3em; margin-bottom: 10px;">🔒</div>
      <p>Підключіть гаманець для торгівлі</p>
    </div>
  `;
}

function renderTradingUI() {
  const host = getTradingHost();
  if (!host) return;

  host.innerHTML = `
    <div class="trade-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <div class="trade-box" style="padding:16px; border-radius:16px; background: rgba(255,255,255,0.04);">
        <h3 style="margin:0 0 10px 0;">Купівля</h3>

        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
          <input id="buyAmount" type="number" inputmode="decimal" placeholder="USDT amount"
                 style="flex:1; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff;">
          <button id="maxBuyBtn" type="button"
                  style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
            MAX
          </button>
        </div>

        <button id="buyBtn" type="button"
                style="width:100%; padding:12px; border-radius:12px; border:0; cursor:pointer;">
          Buy ARUB
        </button>

        <div style="margin-top:10px; font-size:14px; opacity:0.9;">
          USDT balance: <span id="usdtBalance">—</span>
        </div>
      </div>

      <div class="trade-box" style="padding:16px; border-radius:16px; background: rgba(255,255,255,0.04);">
        <h3 style="margin:0 0 10px 0;">Продаж</h3>

        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
          <input id="sellAmount" type="number" inputmode="decimal" placeholder="ARUB amount"
                 style="flex:1; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff;">
          <button id="maxSellBtn" type="button"
                  style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
            MAX
          </button>
        </div>

        <button id="sellBtn" type="button"
                style="width:100%; padding:12px; border-radius:12px; border:0; cursor:pointer;">
          Sell ARUB
        </button>

        <div style="margin-top:10px; font-size:14px; opacity:0.9;">
          ARUB balance: <span id="arubBalance">—</span>
        </div>
      </div>
    </div>
  `;

  // After re-render, bind handlers again
  bindUi();
  hardUnlock();
}

// -----------------------------
// Hard unlock: remove common UI locks (pointer-events/disabled/overlays)
// -----------------------------
function hardUnlock() {
  const root = getTradingRoot();
  if (!root) return;

  root.style.pointerEvents = 'auto';
  root.style.filter = 'none';
  root.style.opacity = '';

  // Enable all controls within trading section
  const controls = root.querySelectorAll('button, input, select, textarea');
  controls.forEach((c) => {
    try { c.disabled = false; } catch (_) {}
    c.removeAttribute('disabled');
    c.removeAttribute('aria-disabled');
    c.classList?.remove('disabled', 'is-disabled', 'btn-disabled', 'opacity-50', 'cursor-not-allowed');
    c.style.pointerEvents = 'auto';
  });

  // Hide any “lock overlays” inside trading section if present
  const candidates = root.querySelectorAll([
    '#tradingLock',
    '#tradingLocked',
    '#tradeLock',
    '#tradeLocked',
    '#lockedOverlay',
    '#lockOverlay',
    '.lock-overlay',
    '.locked-overlay',
    '.trade-lock',
    '.trading-lock',
    '.is-locked',
    '[data-lock]',
    '[data-locked]'
  ].join(','));

  candidates.forEach((node) => {
    node.style.display = 'none';
    node.style.visibility = 'hidden';
    node.style.pointerEvents = 'none';
  });
}

// -----------------------------
// Contracts init
// -----------------------------
function initReadOnly() {
  const rpc = CONFIG?.NETWORK?.rpcUrls?.[0];
  if (!rpc) throw new Error('CONFIG.NETWORK.rpcUrls[0] missing');

  const roProvider = new ethers.providers.JsonRpcProvider(rpc);

  tokenRO = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, roProvider);
  usdtRO  = new ethers.Contract(CONFIG.USDT_ADDRESS,  ERC20_ABI, roProvider);

  // Sync decimals asynchronously (do not block init)
  (async () => {
    try {
      if (tokenRO?.decimals) DECIMALS_ARUB = await tokenRO.decimals();
    } catch (e) {
      console.warn('[TRADING] tokenRO.decimals() failed, using fallback', e);
    }

    try {
      if (usdtRO?.decimals) DECIMALS_USDT = await usdtRO.decimals();
    } catch (e) {
      console.warn('[TRADING] usdtRO.decimals() failed, using fallback', e);
    }

    console.log('[TRADING] decimals synced (RO):', { DECIMALS_ARUB, DECIMALS_USDT });

    // Optional: refresh UI/balances after decimals are known
    try { refreshBalances?.(); } catch (_) {}
  })();
}

function initWithSigner() {
  tokenRW = null;
  usdtRW = null;

  if (!user.signer) return;

  tokenRW = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, user.signer);
  usdtRW  = new ethers.Contract(CONFIG.USDT_ADDRESS,  ERC20_ABI, user.signer);

  // Optional: keep decimals in sync even if RO failed
  (async () => {
    try {
      if (tokenRW?.decimals) DECIMALS_ARUB = await tokenRW.decimals();
    } catch (_) {}

    try {
      if (usdtRW?.decimals) DECIMALS_USDT = await usdtRW.decimals();
    } catch (_) {}

    console.log('[TRADING] decimals synced (RW):', { DECIMALS_ARUB, DECIMALS_USDT });
  })();
}

// -----------------------------
// Data refresh
// -----------------------------
async function refreshBalances() {
  try {
    if (!user.address || !tokenRO || !usdtRO) return;

    const [arubBal, usdtBal] = await Promise.all([
      tokenRO.balanceOf(user.address),
      usdtRO.balanceOf(user.address)
    ]);

    setText('arubBalance', formatTokenAmount(arubBal, DECIMALS_ARUB, 2));
    setText('usdtBalance', formatTokenAmount(usdtBal, DECIMALS_USDT, 2));
  } catch (e) {
    console.warn('[TRADING] refreshBalances error:', e);
  }
}

// -----------------------------
// UI bindings (must be re-run after renderTradingUI)
// -----------------------------
function bindUi() {
  // Do not use a global "bind once" here because UI is re-rendered.
  // Instead, safely bind by replacing handlers each time.

  const mb = el('maxBuyBtn');
  if (mb) mb.onclick = () => setMaxBuy();

  const ms = el('maxSellBtn');
  if (ms) ms.onclick = () => setMaxSell();

  const bb = el('buyBtn');
  if (bb) bb.onclick = () => buyTokens();

  const sb = el('sellBtn');
  if (sb) sb.onclick = () => sellTokens();

  // Enable buttons by default (they are disabled only in locked mode)
  ['buyBtn', 'sellBtn', 'maxBuyBtn', 'maxSellBtn'].forEach((id) => setDisabled(id, false));
}

// -----------------------------
// Actions
// -----------------------------
  export async function setMaxBuy() {
  try {
    if (!user.address || !usdtRO) throw new Error('Wallet not connected');
    const bal = await usdtRO.balanceOf(user.address);
    const v = ethers.utils.formatUnits(bal, DECIMALS_USDT);
    const inp = el('buyAmount');
    if (inp) inp.value = v;
  } catch (e) {
    showNotification?.(e?.message || 'Cannot set max buy', 'error');
  }
}

 export async function setMaxSell() {
  try {
    if (!user.address || !tokenRO) throw new Error('Wallet not connected');
    const bal = await tokenRO.balanceOf(user.address);
    const v = ethers.utils.formatUnits(bal, DECIMALS_ARUB);
    const inp = el('sellAmount');
    if (inp) inp.value = v;
  } catch (e) {
    showNotification?.(e?.message || 'Cannot set max sell', 'error');
  }
}

 export async function buyTokens(usdtAmount) {
  let amountBN;
  try {
    amountBN = parseTokenAmount(usdtAmount, 6); // USDT = 6
  } catch (e) {
    showNotification?.(e.message || 'Invalid amount', 'error');
    return;
  }

  return await buyWithUsdt(
    formatTokenAmount(amountBN, 6, 6),
    {
      confirmations: 1,
      onStatus: (stage) => {
        if (stage === 'approve_submitted') showNotification?.('Approving USDT...', 'success');
        if (stage === 'buy_submitted') showNotification?.('Submitting buy tx...', 'success');
        if (stage === 'buy_confirmed') showNotification?.('Purchase successful', 'success');
      }
    }
  );
}

 export async function sellTokens() {
  try {
    if (!user.signer) throw new Error('Wallet not connected');

    const raw = getInputValue('sellAmount');
    const amountBN = parseTokenAmount(raw, 6); // ROOP = 6

    // TODO: реальный sell-контракт
    throw new Error('SELL flow is not wired: provide your sell contract ABI + method');
  } catch (e) {
    showNotification?.(e.message || 'Sell failed', 'error');
    throw e;
  }
}

// -----------------------------
// Public init
// -----------------------------
export function initTradingModule() {
  if (inited) return true;
  inited = true;

  console.log('[TRADING] initTradingModule: start');

  try {
    initReadOnly();
  } catch (e) {
    console.error('[TRADING] initReadOnly failed:', e);
  }

  const ws = window.walletState || null;

  if (ws?.address && ws?.signer) {
    user.address = ws.address;
    user.provider = ws.provider || null;
    user.signer = ws.signer || null;

    initWithSigner();
    renderTradingUI();
    refreshBalances();

    console.log('[TRADING] wallet already connected -> UI rendered');
  } else {
    renderLocked();
    console.log('[TRADING] no wallet -> locked UI rendered');
  }

  if (!listenersBound) {
    listenersBound = true;

    window.addEventListener('wallet:connected', (ev) => {
      const addr = ev?.detail?.address || window.walletState?.address || null;

      user.address = addr;
      user.provider = window.walletState?.provider || null;
      user.signer = window.walletState?.signer || null;

      initWithSigner();
      renderTradingUI();
      refreshBalances();

      console.log('[TRADING] wallet connected -> UI rendered/unlocked');
    });

    window.addEventListener('wallet:disconnected', () => {
      user.address = null;
      user.provider = null;
      user.signer = null;

      tokenRW = null;
      usdtRW = null;

      renderLocked();
      console.log('[TRADING] wallet disconnected -> locked UI rendered');
    });
  }
} 
 


