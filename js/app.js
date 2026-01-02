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

wallets.forEach((w) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.walletItem = '1';
  btn.textContent = w.name;

  btn.onclick = async () => {
  if (uiConnecting) {
    showNotification?.(
      'Подключение уже выполняется. Дождитесь завершения.',
      'error'
    );
    return;
  }

  uiConnecting = true;
  setWalletMenuDisabled(menu, true);

  try {
    await connectWalletUI({ walletId: w.id });

    // 👇 один раз, после успешного подключения
    updateWalletUI('connected');
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

  updateWalletUI('startup');


  // <-- ВАЖНО: вставка кнопки должна быть здесь (вне onclick)
  menu.insertBefore(btn, menu.firstChild);
});
}

window.addEventListener('walletStateChanged', () => {
  updateWalletUI('walletStateChanged');
  renderWallets();
});


function shortAddr(a) {
  if (!a || typeof a !== 'string') return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function updateWalletUI(reason = 'unknown') {
  const btn = document.getElementById('connectBtn');
  const menu = document.getElementById('walletDropdown') || document.getElementById('walletMenu');
  const disconnectBtn = document.getElementById('disconnectWalletBtn');

  const ws = window.walletState;
  const connected = !!ws?.address && !!ws?.signer;

  console.log('[UI] updateWalletUI', { reason, connected, address: ws?.address, chainId: ws?.chainId });

  if (btn) {
    btn.textContent = connected ? shortAddr(ws.address) : 'Підключити гаманець';
    btn.classList.toggle('connected', connected);
  }

  if (menu) {
    // dropdown показываем только когда connected (иначе там список кошельков)
    menu.style.display = connected ? 'block' : 'none';
  }

  if (disconnectBtn) {
    disconnectBtn.style.display = connected ? 'block' : 'none';
    disconnectBtn.onclick = async () => {
      try {
        await disconnectWallet();
      } catch (e) {
        console.warn('[UI] disconnectWallet failed:', e?.message || e);
      } finally {
        // UI обновим в любом случае
        updateWalletUI('disconnect');
        renderWallets(); // чтобы снова показать список кошельков
      }
    };
  }
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


window.CONFIG = window.CONFIG || CONFIG;

window.connectWalletUI = connectWalletUI;

window.connectWallet = () => {
  const menu =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  if (!menu) {
    showNotification?.('Wallet menu not found in DOM', 'error');
    return;
  }

  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    renderWallets();

    const hasAny = (getAvailableWallets() || []).length > 0;
    if (!hasAny) {
      showNotification?.(
        'Web3-гаманець не знайдено. Встановіть MetaMask/Trust або відкрийте сайт у dApp-браузері.',
        'error'
      );
    }
  }
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

// ------------------------------
initWalletModule?.();

// 2) UI: список кошельков в dropdown
// (1) Объявили один раз
const connectBtn = document.getElementById('connectBtn');
const dropdown   = document.getElementById('walletDropdown');
const disconnectBtn = document.getElementById('disconnectWalletBtn');



function setWalletUIConnected(address) {
  if (connectBtn) connectBtn.textContent = shortAddr(address);
  if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
  if (dropdown) dropdown.style.display = 'none';
}

function setWalletUIDisconnected() {
  if (connectBtn) connectBtn.textContent = 'Підключити гаманець';
  if (disconnectBtn) disconnectBtn.style.display = 'none';
}

// На старте страницы — привести UI в корректное состояние
setWalletUIDisconnected();


disconnectBtn?.addEventListener('click', async () => {
  const menu =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  try {
    await disconnectWallet();
  } finally {
    uiConnecting = false;
    setWalletMenuDisabled(menu, false);
    if (dropdown) dropdown.style.display = 'none';
    if (typeof renderWallets === 'function') renderWallets();
  }
});


function clearWalletList() {
  if (!dropdown) return;
  // оставляем кнопку disconnect, остальное удаляем
  [...dropdown.querySelectorAll('[data-wallet-item="1"]')].forEach(n => n.remove());
}


function getDropdownEl() {
  return (
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu')
  );
}

connectBtn?.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();

  const dd = getDropdownEl();
  console.log('[UI] connectBtn click', { connectBtn: !!connectBtn, dropdown: !!dd });

  if (!dd) {
    showNotification?.('Меню кошельков не найдено на странице.', 'error');
    return;
  }

  if (typeof renderWallets === 'function') renderWallets();

  const isVisible = window.getComputedStyle(dd).display !== 'none';
  dd.style.display = isVisible ? 'none' : 'block';

  dd.style.pointerEvents = 'auto';
  dd.style.zIndex = '9999';
});


