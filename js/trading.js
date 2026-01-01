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
import { ERC20_ABI, ERC20_ABI_MIN, PRESALE_READ_ABI } from './abis.js';
import { getReadOnlyPresale } from './contracts.js';
import { CONFIG } from './config.js';

const rpcProvider = new ethers.providers.JsonRpcProvider(
  CONFIG.NETWORK.rpcUrls[0],
  CONFIG.NETWORK.chainId
);

// -----------------------------
// Addresses (presale + token proxies)
// -----------------------------
// Keep defaults here as a safety net; prefer setting these in config.js.
const PRESALE_ADDRESS = CONFIG?.PRESALE_ADDRESS || '0x986833160f8E9636A6383BfAb5BeF35739edA1eC';
const ARUB_TOKEN_ADDRESS = CONFIG?.ARUB_TOKEN_ADDRESS || CONFIG?.TOKEN_ADDRESS || '0x161296CD7F742220f727e1B4Ccc02cAEc71Ed2C6';
const USDT_ADDRESS = CONFIG?.USDT_ADDRESS || '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const TERMS_NOTICE = {
  ua: 'Натискаючи кнопку, ви підтверджуєте, що ознайомилися та погоджуєтеся з умовами і правилами смарт-контракту.',
  en: 'By clicking the button, you confirm that you have read and agree to the smart contract terms and rules.',
};


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

// ТЕКУЩИЙ вариант (через кошелёк)
const buyContract = new ethers.Contract(
  BUY_CONTRACT_ADDRESS,
  BUY_ABI,
  signer // или ethersProvider
);

const buyContractSim = new ethers.Contract(
  BUY_CONTRACT_ADDRESS,
  BUY_ABI,
  rpcProvider
);

const PRESALE_ABI_MIN = [
  // write
  'function buyWithUSDT(uint256 amount, bool withBonus) external',
  'function unlockDeposit() external',
  'function redeemForUSDT(uint256 arubAmount) external',
  'function claimDebt() external',

  // key redeem limiter
  'function redeemableBalance(address) view returns (uint256)',

  // lock info
  'function getMyLockedInfo() view returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)',
  'function lockedPrincipalArub(address) view returns (uint256)',
  'function lockedBonusArub(address) view returns (uint256)',
  'function lockedDepositUntil(address) view returns (uint256)',
  'function getRemainingLockTime(address user) view returns (uint256)',

  // discount
  'function getDiscountPercent() view returns (uint256)',
  'function totalDiscountBuyers() view returns (uint256)',
  'function DISCOUNT_MAX_BUYERS() view returns (uint256)',
  'function isDiscountBuyer(address) view returns (bool)',

  // sell fee
  'function getMySellFeeBps() view returns (uint256)',
  'function getUserSellFeeBps(address user) view returns (uint256)',

  // debt
  'function debtUsdtEquivalent(address) view returns (uint256)',
];

function getUiLang() {
  const l = String(navigator.language || '').toLowerCase();
  return l.startsWith('en') ? 'en' : 'ua';
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

// Prevent overlapping apply cycles
let applySeq = 0;

// -----------------------------
// DOM helpers
// -----------------------------

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
    minute: '2-digit'
  }).format(d);
}

let lockRefreshTimer = null;

