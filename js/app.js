/**
 * Main Application Entry Point (Vault-only)
 * Initializes modules and manages global state
 * Staking/Faucet removed.
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { initWalletModule, getEthersProvider, getAvailableWallets, connectWallet, disconnectWallet } from './wallet.js';
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount } from './ui.js';
import { initReadOnlyContracts, getReadOnlyProviderAsync, getArubPrice, getTotalSupplyArub } from './contracts.js';

initWalletModule(); // важно: до любых renderWallets()

// Публикуем API кошелька ОДИН РАЗ и НЕ ПЕРЕЗАТИРАЕМ ниже
window.getAvailableWallets = getAvailableWallets;
window.connectWallet = connectWallet;           // реальный connectWallet({walletId})
window.disconnectWallet = disconnectWallet;

if (typeof window.walletState === 'undefined') window.walletState = null;

console.log('[app] wallet api ready', typeof window.getAvailableWallets, typeof window.connectWallet);

// -----------------------------
// Read-only provider (stable RPC)
// -----------------------------
console.log('[APP] module loaded:', import.meta.url);

let tradingInitDone = false;
let tradingMounted = false;

// -----------------------------
// Trading UI init (idempotent)
// -----------------------------
async function ensureTradingUI(reason = 'unknown') {
  const box = document.getElementById('tradingInterface');
  if (!box) return;

  try {
    await initTradingModule();
    tradingInitDone = true;
    console.log('[UI] ensureTradingUI ok', { reason });
  } catch (e) {
    console.warn('[UI] ensureTradingUI failed', reason, e?.message || e);
  }
}

// 1) после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  ensureTradingUI('DOMContentLoaded');
});

// 2) после любого изменения кошелька
window.addEventListener('walletStateChanged', () => {
  ensureTradingUI('walletStateChanged');
});

// -----------------------------
// Debug helpers
// -----------------------------
async function debugPresaleMath(address) {
  const provider = await getReadOnlyProviderAsync();

  const arub = new ethers.Contract(
    CONFIG.TOKEN_ADDRESS,
    ['function decimals() view returns (uint8)'],
    provider
  );

  const oracle = new ethers.Contract(
    CONFIG.ORACLE_ADDRESS,
    ['function rate() view returns (uint256)'],
    provider
  );

  const arubDecimals = await arub.decimals();
  const oracleRateRaw = await oracle.rate();

  console.log('[DEBUG] ARUB decimals =', arubDecimals);
  console.log('[DEBUG] Oracle rate raw =', oracleRateRaw.toString());
}

// -----------------------------
// Wallet UI update hook
// -----------------------------
window.addEventListener('walletStateChanged', () => updateWalletUI('walletStateChanged'));

// Legacy: keep CONFIG global
window.CONFIG = window.CONFIG || CONFIG;

// -----------------------------
// Compatibility: unify ids across pages
// -----------------------------
(function () {
  const d1 = document.getElementById('disconnectWalletBtn');
  const d2 = document.getElementById('walletDisconnect');
  if (!d1 && d2) d2.id = 'disconnectWalletBtn';

  const dropdown = document.getElementById('walletDropdown');
  const menu = document.getElementById('walletMenu');

  // если на странице старый id walletMenu — приводим к единому walletDropdown
  if (!dropdown && menu) menu.id = 'walletDropdown';
})();

// -----------------------------
// Wallet dropdown rendering
// -----------------------------
export async function renderWallets() {
  console.log('[UI] renderWallets() start', {
    hasDropdown: !!document.getElementById('walletDropdown'),
    typeofGetAvailableWallets: typeof window.getAvailableWallets,
    typeofConnectWallet: typeof window.connectWallet
  });

  const dd = document.getElementById('walletDropdown');
  if (!dd) {
    console.warn('[UI] walletDropdown not found');
    return;
  }

  // Close both wallet picker dropdown and the separate wallet menu (if present)
  const closeWalletUI = () => {
  dd.classList.remove('open');
  dd.querySelector('.wallet-list')?.classList.add('is-hidden');
  document.getElementById('walletMenu')?.classList.remove('open');
  document.querySelector('.wallet-menu')?.classList.remove('open');
  try { document.activeElement?.blur?.(); } catch (_) {}
};

  // bind dropdown handler once (stop propagation + disconnect)
  if (!dd.dataset.bound) {
    dd.dataset.bound = '1';

    dd.addEventListener('click', async (e) => {
      e.stopPropagation();

      const disconnectBtn = e.target.closest?.('#disconnectWalletBtn');
      if (!disconnectBtn) return;

      e.preventDefault();

      if (dd.dataset.disconnecting === '1') return;
      dd.dataset.disconnecting = '1';

      try {
        await window.disconnectWallet?.();

        try { window.updateWalletUI?.('disconnected'); } catch (_) {}
        try { renderWallets?.(); } catch (_) {}

        closeWalletUI();
      } catch (err) {
        console.warn('[UI] disconnectWallet failed:', err);
      } finally {
        dd.dataset.disconnecting = '0';
      }
    });
  }

  // контейнер списка — строго после .wallet-actions
  let list = dd.querySelector('.wallet-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'wallet-list';

    const actions = dd.querySelector('.wallet-actions');
    if (actions && actions.parentNode === dd) {
      actions.insertAdjacentElement('afterend', list);
    } else {
      dd.appendChild(list);
    }
  }

  const getWalletsSafe = () => {
    try {
      const fn = window.getAvailableWallets;
      const w = (typeof fn === 'function') ? (fn() || []) : [];
      return Array.isArray(w) ? w : [];
    } catch (e) {
      console.warn('[UI] getAvailableWallets failed:', e);
      return [];
    }
  };

  // ------------------------------------------
  // загрузим список кошельков (EIP-6963 async)
  // ------------------------------------------
  let wallets = getWalletsSafe();

  if (!wallets || wallets.length <= 1) {
    await new Promise(r => setTimeout(r, 120));
    wallets = getWalletsSafe();
  }
  if (!wallets || wallets.length <= 1) {
    await new Promise(r => setTimeout(r, 200));
    wallets = getWalletsSafe();
  }

  if (!Array.isArray(wallets) || wallets.length === 0) {
    list.innerHTML = 
    list.classList.remove('is-hidden');`
      <div class="wallet-list-title">Гаманці не знайдено</div>
      <div class="wallet-list-hint">Увімкніть розширення гаманця (MetaMask / Trust / Phantom / Uniswap).</div>
    `;
    return;
  }

  // ------------------------------------------
  // normalize + de-duplicate by id
  // ------------------------------------------
  const seen = new Set();
  const norm = wallets
    .map((w) => {
      const id = w?.walletId ?? w?.id ?? w?.entryId ?? null;
      const label =
        w?.entryName ??
        w?.name ??
        w?.entryId ??
        w?.walletId ??
        w?.id ??
        'Wallet';

      const type = w?.type ?? '';
      return { id, label, type };
    })
    .filter(x => !!x.id)
    .filter(x => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });

  if (norm.length === 0) {
    list.innerHTML = `
      <div class="wallet-list-title">Гаманці не знайдено</div>
      <div class="wallet-list-hint">Невірний формат списку гаманців (walletId/id відсутній).</div>
    `;
    console.warn('[UI] wallets list has no usable ids:', wallets);
    return;
  }

  // сортировка: eip6963 -> injected, дальше по имени
  const rank = (t) => (t === 'eip6963' ? 0 : 1);
  norm.sort((a, b) => {
    const ra = rank(a.type), rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    return String(a.label).localeCompare(String(b.label));
  });

  // ------------------------------------------
  // render list (text-only)
  // ------------------------------------------
  list.innerHTML = `
    <div class="wallet-list-title">Оберіть гаманець</div>
    <div class="wallet-items">
      ${norm.map(w => `
        <div class="wallet-item-textonly" data-wallet-id="${escapeHtml(String(w.id))}">
          ${escapeHtml(String(w.label))}
        </div>
      `).join('')}
    </div>
  `;

  console.log('[UI] wallet items rendered:', list.querySelectorAll('.wallet-item-textonly').length);

  // bind click handler once (event delegation) for wallet items
  if (!list.dataset.bound) {
    list.dataset.bound = '1';

    list.addEventListener('click', async (e) => {
      const item = e.target.closest?.('.wallet-item-textonly');
      if (!item) return;

      e.stopPropagation();

      const walletId = item.getAttribute('data-wallet-id');
      if (!walletId) return;

      if (window.__uiConnecting) return;
      window.__uiConnecting = true;

      try {
        closeWalletUI(); // закрываем сразу
        await window.connectWallet?.({ walletId });
        try { window.updateWalletUI?.('connected'); } catch (_) {}
        closeWalletUI(); // закрываем повторно
      } catch (err) {
        console.warn('[UI] connectWallet failed (walletId=%s):', walletId, err);
      } finally {
        window.__uiConnecting = false;
      }
    });
  }
}

// простая защита от HTML-инъекций
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortAddr(a) {
  if (!a || a.length < 10) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// -----------------------------
// Wallet menu / UI helpers
// -----------------------------
function bindWalletUiTradingPage() {
  const connectBtn = document.getElementById('connectBtn');
  const toggleBtn = document.getElementById('walletMenuToggle');
  const menu = document.getElementById('walletMenu');

  // toggle wallet menu
  toggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu?.classList.toggle('open');
  });

  // close menu on outside click
  document.addEventListener('click', (e) => {
    if (!menu || !toggleBtn) return;
    const wrap = menu.parentElement;
    if (menu.classList.contains('open') && wrap && !wrap.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // connect button opens your wallet picker
  connectBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { await renderWallets?.(); } catch (_) {}
  });

  // explorer
  document.getElementById('walletViewOnExplorer')?.addEventListener('click', () => {
    const a = window.walletState?.address;
    if (!a) return;
    window.open(`https://arbiscan.io/address/${a}`, '_blank');
    menu?.classList.remove('open');
  });

  // disconnect
  document.getElementById('walletDisconnect')?.addEventListener('click', async () => {
    try { await disconnectWallet?.(); } catch (_) {}
    menu?.classList.remove('open');
  });
}

function updateWalletUI(reason = 'unknown') {
  const ws = window.walletState;
  const connected = !!ws?.address && !!ws?.signer;

  console.log('[UI] updateWalletUI', { reason, connected, address: ws?.address, chainId: ws?.chainId });

  // Общая кнопка connect
  const connectBtn = document.getElementById('connectBtn');
  if (connectBtn) {
    connectBtn.textContent = connected ? shortAddr(ws.address) : 'Підключити гаманець';
    connectBtn.classList.toggle('connected', connected);
  }

  // INDEX / dashboard: dropdown + disconnectWalletBtn
  const disconnectBtn = document.getElementById('disconnectWalletBtn');
  const dropdown = document.getElementById('walletDropdown');

  if (disconnectBtn) {
    disconnectBtn.style.display = connected ? 'block' : 'none';
    disconnectBtn.onclick = async () => {
      try {
        await disconnectWallet();
      } finally {
        renderWallets?.();
        updateWalletUI('disconnected');
        if (dropdown) dropdown.classList.remove('open');
      }
    };
  }

  // TRADING page: wallet menu toggle + menu address + disconnect
  const toggleBtn = document.getElementById('walletMenuToggle');
  const menuAddr = document.getElementById('walletMenuAddress');

  if (toggleBtn) toggleBtn.hidden = !connected;
  if (menuAddr) menuAddr.textContent = connected ? ws.address : '—';

  const explorerBtn = document.getElementById('walletViewOnExplorer');
  if (explorerBtn) {
    explorerBtn.onclick = () => {
      const a = window.walletState?.address;
      if (!a) return;
      window.open(`https://arbiscan.io/address/${a}`, '_blank');
      document.getElementById('walletMenu')?.classList.remove('open');
    };
  }

  const walletDisconnect = document.getElementById('walletDisconnect');
  if (walletDisconnect) {
    walletDisconnect.onclick = async () => {
      try { await disconnectWallet?.(); } finally {
        document.getElementById('walletMenu')?.classList.remove('open');
      }
    };
  }

  // callbacks (if present)
  if (connected) {
    try { window.onWalletConnected?.(ws.address, { chainId: ws.chainId }); } catch (_) {}
  } else {
    try { window.onWalletDisconnected?.({}); } catch (_) {}
  }
}

// -----------------------------
// Dropdown close + disconnect binding (optional)
// -----------------------------
function setupWalletMenu() {
  if (window.__walletMenuBound) return;
  window.__walletMenuBound = true;

  const getMenuEl = () => document.getElementById('walletDropdown');
  const getAreaEl = () => document.querySelector('.wallet-button-area');

  // закрытие dropdown по клику вне
  document.addEventListener('click', (e) => {
    const menu = getMenuEl();
    const area = getAreaEl();
    if (!menu || !area) return;

    if (menu.classList.contains('open') && !area.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // клики внутри dropdown не закрывают его
  getMenuEl()?.addEventListener('click', (e) => e.stopPropagation());

  // Disconnect button
  document.getElementById('disconnectWalletBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    document.getElementById('walletDropdown')?.classList.remove('open');
    await disconnectWallet();
    try { renderWallets(); } catch (_) {}
    try { updateWalletUI?.('disconnected'); } catch (_) {}
  });
}

// -----------------------------
// Global stats
// -----------------------------
async function updateGlobalStats() {
  try {
    const [arubPriceInfo, totalSupply] = await Promise.all([
      getArubPrice(),
      getTotalSupplyArub()
    ]);

    const arubPrice = arubPriceInfo?.price;

    const setTextLocal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setTextLocal('arubPriceValue', Number.isFinite(arubPrice) ? arubPrice.toFixed(6) : '—');

    const supplyEl = document.getElementById('totalSupplyArub');
    if (supplyEl) supplyEl.textContent = formatTokenAmount(totalSupply) + ' ARUB';
  } catch (e) {
    console.warn('[APP] updateGlobalStats failed:', e?.message || e);
  }
}

// =======================
// PRESALE / ORACLE STATS
// =======================
const PRESALE_ABI_MIN = [
  'function totalDeposited(address) view returns (uint256)',
  'function lockedPrincipalArub(address) view returns (uint256)',
  'function lockedBonusArub(address) view returns (uint256)'
];

const ORACLE_ABI_MIN = [
  'function getRate() view returns (uint256,uint256)',
  'function rate() view returns (uint256)'
];

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function calcDiscount(avgPrice, currentPrice) {
  if (!avgPrice || !currentPrice || currentPrice <= 0) return null;
  return (1 - avgPrice / currentPrice) * 100;
}

const USDT_DECIMALS = 6;
const ARUB_DECIMALS = 6;

// 2025-12-15 16:30:03 UTC (ваш деплой)
const PRESALE_DEPLOY_UTC_MS = Date.parse('2025-12-15T16:30:03Z');

async function loadPresaleStats(user, provider) {
  const c = new ethers.Contract(CONFIG.PRESALE_ADDRESS, PRESALE_ABI_MIN, provider);

  const [paidRaw, principalRaw, bonusRaw] = await Promise.all([
    c.totalDeposited(user),
    c.lockedPrincipalArub(user),
    c.lockedBonusArub(user),
  ]);

  const paidUSDT = Number(ethers.utils.formatUnits(paidRaw, USDT_DECIMALS));
  const principalARUB = Number(ethers.utils.formatUnits(principalRaw, ARUB_DECIMALS));
  const bonusARUB = Number(ethers.utils.formatUnits(bonusRaw, ARUB_DECIMALS));
  const totalARUB = principalARUB + bonusARUB;

  const avgPrice = totalARUB > 0 ? (paidUSDT / totalARUB) : null;

  return { paidUSDT, totalARUB, avgPrice };
}

async function loadCurrentArubPrice(provider) {
  const oracle = new ethers.Contract(CONFIG.ORACLE_ADDRESS, ORACLE_ABI_MIN, provider);

  let rateRaw;
  try {
    const res = await oracle.getRate();
    rateRaw = res[0];
  } catch (_) {
    rateRaw = await oracle.rate();
  }

  const d = Number(CONFIG.ORACLE_RATE_DECIMALS ?? 6);
  return Number(ethers.utils.formatUnits(rateRaw, d));
}

// Event ABI: Purchased(buyer, usdtAmount, arubTotal, bonusArub, ...)
const PRESALE_EVENTS_ABI = [
  'event Purchased(address indexed buyer, uint256 usdtAmount, uint256 arubTotal, uint256 bonusArub, uint256 discountPercent, uint256 discountAppliedEq)'
];

// Находим ближайший блок по timestamp (бинарный поиск)
async function findBlockByTimestamp(provider, targetTsSec) {
  const latest = await provider.getBlockNumber();
  let lo = 1;
  let hi = latest;

  const bLo = await provider.getBlock(lo);
  if (bLo && bLo.timestamp >= targetTsSec) return lo;

  const bHi = await provider.getBlock(hi);
  if (bHi && bHi.timestamp <= targetTsSec) return hi;

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (!b) { hi = mid; continue; }

    if (b.timestamp < targetTsSec) lo = mid;
    else hi = mid;
  }
  return lo; // ближайший <= target
}

function setPresaleScanVisible(visible) {
  const wrap = document.getElementById('presaleScanWrap');
  if (!wrap) return;
  wrap.style.display = visible ? 'block' : 'none';
}

function setPresaleScanProgress(pct) {
  const bar = document.getElementById('presaleScanBar');
  const label = document.getElementById('presaleScanPct');
  if (!bar || !label) return;

  const p = Math.max(0, Math.min(100, Math.floor(pct)));
  label.textContent = `${p}%`;
  bar.style.width = `${p}%`;
}

// Сканируем Purchased в чанках, чтобы не упираться в лимиты RPC
async function loadPresaleStatsFromEvents(user, provider) {
  const presale = new ethers.Contract(
    CONFIG.PRESALE_ADDRESS,
    PRESALE_EVENTS_ABI,
    provider
  );

  const targetTsSec = Math.floor(PRESALE_DEPLOY_UTC_MS / 1000);
  const guessed = await findBlockByTimestamp(provider, targetTsSec);
  const startBlock = Math.max(1, guessed - 1000);
  const endBlock = await provider.getBlockNumber();

  const filter = presale.filters.Purchased(user);

  let paidRaw = ethers.BigNumber.from(0);
  let arubTotalRaw = ethers.BigNumber.from(0);
  let bonusRaw = ethers.BigNumber.from(0);

  const STEP = 120_000;

  const totalRanges = Math.max(1, Math.ceil((endBlock - startBlock + 1) / STEP));
  let doneRanges = 0;

  setPresaleScanVisible(true);
  setPresaleScanProgress(0);

  try {
    for (let from = startBlock; from <= endBlock; from += STEP) {
      const to = Math.min(endBlock, from + STEP - 1);
      const logs = await presale.queryFilter(filter, from, to);

      for (const ev of logs) {
        paidRaw = paidRaw.add(ev.args.usdtAmount);
        arubTotalRaw = arubTotalRaw.add(ev.args.arubTotal);
        bonusRaw = bonusRaw.add(ev.args.bonusArub);
      }

      doneRanges += 1;
      setPresaleScanProgress((doneRanges / totalRanges) * 100);
    }

    setPresaleScanProgress(100);

    const paidUSDT = Number(ethers.utils.formatUnits(paidRaw, USDT_DECIMALS));
    const totalARUB = Number(ethers.utils.formatUnits(arubTotalRaw, ARUB_DECIMALS));
    const bonusARUB = Number(ethers.utils.formatUnits(bonusRaw, ARUB_DECIMALS));
    const principalARUB = Math.max(0, totalARUB - bonusARUB);
    const avgPrice = totalARUB > 0 ? paidUSDT / totalARUB : null;

    return { paidUSDT, totalARUB, principalARUB, bonusARUB, avgPrice };
  } finally {
    setPresaleScanVisible(false);
  }
}

async function refreshPresaleUI(address) {
  const provider = await getReadOnlyProviderAsync();

  let presale = await loadPresaleStatsFromEvents(address, provider);
  if (!presale || !presale.totalARUB || presale.totalARUB <= 0) {
    presale = await loadPresaleStats(address, provider);
  }

  const currentPrice = await loadCurrentArubPrice(provider);
  const discount = calcDiscount(presale.avgPrice, currentPrice);

  setText('presalePurchased', presale.totalARUB.toFixed(6));
  setText('presalePaid', presale.paidUSDT.toFixed(2));
  setText('presaleAvgPrice', presale.avgPrice ? presale.avgPrice.toFixed(6) : '—');
  setText('presaleDiscount', discount !== null ? discount.toFixed(2) + '%' : '—');
}

window.refreshPresaleUI = refreshPresaleUI;

// -------------------------
// Legacy / Global hooks (HTML compatibility)
// -------------------------
window.CONFIG = window.CONFIG || CONFIG;

// ВАЖНО: connectWalletUI должен существовать (у вас его не было) — делаем alias на openWalletMenu
window.connectWalletUI = () => window.openWalletMenu?.();

// Открытие dropdown (НЕ перезатирает window.connectWallet!)
window.openWalletMenu = async () => {
  const dd = document.getElementById('walletDropdown') || document.getElementById('walletMenu');
  if (!dd) {
    showNotification?.('Wallet menu not found in DOM', 'error');
    return;
  }

  const connected = !!window.walletState?.address && !!window.walletState?.signer;
  if (!connected) {
    try { await renderWallets(); } catch (_) {}
    const hasAny = (getAvailableWallets() || []).length > 0;
    if (!hasAny) {
      showNotification?.(
        'Web3-гаманець не знайдено. Встановіть MetaMask/Trust/Phantom/Uniswap або відкрийте сайт у dApp-браузері.',
        'error'
      );
    }
  }

  dd.classList.toggle('open');
};

// Для inline onclick="addTokenToWallet('ARUB')" из HTML
window.addTokenToWallet = async (symbol) => {
  try {
    if (!window.walletState?.signer) {
      await window.openWalletMenu?.();
      showNotification?.('Спочатку оберіть гаманець і підключіться.', 'info');
      return;
    }
    // addTokenToWalletImpl должен быть определён в вашем проекте
    return await addTokenToWalletImpl(symbol);
  } catch (e) {
    console.error(e);
    showNotification?.(e?.message || 'Add token failed', 'error');
    throw e;
  }
};

// -------------------------
// Misc global event listeners
// -------------------------
function setupGlobalEventListeners() {
  window.addEventListener('contractsInitialized', () => {
    if (typeof updateGlobalStats === 'function') {
      try { updateGlobalStats(); } catch (e) {
        console.warn('[APP] updateGlobalStats failed:', e);
      }
    }
  });

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// -------------------------
// Bind connect button (dropdown)
// -------------------------
function bindConnectButton() {
  const btn = document.getElementById('connectBtn');
  const dd = document.getElementById('walletDropdown');
  if (!btn || !dd) return;

  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    try { await renderWallets(); } catch (err) {
      console.warn('[UI] renderWallets failed:', err?.message || err);
    }

    dd.classList.toggle('open');
  });

  dd.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (!dd.classList.contains('open')) return;
    const area = document.querySelector('.wallet-button-area') || btn.closest('.wallet-wrap') || btn.parentElement;
    if (area && !area.contains(e.target)) dd.classList.remove('open');
  });
}

// -------------------------
// Trading lock/unlock UI
// -------------------------
function renderTradingLocked() {
  const box = document.getElementById('tradingInterface');
  if (!box) return;

  box.innerHTML = `
    <div style="text-align:center; padding:50px;">
      <div style="font-size:3em; margin-bottom: 10px;">🔒</div>
      <p>Підключіть гаманець для торгівлі</p>
    </div>
  `;
}

async function renderTradingUnlocked() {
  const box = document.getElementById('tradingInterface');
  if (!box) return;

  if (!tradingMounted) {
    tradingMounted = true;
    // если вы где-то публикуете initTradingModule в window — оставим страховку
    if (typeof window.initTradingModule === 'function') {
      await window.initTradingModule();
    }
  }

  if (!box.innerHTML || box.textContent.includes('Підключіть гаманець')) {
    box.innerHTML = `
      <div style="text-align:center; padding:30px;">
        <div style="font-size:2em; margin-bottom:10px;">✅</div>
        <p>Гаманець підключено. UI торгівлі має бути відрендерений trading.js.</p>
      </div>
    `;
  }
}

function syncTradingLock(reason = 'sync') {
  const ws = window.walletState;
  const connected = !!ws?.address && !!ws?.signer;
  const onArbitrum = Number(ws?.chainId) === 42161;

  if (connected && onArbitrum) {
    renderTradingUnlocked().catch(() => {});
    try { window.onWalletConnected?.(ws.address, { chainId: ws.chainId, reason }); } catch (_) {}
  } else {
    renderTradingLocked();
    try { window.onWalletDisconnected?.({ reason }); } catch (_) {}
  }
}

window.addEventListener('walletStateChanged', () => syncTradingLock('walletStateChanged'));

// -------------------------
// Helpers used by other parts
// -------------------------
function isConnected(ws) {
  return !!ws?.address && !!ws?.signer && Number(ws?.chainId) === 42161;
}

function applyWalletToUI(ws) {
  const connectBtn = document.getElementById('connectBtn');
  if (connectBtn) {
    if (ws?.address) {
      const a = ws.address;
      connectBtn.textContent = `${a.slice(0, 6)}…${a.slice(-4)}`;
      connectBtn.classList.add('connected');
    } else {
      connectBtn.textContent = 'Підключити гаманець';
      connectBtn.classList.remove('connected');
    }
  }

  const enabled = isConnected(ws);

  if (typeof window.setTradingEnabled === 'function') {
    window.setTradingEnabled(enabled);
  }

  document.querySelectorAll('[data-requires-wallet]').forEach((el) => {
    el.classList.toggle('locked', !enabled);
  });

  document.querySelectorAll('.trade button, #buyBtn, #sellBtn').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

window.addEventListener('wallet:state', (e) => applyWalletToUI(e.detail));
window.addEventListener('wallet:connected', (e) => applyWalletToUI(e.detail));
window.addEventListener('wallet:disconnected', (e) => applyWalletToUI(e.detail));

// -------------------------
// Single init
// -------------------------
function initApp() {
  // 1) bind UI
  bindConnectButton();
  setupWalletMenu();
  bindWalletUiTradingPage();

  // 2) init read-only contracts + stats
  (async () => {
    try {
      const roOk = await initReadOnlyContracts();
      if (roOk && typeof updateGlobalStats === 'function') {
        setTimeout(() => { try { updateGlobalStats(); } catch {} }, 400);

        const intervalMs = Number(CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000);
        const ms = Number.isFinite(intervalMs) && intervalMs >= 3000 ? intervalMs : 15000;

        setInterval(() => { try { updateGlobalStats(); } catch {} }, ms);
      }
    } catch (e) {
      console.warn('[APP] initReadOnlyContracts failed:', e?.message || e);
    }
  })();

  // 3) initial UI sync
  try { updateWalletUI?.('initApp'); } catch (_) {}
  try { syncTradingLock('initApp'); } catch (_) {}

  console.log('[APP] Ready');
}

document.addEventListener('DOMContentLoaded', initApp);
document.addEventListener('DOMContentLoaded', () => applyWalletToUI(window.walletState));
document.addEventListener('DOMContentLoaded', () => syncTradingLock('DOMContentLoaded'));

setupGlobalEventListeners();