document.getElementById('disconnectWalletBtn')?.addEventListener('click', async () => {
  await disconnectWallet();
  dropdown.style.display = 'none';
});

// закрытие dropdown по клику вне
window.addEventListener('click', (e) => {
  if (!dropdown || !connectBtn) return;
  if (e.target === connectBtn || dropdown.contains(e.target)) return;
  dropdown.style.display = 'none';
});

/**
 * Обновление глобальной статистики (Vault-only)
 * - ARUB price
 * - Total supply
 * - Остальные staking-виджеты заполняем "—" (если они есть в верстке)
 */
async function updateGlobalStats() {
  console.log('[APP] 🔄 Updating global statistics (vault-only)...');

  try {
    const [arubPriceInfo, totalSupply] = await Promise.all([
      getArubPrice(),
      getTotalSupplyArub()
    ]);

    const arubPrice = arubPriceInfo?.price;

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    // 1) ARUB price
    setText('arubPriceValue', Number.isFinite(arubPrice) ? arubPrice.toFixed(6) : '—');

    // 2) Total supply (если где-то показывается)
    const supplyEl = document.getElementById('totalSupplyArub');
    if (supplyEl) {
      supplyEl.textContent = formatTokenAmount(totalSupply) + ' ARUB';
    }

    // 3) Если в верстке остались staking-поля — заполняем "—"
    [
      'dashHeroStakers', 'dashHeroTvl',
      'totalTvl', 'currentApy', 'totalStakers',
      'globalTvl', 'globalApy', 'globalStakers',
      'globalArubPrice'
    ].forEach((id) => setText(id, '—'));

    console.log('[APP] ✅ Stats updated (vault-only)');
  } catch (error) {
    console.error('[APP] ❌ Error updating stats (vault-only):', error);

    // мягкий фолбек
    const ids = [
      'arubPriceValue',
      'totalSupplyArub',
      'dashHeroStakers',
      'dashHeroTvl',
      'totalTvl',
      'currentApy',
      'totalStakers'
    ];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
  }
}

/**
 * Анимации при скролле (если блоки есть на странице)
 */
function setupScrollAnimations() {
  const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -100px 0px'
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, observerOptions);

  document.querySelectorAll('.stats-section').forEach(section => {
    section.style.opacity = '0';
    section.style.transform = 'translateY(30px)';
    section.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(section);
  });
}

/**
 * Плавный скролл + мелкие слушатели (без faucet/staking)
 */
function setupGlobalEventListeners() {
  // Плавный скролл по якорям
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Переключатель языка (если есть)
  const langButtons = document.querySelectorAll('.lang-btn');
  langButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      langButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showNotification('🌐 Мовна підтримка в розробці', 'info');
    });
  });

  // Если контракты инициализировались где-то ещё — обновим статы
  window.addEventListener('contractsInitialized', () => {
    console.log('[APP] Updating stats (contractsInitialized)...');
    updateGlobalStats();
  });
}

/**
 * Лог сети/chainId максимально безопасно
 */
async function logNetworkState(tag = 'APP') {
  try {
    const ws = window.walletState;

    let chainId = ws?.chainId;

    if (!chainId && ws?.provider?.getNetwork) {
      const net = await ws.provider.getNetwork();
      chainId = net?.chainId;
    }

    console.log(`[${tag}] walletState chainId:`, chainId ?? '(unknown)');
  } catch (e) {
    console.warn(`[${tag}] logNetworkState failed:`, e);
  }
}

/**
 * Wallet dropdown menu logic (без падений, без несуществующих переменных)
 */
