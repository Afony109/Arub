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
import { showNotification, formatTokenAmount } from './ui.js';
import { ERC20_ABI, ERC20_ABI_MIN } from './abis.js';
import {
  initReadOnlyContracts,
  getReadOnlyProviderAsync,
  getReadOnlyPresale,
} from './contracts.js';
import { CONFIG } from './config.js';
import { requireArbitrumOrThrow, trySwitchToArbitrum } from './wallet.js';
import { getStoredLang } from './i18n.js';

console.log('[TRADING] trading.js loaded, build:', Date.now());

// -----------------------------
// Addresses (presale + token proxies)
// -----------------------------
// Keep defaults here as a safety net; prefer setting these in config.js.
const PRESALE_ADDRESS =
  CONFIG?.PRESALE_ADDRESS || '0x986833160f8E9636A6383BfAb5BeF35739edA1eC';
const ARUB_TOKEN_ADDRESS =
  CONFIG?.ARUB_TOKEN_ADDRESS ||
  CONFIG?.TOKEN_ADDRESS ||
  '0x161296CD7F742220f727e1B4Ccc02cAEc71Ed2C6';
const USDT_ADDRESS =
  CONFIG?.USDT_ADDRESS || '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const VAULT_ADDRESS = CONFIG?.VAULT_ADDRESS || '';
const LP_TARGET_USDT = Number(CONFIG?.LP_TARGET_USDT ?? 50000);
const MIN_LP_ARUB = '0.15';
const MIN_LP_USDT = '10';
const MIN_SELL_ARUB = '0.15';

const I18N = {
  ru: {
    connect_liquidity: 'Подключите кошелек, чтобы добавить ликвидность.',
    connect_trade: 'Подключите кошелек для торговли.',
    switch_liquidity: 'Переключите сеть на Arbitrum One, чтобы добавить ликвидность.',
    need_network: 'Нужна сеть Arbitrum One',
    current_chain: 'Сейчас: chainId',
    switch_to_arb: 'Переключить на Arbitrum One',
    switch_hint: 'Если кошелек не позволяет автопереключение — переключитесь вручную в кошельке.',
    buy_title: 'Покупка',
    buy_instant: 'Купить ARUB (мгновенно)',
    buy_bonus: 'Купить ARUB (с бонусом, депозит блокируется)',
    bonus_now: 'Бонус сейчас:',
    bonus_slots: 'Осталось мест:',
    limits_prefix: 'Лимиты: минимум',
    limits_per_tx: 'USDT за покупку',
    limits_per_wallet: 'USDT на кошелек',
    amount_usdt: 'Сумма USDT',
    max_btn: 'МАКС',
    buy_btn: 'Купить ARUB',
    balance_usdt: 'Баланс USDT:',
    lock_status: 'Статус блокировки',
    locked_principal: 'Заблокированный основной:',
    locked_bonus: 'Заблокированный бонус:',
    unlock_date: 'Дата разблокировки:',
    remaining: 'Осталось:',
    unlock_btn: 'Разблокировать',
    sell_title: 'Продажа',
    amount_arub: 'Сумма ARUB',
    sell_btn: 'Продать ARUB',
    sell_fee: 'Комиссия при продаже:',
    fee_active_until: 'действует до',
    fee_remaining: 'осталось',
    fee_after: 'После этого —',
    fee_from: 'с',
    fee_then: 'далее —',
    bonus_lock_active: 'Активный лок бонусной покупки:',
    sell_free_allowed: 'Продажа свободных ARUB:',
    allowed: 'разрешено',
    balance_arub: 'Баланс ARUB:',
    presale_loading: 'Ожидается загрузка данных:',
    presale_purchased: 'Куплено на пресейле:',
    presale_bonus: 'В том числе бонусом:',
    presale_paid: 'Оплачено:',
    presale_avg_price: 'Средняя цена покупки:',
    presale_avg_bonus: 'Средний бонус:',
    presale_scan: 'Сканируем историю покупок…',
    lock_warning: 'Внимание: у вас активный лок. Если контракт блокирует redeem во время лока — транзакция может быть отклонена.',
  },
  en: {
    connect_liquidity: 'Connect a wallet to add liquidity.',
    connect_trade: 'Connect a wallet to trade.',
    switch_liquidity: 'Switch to Arbitrum One to add liquidity.',
    need_network: 'Arbitrum One network required',
    current_chain: 'Current: chainId',
    switch_to_arb: 'Switch to Arbitrum One',
    switch_hint: 'If your wallet does not allow auto-switching, switch manually in your wallet.',
    buy_title: 'Buy',
    buy_instant: 'Buy ARUB (instant)',
    buy_bonus: 'Buy ARUB (with bonus, deposit locked)',
    bonus_now: 'Bonus now:',
    bonus_slots: 'Slots left:',
    limits_prefix: 'Limits: minimum',
    limits_per_tx: 'USDT per purchase',
    limits_per_wallet: 'USDT per wallet',
    amount_usdt: 'USDT amount',
    max_btn: 'MAX',
    buy_btn: 'Buy ARUB',
    balance_usdt: 'USDT balance:',
    lock_status: 'Lock status',
    locked_principal: 'Locked principal:',
    locked_bonus: 'Locked bonus:',
    unlock_date: 'Unlock date:',
    remaining: 'Remaining:',
    unlock_btn: 'Unlock',
    sell_title: 'Sell',
    amount_arub: 'ARUB amount',
    sell_btn: 'Sell ARUB',
    sell_fee: 'Sell fee:',
    fee_active_until: 'active until',
    fee_remaining: 'remaining',
    fee_after: 'After that —',
    fee_from: 'from',
    fee_then: 'then —',
    bonus_lock_active: 'Bonus purchase lock active:',
    sell_free_allowed: 'Selling free ARUB:',
    allowed: 'allowed',
    balance_arub: 'ARUB balance:',
    presale_loading: 'Loading data:',
    presale_purchased: 'Purchased in presale:',
    presale_bonus: 'Including bonus:',
    presale_paid: 'Paid:',
    presale_avg_price: 'Average buy price:',
    presale_avg_bonus: 'Average bonus:',
    presale_scan: 'Scanning purchase history…',
    lock_warning: 'Warning: you have an active lock. If the contract blocks redeem during lock, the transaction may be rejected.',
  },
};

function t(key) {
  const lang = getUiLang();
  return (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
}

const TERMS_NOTICE = {
  ru: 'Нажимая кнопку, вы подтверждаете, что ознакомились и согласны с условиями и правилами смарт-контракта.',
  en: 'By clicking the button, you confirm that you have read and agree to the smart contract terms and rules.',
};

const btn = document.getElementById('switchToArbBtn');
if (btn) {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const ok = await trySwitchToArbitrum();
      if (!ok) {
        console.warn('[TRADING] trySwitchToArbitrum returned false');
      } else {
        // после переключения перерисуем торговлю
        try { renderTrading(); } catch (_) {}
      }
    } catch (e) {
      console.warn('[TRADING] trySwitchToArbitrum failed:', e?.message || e);
    } finally {
      btn.disabled = false;
    }
  };
}

// -----------------------------
// Module state
// -----------------------------
let inited = false;
let listenersBound = false;
let lastVaultTotalsTs = 0;
const VAULT_REFRESH_MIN_MS = 8000;

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
  chainId: null,
};

// Cached redeemable balance (for consistent UI/max sell)
let redeemableCached = null;
let redeemableFor = null;
let sellFreeAllowedCached = null;
let sellFreeAllowedFor = null;

const PRESALE_ABI_MIN = [
  'function buyWithUSDT(uint256 amount, bool withBonus) external',
  'function unlockDeposit() external',
  'function redeemForUSDT(uint256 arubAmount) external',
  'function claimDebt() external',
  'function redeemableBalance(address) view returns (uint256)',
  'function getMyLockedInfo() view returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)',
  'function lockedPrincipalArub(address) view returns (uint256)',
  'function lockedBonusArub(address) view returns (uint256)',
  'function lockedDepositUntil(address) view returns (uint256)',
  'function getRemainingLockTime(address user) view returns (uint256)',
  'function getDiscountPercent() view returns (uint256)',
  'function totalDiscountBuyers() view returns (uint256)',
  'function DISCOUNT_MAX_BUYERS() view returns (uint256)',
  'function isDiscountBuyer(address) view returns (bool)',
  'function getMySellFeeBps() view returns (uint256)',
  'function getUserSellFeeBps(address user) view returns (uint256)',
  'function getCurrentSellFeeBps(address user) view returns (uint256)',
  'function getNextFeeDropETA(address user) view returns (uint256 secondsToNext, uint256 nextFeeBps)',
  'function debtUsdtEquivalent(address) view returns (uint256)',
];

// -----------------------------
// Presale signer contract cache
// -----------------------------
let presaleSignerCached = null;
let presaleSignerFor = null;

function getPresaleAsSigner() {
  if (!user.signer) return null;

  if (presaleSignerCached && presaleSignerFor === user.signer) {
    return presaleSignerCached;
  }

  presaleSignerFor = user.signer;
  presaleSignerCached = new ethers.Contract(
    PRESALE_ADDRESS,
    PRESALE_ABI_MIN,
    user.signer
  );

  return presaleSignerCached;
}

// -----------------------------
// Presale read-only simulator (callStatic) via unified provider
// -----------------------------

let presaleSim = null;
let presaleSimChainId = null;

