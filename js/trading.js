/**
 * trading.js — Event-driven trading UI module (race-free)
 *
 * Key principles:
 * - UI state is driven ONLY by wallet events + initial sync.
 * - render/bind never disables UI based on instantaneous reads.
 * - A small readiness barrier awaits a consistent walletState after events.
 *
 * Assumptions:
 * - ARUB decimals default = 6
 * - USDT decimals default = 6
 * - wallet.js sets window.walletState = { provider, signer, address, chainId, ... }
 * - wallet.js dispatches:
 *    - wallet:connected (CustomEvent detail: { address })
 *    - wallet:disconnected (Event)
 *   Optionally compat:
 *    - walletConnected / walletDisconnected / walletChanged
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification, formatTokenAmount } from './ui.js';
import { ERC20_ABI } from './abis.js';
import { buyWithUsdt } from './presale.js';

console.log('[TRADING] trading.js loaded, build:', Date.now());

// -----------------------------
// Module state
// -----------------------------
let inited = false;
let listenersBound = false;

// Read-only contracts
let tokenRO = null;
let usdtRO = null;

// Read-write contracts
let tokenRW = null;
let usdtRW = null;

// Decimals (fallbacks)
let DECIMALS_ARUB = 6;
let DECIMALS_USDT = 6;

// User connection snapshot used by this module
const user = {
  address: null,
  provider: null,
  signer: null,
  chainId: null
};

// Prevent overlapping apply cycles
let applySeq = 0;

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
  return el('trading') || el('tradingInterface') || null;
}

function getTradingHost() {
  return el('tradingInterface');
}

function setControlsEnabled(enabled) {
  ['buyBtn', 'sellBtn', 'maxBuyBtn', 'maxSellBtn', 'buyAmount', 'sellAmount']
    .forEach((id) => {
      const node = el(id);
      if (!node) return;
      if ('disabled' in node) node.disabled = !enabled;
      node.style.pointerEvents = enabled ? 'auto' : 'none';
      node.style.opacity = enabled ? '' : '0.75';
    });
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
                 style="flex:1; padding:12px; border-radius:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff;">
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

  bindUiOncePerRender();
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

  const controls = root.querySelectorAll('button, input, select, textarea');
  controls.forEach((c) => {
    try { c.disabled = false; } catch (_) {}
    c.removeAttribute('disabled');
    c.removeAttribute('aria-disabled');
    c.classList?.remove('disabled', 'is-disabled', 'btn-disabled', 'opacity-50', 'cursor-not-allowed');
    c.style.pointerEvents = 'auto';
  });

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

  // Sync decimals asynchronously
  (async () => {
    try { if (tokenRO?.decimals) DECIMALS_ARUB = Number(await tokenRO.decimals()); }
    catch (e) { console.warn('[TRADING] tokenRO.decimals() failed, using fallback', e); }

    try { if (usdtRO?.decimals) DECIMALS_USDT = Number(await usdtRO.decimals()); }
    catch (e) { console.warn('[TRADING] usdtRO.decimals() failed, using fallback', e); }

    console.log('[TRADING] decimals synced (RO):', { DECIMALS_ARUB, DECIMALS_USDT });
    try { await refreshBalances(); } catch (_) {}
  })();
}

function initWithSigner() {
  tokenRW = null;
  usdtRW = null;

  if (!user.signer) return;

  tokenRW = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20_ABI, user.signer);
  usdtRW  = new ethers.Contract(CONFIG.USDT_ADDRESS,  ERC20_ABI, user.signer);

  (async () => {
    try { if (tokenRW?.decimals) DECIMALS_ARUB = Number(await tokenRW.decimals()); } catch (_) {}
    try { if (usdtRW?.decimals) DECIMALS_USDT = Number(await usdtRW.decimals()); } catch (_) {}
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
// Amount helpers
// -----------------------------
function parseTokenAmount(value, decimals) {
  const v = String(value ?? '').trim();
  if (!v || v === '.' || v === ',') throw new Error('Enter amount');
  const normalized = v.replace(',', '.');
  return ethers.utils.parseUnits(normalized, Number(decimals));
}

// -----------------------------
// UI bindings (per render; no wallet logic here)
// -----------------------------
function bindUiOncePerRender() {
  // BUY
  const buyBtn = el('buyBtn');
  if (buyBtn) {
    buyBtn.onclick = async () => {
      try {
        const amount = el('buyAmount')?.value ?? '';
        await buyTokens(amount);
      } catch (e) {
        console.error('[UI] buy click error:', e);
        showNotification?.(e?.message || 'Buy failed', 'error');
      }
    };
  }

  // SELL
  const sellBtn = el('sellBtn');
  if (sellBtn) {
    sellBtn.onclick = async () => {
      try {
        const amount = el('sellAmount')?.value ?? '';
        await sellTokens(amount);
      } catch (e) {
        console.error('[UI] sell click error:', e);
        showNotification?.(e?.message || 'Sell failed', 'error');
      }
    };
  }

  // MAX buttons
  const maxBuyBtn = el('maxBuyBtn');
  if (maxBuyBtn) {
    maxBuyBtn.onclick = async () => {
      try { await setMaxBuy(); }
      catch (e) { showNotification?.(e?.message || 'Cannot set max buy', 'error'); }
    };
  }

  const maxSellBtn = el('maxSellBtn');
  if (maxSellBtn) {
    maxSellBtn.onclick = async () => {
      try { await setMaxSell(); }
      catch (e) { showNotification?.(e?.message || 'Cannot set max sell', 'error'); }
    };
  }
}

// -----------------------------
// Wallet readiness barrier (prevents race conditions)
// -----------------------------
async function awaitWalletReady({ requireSigner = true, timeoutMs = 1200, stepMs = 50 } = {}) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const ws = window.walletState;
    const okAddress = !!ws?.address;
    const okSigner = !requireSigner || !!ws?.signer;
    if (okAddress && okSigner) return ws;

    await new Promise((r) => setTimeout(r, stepMs));
  }

  return window.walletState || null;
}

// -----------------------------
// Core event-driven state apply
// -----------------------------
async function applyWalletState(reason = 'unknown') {
  const seq = ++applySeq;

  // Snapshot after (small) readiness wait to avoid “event fired, signer not yet set”
  const ws = await awaitWalletReady({ requireSigner: false });

  // If another apply started, abort this one
  if (seq !== applySeq) return;

  const hasAddress = !!ws?.address;
  const hasSigner = !!ws?.signer;

  if (!hasAddress) {
    // Disconnected
    user.address = null;
    user.provider = null;
    user.signer = null;
    user.chainId = null;

    tokenRW = null;
    usdtRW = null;

    renderLocked();
    return;
  }

  // Connected (address known). For trading we need signer to enable actions.
  user.address = ws.address;
  user.provider = ws.provider || null;
  user.signer = ws.signer || null;
  user.chainId = ws.chainId ?? null;

  // Render UI (always) and then enable/disable based on signer readiness
  renderTradingUI();

  // If signer isn't ready yet, keep controls disabled and wait a bit more
  if (!hasSigner) {
    setControlsEnabled(false);

    const ws2 = await awaitWalletReady({ requireSigner: true });
    if (seq !== applySeq) return;

    if (ws2?.signer) {
      user.signer = ws2.signer;
      user.provider = ws2.provider || user.provider;
      user.chainId = ws2.chainId ?? user.chainId;
    }
  }

  // Now decide final enablement
  const readyForTrading = !!user.signer;
  setControlsEnabled(readyForTrading);

  if (readyForTrading) {
    initWithSigner();
    await refreshBalances();
  }

  console.log('[TRADING] applyWalletState:', {
    reason,
    address: user.address,
    hasSigner: !!user.signer,
    chainId: user.chainId
  });
}

// -----------------------------
// Actions
// -----------------------------
export async function setMaxBuy() {
  if (!user.address || !usdtRO) throw new Error('Wallet not connected');
  const bal = await usdtRO.balanceOf(user.address);
  const v = ethers.utils.formatUnits(bal, DECIMALS_USDT);
  const inp = el('buyAmount');
  if (inp) inp.value = v;
}

export async function setMaxSell() {
  if (!user.address || !tokenRO) throw new Error('Wallet not connected');
  const bal = await tokenRO.balanceOf(user.address);
  const v = ethers.utils.formatUnits(bal, DECIMALS_ARUB);
  const inp = el('sellAmount');
  if (inp) inp.value = v;
}

function parseRpcErrorBody(body) {
  try {
    const j = JSON.parse(body);
    // Geth/Erigon style: { error: { message, code, data } }
    if (j?.error?.message) return j.error.message;
    // Sometimes: { message: ... }
    if (j?.message) return j.message;
  } catch (_) {}
  return null;
}

function explainEthersError(e) {
  const bodyMsg = e?.error?.body ? parseRpcErrorBody(e.error.body) : null;

  return {
    name: e?.name,
    code: e?.code,
    reason: e?.reason,
    message: e?.message,
    shortMessage: e?.shortMessage,
    // nested
    errorMessage: e?.error?.message,
    dataMessage: e?.data?.message,
    bodyMessage: bodyMsg,
    // common MetaMask/user reject
    isUserRejected:
      e?.code === 4001 ||
      e?.code === 'ACTION_REJECTED' ||
      /user rejected|user denied|rejected/i.test(e?.message || e?.error?.message || ''),
  };
}

function pickBestErrorMessage(e) {
  const x = explainEthersError(e);

  if (x.isUserRejected) return 'Transaction rejected in wallet';
  return (
    x.reason ||
    x.shortMessage ||
    x.dataMessage ||
    x.bodyMessage ||
    x.errorMessage ||
    x.message ||
    'Buy failed'
  );
}


export async function buyTokens(usdtAmount) {
  console.log('[TRADING] buyTokens start', {
    walletState: {
      address: window.walletState?.address,
      hasSigner: !!window.walletState?.signer,
      hasProvider: !!window.walletState?.provider,
      chainId: window.walletState?.chainId
    },
    input: usdtAmount
  });

  const ws = window.walletState;

  if (!ws?.signer || !ws?.address) {
    showNotification?.('Connect wallet first', 'error');
    return;
  }

  // network guard (soft; if chainId missing we do not block)
  const expectedChainId = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  if (ws?.chainId && Number(ws.chainId) !== expectedChainId) {
    showNotification?.(`Wrong network. Please switch to chainId ${expectedChainId}`, 'error');
    return;
  }

  const usdtDecimals = Number(DECIMALS_USDT ?? 6);

  let amountBN;
  try {
    amountBN = parseTokenAmount(usdtAmount, usdtDecimals);
  } catch (e) {
    showNotification?.(e?.message || 'Invalid amount', 'error');
    return;
  }

  if (amountBN.isZero?.() === true) {
    showNotification?.('Enter amount greater than 0', 'error');
    return;
  }

  const amountStr = formatTokenAmount(amountBN, usdtDecimals, usdtDecimals);

  // Optional balance check (non-blocking)
  try {
    if (usdtRW?.balanceOf) {
      const balBN = await usdtRW.balanceOf(ws.address);
      if (balBN.lt(amountBN)) {
        const balStr = formatTokenAmount(balBN, usdtDecimals, usdtDecimals);
        showNotification?.(`Insufficient USDT balance. Available: ${balStr}`, 'error');
        return;
      }
    }
  } catch (e) {
    console.error('[TRADING] USDT balance check error (non-blocking):', e);
  }

  try {
    return await buyWithUsdt(amountStr, {
      
    signer: ws.signer,
    provider: ws.provider,
    address: ws.address,
confirmations: 1,
      onStatus: (stage) => {
        console.log('[TRADING] buyWithUsdt status:', stage);
        if (stage === 'approve_submitted') showNotification?.('Approving USDT...', 'success');
        if (stage === 'buy_submitted') showNotification?.('Submitting buy tx...', 'success');
        if (stage === 'buy_confirmed') showNotification?.('Purchase successful', 'success');
      }
    });
 } catch (e) {
  const info = explainEthersError(e);
  console.error('[TRADING] buyWithUsdt error:', info, e);

  showNotification?.(pickBestErrorMessage(e), 'error');
  return;

  }
}

export async function sellTokens(arubAmount) {
  try {
    if (!user.signer) throw new Error('Wallet not connected');

    const raw = String(arubAmount ?? getInputValue('sellAmount'));
    const amountBN = parseTokenAmount(raw, DECIMALS_ARUB); // ARUB = 6 (default)

    // TODO: реальный sell-контракт
    console.log('[TRADING] sellTokens prepared amount:', amountBN.toString());
    throw new Error('SELL flow is not wired: provide your sell contract ABI + method');
  } catch (e) {
    showNotification?.(e?.message || 'Sell failed', 'error');
    throw e;
  }
}

// -----------------------------
// Public init (event-driven)
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

  // Initial render based on current state (no assumptions; apply handles both)
  applyWalletState('init').catch((e) => console.error('[TRADING] applyWalletState(init) error:', e));

  if (!listenersBound) {
    listenersBound = true;

    // Primary events
    window.addEventListener('wallet:connected', () => {
      applyWalletState('wallet:connected').catch((e) => console.error('[TRADING] apply wallet:connected error:', e));
    });

    window.addEventListener('wallet:disconnected', () => {
      // invalidate in-flight apply cycles and render locked immediately
      applySeq++;
      applyWalletState('wallet:disconnected').catch((e) => console.error('[TRADING] apply wallet:disconnected error:', e));
    });

    // Compat events (if wallet.js emits them)
    window.addEventListener('walletConnected', () => {
      applyWalletState('walletConnected').catch((e) => console.error('[TRADING] apply walletConnected error:', e));
    });

    window.addEventListener('walletDisconnected', () => {
      applySeq++;
      applyWalletState('walletDisconnected').catch((e) => console.error('[TRADING] apply walletDisconnected error:', e));
    });

    // Generic “something changed” event: accountsChanged/chainChanged mapped by wallet.js
    window.addEventListener('walletChanged', () => {
      applyWalletState('walletChanged').catch((e) => console.error('[TRADING] apply walletChanged error:', e));
    });
  }

  return true;
}