async function refreshLockPanel() {
  const panel = el('lockPanel');
  if (!panel) return;

  // hide if not connected
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

  const hasLock =
    (principal?.gt && principal.gt(0)) ||
    (bonus?.gt && bonus.gt(0));

  if (!hasLock) {
  panel.style.display = 'none';

  // Lock panel hidden; selling is governed by wallet balance/connection elsewhere.
  // Do not disable/enable sell here.
  const hint = el('sellLockHint');
  if (hint) hint.style.display = 'none';

  return;
}

  // Bonus % = bonus / principal * 100
const bonusInfo = el('buyBonusInfo');
const bonusPctEl = el('buyBonusPct');

if (bonusInfo && bonusPctEl) {
  if (principal?.gt && principal.gt(0) && bonus?.gt && bonus.gt(0)) {
    // bps = (bonus / principal) * 10000
    const bpsBN = bonus.mul(10000).div(principal); // BigNumber
    const pct = Number(bpsBN.toString()) / 100;    // 2 decimals

    bonusInfo.style.display = '';
    bonusPctEl.textContent = `${pct.toFixed(2)}%`;
  } else {
    // если бонуса нет — можно скрывать, либо показывать 0%
    bonusInfo.style.display = '';
    bonusPctEl.textContent = '0.00%';
  }
}

  panel.style.display = '';

 setText('lockedPrincipal', formatTokenAmount(principal, DECIMALS_ARUB, 6));
 setText('lockedBonus',     formatTokenAmount(bonus,     DECIMALS_ARUB, 6));
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
    }
  }

   // Sell lock hint (informational only; selling is allowed for wallet-available ARUB)
  const hint = el('sellLockHint');
  const left = el('sellLockLeft');

  if (hint && left) {
    const now = Math.floor(Date.now() / 1000);
    const unlockTime = Number(info.unlockTime || 0);

    if (unlockTime > now) {
      hint.style.display = 'block';
      left.textContent = formatRemaining(info.remaining || (unlockTime - now));
    } else {
      hint.style.display = 'none';
      left.textContent = '—';
    }
  }

  // Sell fee
  try {
    let feeBps = null;

    // prefer "my" fee when signer exists
    if (user.signer) {
      const presaleAsSigner = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, user.signer);
      if (presaleAsSigner.getMySellFeeBps) feeBps = await presaleAsSigner.getMySellFeeBps();
    }

    // fallback to address-based
    if (feeBps == null) {
      const rpc = CONFIG?.NETWORK?.rpcUrls?.[0];
      const roProvider = rpc ? new ethers.providers.JsonRpcProvider(rpc) : user.provider;
      const presaleRO = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, roProvider);
      if (presaleRO.getUserSellFeeBps) feeBps = await presaleRO.getUserSellFeeBps(user.address);
    }

    if (feeBps != null) {
      const pct = Number(feeBps.toString()) / 100; // bps -> %
      setText('sellFee', `${pct.toFixed(2)}%`);
    }
  } catch (_) {}
}

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
          Ліміти: мінімум 10 USDT · максимум 1000 USDT за покупку · 3000 USDT на гаманець
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
              style="width:100%; padding:12px; border-radius:12px; border:0; cursor:pointer;">
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
        <input id="sellAmount" type="number" inputmode="decimal" placeholder="Сума ARUB"
               style="flex:1; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff;">
        <button id="maxSellBtn" type="button"
                style="padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color:#fff; cursor:pointer;">
          МАКС
        </button>
      </div>

      <button id="sellBtn" type="button"
              style="width:100%; padding:12px; border-radius:12px; border:0; cursor:pointer;">
        Продати ARUB
      </button>
<div style="margin-top:10px; font-size:13px; opacity:0.9;">
  Комісія при продажу: <span id="sellFee">—</span>
</div>
<div id="sellLockHint" style="display:none; margin-top:6px; font-size:13px; opacity:0.85;">
  Активний лок бонусної покупки. Продаж вільних ARUB дозволено. Залишилось: <span id="sellLockLeft">—</span>
</div>
      <div style="margin-top:10px; font-size:14px; opacity:0.9;">
        Баланс ARUB: <span id="arubBalance">—</span>
      </div>
    </div>
  </div>