async function getPresaleSim() {
  const expectedChainId = Number(CONFIG?.NETWORK?.chainId ?? 42161);

  // Ensure contracts.js selected RPC once
  await initReadOnlyContracts();

  const roProvider = await getReadOnlyProviderAsync();

  // 1) Проверяем сеть read-only провайдера (обязательно)
  let net;
  try {
    net = await roProvider.getNetwork();
  } catch (e) {
    throw new Error('Read-only RPC is not reachable (getNetwork failed)');
  }

  const roChainId = Number(net?.chainId ?? 0);
  if (roChainId !== expectedChainId) {
    throw new Error(
      `Read-only RPC is on wrong network. Expected ${expectedChainId}, got ${roChainId}`
    );
  }

  // 2) Кэш только если сеть совпадает и не менялась
  if (presaleSim && presaleSimChainId === roChainId) return presaleSim;

  presaleSim = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, roProvider);
  presaleSimChainId = roChainId;

  return presaleSim;
}

export function resetPresaleSimCache() {
  presaleSim = null;
  presaleSimChainId = null;
}

async function ensureAllowance(amount) {
  requireArbitrumOrThrow();

  const signer = window.walletState.signer;
  const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, signer);

  const allowance = await usdt.allowance(window.walletState.address, PRESALE_ADDRESS);
  if (allowance.lt(amount)) {
    await usdt.approve(PRESALE_ADDRESS, amount);
  }
}

function renderTrading() {
  const host = getTradingHost?.() || document.getElementById('tradingInterface');
  if (!host) return;

  const ws = window.walletState || null;
  const address = ws?.address || null;
  const signer  = ws?.signer || null;
  const chainId = Number(ws?.chainId);

  const connected  = !!address && !!signer;
  const onArbitrum = chainId === 42161;

  console.log('[TRADING] renderTrading', { address, hasSigner: !!signer, chainId, connected, onArbitrum });

  // 1) not connected
  if (!connected) {
    const lpHost = getLiquidityHost();
    if (lpHost) {
      lpHost.innerHTML = `
        <div style="text-align:center; padding:40px;">
          <div style="font-size:2.2em; margin-bottom:10px;">💧</div>
          <p>${t('connect_liquidity')}</p>
        </div>
      `;
    }
    host.innerHTML = `
      <div style="text-align:center; padding:50px;">
        <div style="font-size:3em; margin-bottom:10px;">🔒</div>
        <p>${t('connect_trade')}</p>
      </div>
    `;
    return;
  }

// 2) wrong network
  if (!onArbitrum) {
    const lpHost = getLiquidityHost();
    if (lpHost) {
      lpHost.innerHTML = `
        <div style="text-align:center; padding:40px;">
          <div style="font-size:2.2em; margin-bottom:10px;">⚠️</div>
          <p>${t('switch_liquidity').replace('Arbitrum One', '<b>Arbitrum One</b>')}</p>
        </div>
      `;
    }
    host.innerHTML = `
      <div style="text-align:center; padding:50px;">
        <div style="font-size:3em; margin-bottom:10px;">⛔</div>
        <p style="margin:0 0 12px 0;">${t('need_network').replace('Arbitrum One', '<b>Arbitrum One</b>')}</p>
        <div style="font-size:13px; opacity:.8; margin-bottom:14px;">
          ${t('current_chain')} <b>${Number.isFinite(chainId) ? chainId : '?'}</b>
        </div>
        <button id="switchToArbBtn" type="button"
          style="padding:10px 14px; border-radius:12px; border:0; cursor:pointer;">
          ${t('switch_to_arb')}
        </button>
        <div style="margin-top:12px; font-size:13px; opacity:.8;">
          ${t('switch_hint')}
        </div>
      </div>
    `;

    const btn = document.getElementById('switchToArbBtn');
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const ok = await window.trySwitchToArbitrum?.();
          if (!ok) {
            // trySwitchToArbitrum already notifies; this is just a fallback
            console.warn('[TRADING] switchToArbitrum returned false');
          }
        } catch (e) {
          console.warn('[TRADING] switchToArbitrum failed:', e?.message || e);
        } finally {
          btn.disabled = false;
        }
      };
    }
    return;
  }

// 3) ok network => draw real trading UI
  renderTradingUI();
}

// -----------------------------
// Wallet change handler (single, idempotent)
// -----------------------------

function _onWalletChanged() {
  try { renderTrading(); } catch (e) { console.warn(e); }
}

export function initTradingModule() {
  if (_tradingBound) {
    // просто перерендер, без повторных addEventListener
    try { renderTrading(); } catch (e) {
      console.warn('[TRADING] renderTrading failed (repeat init):', e?.message || e);
    }
    return;
  }
  _tradingBound = true;

  // Read-only RPC/contracts for balances and limits
  try { initReadOnly(); } catch (e) {
    console.warn('[TRADING] initReadOnly failed:', e?.message || e);
  }

  // Keep UI/state in sync with wallet lifecycle
  const safeApply = (reason) => () => {
    try { applyWalletState(reason); } catch (err) {
      console.warn('[TRADING] applyWalletState failed:', err?.message || err);
    }
  };

  window.addEventListener('walletStateChanged', safeApply('walletStateChanged'));
  window.addEventListener('wallet:connected', safeApply('wallet:connected'));
  window.addEventListener('wallet:disconnected', safeApply('wallet:disconnected'));
  document.addEventListener('DOMContentLoaded', safeApply('DOMContentLoaded'));

  // Initial state sync (balances + stats)
  try { applyWalletState('init'); } catch (e) {
    console.warn('[TRADING] applyWalletState init failed:', e?.message || e);
  }

  // bind handlers (если есть) — не критично
  try { bindTradingHandlers?.(); } catch (e) {
    console.warn('[TRADING] bindTradingHandlers failed:', e?.message || e);
  }

  // initial render
  try { renderTrading(); } catch (e) {
    console.warn('[TRADING] initial renderTrading failed:', e?.message || e);
  }

  if (!window.__buyModeBound) {
  window.__buyModeBound = true;

  document.addEventListener('change', (e) => {
    if (e.target?.name === 'buyMode') {
      try { refreshBuyBonusBox(); } catch (_) {}
    }
  });
}
}

function bindTradingHandlers() {}

// -----------------------------
// Utils
// -----------------------------
function getUiLang() {
  try {
    return getStoredLang();
  } catch (_) {}
  const l = String(navigator.language || '').toLowerCase();
  return l.startsWith('en') ? 'en' : 'ru';
}

function pickEthersMessage(e) {
  return (
    e?.reason ||
    e?.data?.message ||
    e?.error?.message ||
    e?.message ||
    'Transaction failed'
  );
}

// -----------------------------
// DOM helpers
// -----------------------------
function el(id) {
  return document.getElementById(id);
}

function setText(id, v) {
  const e = el(id);
  if (e) e.textContent = v;
}

