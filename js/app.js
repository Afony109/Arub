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

initWalletModule();
document.addEventListener('DOMContentLoaded', () => {
  renderWallets();
});

// если UI использует window.*, то публикуем тут (это 100% выполняется после импорта)
window.getAvailableWallets = getAvailableWallets;
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;

console.log('[app] wallet api ready', typeof window.getAvailableWallets, typeof window.connectWallet);

// -----------------------------
// Read-only provider (stable RPC)
// -----------------------------

console.log('[APP] module loaded:', import.meta.url);

(function bindWalletDropdown() {
  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');

  if (!connectBtn || !dropdown) {
    console.warn('[wallet-ui] connectBtn or walletDropdown not found');
    return;
  }

  if (connectBtn.dataset.bound === '1') return;
  connectBtn.dataset.bound = '1';

  connectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // перерисовать список (если есть)
    try {
      if (typeof window.renderWallets === 'function') {
        window.renderWallets();
      }
    } catch (_) {}

    dropdown.classList.toggle('open');
    console.log('[wallet-ui] dropdown open =', dropdown.classList.contains('open'));
  });

  dropdown.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('open')) return;
    if (!dropdown.contains(e.target) && e.target !== connectBtn) {
      dropdown.classList.remove('open');
    }
  });

  console.log('[wallet-ui] dropdown binding attached');
})();


function ensureWalletDropdownBinding() {
  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');

  if (!connectBtn || !dropdown) {
    console.warn('[UI] connectBtn or walletDropdown not found');
    return;
  }

  // защита от повторной привязки
  if (connectBtn.dataset.bound === '1') return;
  connectBtn.dataset.bound = '1';

  // клик по кнопке — открыть/закрыть
  connectBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // если у тебя есть модульная renderWallets — вызови её
    // иначе — fallback: нарисуем минимальный список из window.getAvailableWallets()
    try {
      if (typeof window.renderWallets === 'function') {
        await window.renderWallets();
      } else {
        // fallback render
        let list = dropdown.querySelector('.wallet-list');
        if (!list) {
          list = document.createElement('div');
          list.className = 'wallet-list';
          dropdown.insertBefore(list, dropdown.firstChild);
        }

        const wallets = window.getAvailableWallets?.() || [];
        list.innerHTML = wallets.length
          ? wallets.map(w => `<button class="wallet-item" data-wallet-id="${w.id}">${w.name}</button>`).join('')
          : `<div class="wallet-list-title">Гаманці не знайдено</div>`;

        list.querySelectorAll('.wallet-item').forEach(btn => {
          btn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const walletId = btn.getAttribute('data-wallet-id');
            await window.connectWallet?.({ walletId });
            dropdown.classList.remove('open');
          });
        });
      }
    } catch (err) {
      console.warn('[UI] renderWallets failed:', err?.message || err);
    }

    dropdown.classList.toggle('open');
  });

  // клики внутри dropdown не закрывают его
  dropdown.addEventListener('click', (e) => e.stopPropagation());

  // клик вне — закрыть
  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('open')) return;
    const area = document.querySelector('.wallet-button-area') || connectBtn.closest('.wallet-wrap') || connectBtn.parentElement;
    if (area && !area.contains(e.target)) dropdown.classList.remove('open');
  });

  console.log('[UI] wallet dropdown binding OK');
}

// 1) обычный запуск
document.addEventListener('DOMContentLoaded', ensureWalletDropdownBinding);

// 2) подстраховка: если скрипт загрузился после DOMContentLoaded
ensureWalletDropdownBinding();


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


// чтобы старый onclick="connectWallet()" продолжал работать:


window.CONFIG = window.CONFIG || CONFIG;

// app.js (глобально)
let uiConnecting = false;

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

  // контейнер списка
  let list = dd.querySelector('.wallet-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'wallet-list';
    dd.insertBefore(list, dd.firstChild);
  }

  let wallets = [];
  try {
    const fn = window.getAvailableWallets;
    wallets = (typeof fn === 'function') ? (fn() || []) : [];
  } catch (e) {
    console.warn('[UI] getAvailableWallets failed:', e?.message || e);
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


  list.innerHTML = wallets.map(w => `
    <button class="wallet-item" data-wallet-id="${w.id}">
      <span class="wallet-name">${w.name || w.id}</span>
    </button>
  `).join('');

  list.querySelectorAll('.wallet-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const walletId = btn.getAttribute('data-wallet-id');
      try {
        await window.connectWallet?.({ walletId });
        dd.classList.remove('open');
      } catch (err) {
        console.warn('[UI] connectWallet failed:', err?.message || err);
      }
    });
  });
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
  if (!a || typeof a !== 'string') return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function updateWalletUI(reason = 'unknown') {
  const ws = window.walletState;

  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');
  const disconnectBtn = document.getElementById('disconnectWalletBtn');

  const connected = !!ws?.address && !!ws?.signer;

  console.log('[UI] updateWalletUI', { reason, connected, address: ws?.address, chainId: ws?.chainId });

  if (connectBtn) {
    connectBtn.textContent = connected ? shortAddr(ws.address) : 'Підключити гаманець';
    connectBtn.classList.toggle('connected', connected);
  }

  if (disconnectBtn) {
    disconnectBtn.style.display = connected ? 'block' : 'none';
    disconnectBtn.onclick = async () => {
      try {
        await disconnectWallet();
      } finally {
        // после дисконнекта: вернуть список кошельков
        renderWallets();
        updateWalletUI('disconnected');
        if (dropdown) dropdown.classList.remove('open');
      }
    };
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