`;

  bindUiOncePerRender();
  hardUnlock();
  refreshBuyBonusBox().catch(()=>{});
}

function formatRemaining(sec) {
  sec = Math.max(0, sec);
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600);  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  return `${d ? d + ' д ' : ''}${h ? h + ' год ' : ''}${m} хв`;
}
async function refreshBuyBonusBox() {
  const box = el('buyBonusBox');
  const pctEl = el('buyBonusPct');
  const slotsEl = el('buyBonusSlots');
  const noteEl = el('buyBonusNote');

  if (!box || !pctEl || !slotsEl) return;

  const isBonusMode = getBuyMode() === 'discount';
  box.style.display = isBonusMode ? '' : 'none';
  if (!isBonusMode) return;

  if (!user.address) {
    pctEl.textContent = '—';
    slotsEl.textContent = '—';
    if (noteEl) noteEl.style.display = 'none';
    return;
  }

  try {
    const rpc = CONFIG?.NETWORK?.rpcUrls?.[0];
    const roProvider = rpc ? new ethers.providers.JsonRpcProvider(rpc) : user.provider;
    const presaleRO = new ethers.Contract(PRESALE_ADDRESS, PRESALE_READ_ABI, roProvider);

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
      try { maxBN = await presaleRO.DISCOUNT_MAX_BUYERS(); } catch (_) { maxBN = null; }

      const used = Number(usedBN.toString());

      if (maxBN != null) {
        const max = Number(maxBN.toString());
        left = Math.max(0, max - used);
      } else {
        // fallback if getter not available
        const FALLBACK_MAX = 100;
        left = Math.max(0, FALLBACK_MAX - used);
      }
    } catch (_) {}

        pctEl.textContent = (percent != null ? `${percent}%` : '—');
    if (noteEl) noteEl.style.display = '';

    // Mirror the same bonus % in the presale stats block (under Sell)
    const bonusOut = document.getElementById('presaleBonusPct');
    if (bonusOut) bonusOut.textContent = (percent != null ? `${percent}%` : '—');
slotsEl.textContent = (left != null ? String(left) : '—');
  } catch (e) {
    console.warn('[TRADING] refreshBuyBonusBox failed:', e?.message || e);
    pctEl.textContent = '—';
    slotsEl.textContent = '—';
    if (noteEl) noteEl.style.display = 'none';
  }
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
  tokenRO = new ethers.Contract(CONFIG?.TOKEN_ADDRESS, ERC20_ABI, roProvider);
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

  tokenRW = new ethers.Contract(CONFIG?.TOKEN_ADDRESS, ERC20_ABI, user.signer);
  usdtRW  = new ethers.Contract(CONFIG.USDT_ADDRESS,  ERC20_ABI, user.signer);

  (async () => {
    try { if (tokenRW?.decimals) DECIMALS_ARUB = Number(await tokenRW.decimals()); } catch (_) {}
    try { if (usdtRW?.decimals) DECIMALS_USDT = Number(await usdtRW.decimals()); } catch (_) {}
    console.log('[TRADING] decimals synced (RW):', { DECIMALS_ARUB, DECIMALS_USDT });
  })();
}

// === ВСТАВИТЬ СЮДА ===
function ensurePresaleUI() {
  const bal = document.getElementById('arubBalance');
  if (!bal) return;

  // защита от повторной вставки
  if (document.getElementById('presaleStats')) return;

  const box = document.createElement('div');
  box.id = 'presaleStats';
  box.style.marginTop = '8px';
  box.style.fontSize = '13px';
  box.style.opacity = '0.85';
  box.innerHTML = `
  <div>Куплено на пресейлі: <span id="presalePurchased">—</span> ARUB</div>
  <div>Сплачено: <span id="presalePaid">—</span> USDT</div>
  <div>Середня ціна купівлі: <span id="presaleAvgPrice">—</span> USDT/ARUB</div>
  <div>Бонус: <span id="presaleBonusPct">—</span></div>

  <!-- Presale scan progress -->
  <div id="presaleScanWrap" style="display:none; margin-top:10px;">
    <div style="display:flex; justify-content:space-between; font-size:12px; opacity:.85;">
      <span>Завантаження історії пресейлу…</span>
      <span id="presaleScanPct">0%</span>
    </div>
    <div style="height:8px; background:rgba(255,255,255,.12); border-radius:999px; overflow:hidden; margin-top:6px;">
      <div id="presaleScanBar"
           style="height:100%; width:0%; background:rgba(255,255,255,.65);">
      </div>
    </div>
  </div>