function formatIntWithSpaces(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function setDisabled(id, disabled) {
  const e = el(id);
  if (e) e.disabled = !!disabled;
}

function getTradingRoot() {
  return el('trading') || el('tradingInterface') || null;
}

function getTradingHost() {
  return el('tradingInterface');
}

function getLiquidityHost() {
  return el('liquidityInterface');
}

function setControlsEnabled(enabled) {
  [
    'buyBtn',
    'sellBtn',
    'maxBuyBtn',
    'maxSellBtn',
    'buyAmount',
    'sellAmount',
    'lpAddArubBtn',
    'lpAddUsdtBtn',
    'lpArubAmount',
    'lpUsdtAmount',
    'lpMaxArubBtn',
    'lpMaxUsdtBtn',
    'lpSlippage',
    'lpDeadline',
  ].forEach((id) => {
    const node = el(id);
    if (!node) return;
    if ('disabled' in node) node.disabled = !enabled;
    node.style.pointerEvents = enabled ? 'auto' : 'none';
    node.style.opacity = enabled ? '' : '0.75';
  });
}

async function refreshUiAfterRpcError({
  includeSellFee = true,
  includeLockPanel = true,
} = {}) {
  try { await refreshBalances?.(); } catch (_) {}
  if (includeLockPanel) {
    try { await refreshLockPanel?.(); } catch (_) {}
  }
  if (includeSellFee) {
    try { await refreshSellFee?.(); } catch (_) {}
  }
}

// -----------------------------
// Buy mode + lock UI helpers
// -----------------------------
function getBuyMode() {
  const v = document.querySelector('input[name="buyMode"]:checked')?.value;
  return v === 'discount' ? 'discount' : 'instant';
}

function formatJerusalemDate(unixSeconds) {
  const n = Number(unixSeconds || 0);
  if (!n) return '—';
  const d = new Date(n * 1000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function formatRemaining(sec) {
  sec = Math.max(0, Number(sec || 0));
  const d = Math.floor(sec / 86400);
  sec -= d * 86400;
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  return `${d ? d + ' д ' : ''}${h ? h + ' год ' : ''}${m} хв`;
}

let lockRefreshTimer = null;
let sellFeeCountdownTimer = null;
let sellFeeDropTs = null;

function startLockAutoRefresh() {
  if (lockRefreshTimer) clearInterval(lockRefreshTimer);
  lockRefreshTimer = setInterval(() => {
    refreshLockPanel().catch(() => {});
  }, 30_000);
}

function stopLockAutoRefresh() {
  if (lockRefreshTimer) clearInterval(lockRefreshTimer);
  lockRefreshTimer = null;
}

function stopSellFeeTimer() {
  if (sellFeeCountdownTimer) clearInterval(sellFeeCountdownTimer);
  sellFeeCountdownTimer = null;
}

// -----------------------------
// Render
// -----------------------------
function renderLocked() {
  const host = getTradingHost();
  const lpHost = getLiquidityHost();
  if (lpHost) {
    lpHost.innerHTML = `
      <div style="text-align:center; padding:40px;">
        <div style="font-size:2.2em; margin-bottom:10px;">💧</div>
        <p>Підключіть гаманець, щоб надіслати токени у Vault.</p>
      </div>
    `;
  }
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

      const liquidityHtml = `
    <div id="lpCard" class="trade-box" style="padding:16px; border-radius:16px; background: rgba(255,255,255,0.04);">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <h3 style=\"margin:0;\">\u041f\u0443\u043b \u043b\u0456\u043a\u0432\u0456\u0434\u043d\u043e\u0441\u0442\u0456 (Vault)</h3>
        <div style="font-size:12px; opacity:0.7;">Vault - ARUB / USDT</div>
      </div>

      <div style="margin-top:6px; font-size:12px; opacity:0.75;">
        \u0417\u0431\u0456\u0440 \u043a\u043e\u0448\u0442\u0456\u0432 \u0434\u043e \u0437\u0430\u043f\u0443\u0441\u043a\u0443 DEX.
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
        <div>
          <div style=\"font-size:13px; opacity:0.8; margin-bottom:6px;\">\u0421\u0443\u043c\u0430 ARUB</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="lpArubAmount" type="number" inputmode="decimal" placeholder="0.0"
                   style="flex:1; padding:12px; border-radius:12px;
                          border:1px solid rgba(255,255,255,0.12);
                          background: rgba(0,0,0,0.25); color:#fff;">
            <button id="lpMaxArubBtn" type="button"
                    style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12);
                           background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
              \u041c\u0410\u041a\u0421
            </button>
          </div>
        </div>

        <div>
          <div style=\"font-size:13px; opacity:0.8; margin-bottom:6px;\">\u0421\u0443\u043c\u0430 USDT</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="lpUsdtAmount" type="number" inputmode="decimal" placeholder="0.0"
                   style="flex:1; padding:12px; border-radius:12px;
                          border:1px solid rgba(255,255,255,0.12);
                          background: rgba(0,0,0,0.25); color:#fff;">
            <button id="lpMaxUsdtBtn" type="button"
                    style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12);
                           background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
              \u041c\u0410\u041a\u0421
            </button>
          </div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px;">
        <div style=\"font-size:13px; opacity:0.85;\">\u041d\u0430\u043a\u043e\u043f\u0438\u0447\u0435\u043d\u043e ARUB: <span id=\"lpVaultArubTotal\">-</span></div>
        <div style=\"font-size:13px; opacity:0.85;\">\u041d\u0430\u043a\u043e\u043f\u0438\u0447\u0435\u043d\u043e USDT: <span id=\"lpVaultUsdtTotal\">-</span></div>
      </div>

      <div style="margin-top:6px; font-size:12px; opacity:0.75;">
        \u041f\u043e\u0440\u0456\u0433 \u0437\u0430\u043f\u0443\u0441\u043a\u0443 DEX: <span id=\"lpVaultTargetUsdt\">50 000 USDT</span>
        (<span id="lpVaultUsdtProgress">0%</span>)
      </div>
      <div style="margin-top:6px; height:6px; background: rgba(255,255,255,0.12); border-radius:999px; overflow:hidden;">
        <div id="lpVaultProgressBar" style="height:100%; width:0%; background: rgba(96,165,250,0.85);"></div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
        <button id="lpAddArubBtn" type="button"
                style="width:66%; padding:12px; border-radius:12px; border:0; cursor:pointer; margin:0 auto; display:block;">
          \u041d\u0430\u0434\u0456\u0441\u043b\u0430\u0442\u0438 \u0443 Vault (ARUB)
        </button>
        <button id="lpAddUsdtBtn" type="button"
                style="width:66%; padding:12px; border-radius:12px; border:0; cursor:pointer; margin:0 auto; display:block;">
          \u041d\u0430\u0434\u0456\u0441\u043b\u0430\u0442\u0438 \u0443 Vault (USDT)
        </button>
      </div>

      <div style="margin-top:8px; font-size:12px; opacity:0.75;">
        \u041c\u0456\u043d. \u0432\u043d\u0435\u0441\u043e\u043a: 0.15 ARUB / 10 USDT.
      </div>
      <div style="margin-top:6px; font-size:12px; opacity:0.75;">
        ARUB \u0431\u0443\u0434\u0435 \u0434\u043e\u0434\u0430\u043d\u043e \u043f\u0440\u0438 \u0437\u0430\u043f\u0443\u0441\u043a\u0443 DEX \u0437\u0430 \u043a\u0443\u0440\u0441\u043e\u043c \u043e\u0440\u0430\u043a\u0443\u043b\u0430.
      </div>
    </div>
  `;

  host.innerHTML = `
  <div class="trade-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
    <div class="trade-box" style="padding:16px; border-radius:16px; background: rgba(255,255,255,0.04);">
      <h3 style="margin:0 0 10px 0;">Купівля</h3>

      <!-- BUY MODE -->
      <div style="display:flex; flex-direction:column; gap:6px; margin:8px 0 10px 0; font-size:14px; opacity:0.95;">
        <label style="display:flex; gap:8px; align-items:center;">
          <input type="radio" name="buyMode" value="instant" checked>
          <span>Купити ARUB (миттєво)</span>
        </label>

        <label style="display:flex; gap:8px; align-items:center;">
          <input type="radio" name="buyMode" value="discount">
          <span>Купити ARUB (з бонусом, депозит блокується)</span>
        </label>
      </div>

      <!-- BONUS INFO -->
      <div id="buyBonusBox"
           style="display:none; margin:6px 0 10px 0; padding:10px; border-radius:12px;
                  border:1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.18);
                  font-size:13px; opacity:0.95;">
        <div style="display:flex; justify-content:space-between; gap:12px;">
          <div>
            Бонус зараз: <span id="buyBonusPct">—</span>
          </div>
          <div style="opacity:0.85;">
            Залишилось місць: <span id="buyBonusSlots">—</span>
          </div>
        </div>

        <div id="buyBonusNote" style="margin-top:6px; opacity:0.85; display:none;">
          Ліміти: мінімум <span id="minBuy">10</span> USDT ·
          максимум <span id="maxPerTx">—</span> USDT за покупку ·
          <span id="maxPerWallet">—</span> USDT на гаманець
        </div>
      </div>

      <!-- AMOUNT -->
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
        <input id="buyAmount" type="number" inputmode="decimal" placeholder="Сума USDT"
               style="flex:1; padding:12px; border-radius:12px;
                      border:1px solid rgba(255,255,255,0.12);
                      background: rgba(0,0,0,0.25); color:#fff;">
        <button id="maxBuyBtn" type="button"
                style="padding:12px 14px; border-radius:12px;
                       border:1px solid rgba(255,255,255,0.12);
                       background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
          МАКС
        </button>
      </div>

      <button id="buyBtn" type="button"
              style="width:66%; padding:12px; border-radius:12px; border:0; cursor:pointer; margin:0 auto; display:block;">
        Купити ARUB
      </button>

      <div style="margin-top:6px; font-size:12px; opacity:0.75; text-align:center;">
        Minimum $10
      </div>

      <div style="margin-top:10px; font-size:14px; opacity:0.9;">
        Баланс USDT: <span id="usdtBalance">—</span>
      </div>

      <div id="lockPanel" style="display:none; margin-top:12px; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.18); font-size:14px;">
        <div style="font-weight:600; margin-bottom:6px;">Статус блокування</div>
        <div>Заблокований основний: <span id="lockedPrincipal">—</span> ARUB</div>
        <div>Заблокований бонус: <span id="lockedBonus">—</span> ARUB</div>
        <div>Дата розблокування: <span id="unlockDate">—</span></div>
        <div>Залишилось: <span id="unlockRemaining">—</span></div>
        <button id="unlockBtn" type="button" style="display:none; margin-top:10px; width:100%; padding:10px; border-radius:10px; border:0; cursor:pointer;">Розблокувати</button>
      </div>
    </div>

    <div class="trade-box" style="padding:16px; border-radius:16px; background: rgba(255,255,255,0.04);">
      <h3 style="margin:0 0 10px 0;">Продаж</h3>

      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
        <input id="sellAmount" type="number" inputmode="decimal" placeholder="Сума ARUB" min="${MIN_SELL_ARUB}" step="0.000001"
               style="flex:1; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff;">
        <button id="maxSellBtn" type="button"
                style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
          МАКС
        </button>
      </div>

      <button id="sellBtn" type="button"
              style="width:66%; padding:12px; border-radius:12px; border:0; cursor:pointer; margin:0 auto; display:block;">
        Продати ARUB
      </button>

      <div style="margin-top:10px; font-size:13px; opacity:0.9;">
        Комісія при продажу: <span id="sellFee">—</span>
        <div style="margin-top:4px; line-height:1.45; opacity:0.85;">
          <span id="sellFeeCurrentPct">—</span> діє до <span id="sellFeeUntil">—</span> (залишилось: <span id="sellFeeLeft">—</span>).<br>
          Після цього — <span id="sellFeeNextPct">—</span> з <span id="sellFeeNextAt">—</span>, далі — <span id="sellFeeFinalPct">1%</span>.
        </div>
      </div>

      <div id="sellLockHint" style="display:none; margin-top:6px; font-size:13px; opacity:0.85;">
        Активний лок бонусної покупки: <span id="sellBonusLocked">—</span> ARUB. Продаж вільних ARUB: <span id="sellFreeAllowed">—</span> дозволено. Залишилось: <span id="sellLockLeft">—</span>
      </div>

      <!-- Progress bar for wallet stats scan (uses existing setPresaleScanVisible/Progress) -->
      <div id="presaleScanWrap" style="display:none; margin-top:10px;">
        <div id="presaleScanPct" style="margin-bottom:6px;">0%</div>
        <div style="height:10px; background:rgba(255,255,255,0.08); border-radius:8px; overflow:hidden;">
          <div id="presaleScanBar" style="height:10px; width:0%; background:rgba(0,87,183,0.8);"></div>
        </div>
      </div>

      <div style="margin-top:10px; font-size:14px; opacity:0.9;">
        Баланс ARUB: <span id="arubBalance">—</span>
      </div>
    </div>
  </div>
`;

  let lpHost = getLiquidityHost();
  if (!lpHost && host.parentElement) {
    lpHost = document.createElement('div');
    lpHost.id = 'liquidityInterface';
    lpHost.className = host.className || 'page-card';
    host.parentElement.insertBefore(lpHost, host);
  }
  if (lpHost) {
    lpHost.innerHTML = liquidityHtml;
  }

  try { refreshVaultTotals?.(true); } catch (_) {}

  setTimeout(() => { try { refreshBuyBonusBox?.(); } catch (_) {} }, 0);

document.addEventListener('change', (e) => {
  if (e.target?.name === 'buyMode') {
    try { refreshBuyBonusBox?.(); } catch (_) {}
  }
});

try { bindUiOncePerRender?.(); } catch (e) { console.warn(e); }
try { hardUnlock?.(); } catch (e) { console.warn(e); }
try { refreshBuyBonusBox?.().catch(()=>{}); } catch (e) { console.warn(e); }
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
    try {
      c.disabled = false;
    } catch (_) {}
    c.removeAttribute('disabled');
    c.removeAttribute('aria-disabled');
    c.classList?.remove(
      'disabled',
      'is-disabled',
      'btn-disabled',
      'opacity-50',
      'cursor-not-allowed'
    );
    c.style.pointerEvents = 'auto';
  });

  const candidates = root.querySelectorAll(
    [
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
      '[data-locked]',
    ].join(',')
  );

  candidates.forEach((node) => {
    node.style.display = 'none';
    node.style.visibility = 'hidden';
    node.style.pointerEvents = 'none';
  });
}

// -----------------------------
// Contracts init
// -----------------------------
async function initReadOnly() {
  await initReadOnlyContracts();
  const roProvider = await getReadOnlyProviderAsync();

  tokenRO = new ethers.Contract(ARUB_TOKEN_ADDRESS, ERC20_ABI, roProvider);
  usdtRO = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, roProvider);

  (async () => {
    try {
      if (tokenRO?.decimals) DECIMALS_ARUB = Number(await tokenRO.decimals());
    } catch (_) {}
    try {
      if (usdtRO?.decimals) DECIMALS_USDT = Number(await usdtRO.decimals());
    } catch (_) {}
    console.log('[TRADING] decimals synced (RO):', { DECIMALS_ARUB, DECIMALS_USDT });
    try {
      await refreshBalances();
    } catch (_) {}
    try {
      await refreshVaultTotals(true);
    } catch (_) {}
  })();
}