//function setupWalletMenu() {
  const getAddress = () => window.walletState?.address || '';

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
  });

  document.getElementById('changeWalletBtn')?.addEventListener('click', async () => {
    document.getElementById('walletMenu')?.classList.remove('open');

    // Если у вас есть отдельная функция выбора кошелька (connectWalletUI) — используем её.
    // Иначе просто дисконнект.
    await disconnectWallet();
    if (typeof window.connectWalletUI === 'function') {
      await window.connectWalletUI();
    } else {
      showNotification?.('Вибір кошелька не налаштований (connectWalletUI відсутня)', 'info');
    }
  });

  document.getElementById('disconnectBtn')?.addEventListener('click', async () => {
    document.getElementById('walletMenu')?.classList.remove('open');
    await disconnectWallet();
  });
//}

/**
 * Инициализация приложения
 */
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
    initWalletModule();

    console.log('[APP] Initializing trading module...');
    initTradingModule();

    setupGlobalEventListeners();
    setupScrollAnimations();
    setupWalletMenu();

    // Периодическое обновление статов (если нужно)
    const interval = CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000;
    setInterval(() => updateGlobalStats(), interval);

    console.log('[APP] ✅ Application ready!');
    const netName =
  CONFIG?.NETWORK?.name ||
  CONFIG?.NETWORK?.chainName ||
  CONFIG?.NETWORK?.chainIdName ||
  'Arbitrum One';

const chainId = Number(CONFIG?.NETWORK?.chainIdDecimal ?? CONFIG?.NETWORK?.chainId ?? 42161);

console.log('[APP] Network:', netName);
console.log('[APP] Chain ID:', chainId);

    await logNetworkState('APP');
  } catch (error) {
    console.error('[APP] ❌ Initialization error:', error);
    showNotification?.('❌ Помилка ініціалізації додатку', 'error');
    await logNetworkState('APP');
  }
}

// -------------------------
// Глобальные функции для HTML
// -------------------------

// Trading
window.buyTokens = buyTokens;
window.sellTokens = sellTokens;
window.setMaxBuy = setMaxBuy;
window.setMaxSell = setMaxSell;

// Хелпер для скролла
window.scrollToSection = (sectionId) => {
  const element = document.getElementById(sectionId);
  if (element) element.scrollIntoView({ behavior: 'smooth' });
};

// Подпишемся на wallet-connected, если событие/хук используется
const prevOnWalletConnected = window.onWalletConnected;
window.onWalletConnected = async (address, meta) => {
  try { prevOnWalletConnected?.(address, meta); } catch (_) {}
  await logNetworkState('APP');
};

// Старт
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

console.log('[APP] Version: 2.0.0 (Vault-only)');
console.log('[APP] Build: ' + new Date().toISOString());

const netName =
  CONFIG?.chainName ||
  CONFIG?.networkName ||
  CONFIG?.name ||
  'Arbitrum One';

const chainId = Number(CONFIG?.chainId ?? CONFIG?.chainIdDecimal ?? 42161);

console.log('[APP] Network:', netName);
console.log('[APP] Chain ID:', chainId);
console.log('[APP] RPC:', (CONFIG?.rpcUrls?.[0] || '(none)'));
console.log('[APP] Explorer:', (CONFIG?.blockExplorerUrls?.[0] || '(none)'));


export { initApp };

document.addEventListener('DOMContentLoaded', () => {
  const connectBtn = document.getElementById('connectBtn');
  const dropdown = document.getElementById('walletDropdown');

  if (!connectBtn || !dropdown) {
    console.warn('[UI] wallet button or dropdown not found');
    return;
  }

  // стартовый рендер
  updateWalletUI('init');
  renderWallets();

  // toggle dropdown по клику на кнопку
  connectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const ws = window.walletState;
    const connected = !!ws?.address && !!ws?.signer;

    if (!connected) {
      renderWallets(); // показать список кошельков
    }

    dropdown.style.display = (dropdown.style.display === 'block') ? 'none' : 'block';
  });

  // закрытие dropdown по клику вне зоны
  document.addEventListener('click', (e) => {
    const area = document.querySelector('.wallet-button-area');
    if (!area) return;
    if (!area.contains(e.target)) dropdown.style.display = 'none';
  });
});
