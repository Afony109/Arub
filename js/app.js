/**
 * Main Application Entry Point (Vault-only)
 * Initializes modules and manages global state
 * Staking/Faucet removed.
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import {initWalletModule, getAvailableWallets, connectWalletUI, disconnectWallet} from './wallet.js';
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount } from './ui.js';
import { getArubPrice, initReadOnlyContracts, getTotalSupplyArub } from './contracts.js';
//------------


// чтобы старый onclick="connectWallet()" продолжал работать:


window.CONFIG = window.CONFIG || CONFIG;

function renderWallets() {
  const menu =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  if (!menu) return;

  // удалить старые элементы списка (кроме disconnect)
  menu.querySelectorAll('[data-wallet-item="1"], [data-walletItem="1"]').forEach(n => n.remove());

  const wallets = getAvailableWallets();

  let uiConnecting = false;

function setWalletMenuDisabled(menuEl, disabled) {
  if (!menuEl) return;
  menuEl.querySelectorAll('button[data-wallet-item="1"]').forEach(b => {
    b.disabled = disabled;
  });
}

  wallets.forEach((w) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.walletItem = '1';
    btn.textContent = w.name;

    btn.onclick = async () => {
  if (uiConnecting) {
    showNotification?.('Wallet connection is already in progress. Close the wallet popup or wait.', 'error');
    return;
  }

  uiConnecting = true;
  setWalletMenuDisabled(menu, true);

  try {
    await connectWalletUI(w.id);
    menu.style.display = 'none';
  } catch (e) {
    // Это ожидаемая ситуация при закрытии окна или отказе
    console.error('[UI] connect error:', e);
    showNotification?.(e?.message || 'Wallet connect failed', 'error');
  } finally {
    uiConnecting = false;
    setWalletMenuDisabled(menu, false);
  }
};

    menu.prepend(btn);
  });
}


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

window.addEventListener('wallet:connected', () => {
  console.log('[APP] walletState chainId:', window.walletState?.chainId ?? '(unknown)');
});
// ------------------------------
initWalletModule?.();

// 2) UI: список кошельков в dropdown
// (1) Объявили один раз
const connectBtn = document.getElementById('connectBtn');
const dropdown   = document.getElementById('walletDropdown');
const disconnectBtn = document.getElementById('disconnectWalletBtn');

// (2) Дальше используем, без повторных const
connectBtn?.addEventListener('click', () => {
  const isOpen = dropdown?.style.display === 'block';
  if (dropdown) dropdown.style.display = isOpen ? 'none' : 'block';
});

disconnectBtn?.addEventListener('click', async () => {
  try {
    await disconnectWallet();
    if (dropdown) dropdown.style.display = 'none';
  } catch (e) {
    console.error(e);
  }
});


function clearWalletList() {
  if (!dropdown) return;
  // оставляем кнопку disconnect, остальное удаляем
  [...dropdown.querySelectorAll('[data-wallet-item="1"]')].forEach(n => n.remove());
}


connectBtn?.addEventListener('click', () => {
  // пробуем найти dropdown на момент клика
  const menu =
    document.getElementById('walletDropdown') ||
    document.getElementById('walletMenu');

  if (!menu) {
    console.warn('[UI] wallet dropdown not found in DOM');
    return;
  }

  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) renderWallets();
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
    setText('arubPriceValue', Number.isFinite(arubPrice) ? arubPrice.toFixed(2) : '—');

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
function setupWalletMenu() {
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
}

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

// Wallet
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.addTokenToWallet = addTokenToWallet;
window.addArubToMetaMask = () => addTokenToWallet('ARUB');
window.addUsdtToMetaMask = () => addTokenToWallet('USDT');
window.copyTokenAddress = () =>
  copyToClipboard(CONFIG.TOKEN_ADDRESS, '✅ Адресу токена скопійовано!');

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