function initWithSigner() {
  tokenRW = null;
  usdtRW = null;

  if (!user.signer) return;

  tokenRW = new ethers.Contract(ARUB_TOKEN_ADDRESS, ERC20_ABI, user.signer);
  usdtRW = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, user.signer);

  (async () => {
    try {
      if (tokenRW?.decimals) DECIMALS_ARUB = Number(await tokenRW.decimals());
    } catch (_) {}
    try {
      if (usdtRW?.decimals) DECIMALS_USDT = Number(await usdtRW.decimals());
    } catch (_) {}
    console.log('[TRADING] decimals synced (RW):', { DECIMALS_ARUB, DECIMALS_USDT });
  })();
}

// -----------------------------
// Presale UI insertion under balances
// -----------------------------
function ensurePresaleUI() {
  const bal = document.getElementById('arubBalance');
  if (!bal) return;
  const existing = document.getElementById('presaleStats');
  if (existing) {
    existing.style.fontSize = '14px';
    existing.style.fontWeight = '500';
    existing.style.fontFamily = 'inherit';
    existing.style.opacity = '0.9';
    return;
  }

  const box = document.createElement('div');
  box.id = 'presaleStats';
  box.style.marginTop = '8px';
  box.style.fontSize = '14px';
  box.style.fontWeight = '500';
  box.style.fontFamily = 'inherit';
  box.style.opacity = '0.9';
  box.innerHTML = `
  <div id="presaleLoadingNote" style="font-size:13px; opacity:0.75; margin-bottom:6px;">Очікується завантаження даних:</div>
  <div>Куплено на пресейлі: <span id="presalePurchased">—</span> ARUB</div>
  <div>У тому числі бонусом: <span id="presaleBonusAmount">—</span> ARUB</div>
  <div>Сплачено: <span id="presalePaid">—</span> USDT</div>
  <div>Середня ціна купівлі: <span id="presaleAvgPrice">—</span> USDT/ARUB</div>
  <div>Середній бонус: <span id="presaleBonusPct">—</span></div>

  <div id="presaleScanWrap" style="display:none; margin-top:10px;">
    <div style="display:flex; justify-content:space-between; font-size:12px; opacity:.85;">
      <span>Скануємо історію покупок…</span>
      <span id="presaleScanPct">0%</span>
    </div>
    <div style="height:8px; background:rgba(255,255,255,.12); border-radius:999px; overflow:hidden; margin-top:6px;">
      <div id="presaleScanBar" style="height:100%; width:0%; background:rgba(255,255,255,.65);"></div>
    </div>
  </div>
`


  bal.parentElement.appendChild(box);
}

// -----------------------------
// Data refresh
// -----------------------------
async function refreshVaultTotals(force = false) {
  try {
    if (!VAULT_ADDRESS || !tokenRO || !usdtRO) return;
    const now = Date.now();
    if (!force && now - lastVaultTotalsTs < VAULT_REFRESH_MIN_MS) return;
    lastVaultTotalsTs = now;

    const [arubBal, usdtBal] = await Promise.all([
      tokenRO.balanceOf(VAULT_ADDRESS),
      usdtRO.balanceOf(VAULT_ADDRESS),
    ]);

    const arubText = formatTokenAmount(arubBal, DECIMALS_ARUB, 6);
    const usdtText = formatTokenAmount(usdtBal, DECIMALS_USDT, 2);

    setText('lpVaultArubTotal', `${arubText} ARUB`);
    setText('lpVaultUsdtTotal', `${usdtText} USDT`);

    const target = Number.isFinite(LP_TARGET_USDT) && LP_TARGET_USDT > 0 ? LP_TARGET_USDT : 0;
    const usdtVal = Number(ethers.utils.formatUnits(usdtBal, DECIMALS_USDT));
    const pct =
      target > 0 && Number.isFinite(usdtVal) && usdtVal >= 0
        ? Math.min(100, Math.floor((usdtVal / target) * 100))
        : 0;

    setText('lpVaultTargetUsdt', target > 0 ? `${formatIntWithSpaces(target)} USDT` : '—');
    setText('lpVaultUsdtProgress', target > 0 ? `${pct}%` : '—');
    const bar = el('lpVaultProgressBar');
    if (bar) bar.style.width = target > 0 ? `${pct}%` : '0%';
  } catch (e) {
    console.warn('[TRADING] refreshVaultTotals error:', e);
  }
}