`;

  // вставляем прямо под баланс
  bal.parentElement.appendChild(box);
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

    setText('arubBalance', formatTokenAmount(arubBal, DECIMALS_ARUB, 6));
    ensurePresaleUI();
    setText('usdtBalance', formatTokenAmount(usdtBal, DECIMALS_USDT, 2));

    // Enable SELL based on actual wallet ARUB balance (lock does not restrict redeem)
    setDisabled('sellBtn', arubBal.lte(0));
    setDisabled('maxSellBtn', arubBal.lte(0));

    const sellInp = el('sellAmount');
    if (sellInp) sellInp.disabled = arubBal.lte(0);

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
  // BUY
const buyBtn = el('buyBtn');
if (buyBtn) {
  buyBtn.onclick = async () => {
    try {
      // --- TERMS CONFIRM (UA / EN) ---
      const lang = getUiLang(); // 'ua' | 'en'
      const msg = TERMS_NOTICE[lang] || TERMS_NOTICE.ua;

      const ok = confirm(msg);
      if (!ok) return;

      const amount = el('buyAmount')?.value ?? '';
      const withBonus = getBuyMode() === 'discount';
      await buyTokens(amount, withBonus);

      // после успешной покупки обновим бонус-бокс
      try { await refreshBuyBonusBox(); } catch (_) {}
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

  // Buy mode change -> update bonus info
  document.querySelectorAll('input[name="buyMode"]').forEach(r => {
    r.onchange = () => { refreshBuyBonusBox().catch(() => {}); };
  });

  // Первичное обновление
  refreshBuyBonusBox().catch(() => {});
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
    stopLockAutoRefresh();
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
    // Hide lock panel until we have a stable provider/address
    try { const lp = el('lockPanel'); if (lp) lp.style.display = 'none'; } catch (_) {}

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
    await refreshLockPanel();
    startLockAutoRefresh();
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
  if (!user.address || !tokenRO) throw new Error("Wallet not connected");

  const presaleRO = getReadOnlyPresale();

  const bal = await tokenRO.balanceOf(user.address);
  const redeemable = await presaleRO.redeemableBalance(user.address);

  // Уведомление, если ARUB есть, но redeem запрещён
  if (redeemable.isZero() && !bal.isZero()) {
    showNotification?.(
      'На вашому гаманці є ARUB, але Presale зараз не дозволяє його викуп (redeemable = 0). Ймовірно, ці токени не були куплені через цей Presale.',
      'info'
    );
  }

  // maxSell = min(balance, redeemableBalance)
  const maxSell = redeemable.lt(bal) ? redeemable : bal;

  const v = ethers.utils.formatUnits(maxSell, DECIMALS_ARUB);
  const inp = el("sellAmount");
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

function isUserRejectedTx(e) {
  return (
    e?.code === 4001 ||
    e?.code === 'ACTION_REJECTED' ||
    /user rejected|user denied|rejected/i.test((e?.message || '') + ' ' + (e?.error?.message || ''))
  );
}

function isTrustWalletProvider() {
  const p = window.walletState?.eip1193 || window.ethereum;
  return !!(p && (p.isTrust || p.isTrustWallet));
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

export async function buyTokens(usdtAmount, withBonus = false) {
  const ws = window.walletState;

  console.log('[TRADING] buyTokens start', {
    address: ws?.address,
    chainId: ws?.chainId,
    input: usdtAmount,
    withBonus,
  });

  if (!ws?.signer || !ws?.address) {
    showNotification?.('Connect wallet first', 'error');
    return;
  }

  const expectedChainId = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  if (ws?.chainId && Number(ws.chainId) !== expectedChainId) {
    showNotification?.('Wrong network. Please switch to Arbitrum', 'error');
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

  // contracts (wallet/signer)
  const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI_MIN, ws.signer);

  // ВАЖНО: ABI должен содержать buyWithUSDT
  // Если у вас есть только PRESALE_ABI_MIN, убедитесь что там есть сигнатура buyWithUSDT
  const presale = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, ws.signer);

  // contract for simulation (RPC)
 const { provider: readProvider, via } = await pickWorkingRpc(CONFIG.NETWORK.rpcUrls);

const presaleSim = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, readProvider);

// Если via === 'wallet', можно (опционально) отключить preflight или принять, что revert data может быть хуже

  try {
    // 1) allowance / approve
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

    // 2) preflight callStatic (RPC) — ДО покупки
    try {
      await presaleSim.callStatic.buyWithUSDT(
        amountBN,
        withBonus,
        { from: ws.address }
      );
    } catch (e) {
      console.error('[BUY] callStatic reverted:', e);
      console.error('[BUY] callStatic details:', {
        code: e?.code,
        reason: e?.reason,
        message: e?.message,
        dataMessage: e?.data?.message,
        errorMessage: e?.error?.message,
        errorData: e?.error?.data,
        data: e?.data,
        body: e?.error?.body,
      });

      showNotification?.(pickEthersMessage(e), 'error');
      return;
    }

    // 3) buy tx (wallet)
    showNotification?.(
      withBonus ? 'Buying with bonus (90d lock)...' : 'Buying ARUB...',
      'success'
    );

    let tx;
    try {
      // сначала пробуем без overrides
      tx = await presale.buyWithUSDT(amountBN, withBonus);
    } catch (e) {
      // если у Trust/MetaMask падает estimateGas — пробуем с gasLimit
      console.warn('[BUY] buyWithUSDT failed, retry with gasLimit:', e?.message || e);
      tx = await presale.buyWithUSDT(amountBN, withBonus, { gasLimit: 900000 });
    }

    await tx.wait(1);

    showNotification?.(
      withBonus
        ? 'Payment received. ARUB is locked.'
        : 'Purchase successful. ARUB credited.',
      'success'
    );

    try { await refreshBalances?.(); } catch (_) {}
    try { await loadMyLockInfo?.(); } catch (_) {}
    try { await refreshBuyBonusBox?.(); } catch (_) {}

    console.log('[TRADING] buy tx:', tx.hash);
    return tx;
  } catch (e) {
    console.error('[TRADING] buyTokens error:', e);
    console.error('[BUY] reverted details:', {
      code: e?.code,
      reason: e?.reason,
      message: e?.message,
      shortMessage: e?.shortMessage,
      dataMessage: e?.data?.message,
      errorMessage: e?.error?.message,
      errorData: e?.error?.data,
      data: e?.data,
      body: e?.error?.body,
    });

    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      return;
    }

    showNotification?.(pickEthersMessage(e), 'error');
    return;
  }
}

// Продажа (redeem) ARUB -> USDT через presale.
// ВАЖНО: если у пользователя активен lock (покупка со скидкой), контракт будет revert.
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

  const expectedChainId = Number(CONFIG?.NETWORK?.chainId ?? 42161);
  if (ws?.chainId && Number(ws.chainId) !== expectedChainId) {
    showNotification?.('Wrong network. Please switch to Arbitrum', 'error');
    return;
  }

  let amountBN;
  try {
    amountBN = parseTokenAmount(arubAmount, DECIMALS_ARUB);
  } catch (e) {
    showNotification?.(e?.message || 'Invalid amount', 'error');
    return;
  }

  if (amountBN.isZero?.() === true) {
    showNotification?.('Enter amount greater than 0', 'error');
    return;
  }

  const arub = new ethers.Contract(ARUB_TOKEN_ADDRESS, ERC20_ABI_MIN, ws.signer);
  const presale = new ethers.Contract(PRESALE_ADDRESS, PRESALE_ABI_MIN, ws.signer);
  // Guard: redeem is limited by presale redeemableBalance
const redeemable = await presale.redeemableBalance(ws.address);
if (amountBN.gt(redeemable)) {
  showNotification?.(
    `Exceeds redeemable balance. Max: ${ethers.utils.formatUnits(redeemable, DECIMALS_ARUB)} ARUB`,
    'error'
  );
  return;
}

  // Мягкое предупреждение (не блокирует)
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
    // Trust Wallet часто падает на estimateGas → повторяем с ручным gasLimit
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
  // Trust Wallet estimateGas bug workaround
  console.warn('[TRADING] redeem failed, retry with gasLimit:', e?.message || e);
  tx = await presale.redeemForUSDT(amountBN, { gasLimit: 900000 });
}
await tx.wait(1);

    showNotification?.('Redeem successful. USDT credited.', 'success');

    try { await refreshBalances?.(); } catch (_) {}
    try { await loadMyLockInfo?.(); } catch (_) {}

    console.log('[TRADING] redeem tx:', tx.hash);
    return tx;
  } catch (e) {
    console.error('[TRADING] sellTokens error:', e);
    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      return;
    }
    showNotification?.(pickEthersMessage(e), 'error');
    return;
  }
}

// Разблокировка ARUB после 90 дней (только для discounted режима)
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

    try { await refreshBalances?.(); } catch (_) {}
    try { await loadMyLockInfo?.(); } catch (_) {}
    return tx;
  } catch (e) {
    console.error('[TRADING] unlockDeposit error:', e);
    if (isUserRejectedTx(e)) {
      showNotification?.('Transaction rejected in wallet', 'error');
      return;
    }
    showNotification?.(pickEthersMessage(e), 'error');
    return;
  }
}

// Данные лока для UI
export async function loadMyLockInfo() {
  const ws = window.walletState;
  if (!ws?.address) return null;

  const presaleRO = getReadOnlyPresale(); // <-- берём один раз, нормально

  try {
    const [principalLocked, bonusLocked, unlockUntilRaw, remainingRaw] = await Promise.all([
      presaleRO.lockedPrincipalArub(ws.address),
      presaleRO.lockedBonusArub(ws.address),
      presaleRO.lockedDepositUntil(ws.address),
      presaleRO.getRemainingLockTime(ws.address),
    ]);

    const unlockTime = Number(unlockUntilRaw.toString());
    const remaining  = Number(remainingRaw.toString());

    return { principalLocked, bonusLocked, unlockTime, remaining };
  } catch (e) {
    console.warn('[TRADING] loadMyLockInfo failed:', e?.message || e);
    return null;
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

