/**
 * Main Application Entry Point (Vault-only)
 * Initializes modules and manages global state
 * Staking/Faucet removed.
 */

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
window.CONFIG = window.CONFIG || CONFIG;
import { initWalletModule, addTokenToWallet, connectWallet, disconnectWallet } from './wallet.js';
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount, formatPrice } from './ui.js';
import { getArubPrice, initReadOnlyContracts, getTotalSupplyArub } from './contracts.js';

// Address used by wallet dropdown actions
let selectedAddress = null;

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

    setText('arubPriceValue', formatPrice(arubPrice, CONFIG.ORACLE_DECIMALS ?? 6));

    const status = arubPriceInfo?.isFallback ? 'cached' : (arubPriceInfo?.isStale ? 'stale' : '');
    setText('arubPriceStatus', status);

    // Notify other scripts (e.g., chart) that oracle price has updated
    window.dispatchEvent(new CustomEvent('oraclePriceUpdated', {
      detail: {
        price: arubPrice,
        sourceLabel: arubPriceInfo?.isFallback
          ? 'oracle (cached)'
          : (arubPriceInfo?.isStale ? 'oracle (stale)' : 'oracle'),
      }
    }));


    const supplyEl = document.getElementById('totalSupplyArub');
    if (supplyEl) {
      supplyEl.textContent = formatTokenAmount(totalSupply) + ' ARUB';
    }

    [
      'dashHeroStakers', 'dashHeroTvl', 'totalTvl', 'currentApy', 'totalStakers',
      'globalTvl', 'globalApy', 'globalStakers', 'globalArubPrice'
    ].forEach((id) => setText(id, '—'));

    console.log('[APP] ✅ Stats updated (vault-only)');
  } catch (error) {
    console.error('[APP] ❌ Error updating stats (vault-only):', error);

    const ids = [
      'arubPriceValue', 'totalSupplyArub', 'dashHeroStakers',
      'dashHeroTvl', 'totalTvl', 'currentApy', 'totalStakers'
    ];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });

    const chainId =
      window.walletState?.chainId ??
      window.walletState?.provider?.network?.chainId ??
      '(unknown)';

    console.log('[APP] walletState chainId:', chainId);
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

async function logWalletNetwork() {
  try {
    const ws = window.walletState;

    if (!ws?.provider) {
      console.warn('[APP] walletState.provider missing');
      return;
    }

    const net = await ws.provider.getNetwork();

    console.log('[APP] Network:', net?.name);
    console.log('[APP] Chain ID:', net?.chainId);
  } catch (e) {
    console.error('[APP] logWalletNetwork error:', e);

    const chainId =
      window.walletState?.chainId ??
      window.walletState?.provider?.network?.chainId ??
      '(unknown)';

    console.log('[APP] walletState:', window.walletState, 'chainId:', chainId ?? '(unknown)');
  }
}

async function logNetworkState(tag = 'APP') {
  const ws = window.walletState;

  // Берём chainId максимально надёжно
  let chainId = ws?.chainId;

  if (!chainId && ws?.provider?.getNetwork) {
    try {
      const net = await ws.provider.getNetwork();
      chainId = net?.chainId;
    } catch (e) {
      console.warn(`[${tag}] getNetwork() failed:`, e);
    }
  }

  console.log(`[${tag}] walletState chainId:`, chainId ?? '(unknown)');
}

// Один раз: при загрузке (если хочешь)
logNetworkState('APP').catch((e) => console.warn('[APP] logNetworkState init failed:', e));

const prevOnWalletConnected = window.onWalletConnected;

window.onWalletConnected = async (address, meta) => {
  // keep dropdown address in sync
  selectedAddress = address ?? window.walletState?.address ?? null;

  try {
    prevOnWalletConnected?.(address, meta);
  } catch (_) {}

  await logNetworkState('APP');
};

const prevOnWalletDisconnected = window.onWalletDisconnected;

window.onWalletDisconnected = async () => {
  selectedAddress = null;

  try {
    prevOnWalletDisconnected?.();
  } catch (_) {}
};


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

    // Периодическое обновление статов (если нужно)
    const interval = CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000;
    setInterval(() => updateGlobalStats(), interval);

    console.log('[APP] ✅ Application ready!');

    // Network info (be tolerant to CONFIG field names)
    const netName = CONFIG?.NETWORK?.name || CONFIG?.NETWORK?.chainName || CONFIG?.NETWORK?.chainIdName || 'Arbitrum One';
    const chainId = Number(CONFIG?.NETWORK?.chainIdDecimal ?? CONFIG?.NETWORK?.chainId ?? 42161);
    console.log('[APP] Network:', netName);
    console.log('[APP] Chain ID:', chainId);
  } catch (error) {
    console.error('[APP] ❌ Initialization error:', error);
    showNotification('❌ Помилка ініціалізації додатку', 'error');

    const chainId =
      window.walletState?.chainId ??
      window.walletState?.provider?.network?.chainId ??
      '(unknown)';

    console.log('[APP] walletState chainId:', chainId);
  }
}
/**
 * Глобальные функции для HTML-обработчиков (Vault-only)
 */
// Wallet

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

// Старт
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

console.log('[APP] Version: 2.0.0 (Vault-only)');
console.log('[APP] Build: ' + new Date().toISOString());

// =========================
// Wallet dropdown menu logic
// =========================

document.addEventListener("click", (e) => {
  const menu = document.getElementById("walletMenu");
  const wrap = document.querySelector(".wallet-wrap");

  if (!menu || !wrap) return;

  if (menu.classList.contains("open") && !wrap.contains(e.target)) {
    menu.classList.remove("open");
  }
});

document.getElementById("copyAddrBtn")?.addEventListener("click", async () => {
  if (!selectedAddress) return;

  await navigator.clipboard.writeText(selectedAddress);
  document.getElementById("walletMenu").classList.remove("open");
});

document.getElementById("changeWalletBtn")?.addEventListener("click", async () => {
  document.getElementById("walletMenu").classList.remove("open");

  // Сброс текущего и выбор нового кошелька
  await disconnectWallet();
  await connectWallet();
});

document.getElementById("disconnectBtn")?.addEventListener("click", async () => {
  document.getElementById("walletMenu").classList.remove("open");
  await disconnectWallet();
});


export { initApp };