async function refreshBalances() {
  try {
    try { await refreshVaultTotals(); } catch (_) {}
    if (!user.address || !tokenRO || !usdtRO) return;

    const presaleRO = await getReadOnlyPresale();
    if (!presaleRO) return;

    const [arubBal, usdtBal, redeemable] = await Promise.all([
      tokenRO.balanceOf(user.address),
      usdtRO.balanceOf(user.address),
      presaleRO.redeemableBalance(user.address),
    ]);

    setText('arubBalance', formatTokenAmount(arubBal, DECIMALS_ARUB, 6));
    ensurePresaleUI();
    setText('usdtBalance', formatTokenAmount(usdtBal, DECIMALS_USDT, 2));

    redeemableCached = redeemable;
    redeemableFor = user.address;
    const allowed = redeemable;
    sellFreeAllowedCached = allowed;
    sellFreeAllowedFor = user.address;
    const freeEl = el('sellFreeAllowed');
    if (freeEl) {
      freeEl.textContent = formatTokenAmount(allowed, DECIMALS_ARUB, 6);
      freeEl.dataset.allowed = freeEl.textContent;
    }

    const canSell = !redeemable.isZero?.() && !redeemable.lte?.(0);
    setDisabled('sellBtn', !canSell);
    setDisabled('maxSellBtn', !canSell);

    const sellInp = el('sellAmount');
    if (sellInp) sellInp.disabled = !canSell;
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

function readDisplayedNumber(id) {
  const t = el(id)?.textContent ?? '';
  const n = Number(String(t).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function setInputValue(id, value) {
  const node = el(id);
  if (!node) return;
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function getLpSlippageBps() {
  const raw = Number(el('lpSlippage')?.value ?? '');
  const pct = Number.isFinite(raw) && raw >= 0 ? raw : 0.5;
  const bps = Math.round(pct * 100);
  return Math.min(Math.max(bps, 0), 5000);
}

function getLpDeadlineSeconds() {
  const raw = Number(el('lpDeadline')?.value ?? '');
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 20;
  return Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
}

async function sendToVault(kind) {
  const ws = window.walletState;
  if (!ws?.signer || !ws?.address) {
    showNotification?.('\\u041f\\u0456\\u0434\\u043a\\u043b\\u044e\\u0447\\u0456\\u0442\\u044c \\u0433\\u0430\\u043c\\u0430\\u043d\\u0435\\u0446\\u044c', 'error');
    return;
  }

  try {
    requireArbitrumOrThrow(ws);
  } catch (e) {
    showNotification?.(e?.message || '\\u041d\\u0435\\u043f\\u0440\\u0430\\u0432\\u0438\\u043b\\u044c\\u043d\\u0430 \\u043c\\u0435\\u0440\\u0435\\u0436\\u0430. \\u041f\\u0435\\u0440\\u0435\\u043c\\u043a\\u043d\\u0456\\u0442\\u044c \\u043d\\u0430 Arbitrum', 'error');
    return;
  }

  if (!VAULT_ADDRESS) {
    showNotification?.('\\u041d\\u0435 \\u043d\\u0430\\u043b\\u0430\\u0448\\u0442\\u043e\\u0432\\u0430\\u043d\\u043e \\u0430\\u0434\\u0440\\u0435\\u0441\\u0443 Vault', 'error');
    return;
  }

  const isArub = kind === 'arub';
  const inputId = isArub ? 'lpArubAmount' : 'lpUsdtAmount';
  const symbol = isArub ? 'ARUB' : 'USDT';
  const decimals = isArub ? DECIMALS_ARUB : DECIMALS_USDT;
  const minValue = isArub ? MIN_LP_ARUB : MIN_LP_USDT;

  let amountBN;
  try {
    amountBN = parseTokenAmount(el(inputId)?.value ?? '', decimals);
  } catch (e) {
    showNotification?.(e?.message || '\\u0412\\u043a\\u0430\\u0436\\u0456\\u0442\\u044c \\u0441\\u0443\\u043c\\u0443', 'error');
    return;
  }

  if (amountBN.isZero?.() === true) {
    showNotification?.('\\u0412\\u043a\\u0430\\u0436\\u0456\\u0442\\u044c \\u0441\\u0443\\u043c\\u0443, \\u0431\\u0456\\u043b\\u044c\\u0448\\u0443 \\u0437\\u0430 0', 'error');
    return;
  }

  const minBN = parseTokenAmount(minValue, decimals);
  if (amountBN.lt(minBN)) {
    showNotification?.('\\u041c\\u0456\\u043d. \\u0432\\u043d\\u0435\\u0441\\u043e\\u043a: ' + minValue + ' ' + symbol, 'error');
    return;
  }

  const tokenAddr = isArub ? ARUB_TOKEN_ADDRESS : USDT_ADDRESS;
  const token = new ethers.Contract(tokenAddr, ERC20_ABI_MIN, ws.signer);

  try {
    showNotification?.('\\u041f\\u0456\\u0434\\u043f\\u0438\\u0441\\u0430\\u043d\\u043d\\u044f \\u043f\\u0435\\u0440\\u0435\\u043a\\u0430\\u0437\\u0443 ' + symbol + '...', 'success');
    const tx = await token.transfer(VAULT_ADDRESS, amountBN);
    showNotification?.('\\u0422\\u0440\\u0430\\u043d\\u0437\\u0430\\u043a\\u0446\\u0456\\u044e \\u0432\\u0456\\u0434\\u043f\\u0440\\u0430\\u0432\\u043b\\u0435\\u043d\\u043e', 'success');
    await tx.wait(CONFIG?.TX_CONFIRMATIONS ?? 1);
    showNotification?.('\\u041d\\u0430\\u0434\\u0456\\u0441\\u043b\\u0430\\u043d\\u043e \\u0443 Vault (' + symbol + ')', 'success');

    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshVaultTotals?.(true); } catch (_) {}
    return tx;
  } catch (e) {
    console.error('[VAULT] transfer error:', e);
    if (isUserRejectedTx(e)) {
      showNotification?.('\\u0422\\u0440\\u0430\\u043d\\u0437\\u0430\\u043a\\u0446\\u0456\\u044e \\u0441\\u043a\\u0430\\u0441\\u043e\\u0432\\u0430\\u043d\\u043e. \\u0421\\u043f\\u0440\\u043e\\u0431\\u0443\\u0439\\u0442\\u0435 \\u0449\\u0435 \\u0440\\u0430\\u0437.', 'error');
      return;
    }
    showNotification?.(pickEthersMessage(e), 'error');
    return;
  }
}

function syncUserFromWalletState() {
  try {
    const a = window.walletState?.address || null;
    if (!window.user) window.user = {};
    window.user.address = a;
  } catch (_) {}
}

window.addEventListener('walletStateChanged', () => {
  syncUserFromWalletState();
  refreshBuyBonusBox?.().catch?.(() => {});
});

// -----------------------------
// Bonus mode UI box
// -----------------------------
async function refreshBuyBonusBox() {
  const box = el('buyBonusBox');
  const pctEl = el('buyBonusPct');
  const slotsEl = el('buyBonusSlots');
  const noteEl = el('buyBonusNote');

  if (!box || !pctEl || !slotsEl) return;

  const isBonusMode = getBuyMode() === 'discount';
  box.style.display = isBonusMode ? '' : 'none';
  if (!isBonusMode) return;

  if (!user?.address) {
    pctEl.textContent = '—';
    slotsEl.textContent = '—';
    if (noteEl) noteEl.style.display = 'none';
    await refreshUiAfterRpcError();
    return;
  }

  try {
    const presaleRO = await getReadOnlyPresale();
    if (!presaleRO) throw new Error('Read-only presale not ready');

    // limits (safe)
    try {
      // ВАЖНО: ethers должен быть доступен в этом модуле
      if (typeof ethers === 'undefined') throw new Error('ethers is not defined');

      const [maxTxRaw, maxWalletRaw] = await Promise.all([
        presaleRO.maxPurchasePerTx?.(),
        presaleRO.maxPurchasePerWallet?.()
      ]);

      const maxTxEl = document.getElementById('maxPerTx');
      const maxWalletEl = document.getElementById('maxPerWallet');
      const minEl = document.getElementById('minBuy');

      if (minEl) minEl.textContent = '10';

      if (maxTxEl && maxTxRaw) {
        const v = Number(ethers.utils.formatUnits(maxTxRaw, 6));
        maxTxEl.textContent = Number.isFinite(v) ? v.toFixed(2) : '—';
      }

      if (maxWalletEl && maxWalletRaw) {
        const v = Number(ethers.utils.formatUnits(maxWalletRaw, 6));
        maxWalletEl.textContent = Number.isFinite(v) ? v.toFixed(2) : '—';
      }
    } catch (e) {
      console.warn('[TRADING] limits update failed:', e?.message || e);
    }

    // percent
    let percent = null;
    try {
      const p = await presaleRO.getDiscountPercent();
      percent = Number(p.toString());
    } catch (_) {}

    // slots left
    let left = null;
    try {
      const usedBN = await presaleRO.totalDiscountBuyers();

      let maxBN = null;
      try { maxBN = await presaleRO.DISCOUNT_MAX_BUYERS(); } catch (_) {}

      const used = Number(usedBN.toString());

      if (maxBN != null) {
        const max = Number(maxBN.toString());
        left = Math.max(0, max - used);
      } else {
        const FALLBACK_MAX = 100;
        left = Math.max(0, FALLBACK_MAX - used);
      }
    } catch (_) {}

    pctEl.textContent = percent != null ? `${percent}%` : '—';
    slotsEl.textContent = left != null ? String(left) : '—';
    if (noteEl) noteEl.style.display = '';
  } catch (e) {
    console.warn('[TRADING] refreshBuyBonusBox failed:', e?.message || e);
    pctEl.textContent = '—';
    slotsEl.textContent = '—';
    if (noteEl) noteEl.style.display = 'none';
  }
}

// -----------------------------
// Sell fee (separate async function — no top-level await)
// -----------------------------
function resetSellFeeScheduleUI() {
  stopSellFeeTimer();
  sellFeeDropTs = null;
  setText('sellFeeCurrentPct', '—');
  setText('sellFeeUntil', '—');
  setText('sellFeeLeft', '—');
  setText('sellFeeNextPct', '—');
  setText('sellFeeNextAt', '—');
  setText('sellFeeFinalPct', '1%');
}

function updateSellFeeCountdown() {
  if (!sellFeeDropTs) {
    setText('sellFeeLeft', '—');
    setText('sellFeeUntil', '—');
    setText('sellFeeNextAt', '—');
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const left = Math.max(0, sellFeeDropTs - nowSec);
  setText('sellFeeLeft', formatRemaining(left));
  setText('sellFeeUntil', formatJerusalemDate(sellFeeDropTs));
  setText('sellFeeNextAt', formatJerusalemDate(sellFeeDropTs));
}

async function refreshSellFeeSchedule(currentFeeBps) {
  const nextEl = el('sellFeeNextPct');
  if (!nextEl) return;

  if (!user.address) {
    resetSellFeeScheduleUI();
    return;
  }

  stopSellFeeTimer();

  const tryGetNext = async (src) => {
    try {
      if (src?.getNextFeeDropETA) {
        const res = await src.getNextFeeDropETA(user.address);
        if (Array.isArray(res) && res.length >= 2) return res;
        if (res && typeof res === 'object' && 'secondsToNext' in res && 'nextFeeBps' in res) {
          return [res.secondsToNext, res.nextFeeBps];
        }
      }
    } catch (_) {}
    return null;
  };

  let info = null;
  try {
    info = await tryGetNext(getPresaleAsSigner());
    if (!info) {
      const ro = await getReadOnlyPresale();
      info = await tryGetNext(ro);
    }
  } catch (_) {
    await refreshUiAfterRpcError({ includeSellFee: false });
  }

  let secondsToNext = null;
  let nextFeeBps = null;
  if (info) {
    secondsToNext = Number(info[0]);
    nextFeeBps = info[1];
  }

  const nextPct =
    nextFeeBps != null ? Number(nextFeeBps.toString?.() ?? nextFeeBps) / 100 : null;
  if (Number.isFinite(nextPct)) {
    setText('sellFeeNextPct', `${nextPct.toFixed(2)}%`);
  } else {
    setText('sellFeeNextPct', '—');
  }

  if (Number.isFinite(secondsToNext) && secondsToNext > 0) {
    sellFeeDropTs = Math.floor(Date.now() / 1000) + Math.floor(secondsToNext);
    updateSellFeeCountdown();
    sellFeeCountdownTimer = setInterval(() => {
      updateSellFeeCountdown();
      if (sellFeeDropTs && Math.floor(Date.now() / 1000) >= sellFeeDropTs) {
        stopSellFeeTimer();
        refreshSellFee().catch(() => {});
      }
    }, 30_000);
  } else {
    sellFeeDropTs = null;
    setText('sellFeeLeft', '—');
    setText('sellFeeUntil', '—');
    setText('sellFeeNextAt', '—');
  }

  const finalEl = el('sellFeeFinalPct');
  if (finalEl && Number.isFinite(nextPct) && nextPct <= 1.01) {
    setText('sellFeeFinalPct', `${nextPct.toFixed(2)}%`);
  }

  if (currentFeeBps != null && Number.isFinite(Number(currentFeeBps))) {
    const currentPct = Number(currentFeeBps.toString?.() ?? currentFeeBps) / 100;
    if (Number.isFinite(currentPct)) {
      const formatted = `${currentPct.toFixed(2)}%`;
      setText('sellFee', formatted);
      setText('sellFeeCurrentPct', formatted);
    }
  }
}

async function tryCallPresale(src, method, ...args) {
  if (!src || typeof src[method] !== 'function') return null;
  try {
    return await src[method](...args);
  } catch (_) {
    return null;
  }
}

async function refreshSellFee() {
  try {
    if (!user.address) {
      resetSellFeeScheduleUI();
      return;
    }

    let feeBps = null;

    const presaleAsSigner = getPresaleAsSigner();
    feeBps = await tryCallPresale(presaleAsSigner, 'getMySellFeeBps');
    if (feeBps == null) {
      feeBps = await tryCallPresale(presaleAsSigner, 'getCurrentSellFeeBps', user.address);
    }
    if (feeBps == null) {
      feeBps = await tryCallPresale(presaleAsSigner, 'getUserSellFeeBps', user.address);
    }

    if (feeBps == null) {
      const presaleRO = await getReadOnlyPresale();
      feeBps = await tryCallPresale(presaleRO, 'getCurrentSellFeeBps', user.address);
      if (feeBps == null) {
        feeBps = await tryCallPresale(presaleRO, 'getUserSellFeeBps', user.address);
      }
    }

    if (feeBps != null) {
      const pct = Number(feeBps.toString()) / 100;
      const formatted = `${pct.toFixed(2)}%`;
      setText('sellFee', formatted);
      setText('sellFeeCurrentPct', formatted);
    }

    try {
      await refreshSellFeeSchedule(feeBps);
    } catch (_) {}
  } catch (_) {
    await refreshUiAfterRpcError({ includeSellFee: false });
  }
}

// -----------------------------
// Lock panel
// -----------------------------
async function refreshLockPanel() {
  const panel = el('lockPanel');
  if (!panel) return;

  if (!user.address) {
    panel.style.display = 'none';
    return;
  }

  const info = await loadMyLockInfo();
  if (!info) {
    panel.style.display = 'none';
    return;
  }

  const principal = info.principalLocked;
  const bonus = info.bonusLocked;

  const hasLock = (principal?.gt && principal.gt(0)) || (bonus?.gt && bonus.gt(0));
  if (!hasLock) {
    panel.style.display = 'none';
    const hint = el('sellLockHint');
    if (hint) hint.style.display = 'none';
    return;
  }

  panel.style.display = '';

  setText('lockedPrincipal', formatTokenAmount(principal, DECIMALS_ARUB, 6));
  setText('lockedBonus', formatTokenAmount(bonus, DECIMALS_ARUB, 6));
  setText('unlockDate', formatJerusalemDate(info.unlockTime));
  setText('unlockRemaining', formatRemaining(info.remaining));

  const canUnlock = Number(info.remaining) <= 0 && Number(info.unlockTime) > 0;

  const unlockBtn = el('unlockBtn');
  if (unlockBtn) {
    unlockBtn.style.display = canUnlock ? '' : 'none';
    unlockBtn.onclick = async () => {
      await unlockDeposit();
      await refreshBalances();
      await refreshLockPanel();
      startLockAutoRefresh();
    };
  }

  // Sell lock hint (informational only)
  const hint = el('sellLockHint');
  const left = el('sellLockLeft');

  if (hint && left) {
    const now = Math.floor(Date.now() / 1000);
    const unlockTime = Number(info.unlockTime || 0);
    const freeEl = el('sellFreeAllowed');
    const bonusEl = el('sellBonusLocked');

    if (unlockTime > now) {
      hint.style.display = 'block';
      left.textContent = formatRemaining(info.remaining || unlockTime - now);

      if (bonusEl) {
        bonusEl.textContent = formatTokenAmount(bonus, DECIMALS_ARUB, 6);
      }

      if (freeEl) {
        try {
          let allowed = null;

          if (sellFreeAllowedCached && sellFreeAllowedFor === user.address) {
            allowed = sellFreeAllowedCached;
          } else {
            const presaleRO = await getReadOnlyPresale();
            if (!presaleRO) throw new Error('Read-only presale not ready');

            // Only fetch redeemableBalance (tokens bought through presale)
            const redeemable = await presaleRO.redeemableBalance(user.address);

            redeemableCached = redeemable;
            redeemableFor = user.address;
            allowed = redeemable;

            sellFreeAllowedCached = allowed;
            sellFreeAllowedFor = user.address;
          }

          freeEl.textContent = formatTokenAmount(allowed, DECIMALS_ARUB, 6);
          freeEl.dataset.allowed = freeEl.textContent;
        } catch (_) {
          freeEl.textContent = '—';
          freeEl.dataset.allowed = '';
        }
      }
    } else {
      hint.style.display = 'none';
      left.textContent = '—';
      if (bonusEl) bonusEl.textContent = '—';
      if (freeEl) {
        freeEl.textContent = '—';
        freeEl.dataset.allowed = '';
      }
    }
  }
}

// -----------------------------
// UI bindings (per render; no wallet logic here)
// -----------------------------
function bindUiOncePerRender() {
  const buyBtn = el('buyBtn');
  if (buyBtn) {
    buyBtn.onclick = async () => {
      try {
        const lang = getUiLang();
        const msg = TERMS_NOTICE[lang] || TERMS_NOTICE.ru;

        const ok = confirm(msg);
        if (!ok) return;

        const amount = el('buyAmount')?.value ?? '';
        const withBonus = getBuyMode() === 'discount';
        await buyTokens(amount, withBonus);

        try {
          await refreshBuyBonusBox();
        } catch (_) {}
      } catch (e) {
        console.error('[UI] buy click error:', e);
        showNotification?.(e?.message || 'Buy failed', 'error');
      }
    };
  }

  const sellBtn = el('sellBtn');
  if (sellBtn) {
    sellBtn.onclick = async () => {
      try {
        const amountRaw = String(el('sellAmount')?.value ?? '').trim();
        const normalized = amountRaw.replace(',', '.');
        if (!normalized) {
          showNotification?.('\u0412\u043a\u0430\u0436\u0456\u0442\u044c \u0441\u0443\u043c\u0443 \u0434\u043b\u044f \u043f\u0440\u043e\u0434\u0430\u0436\u0443', 'error');
          return;
        }
        const num = Number(normalized);
        if (!Number.isFinite(num)) {
          showNotification?.('\u041d\u0435\u043a\u043e\u0440\u0435\u043a\u0442\u043d\u0430 \u0441\u0443\u043c\u0430', 'error');
          return;
        }
        if (num <= 0) {
          showNotification?.('\u0421\u0443\u043c\u0430 \u043c\u0430\u0454 \u0431\u0443\u0442\u0438 \u0431\u0456\u043b\u044c\u0448\u043e\u044e \u0437\u0430 0', 'error');
          return;
        }
        if (num < Number(MIN_SELL_ARUB)) {
          showNotification?.(`\u041c\u0456\u043d. \u043f\u0440\u043e\u0434\u0430\u0436: ${MIN_SELL_ARUB} ARUB`, 'error');
          return;
        }
        await sellTokens(normalized);
      } catch (e) {
        console.error('[UI] sell click error:', e);
        showNotification?.(e?.message || '\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u043f\u0440\u043e\u0434\u0430\u0442\u0438', 'error');
      }
    };
  }

  const maxBuyBtn = el('maxBuyBtn');
  if (maxBuyBtn) {
    maxBuyBtn.onclick = async () => {
      try {
        await setMaxBuy();
      } catch (e) {
        showNotification?.(e?.message || 'Cannot set max buy', 'error');
      }
    };
  }

  const maxSellBtn = el('maxSellBtn');
  if (maxSellBtn) {
    // Hard override: if "free ARUB" is shown, force max to that value.
    maxSellBtn.addEventListener(
      'click',
      (e) => {
        const freeEl = el('sellFreeAllowed');
        const freeText = freeEl?.dataset?.allowed || freeEl?.textContent?.trim() || '';
        const freeNum = Number(freeText.replace(',', '.'));
        if (Number.isFinite(freeNum) && freeNum >= 0) {
          const inp = el('sellAmount');
          if (inp) inp.value = freeText.replace(',', '.');
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true
    );

    maxSellBtn.onclick = async () => {
      try {
        await setMaxSell();
      } catch (e) {
        showNotification?.(e?.message || 'Cannot set max sell', 'error');
      }
    };
  }

      const lpAddArubBtn = el('lpAddArubBtn');
  if (lpAddArubBtn) {
    lpAddArubBtn.onclick = async () => {
      try {
        await sendToVault('arub');
      } catch (e) {
        console.error('[UI] sendToVault ARUB error:', e);
        showNotification?.(e?.message || '\\u041d\\u0435 \\u0432\\u0434\\u0430\\u043b\\u043e\\u0441\\u044f \\u043d\\u0430\\u0434\\u0456\\u0441\\u043b\\u0430\\u0442\\u0438 ARUB \\u0443 Vault', 'error');
      }
    };
  }

  const lpAddUsdtBtn = el('lpAddUsdtBtn');
  if (lpAddUsdtBtn) {
    lpAddUsdtBtn.onclick = async () => {
      try {
        await sendToVault('usdt');
      } catch (e) {
        console.error('[UI] sendToVault USDT error:', e);
        showNotification?.(e?.message || '\\u041d\\u0435 \\u0432\\u0434\\u0430\\u043b\\u043e\\u0441\\u044f \\u043d\\u0430\\u0434\\u0456\\u0441\\u043b\\u0430\\u0442\\u0438 USDT \\u0443 Vault', 'error');
      }
    };
  }



  const lpMaxArubBtn = el('lpMaxArubBtn');
  if (lpMaxArubBtn) {
    lpMaxArubBtn.onclick = () => {
      const bal = readDisplayedNumber('arubBalance');
      if (bal == null) return;
      setInputValue('lpArubAmount', String(bal));
    };
  }

  const lpMaxUsdtBtn = el('lpMaxUsdtBtn');
  if (lpMaxUsdtBtn) {
    lpMaxUsdtBtn.onclick = () => {
      const bal = readDisplayedNumber('usdtBalance');
      if (bal == null) return;
      setInputValue('lpUsdtAmount', String(bal));
    };
  }

  document.querySelectorAll('input[name="buyMode"]').forEach((r) => {
    r.onchange = () => {
      refreshBuyBonusBox().catch(() => {});
    };
  });

  refreshBuyBonusBox().catch(() => {});
}

// -----------------------------
// Wallet readiness barrier
// -----------------------------
async function awaitWalletReady({
  requireSigner = true,
  timeoutMs = 1200,
  stepMs = 50,
} = {}) {
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
// Trading UI state
// -----------------------------
let __tradingUiRendered = false;
let applySeq = 0;
let _tradingBound = false;
let _presaleUiFor = null;


// -----------------------------
// Core event-driven state apply
// -----------------------------
async function applyWalletState(reason = 'unknown') {
  const seq = ++applySeq;

  const ws = await awaitWalletReady({ requireSigner: false });
  if (seq !== applySeq) return;

  const hasAddress = !!ws?.address;
  const hasSigner = !!ws?.signer;

  if (!hasAddress) {
    user.address = null;
    user.provider = null;
    user.signer = null;
    user.chainId = null;
    _presaleUiFor = null;

    tokenRW = null;
    usdtRW = null;
    redeemableCached = null;
    redeemableFor = null;
    sellFreeAllowedCached = null;
    sellFreeAllowedFor = null;

    __tradingUiRendered = false;

    renderLocked();
    stopLockAutoRefresh();
    return;
  }

  const prevAddress = user.address;
  user.address = ws.address;
  user.provider = ws.provider || null;
  user.signer = ws.signer || null;
  user.chainId = ws.chainId ?? null;

  if (prevAddress && prevAddress !== user.address) {
    redeemableCached = null;
    redeemableFor = null;
    sellFreeAllowedCached = null;
    sellFreeAllowedFor = null;
  }

  if (!__tradingUiRendered) {
    renderTradingUI();
    __tradingUiRendered = true;
  }

  // Block sell controls until redeemableBalance is loaded for this address
  setDisabled('sellBtn', true);
  setDisabled('maxSellBtn', true);
  const sellInp = el('sellAmount');
  if (sellInp) sellInp.disabled = true;
  setText('sellBonusLocked', '—');
  const loadingNote = el('presaleLoadingNote');
  if (loadingNote) loadingNote.style.display = 'none';

  try { await refreshBuyBonusBox(); } catch (_) {}


  // обновляем бонус-бокс и лимиты сразу после отрисовки UI
  try { await refreshBuyBonusBox(); } catch (_) {}


  if (!hasSigner) {
    setControlsEnabled(false);
    try {
      const lp = el('lockPanel');
      if (lp) lp.style.display = 'none';
    } catch (_) {}
    resetSellFeeScheduleUI();

    const ws2 = await awaitWalletReady({ requireSigner: true });
    if (seq !== applySeq) return;

    if (ws2?.signer) {
      user.signer = ws2.signer;
      user.provider = ws2.provider || user.provider;
      user.chainId = ws2.chainId ?? user.chainId;
    }
  }

  const readyForTrading = !!user.signer;
  setControlsEnabled(readyForTrading);

  if (readyForTrading) {
    initWithSigner();
    try { ensurePresaleUI(); } catch (_) {}
    await refreshBalances();
    await refreshLockPanel();
    await refreshSellFee();
    startLockAutoRefresh();

    const needPresaleUi = user.address && user.address !== _presaleUiFor;
    if (needPresaleUi) {
      try {
        await window.refreshPresaleUI?.(user.address);
        _presaleUiFor = user.address;
      } catch (e) {
        console.warn('[TRADING] refreshPresaleUI failed:', e?.message || e);
        _presaleUiFor = null;
      }
    }
  }

  console.log('[TRADING] applyWalletState:', {
    reason,
    address: user.address,
    hasSigner: !!user.signer,
    chainId: user.chainId,
  });
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
    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}
    throw e;
  }
}

export async function setMaxSell() {
  try {
    if (!user.address || !tokenRO) throw new Error('Wallet not connected');

    const freeEl = el('sellFreeAllowed');
    const freeText = freeEl?.dataset?.allowed || freeEl?.textContent?.trim() || '';
    const freeNum = Number(freeText.replace(',', '.'));
    if (Number.isFinite(freeNum) && freeNum >= 0) {
      const inp = el('sellAmount');
      if (inp) inp.value = freeText.replace(',', '.');
      return;
    }

    const presaleRO = await getReadOnlyPresale();

    // Only fetch redeemableBalance (tokens bought through presale), not wallet balance
    const redeemable = await presaleRO.redeemableBalance(user.address);
    redeemableCached = redeemable;
    redeemableFor = user.address;

    const allowed = redeemable;
    sellFreeAllowedCached = allowed;
    sellFreeAllowedFor = user.address;
    if (freeEl) {
      freeEl.textContent = formatTokenAmount(allowed, DECIMALS_ARUB, 6);
      freeEl.dataset.allowed = freeEl.textContent;
    }
    try { await refreshLockPanel(); } catch (_) {}

    const maxSell = allowed;

    const v = formatTokenAmount(maxSell, DECIMALS_ARUB, 6);
    const inp = el('sellAmount');
    if (inp) inp.value = v;
  } catch (e) {
    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}
    throw e;
  }
}

function parseRpcErrorBody(body) {
  try {
    const j = JSON.parse(body);
    if (j?.error?.message) return j.error.message;
    if (j?.message) return j.message;
  } catch (_) {}
  return null;
}

function isUserRejectedTx(e) {
  return (
    e?.code === 4001 ||
    e?.code === 'ACTION_REJECTED' ||
    /user rejected|user denied|rejected/i.test(
      (e?.message || '') + ' ' + (e?.error?.message || '')
    )
  );
}

function explainEthersError(e) {
  const bodyMsg = e?.error?.body ? parseRpcErrorBody(e.error.body) : null;

  return {
    name: e?.name,
    code: e?.code,
    reason: e?.reason,
    message: e?.message,
    shortMessage: e?.shortMessage,
    errorMessage: e?.error?.message,
    dataMessage: e?.data?.message,
    bodyMessage: bodyMsg,
    isUserRejected:
      e?.code === 4001 ||
      e?.code === 'ACTION_REJECTED' ||
      /user rejected|user denied|rejected/i.test(
        e?.message || e?.error?.message || ''
      ),
  };
}


export async function buyTokens(usdtAmount, withBonus = false) {
  const ws = window.walletState;

  console.log('[TRADING] buyTokens start', {
    address: ws?.address,
    chainId: ws?.chainId,
    input: usdtAmount,
    withBonus,
  });

  if (!ws?.signer || !ws?.address) {
    showNotification?.('\u041f\u0456\u0434\u043a\u043b\u044e\u0447\u0456\u0442\u044c \u0433\u0430\u043c\u0430\u043d\u0435\u0446\u044c', 'error');
    return;
  }

  // ✅ единый гейтинг сети (и без дублей)
  try {
    requireArbitrumOrThrow(ws);
  } catch (e) {
    showNotification?.(e?.message || '\u041d\u0435\u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d\u0430 \u043c\u0435\u0440\u0435\u0436\u0430. \u041f\u0435\u0440\u0435\u043c\u043a\u043d\u0456\u0442\u044c \u043d\u0430 Arbitrum', 'error');
    return;
  }

  let amountBN;
  try {
    amountBN = parseTokenAmount(usdtAmount, DECIMALS_USDT);
  } catch (e) {
    showNotification?.(e?.message || 'Invalid amount', 'error');
    return;
  }

  const MIN_USDT = ethers.utils.parseUnits('10', DECIMALS_USDT);
  if (amountBN.lt(MIN_USDT)) {
    showNotification?.('Minimum purchase is $10', 'error');
    return;
  }
  if (amountBN.isZero?.() === true) {
    showNotification?.('Enter amount greater than 0', 'error');
    return;
  }

  const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI_MIN, ws.signer);
  const presale = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, ws.signer);

  try {
    const allowance = await usdt.allowance(ws.address, PRESALE_ADDRESS);

    if (allowance.lt(amountBN)) {
      showNotification?.('Approving USDT...', 'success');

      try {
        const txA = await usdt.approve(PRESALE_ADDRESS, amountBN);
        await txA.wait(1);
      } catch (e) {
        console.warn('[TRADING] approve failed, retry with gasLimit:', e?.message || e);
        const txA = await usdt.approve(PRESALE_ADDRESS, amountBN, { gasLimit: 150000 });
        await txA.wait(1);
      }
    }

    // preflight callStatic via unified provider
    try {
      const sim = await getPresaleSim();
      // ⚠️ ВАЖНО: симуляция должна быть в той же сети (Arbitrum).
      await sim.callStatic.buyWithUSDT(amountBN, withBonus, { from: ws.address });
    } catch (e) {
      console.error('[BUY] callStatic reverted:', e);
      console.error('[BUY] callStatic details:', explainEthersError(e));
      showNotification?.(pickEthersMessage(e), 'error');
      return;
    }

    showNotification?.(
      withBonus ? 'Buying with bonus (90d lock)...' : 'Buying ARUB...',
      'success'
    );

    let tx;
    try {
      tx = await presale.buyWithUSDT(amountBN, withBonus);
    } catch (e) {
      console.warn('[BUY] buyWithUSDT failed, retry with gasLimit:', e?.message || e);
      tx = await presale.buyWithUSDT(amountBN, withBonus, { gasLimit: 900000 });
    }

    await tx.wait(1);

    showNotification?.(
      withBonus ? 'Payment received. ARUB is locked.' : 'Purchase successful. ARUB credited.',
      'success'
    );

    try { await refreshBalances?.(); } catch (_) {}
    try { await loadMyLockInfo?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshBuyBonusBox?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}

    console.log('[TRADING] buy tx:', tx.hash);
    return tx;
  } catch (e) {
    console.error('[TRADING] buyTokens error:', e);
    console.error('[BUY] reverted details:', explainEthersError(e));

    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      try { await refreshBalances?.(); } catch (_) {}
      try { await refreshLockPanel?.(); } catch (_) {}
      try { await refreshSellFee?.(); } catch (_) {}
      return;
    }

    showNotification?.(pickEthersMessage(e), 'error');
    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}
    return;
  }
}


export async function sellTokens(arubAmount) {
  const ws = window.walletState;

  console.log('[TRADING] sellTokens start', {
    address: ws?.address,
    chainId: ws?.chainId,
    input: arubAmount,
  });

  if (!ws?.signer || !ws?.address) {
    showNotification?.('Connect wallet first', 'error');
    return;
  }

  // ✅ единый гейтинг сети
  try {
    requireArbitrumOrThrow(ws);
  } catch (e) {
    showNotification?.(e?.message || 'Wrong network. Please switch to Arbitrum', 'error');
    return;
  }

  let amountBN;
  try {
    amountBN = parseTokenAmount(arubAmount, DECIMALS_ARUB);
  } catch (e) {
    showNotification?.(e?.message || '\u041d\u0435\u043a\u043e\u0440\u0435\u043a\u0442\u043d\u0430 \u0441\u0443\u043c\u0430', 'error');
    return;
  }

  if (amountBN.isZero?.() === true) {
    showNotification?.('\u0421\u0443\u043c\u0430 \u043c\u0430\u0454 \u0431\u0443\u0442\u0438 \u0431\u0456\u043b\u044c\u0448\u043e\u044e \u0437\u0430 0', 'error');
    return;
  }
  const minSellBN = parseTokenAmount(MIN_SELL_ARUB, DECIMALS_ARUB);
  if (amountBN.lt(minSellBN)) {
    showNotification?.(`\u041c\u0456\u043d. \u043f\u0440\u043e\u0434\u0430\u0436: ${MIN_SELL_ARUB} ARUB`, 'error');
    return;
  }

  const arub = new ethers.Contract(ARUB_TOKEN_ADDRESS, ERC20_ABI_MIN, ws.signer);
  const presale = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, ws.signer);

  // Guard: redeem limited by presale redeemableBalance
  const redeemable = await presale.redeemableBalance(ws.address);
  if (amountBN.gt(redeemable)) {
    showNotification?.(
      `Exceeds redeemable balance. Max: ${ethers.utils.formatUnits(redeemable, DECIMALS_ARUB)} ARUB`,
      'error'
    );
    return;
  }

  // soft warning
  try {
    const info = await loadMyLockInfo();
    if (info && Number(info.remaining) > 0) {
      showNotification?.(
        'Увага: у вас активний лок. Якщо контракт блокує redeem під час лока — транзакція може бути відхилена.',
        'info'
      );
    }
  } catch (_) {}

  try {
    const allowance = await arub.allowance(ws.address, PRESALE_ADDRESS);
    if (allowance.lt(amountBN)) {
      showNotification?.('Approving ARUB...', 'success');

      try {
        const txA = await arub.approve(PRESALE_ADDRESS, amountBN);
        await txA.wait(1);
      } catch (e) {
        console.warn('[TRADING] approve failed, retry with gasLimit:', e?.message || e);
        const txA = await arub.approve(PRESALE_ADDRESS, amountBN, { gasLimit: 150000 });
        await txA.wait(1);
      }
    }

    showNotification?.('Redeeming for USDT...', 'success');

    let tx;
    try {
      tx = await presale.redeemForUSDT(amountBN);
    } catch (e) {
      console.warn('[TRADING] redeem failed, retry with gasLimit:', e?.message || e);
      tx = await presale.redeemForUSDT(amountBN, { gasLimit: 900000 });
    }
    await tx.wait(1);

    showNotification?.('Redeem successful. USDT credited.', 'success');

    try { await refreshBalances?.(); } catch (_) {}
    try { await loadMyLockInfo?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}

    console.log('[TRADING] redeem tx:', tx.hash);
    return tx;
  } catch (e) {
    console.error('[TRADING] sellTokens error:', e);
    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      try { await refreshBalances?.(); } catch (_) {}
      try { await refreshLockPanel?.(); } catch (_) {}
      try { await refreshSellFee?.(); } catch (_) {}
      return;
    }
    showNotification?.(pickEthersMessage(e), 'error');
    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}
    return;
  }
}

