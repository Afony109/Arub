/**
 * Main Application Entry Point (Vault-only)
 * Initializes modules and manages global state
 * Staking/Faucet removed.
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import {initWalletModule, getEthersProvider, getAvailableWallets, connectWalletUI, disconnectWallet} from './wallet.js';
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount } from './ui.js';
import { initReadOnlyContracts, getReadOnlyProviderAsync, getArubPrice, getTotalSupplyArub } from './contracts.js';

// -----------------------------
// Read-only provider (stable RPC)
// -----------------------------
let _readProvider = null;

console.log('[APP] module loaded:', import.meta.url);


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

function setWalletMenuDisabled(menuEl, disabled) {
  if (!menuEl) return;
  menuEl.querySelectorAll('button[data-wallet-item="1"]').forEach(b => {
    b.disabled = disabled;
  });
}

// Compatibility: unify ids across pages
(function () {
  const d1 = document.getElementById('disconnectWalletBtn');
  const d2 = document.getElementById('walletDisconnect');
  if (!d1 && d2) d2.id = 'disconnectWalletBtn';

  const m1 = document.getElementById('walletDropdown');
  const m2 = document.getElementById('walletMenu');
  if (!m1 && m2) m2.id = 'walletDropdown';
})();

function renderWallets() {
  const menu =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  if (!menu) return;

  // удалить старые элементы списка (кроме disconnect)
  menu.querySelectorAll('[data-wallet-item="1"], [data-walletItem="1"]').forEach(n => n.remove());

  const wallets = getAvailableWallets();
  if (!Array.isArray(wallets) || wallets.length === 0) return;

  wallets.forEach((w) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.walletItem = '1';
    btn.textContent = w.name;

    btn.onclick = async () => {
      if (uiConnecting) {
        showNotification?.('Подключение уже выполняется. Дождитесь завершения.', 'error');
        return;
      }

      uiConnecting = true;
      setWalletMenuDisabled(menu, true);

      try {
        await connectWalletUI({ walletId: w.id });

        // обновить UI кнопки/меню
        updateWalletUI('connected');

        // обновить пресейл-данные
        const addr = window.walletState?.address;
        if (addr) {
          try {
            await refreshPresaleUI(addr);
          } catch (e) {
            console.warn('[APP] refreshPresaleUI failed:', e?.message || e);
          }
        }

        // если dropdown открыт — можно закрыть после успешного connect
        // menu.style.display = 'none';
      } catch (e) {
        const code = e?.code;
        const m = String(e?.message || '').toLowerCase();
        const isUserRejected =
          code === 4001 ||
          m.includes('user rejected') ||
          m.includes('rejected the request') ||
          m.includes('request rejected') ||
          m.includes('action_rejected');

        if (isUserRejected) {
          showNotification?.('Підключення скасовано користувачем.', 'info');
        } else {
          console.error('[UI] connect error:', e);
          showNotification?.('Помилка підключення.', 'error');
        }
      } finally {
        uiConnecting = false;
        setWalletMenuDisabled(menu, false);
      }
    };

    // вставляем кнопку в меню
    menu.insertBefore(btn, menu.firstChild);
  });
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
        if (dropdown) dropdown.style.display = 'none';
      }
    };
  }
}

function setupWalletDropdownUI() {
  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');
  const area = document.querySelector('.wallet-button-area');

  if (!connectBtn || !dropdown) {
    console.warn('[UI] wallet button or dropdown not found');
    return;
  }

  // защита от повторного навешивания
  if (connectBtn.dataset.bound === '1') return;
  connectBtn.dataset.bound = '1';

  updateWalletUI('init');
  renderWallets();

  connectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const ws = window.walletState;
    const connected = !!ws?.address && !!ws?.signer;

    if (!connected) renderWallets();

    dropdown.classList.toggle('open');
  });

  dropdown.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (area && area.contains(e.target)) return;
    dropdown.classList.remove('open');
  });
}


// Нормализация ошибок (cancel/timeout и т.п.)
function normalizeWalletError(e) {
  const m = String(e?.message || e || '');

  // частые случаи
  if (/user rejected|rejected|denied|canceled|cancelled/i.test(m)) return 'Підключення скасовано користувачем.';
  if (/timeout/i.test(m)) return 'Таймаут підключення. Відкрийте/розблокуйте гаманець і спробуйте ще раз.';
  if (/already pending|pending request/i.test(m)) return 'У гаманці вже є запит на підключення. Відкрийте гаманець і завершіть/відхиліть його.';
  if (/No wallet selected/i.test(m)) return 'Оберіть гаманець зі списку.';

  return 'Не вдалося підключити гаманець: ' + m;
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


function presaleCacheKey(addr) {
  return `presaleStats:${CONFIG.PRESALE_ADDRESS}:${addr.toLowerCase()}`;
}

function loadPresaleCache(addr) {
  try {
    const raw = localStorage.getItem(presaleCacheKey(addr));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePresaleCache(addr, data) {
  try {
    localStorage.setItem(
      presaleCacheKey(addr),
      JSON.stringify({ ...data, cachedAt: Date.now() })
    );
  } catch {}
}

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
function setupWalletMenu() {
  const getAddress = () => window.walletState?.address || '';

  // закрытие меню по клику вне
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('walletMenu');
    const wrap = document.querySelector('.wallet-wrap');
    if (!menu || !wrap) return;

    if (menu.classList.contains('open') && !wrap.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  document.getElementById('copyAddrBtn')?.addEventListener('click', async () => {
    const addr = getAddress();
    if (!addr) return;

    await navigator.clipboard.writeText(addr);
    document.getElementById('walletMenu')?.classList.remove('open');
    showNotification?.('Адреса скопійовано', 'info');
  });

  document.getElementById('changeWalletBtn')?.addEventListener('click', async () => {
    document.getElementById('walletMenu')?.classList.remove('open');

    await disconnectWallet();
    // открываем dropdown со списком кошельков
    window.connectWallet?.();
  });

  document.getElementById('disconnectBtn')?.addEventListener('click', async () => {
    document.getElementById('walletMenu')?.classList.remove('open');
    await disconnectWallet();
    try { renderWallets(); } catch (_) {}
    try { updateWalletUI('disconnected'); } catch (_) {}
  });
}

// -------------------------
// initApp() — оставляем initWalletModule только здесь
// -------------------------
async function initApp() {
  console.log('='.repeat(60));
  console.log('ANTI RUB - Vault Platform (Vault-only)');
  console.log('Initializing application...');
  console.log('='.repeat(60));

  try {
    console.log('[APP] Initializing read-only contracts...');
    const readOnlySuccess = await initReadOnlyContracts();

    if (readOnlySuccess) {
      console.log('[APP] Read-only contracts ready, fetching initial stats...');
      setTimeout(() => updateGlobalStats(), 500);
    } else {
      console.warn('[APP] initReadOnlyContracts returned false');
    }

    console.log('[APP] Initializing wallet module...');
    initWalletModule(); // ✅ только тут

    console.log('[APP] Initializing trading module...');
    initTradingModule();

    setupGlobalEventListeners();
    setupScrollAnimations();

    // ✅ единый dropdown UI (через class "open")
    setupWalletDropdownUI();

    // ✅ если нужно меню "Copy/Change/Disconnect"
    try { setupWalletMenu(); } catch (e) {
      console.warn('[APP] setupWalletMenu failed:', e?.message || e);
    }

    // ✅ привести UI к текущему состоянию и отрисовать список кошельков
    updateWalletUI('startup');
    renderWallets();

    // Периодическое обновление статов
    const interval = CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000;
    setInterval(() => updateGlobalStats(), interval);

    console.log('[APP] ✅ Application ready!');
    await logNetworkState('APP');
  } catch (error) {
    console.error('[APP] ❌ Initialization error:', error);
    showNotification?.('❌ Помилка ініціалізації додатку', 'error');
    await logNetworkState('APP');
  }
}

// Старт
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

export { initApp };
