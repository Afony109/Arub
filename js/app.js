/**
 * Main Application Entry Point (Vault-only)
 * Initializes modules and manages global state
 * Staking/Faucet removed.
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import {initWalletModule, getEthersProvider, getAvailableWallets, connectWallet, disconnectWallet} from './wallet.js';
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount } from './ui.js';
import { initReadOnlyContracts, getReadOnlyProviderAsync, getArubPrice, getTotalSupplyArub } from './contracts.js';

document.addEventListener('DOMContentLoaded', async () => {
  try { await renderWallets(); } catch (e) { console.warn(e); }
});

if (typeof window.walletState === 'undefined') window.walletState = null;

// если UI использует window.*, то публикуем тут (это 100% выполняется после импорта)
window.getAvailableWallets = getAvailableWallets;
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;

console.log('[app] wallet api ready', typeof window.getAvailableWallets, typeof window.connectWallet);

// -----------------------------
// Read-only provider (stable RPC)
// -----------------------------

console.log('[APP] module loaded:', import.meta.url);

let tradingInitDone = false;

async function ensureTradingUI(reason = 'unknown') {
  // trading.html: контейнер существует
  const box = document.getElementById('tradingInterface');
  if (!box) return;

  // ВАЖНО: initTradingModule должен быть идемпотентным.
  // Если он не идемпотентен — смотрите пункт 2 ниже.
  try {
    await initTradingModule();
    tradingInitDone = true;
    console.log('[UI] ensureTradingUI ok', { reason });
  } catch (e) {
    console.warn('[UI] ensureTradingUI failed', reason, e?.message || e);
  }
}

// 1) после загрузки DOM (чтобы #tradingInterface точно был в DOM)
document.addEventListener('DOMContentLoaded', () => {
  ensureTradingUI('DOMContentLoaded');
});

// 2) после любого изменения кошелька
window.addEventListener('walletStateChanged', () => {
  ensureTradingUI('walletStateChanged');
});

function ensureWalletDropdownBinding() {
  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');

  if (!connectBtn || !dropdown) {
    return false;
  }

  if (connectBtn.dataset.bound === '1') return true;
  connectBtn.dataset.bound = '1';

  connectBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await renderWallets(); // ВАЖНО: прямой вызов, не window.renderWallets
    } catch (err) {
      console.warn('[UI] renderWallets failed:', err?.message || err);
    }

    dropdown.classList.toggle('open');
  });

  dropdown.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('open')) return;
    const area = document.querySelector('.wallet-button-area') || connectBtn.closest('.wallet-wrap') || connectBtn.parentElement;
    if (area && !area.contains(e.target)) dropdown.classList.remove('open');
  });

  console.log('[UI] wallet dropdown binding OK');
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  // пробуем сразу
  if (ensureWalletDropdownBinding()) return;

  // если DOM дорисовывается позже — пробуем несколько раз
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (ensureWalletDropdownBinding() || tries >= 20) clearInterval(t);
  }, 100);
});

async function debugPresaleMath(address) {
  const provider = await getReadOnlyProviderAsync();

  const arub = new ethers.Contract(
    CONFIG.TOKEN_ADDRESS,
    ["function decimals() view returns (uint8)"],
    provider
  );

  const oracle = new ethers.Contract(
    CONFIG.ORACLE_ADDRESS,
    ["function rate() view returns (uint256)"],
    provider
  );

  const arubDecimals = await arub.decimals();
  const oracleRateRaw = await oracle.rate();

  console.log("[DEBUG] ARUB decimals =", arubDecimals);
  console.log("[DEBUG] Oracle rate raw =", oracleRateRaw.toString());
}

window.addEventListener('walletStateChanged', () => updateWalletUI('walletStateChanged'));

// чтобы старый onclick="connectWallet()" продолжал работать:
window.CONFIG = window.CONFIG || CONFIG;

// app.js (глобально)

function getWalletDropdownEl() {
  return document.getElementById('walletDropdown') || null;
}

// Compatibility: unify ids across pages
(function () {
  const d1 = document.getElementById('disconnectWalletBtn');
  const d2 = document.getElementById('walletDisconnect');
  if (!d1 && d2) d2.id = 'disconnectWalletBtn';

  const dropdown = document.getElementById('walletDropdown');
  const menu = document.getElementById('walletMenu');

  // если на странице старый id walletMenu — приводим к единому walletDropdown
  if (!dropdown && menu) menu.id = 'walletDropdown';
})();

let uiConnecting = false;

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

  // bind dropdown handler once (stop propagation + disconnect)
  if (!dd.dataset.bound) {
    dd.dataset.bound = '1';

    dd.addEventListener('click', async (e) => {
      e.stopPropagation();

      const disconnectBtn = e.target.closest?.('#disconnectWalletBtn');
      if (!disconnectBtn) return;

      e.preventDefault();

      // ⛔ блокируем повторные клики по disconnect
      if (dd.dataset.disconnecting === '1') return;
      dd.dataset.disconnecting = '1';

      try {
        await window.disconnectWallet?.();

        // UI refresh after disconnect
        try { window.updateWalletUI?.('disconnected'); } catch (_) {}
        try { renderWallets?.(); } catch (_) {}

        dd.classList.remove('open');
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

  // загрузим список кошельков
  let wallets = [];
  try {
    const fn = window.getAvailableWallets;
    wallets = (typeof fn === 'function') ? (fn() || []) : [];
  } catch (e) {
    console.warn('[UI] getAvailableWallets failed:', e);
    wallets = [];
  }

  if (!Array.isArray(wallets) || wallets.length === 0) {
    list.innerHTML = `
      <div class="wallet-list-title">Гаманці не знайдено</div>
      <div class="wallet-list-hint">Встановіть MetaMask / Rabby або увімкніть WalletConnect.</div>
    `;
    return;
  }

  console.log('[UI] wallets detected:', wallets);

  // ✅ normalize: поддерживаем и новый формат (walletId/entryName),
  // и старый (id/name) на всякий случай
  const norm = wallets.map((w) => {
    const id = w?.walletId ?? w?.id ?? w?.entryId ?? null;
    const label =
      w?.entryName ??
      w?.name ??
      w?.entryId ??
      w?.walletId ??
      w?.id ??
      'Wallet';

    return { id, label, raw: w };
  }).filter(x => !!x.id);

  if (norm.length === 0) {
    list.innerHTML = `
      <div class="wallet-list-title">Гаманці не знайдено</div>
      <div class="wallet-list-hint">Невірний формат списку гаманців (walletId/id відсутній).</div>
    `;
    console.warn('[UI] wallets list has no usable ids:', wallets);
    return;
  }

  // рисуем кнопки
  list.innerHTML = norm.map(w => `
    <button type="button" class="wallet-item" data-wallet-id="${String(w.id)}">
      <span class="wallet-name">${String(w.label)}</span>
    </button>
  `).join('');

  console.log('[UI] wallet buttons rendered:', list.querySelectorAll('.wallet-item').length);

  // bind click handler once (event delegation) for wallet items
  if (!list.dataset.bound) {
    list.dataset.bound = '1';

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest?.('.wallet-item');
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const walletId = btn.getAttribute('data-wallet-id');
      if (!walletId) {
        console.warn('[UI] wallet-item has no data-wallet-id');
        return;
      }

      // ⛔ блокируем повторные клики
      if (window.uiConnecting) return;
      window.uiConnecting = true;
      btn.disabled = true;

      try {
        await window.connectWallet?.({ walletId });

        // опционально: обновить UI сразу (если updateWalletUI слушает walletStateChanged, можно не надо)
        try { window.updateWalletUI?.('connected'); } catch (_) {}

        dd.classList.remove('open');
      } catch (err) {
        console.warn('[UI] connectWallet failed (walletId=%s):', walletId, err);
        console.warn('[UI] connectWallet failed details:', {
          walletId,
          message: err?.message,
          code: err?.code,
          data: err?.data,
          reason: err?.reason,
          stack: err?.stack
        });

        // ❗ НЕ вызываем disconnectWallet здесь.
        // Ошибка подключения не означает, что надо рвать текущую сессию.
      } finally {
        window.uiConnecting = false;
        btn.disabled = false;
      }
    });
  }
}

// маленький helper для текста (чтобы не ломать разметку)
function escapeHtml(s) {
  return s
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

function bindWalletUiTradingPage() {
  const connectBtn = document.getElementById('connectBtn');
  const toggleBtn  = document.getElementById('walletMenuToggle');
  const menu       = document.getElementById('walletMenu');

  // toggle wallet menu
  toggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu?.classList.toggle('open');
  });

  // close menu on outside click
  document.addEventListener('click', (e) => {
    if (!menu || !toggleBtn) return;
    const wrap = menu.parentElement; // .wallet-dropdown
    if (menu.classList.contains('open') && wrap && !wrap.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // connect button opens your wallet picker (если так задумано)
  connectBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // если у вас подключение делается через dropdown/рендер кошельков — вызовите это
    try { renderWallets?.(); } catch (_) {}
    // либо напрямую коннект:
    // await window.connectWallet?.();
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
  });// главный: слушаем изменения кошелька
}

function updateWalletUI(reason = 'unknown') {
  const ws = window.walletState;

  const connected = !!ws?.address && !!ws?.signer;

  console.log('[UI] updateWalletUI', { reason, connected, address: ws?.address, chainId: ws?.chainId });

  // ---------
  // Общая кнопка connect (есть на обеих страницах)
  // ---------
  const connectBtn = document.getElementById('connectBtn');
  if (connectBtn) {
    connectBtn.textContent = connected ? shortAddr(ws.address) : 'Підключити гаманець';
    connectBtn.classList.toggle('connected', connected);
  }

  // ---------
  // INDEX / dashboard: dropdown + disconnectWalletBtn
  // ---------
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

  // ---------
  // TRADING page: wallet menu toggle + menu address + disconnect
  // ---------
  const toggleBtn = document.getElementById('walletMenuToggle');
  const menuAddr  = document.getElementById('walletMenuAddress');

  if (toggleBtn) toggleBtn.hidden = !connected;
  if (menuAddr)  menuAddr.textContent = connected ? ws.address : '—';

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

  // Вызвать ваши колбэки из inline-скрипта trading.html (если есть)
  if (connected) {
    try { window.onWalletConnected?.(ws.address, { chainId: ws.chainId }); } catch (_) {}
  } else {
    try { window.onWalletDisconnected?.({}); } catch (_) {}
  }
}

function setupWalletMenu() {
  // защита от повторного навешивания
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

  // Disconnect button (ID как в вашем HTML!)
  document.getElementById('disconnectWalletBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();

  document.getElementById('walletDropdown')?.classList.remove('open');
  await disconnectWallet();
  try { renderWallets(); } catch (_) {}
  try { updateWalletUI?.('disconnected'); } catch (_) {}
});

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
// вставить сразу после renderWalletButtons(...)
// =======================


const PRESALE_ABI_MIN = [
  "function totalDeposited(address) view returns (uint256)",
  "function lockedPrincipalArub(address) view returns (uint256)",
  "function lockedBonusArub(address) view returns (uint256)"
];

const ORACLE_ABI_MIN = [
  "function getRate() view returns (uint256,uint256)",
  "function rate() view returns (uint256)"
];

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function calcDiscount(avgPrice, currentPrice) {
  if (!avgPrice || !currentPrice || currentPrice <= 0) return null;
  return (1 - avgPrice / currentPrice) * 100;
}

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
  "event Purchased(address indexed buyer, uint256 usdtAmount, uint256 arubTotal, uint256 bonusArub, uint256 discountPercent, uint256 discountAppliedEq)"
];

const USDT_DECIMALS = 6;
const ARUB_DECIMALS = 6;

// 2025-12-15 16:30:03 UTC (ваш деплой)
const PRESALE_DEPLOY_UTC_MS = Date.parse("2025-12-15T16:30:03Z");

// Находим ближайший блок по timestamp (бинарный поиск)
async function findBlockByTimestamp(provider, targetTsSec) {
  const latest = await provider.getBlockNumber();
  let lo = 1;
  let hi = latest;

  // быстрые границы
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

  // --- progress setup ---
  const totalRanges = Math.max(1, Math.ceil((endBlock - startBlock + 1) / STEP));
  let doneRanges = 0;

  setPresaleScanVisible(true);
  setPresaleScanProgress(0);

  try {
    for (let from = startBlock; from <= endBlock; from += STEP) {
      const to = Math.min(endBlock, from + STEP - 1);

      const logs = await presale.queryFilter(filter, from, to);

      for (const ev of logs) {
        console.log("[PURCHASED]", {
          block: ev.blockNumber,
          tx: ev.transactionHash,
          usdt: ethers.utils.formatUnits(ev.args.usdtAmount, USDT_DECIMALS),
          arub: ethers.utils.formatUnits(ev.args.arubTotal, ARUB_DECIMALS),
          bonus: ethers.utils.formatUnits(ev.args.bonusArub, ARUB_DECIMALS),
        });

        paidRaw = paidRaw.add(ev.args.usdtAmount);
        arubTotalRaw = arubTotalRaw.add(ev.args.arubTotal);
        bonusRaw = bonusRaw.add(ev.args.bonusArub);
      }

      // --- progress update per range ---
      doneRanges += 1;
      setPresaleScanProgress((doneRanges / totalRanges) * 100);
    }

    setPresaleScanProgress(100);

    const paidUSDT = Number(ethers.utils.formatUnits(paidRaw, USDT_DECIMALS));
    const totalARUB = Number(ethers.utils.formatUnits(arubTotalRaw, ARUB_DECIMALS));
    const bonusARUB = Number(ethers.utils.formatUnits(bonusRaw, USDT_DECIMALS)); // <-- нет, см. ниже
    const bonusARUB2 = Number(ethers.utils.formatUnits(bonusRaw, ARUB_DECIMALS));
    const principalARUB = Math.max(0, totalARUB - bonusARUB2);
    const avgPrice = totalARUB > 0 ? paidUSDT / totalARUB : null;

    return { paidUSDT, totalARUB, principalARUB, bonusARUB: bonusARUB2, avgPrice };
  } finally {
    // даже если упадёт RPC — UI не зависнет “на загрузке”
    setPresaleScanVisible(false);
  }
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

async function refreshPresaleUI(address) {
  
  // Единый read-only провайдер (proxy-first) из contracts.js
  const provider = await getReadOnlyProviderAsync();

  let presale = await loadPresaleStatsFromEvents(address, provider);
  if (!presale || !presale.totalARUB || presale.totalARUB <= 0) {
    presale = await loadPresaleStats(address, provider);
  }

  const currentPrice = await loadCurrentArubPrice(provider);
  const discount = calcDiscount(presale.avgPrice, currentPrice);

  setText("presalePurchased", presale.totalARUB.toFixed(6));
  setText("presalePaid", presale.paidUSDT.toFixed(2));
  setText("presaleAvgPrice", presale.avgPrice ? presale.avgPrice.toFixed(6) : "—");
  setText("presaleDiscount", discount !== null ? discount.toFixed(2) + "%" : "—");
}

window.refreshPresaleUI = refreshPresaleUI;


// =======================
// END PRESALE / ORACLE STATS
// =======================


// -------------------------
// Legacy / Global hooks (HTML compatibility)
// -------------------------

window.CONFIG = window.CONFIG || CONFIG;

// если где-то в HTML дергают connectWalletUI напрямую
window.connectWalletUI = connectWalletUI;

// чтобы старый onclick="connectWallet()" продолжал работать
window.connectWallet = () => {
  const dd =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  if (!dd) {
    showNotification?.('Wallet menu not found in DOM', 'error');
    return;
  }

  // если не подключены — перерендерим список кошельков
  const connected = !!window.walletState?.address && !!window.walletState?.signer;
  if (!connected) {
    try { renderWallets(); } catch (_) {}
    const hasAny = (getAvailableWallets() || []).length > 0;
    if (!hasAny) {
      showNotification?.(
        'Web3-гаманець не знайдено. Встановіть MetaMask/Trust або відкрийте сайт у dApp-браузері.',
        'error'
      );
    }
  }

  // единый способ открытия/закрытия: класс open
  dd.classList.toggle('open');
};

// Для inline onclick="addTokenToWallet('ARUB')" из HTML
window.addTokenToWallet = async (symbol) => {
  try {
    if (!window.walletState?.signer) {
      window.connectWallet?.();
      showNotification?.('Спочатку оберіть гаманець і підключіться.', 'info');
      return;
    }
    return await addTokenToWalletImpl(symbol);
  } catch (e) {
    console.error(e);
    showNotification?.(e?.message || 'Add token failed', 'error');
    throw e;
  }
};

// -------------------------
// Optional: wallet account menu (copy/change/disconnect)
// Делает то, что ты пытался сделать в "setupWalletMenu", но корректно
// -------------------------


function setupGlobalEventListeners() {
  // обновление статистики, когда контракты готовы
  window.addEventListener('contractsInitialized', () => {
    if (typeof updateGlobalStats === 'function') {
      try { updateGlobalStats(); } catch (e) {
        console.warn('[APP] updateGlobalStats failed:', e);
      }
    }
  });

  // плавный скролл по якорям (UX, безопасно)
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

function setupWalletDropdownUI() {
  try { renderWallets?.(); } catch (_) {}
  try { setupWalletMenu?.(); } catch (_) {}
}

function bindConnectButton() {
  if (window.__connectBtnBound) return;
  window.__connectBtnBound = true;

  const btn = document.getElementById('connectBtn');
  const dd  = document.getElementById('walletDropdown');
  if (!btn || !dd) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    try { renderWallets(); } catch (err) {
      console.warn('[UI] renderWallets failed:', err?.message || err);
    }

    dd.classList.toggle('open');
  });

  dd.addEventListener('click', (e) => e.stopPropagation());
}

let tradingMounted = false;

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

  // 1) Если у вас есть модуль торговли, который должен отрендерить UI — дерните его здесь.
  // Подставьте вашу реальную функцию: initTradingModule(), renderTradingUI(), mountTrading(), etc.
  if (!tradingMounted) {
    tradingMounted = true;

    // пример: если вы делали window.initTradingModule в app.js
    if (typeof window.initTradingModule === 'function') {
      await window.initTradingModule();
    }
  }

  // 2) Если никакого рендера пока нет — хотя бы уберём замок и покажем заглушку "готово"
  // (чтобы отличать проблему рендера от проблемы коннекта)
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

// дергаем при изменении кошелька + при старте страницы
window.addEventListener('walletStateChanged', () => syncTradingLock('walletStateChanged'));
document.addEventListener('DOMContentLoaded', () => syncTradingLock('DOMContentLoaded'));

function onWalletUIChange(reason = 'walletStateChanged') {
  updateWalletUI(reason);

  const ws = window.walletState;
  const connected = !!ws?.address && !!ws?.signer;
  const onArbitrum = Number(ws?.chainId) === 42161;

  if (connected && onArbitrum) {
    renderTradingUnlocked();
  } else {
    renderTradingLocked();
  }
}

window.addEventListener('walletStateChanged', () => onWalletUIChange('walletStateChanged'));

document.addEventListener('DOMContentLoaded', () => {
  // начальная синхронизация (важно, если кошелек уже подключен при загрузке)
  onWalletUIChange('DOMContentLoaded');
});

// -------------------------
// initApp() — оставляем initWalletModule только здесь
// -------------------------
async function initApp() {
  console.log('[APP] Boot (Vault-only)');

  const safe = async (label, fn) => {
    try { return await fn?.(); }
    catch (e) {
      console.warn(`[APP] ${label} failed:`, e?.message || e);
      return null;
    }
  };

  try {
    const roOk = await safe('initReadOnlyContracts', initReadOnlyContracts);

    await safe('initWalletModule', initWalletModule);
    await safe('bindConnectButton', bindConnectButton);
    await safe('setupWalletMenu', setupWalletMenu);

    await safe('initTradingModule', initTradingModule);
    await safe('setupGlobalEventListeners', setupGlobalEventListeners);

    await safe('updateWalletUI(startup)', () => updateWalletUI?.('startup'));

    if (roOk && typeof updateGlobalStats === 'function') {
      setTimeout(() => { try { updateGlobalStats(); } catch {} }, 400);

      const intervalMs = Number(CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000);
      const ms = Number.isFinite(intervalMs) && intervalMs >= 3000 ? intervalMs : 15000;

      setInterval(() => { try { updateGlobalStats(); } catch {} }, ms);
    }

    console.log('[APP] Ready');
  } catch (e) {
    console.error('[APP] Fatal init error:', e);
    showNotification?.('❌ Помилка ініціалізації додатку', 'error');
  }
}
}

function isConnected(ws) {
  return !!ws?.address && !!ws?.signer && Number(ws?.chainId) === 42161;
}

function applyWalletToUI(ws) {
  // 1) Кнопка "Подключить" -> адрес
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

  // 2) Разблокировать торговлю
  const enabled = isConnected(ws);

  // Вариант А: если у вас есть готовая функция
  if (typeof window.setTradingEnabled === 'function') {
    window.setTradingEnabled(enabled);
  }

  // Вариант B: прямое включение контролов (универсально)
  document.querySelectorAll('[data-requires-wallet]').forEach((el) => {
    el.classList.toggle('locked', !enabled);
  });

  // Пример: отключаем/включаем кнопки buy/sell
  document.querySelectorAll('.trade button, #buyBtn, #sellBtn').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

// Подписка на события кошелька
window.addEventListener('wallet:state', (e) => applyWalletToUI(e.detail));
window.addEventListener('wallet:connected', (e) => applyWalletToUI(e.detail));
window.addEventListener('wallet:disconnected', (e) => applyWalletToUI(e.detail));

// И ПРИНУДИТЕЛЬНО применить текущее состояние при старте
document.addEventListener('DOMContentLoaded', () => {
  applyWalletToUI(window.walletState);
});

function initApp() {
  // 1) Привязка UI кошелька
  bindWalletUiTradingPage();

  // 2) Начальная отрисовка/синхронизация
  try { updateWalletUI?.('initApp'); } catch (_) {}
  try { window.dispatchEvent(new CustomEvent('walletStateChanged', { detail: window.walletState ?? null })); } catch (_) {}
}

// ВАЖНО: только после загрузки DOM
document.addEventListener('DOMContentLoaded', initApp);