export async function unlockDeposit() {
  const ws = window.walletState;
  if (!ws?.signer) {
    showNotification?.('Connect wallet first', 'error');
    return;
  }

  const presale = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, ws.signer);

  try {
    showNotification?.('Unlocking deposit...', 'success');
    const tx = await presale.unlockDeposit();
    await tx.wait(1);
    showNotification?.('ARUB unlocked and transferred.', 'success');

    try {
      await refreshBalances?.();
    } catch (_) {}
    try {
      await loadMyLockInfo?.();
    } catch (_) {}
    try {
      await refreshLockPanel?.();
    } catch (_) {}
    try {
      await refreshSellFee?.();
    } catch (_) {}

    return tx;
  } catch (e) {
    console.error('[TRADING] unlockDeposit error:', e);
    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      try { await refreshBalances?.(); } catch (_) {}
      try { await refreshLockPanel?.(); } catch (_) {}
      try { await refreshSellFee?.(); } catch (_) {}
      return;
    }
    showNotification?.(pickEthersMessage(e), 'error');
    try { await refreshBalances?.(); } catch (_) {}
    try { await refreshLockPanel?.(); } catch (_) {}
    try { await refreshSellFee?.(); } catch (_) {}
    return;
  }
}

export async function loadMyLockInfo() {
  const ws = window.walletState;
  if (!ws?.address) return null;

  const expectedChainId = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  if (ws?.chainId && Number(ws.chainId) !== expectedChainId) return null;

  const presaleRO = await getReadOnlyPresale();
  if (!presaleRO) return null;

  try {
    const [principalLocked, bonusLocked, unlockUntilRaw, remainingRaw] =
      await Promise.all([
        presaleRO.lockedPrincipalArub(ws.address),
        presaleRO.lockedBonusArub(ws.address),
        presaleRO.lockedDepositUntil(ws.address),
        presaleRO.getRemainingLockTime(ws.address),
      ]);

    const unlockTime = Number(unlockUntilRaw.toString());
    const remaining = Number(remainingRaw.toString());

    return { principalLocked, bonusLocked, unlockTime, remaining };
  } catch (e) {
    console.warn('[TRADING] loadMyLockInfo failed:', {
      code: e?.code,
      reason: e?.reason,
      message: e?.message,
      errorMessage: e?.error?.message,
      body: e?.error?.body,
    });
    await refreshUiAfterRpcError({ includeLockPanel: false, includeSellFee: false });
    return null;
  }
}

