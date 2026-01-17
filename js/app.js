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
import { ERC20_ABI_MIN, VAULT_ABI } from './abis.js';
import { initI18n, getStoredLang } from './i18n.js';
import {
  initReadOnlyContracts,
  getReadOnlyProviderAsync,
  getArubPrice,
  getTotalSupplyArub,
} from './contracts.js';

initWalletModule(); // важно: до любых renderWallets()
initI18n();

const I18N = {
  ru: {
    wallets_not_found: 'Гаманці не знайдені',
    wallets_hint: 'Увімкніть розширення гаманця (MetaMask / Trust / Phantom / Uniswap).',
    wallets_bad_format: 'Некоректний формат списку гаманців (walletId/id відсутній).',
    choose_wallet: 'Оберіть гаманець',
    connect_wallet: 'Підключити гаманець',
    price_source_oracle: 'Ончейн оракул',
    price_source_oracle_fallback: 'Резервний оракул',
    price_source_fallback: 'Резервні дані',
    price_source_label: 'Джерело курсу: {{source}}',
    price_source_unknown: 'Джерело курсу: —',
    data_updated: 'Дані оновлено',
    wallet_not_found: 'Web3-гаманець не знайдено. Встановіть MetaMask/Trust/Phantom/Uniswap або відкрийте сайт у dApp-браузері.',
    select_wallet_first: 'Спочатку оберіть гаманець і підключіться.',
    wallet_menu_not_found: 'Меню гаманця не знайдено в DOM.',
    add_token_failed: 'Не вдалося додати токен.',
    trading_connect_wallet: 'Підключіть гаманець для торгівлі',
    trading_connected_note: 'Гаманець підключено. UI торгівлі має бути відрендерено trading.js.',
  },
  en: {
    wallets_not_found: 'No wallets found',
    wallets_hint: 'Enable a wallet extension (MetaMask / Trust / Phantom / Uniswap).',
    wallets_bad_format: 'Invalid wallet list format (walletId/id missing).',
    choose_wallet: 'Choose a wallet',
    connect_wallet: 'Connect wallet',
    price_source_oracle: 'On-chain oracle',
    price_source_oracle_fallback: 'Fallback oracle',
    price_source_fallback: 'Fallback data',
    price_source_label: 'Price source: {{source}}',
    price_source_unknown: 'Price source: —',
    data_updated: 'Data updated',
    wallet_not_found: 'Web3 wallet not found. Install MetaMask/Trust/Phantom/Uniswap or open the site in a dApp browser.',
    select_wallet_first: 'Please choose a wallet and connect first.',
    wallet_menu_not_found: 'Wallet menu not found in DOM.',
    add_token_failed: 'Failed to add token.',
    trading_connect_wallet: 'Connect a wallet to trade',
    trading_connected_note: 'Wallet connected. Trading UI should be rendered by trading.js.',
  },
};

function t(key, vars) {
  const lang = (getStoredLang?.() || 'ru');
  const dict = I18N[lang] || I18N.ru;
  let out = dict[key] || I18N.ru[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(vars[k]));
    });
  }
  return out;
}

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
  dd.querySelector('.wallet-list')?.style.setProperty('display', 'none');

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
  list.innerHTML = `
    <div class="wallet-list-title">${t('wallets_not_found')}</div>
    <div class="wallet-list-hint">${t('wallets_hint')}</div>
  `;

  // железобетонно скрываем список, если dropdown закрыт
  list.style.display = dd.classList.contains('open') ? 'block' : 'none';

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
      <div class="wallet-list-title">${t('wallets_not_found')}</div>
      <div class="wallet-list-hint">${t('wallets_bad_format')}</div>
    `;
    list.style.display = dd.classList.contains('open') ? 'block' : 'none';
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
    <div class="wallet-list-title">${t('choose_wallet')}</div>
    <div class="wallet-items">
      ${norm.map(w => `
        <div class="wallet-item-textonly" data-wallet-id="${escapeHtml(String(w.id))}">
          ${escapeHtml(String(w.label))}
        </div>
      `).join('')}
    </div>
  `;
  list.style.display = dd.classList.contains('open') ? 'block' : 'none';

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
    connectBtn.textContent = connected ? shortAddr(ws.address) : t('connect_wallet');
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

  const setDropdownOpen = (open) => {
    const menu = getMenuEl();
    if (!menu) return;
    menu.classList.toggle('open', !!open);
    menu.querySelector('.wallet-list')?.style.setProperty('display', open ? 'block' : 'none');
  };

  // закрытие dropdown по клику вне
  document.addEventListener('click', (e) => {
    const menu = getMenuEl();
    const area = getAreaEl();
    if (!menu || !area) return;

    if (menu.classList.contains('open') && !area.contains(e.target)) {
      setDropdownOpen(false);
    }
  });

  // клики внутри dropdown не закрывают его
  getMenuEl()?.addEventListener('click', (e) => e.stopPropagation());

  // Disconnect button
  document.getElementById('disconnectWalletBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    setDropdownOpen(false);

    await disconnectWallet();
    try { renderWallets(); } catch (_) {}
    try { updateWalletUI?.('disconnected'); } catch (_) {}
  });
}

function getPriceSourceLabel(info) {
  if (info?.source === 'oracle') return info?.isFallback ? t('price_source_oracle_fallback') : t('price_source_oracle');
  if (info?.isFallback) return t('price_source_fallback');
  return '—';
}
// -----------------------------
// Global stats
// -----------------------------
async function updateGlobalStats() {
  try {
    const [oraclePriceInfo, totalSupply] = await Promise.all([
      getArubPrice().catch(() => null),
      getTotalSupplyArub()
    ]);

    const oracleOk = oraclePriceInfo && Number.isFinite(oraclePriceInfo.price);
    const priceInfo = oracleOk ? oraclePriceInfo : null;

    const arubPrice = priceInfo?.price;
    const priceSource = getPriceSourceLabel(priceInfo);

    const setTextLocal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    const priceOk = Number.isFinite(arubPrice);
    setTextLocal('arubPriceValue', priceOk ? arubPrice.toFixed(6) : '—');
    setTextLocal(
      'arubPriceSource',
      priceOk ? t('price_source_label', { source: priceSource }) : t('price_source_unknown')
    );

    const priceShort = priceOk ? arubPrice.toFixed(2) : '—';
    setTextLocal('arubPriceDisplay', priceOk ? `${priceShort} USDT` : '—');
    setTextLocal('usdRubRate', priceShort);

    const supplyHuman = formatTokenAmount(totalSupply) + ' ARUB';
    const supplyUsd = priceOk ? `$${(Number(ethers.utils.formatUnits(totalSupply, 6)) * arubPrice).toFixed(2)}` : '—';

    setTextLocal('totalSupplyArub', supplyHuman);
    setTextLocal('arub-supply', supplyHuman);
    setTextLocal('arub-supply-usd', supplyUsd);

    setTextLocal('dashHeroStakers', '—');
    setTextLocal('dashHeroTvl', '—');
    setTextLocal('dashHeroTier', 'Arbitrum One');

    const loading = document.getElementById('dashLoadingText');
    try {
      await updateVaultStats(priceInfo, setTextLocal);
    } catch (e) {
      console.warn('[APP] updateVaultStats failed:', e?.message || e);
    }
    if (oracleOk) {
      try {
        window.dispatchEvent(new CustomEvent('oraclePriceUpdated', {
          detail: { price: oraclePriceInfo.price, sourceLabel: getPriceSourceLabel(oraclePriceInfo) }
        }));
      } catch (_) {}
    }
    if (loading && priceOk) {
      loading.textContent = t('data_updated');
    }
  } catch (e) {
    console.warn('[APP] updateGlobalStats failed:', e?.message || e);
  }
}

async function updateVaultStats(arubPriceInfo, setTextLocal) {
  const vaultAddr = CONFIG?.VAULT_ADDRESS;
  const arubAddr = CONFIG?.TOKEN_ADDRESS;
  const usdtAddr = CONFIG?.USDT_ADDRESS;
  if (!vaultAddr || !arubAddr || !usdtAddr) return;

  const setTextSafe =
    typeof setTextLocal === 'function'
      ? setTextLocal
      : (id, val) => {
          const el = document.getElementById(id);
          if (el) el.textContent = val;
        };

  let provider = null;
  try {
    provider = await getReadOnlyProviderAsync();
  } catch (_) {
    return;
  }
  if (!provider) return;

  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
  const arub = new ethers.Contract(arubAddr, ERC20_ABI_MIN, provider);
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI_MIN, provider);

  let sharesSupply;
  let sharesDecimals;
  let arubBal;
  let arubDecimals;
  let usdtBal;
  let usdtDecimals;

  try {
    [
      sharesSupply,
      sharesDecimals,
      arubBal,
      arubDecimals,
      usdtBal,
      usdtDecimals,
    ] = await Promise.all([
      vault.totalSupply(),
      vault.decimals().catch(() => CONFIG?.TOKEN_DECIMALS ?? 6),
      arub.balanceOf(vaultAddr),
      arub.decimals().catch(() => CONFIG?.TOKEN_DECIMALS ?? 6),
      usdt.balanceOf(vaultAddr),
      usdt.decimals().catch(() => 6),
    ]);
  } catch (_) {
    return;
  }

  const sharesDec = Number(sharesDecimals);
  const arubDec = Number(arubDecimals);
  const usdtDec = Number(usdtDecimals);

  const safeSharesDec = Number.isFinite(sharesDec) ? sharesDec : 6;
  const safeArubDec = Number.isFinite(arubDec) ? arubDec : 6;
  const safeUsdtDec = Number.isFinite(usdtDec) ? usdtDec : 6;

  const sharesHuman = formatTokenAmount(sharesSupply, safeSharesDec, 6);
  setTextSafe('dashHeroStakers', sharesHuman);

  const arubHuman = formatTokenAmount(arubBal, safeArubDec, 6);
  const usdtHuman = formatTokenAmount(usdtBal, safeUsdtDec, 2);

  setTextSafe('arub-staked', `${arubHuman} ARUB`);
  setTextSafe('usdt-staked', `${usdtHuman} USDT`);

  const arubVal = Number(ethers.utils.formatUnits(arubBal, safeArubDec));
  const usdtVal = Number(ethers.utils.formatUnits(usdtBal, safeUsdtDec));

  const price = Number(arubPriceInfo?.price);
  const priceOk = Number.isFinite(price) && price > 0;

  if (priceOk) {
    const arubUsd = arubVal * price;
    const tvlUsd = arubUsd + usdtVal;
    setTextSafe('arub-staked-usd', formatUSD(arubUsd));
    setTextSafe('dashHeroTvl', formatUSD(tvlUsd));
  } else {
    setTextSafe('arub-staked-usd', '—');
  }

  setTextSafe('usdt-staked-usd', formatUSD(usdtVal));
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

function normalizeAvgPrice(avgPrice, currentPrice) {
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return avgPrice;

  const inv = 1 / avgPrice;
  const rel = Math.abs(avgPrice - currentPrice) / currentPrice;
  const relInv = Math.abs(inv - currentPrice) / currentPrice;

  if (Number.isFinite(relInv) && relInv < rel) return inv;
  return avgPrice;
}

const USDT_DECIMALS = 6;
const ARUB_DECIMALS = 6;

// 2025-12-15 16:30:03 UTC (ваш деплой)
const PRESALE_DEPLOY_UTC_MS = Date.parse('2025-12-15T16:30:03Z');
const PRESALE_STATS_CACHE = new Map();
const PRESALE_STATS_CACHE_EPS = 1e-6;
const PRESALE_STATS_STORAGE_PREFIX = 'arub:presaleStats:v1';

function presaleCacheKey(address) {
  return String(address || '').toLowerCase();
}

function samePaidUsdt(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= PRESALE_STATS_CACHE_EPS;
}

function presaleStorageKey(address) {
  const addr = presaleCacheKey(address);
  const presale = presaleCacheKey(CONFIG?.PRESALE_ADDRESS);
  return `${PRESALE_STATS_STORAGE_PREFIX}:${presale}:${addr}`;
}

function loadPresaleStatsFromStorage(address) {
  try {
    if (!address || !window?.localStorage) return null;
    const raw = localStorage.getItem(presaleStorageKey(address));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data) return null;

    const paidUSDT = Number(data.paidUSDT);
    const totalARUB = Number(data.totalARUB);
    const principalARUB = Number(data.principalARUB);
    const bonusARUB = Number(data.bonusARUB);
    const avgPrice = Number(data.avgPrice);

    if (!Number.isFinite(paidUSDT) || !Number.isFinite(totalARUB)) return null;
    return { paidUSDT, totalARUB, principalARUB, bonusARUB, avgPrice };
  } catch (_) {
    return null;
  }
}

function savePresaleStatsToStorage(address, stats) {
  try {
    if (!address || !window?.localStorage) return;
    const payload = {
      paidUSDT: stats?.paidUSDT ?? null,
      totalARUB: stats?.totalARUB ?? null,
      principalARUB: stats?.principalARUB ?? null,
      bonusARUB: stats?.bonusARUB ?? null,
      avgPrice: stats?.avgPrice ?? null,
      cachedAt: Date.now(),
    };
    localStorage.setItem(presaleStorageKey(address), JSON.stringify(payload));
  } catch (_) {}
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

  return { paidUSDT, totalARUB, principalARUB, bonusARUB, avgPrice };
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

  // Some RPC providers cap eth_getLogs ranges (e.g. 50k blocks). Keep the
  // step conservative to avoid SERVER_ERROR -32701 "exceed maximum block range".
  const STEP = 50_000;

  const totalRanges = Math.max(1, Math.ceil((endBlock - startBlock + 1) / STEP));
  let doneRanges = 0;

  setPresaleScanVisible(true);
  setPresaleScanProgress(0);

  try {
    for (let from = startBlock; from <= endBlock; from += STEP) {
      const to = Math.min(endBlock, from + STEP - 1);

      let logs;
      try {
        logs = await presale.queryFilter(filter, from, to);
      } catch (err) {
        // If provider still rejects the range, shrink the window and retry once.
        const mid = Math.floor((from + to) / 2);
        const firstHalf = await presale.queryFilter(filter, from, mid);
        const secondHalf = await presale.queryFilter(filter, mid + 1, to);
        logs = firstHalf.concat(secondHalf);
      }

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

  let presale = null;
  let usedEvents = false;
  const loadingNote = document.getElementById('presaleLoadingNote');
  if (loadingNote) loadingNote.style.display = 'none';

  let fast = null;
  try {
    fast = await loadPresaleStats(address, provider);
  } catch (_) {}

  const fastPaid = fast?.paidUSDT;
  const fastPaidOk = Number.isFinite(fastPaid);
  const hasPaid = fastPaidOk && fastPaid > 0;

  const key = presaleCacheKey(address);
  if (!PRESALE_STATS_CACHE.has(key)) {
    const stored = loadPresaleStatsFromStorage(address);
    if (stored) PRESALE_STATS_CACHE.set(key, stored);
  }
  const cached = PRESALE_STATS_CACHE.get(key);
  const canUseCache =
    cached &&
    Number.isFinite(cached.paidUSDT) &&
    (!fastPaidOk || samePaidUsdt(cached.paidUSDT, fastPaid));

  if (hasPaid || !fastPaidOk) {
    if (canUseCache) {
      presale = cached;
      usedEvents = true;
    } else {
      if (loadingNote) loadingNote.style.display = '';
      try {
        presale = await loadPresaleStatsFromEvents(address, provider);
        if (presale) {
          PRESALE_STATS_CACHE.set(key, presale);
          savePresaleStatsToStorage(address, presale);
          usedEvents = true;
        }
      } catch (_) {
        if (cached) {
          presale = cached;
          usedEvents = true;
        }
      }
    }
  }

  if (!presale) {
    presale = fast;
  }

  if (!presale) {
    presale = { paidUSDT: 0, totalARUB: 0, principalARUB: 0, bonusARUB: 0, avgPrice: null };
  }
  if (!usedEvents) {
    presale.avgPrice = null;
  }

  const currentPrice = await loadCurrentArubPrice(provider);
  const avgPrice = normalizeAvgPrice(presale.avgPrice, currentPrice);
  const discount = calcDiscount(avgPrice, currentPrice);
  const bonusPct = presale.totalARUB > 0 ? (presale.bonusARUB / presale.totalARUB) * 100 : null;

  setText('presalePurchased', presale.totalARUB.toFixed(6));
  setText('presaleBonusAmount', presale.bonusARUB != null ? presale.bonusARUB.toFixed(6) : '—');
  setText('presalePaid', presale.paidUSDT.toFixed(2));
  setText('presaleAvgPrice', avgPrice ? avgPrice.toFixed(6) : '—');
  setText('presaleBonusPct', bonusPct !== null ? bonusPct.toFixed(2) + '%' : '—');
  setText('presaleDiscount', discount !== null ? discount.toFixed(2) + '%' : '—');

  if (loadingNote) loadingNote.style.display = 'none';
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
    showNotification?.(t('wallet_menu_not_found'), 'error');
    return;
  }

  const connected = !!window.walletState?.address && !!window.walletState?.signer;
  if (!connected) {
    try { await renderWallets(); } catch (_) {}
    const hasAny = (getAvailableWallets() || []).length > 0;
    if (!hasAny) {
      showNotification?.(
        t('wallet_not_found'),
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
      showNotification?.(t('select_wallet_first'), 'info');
      return;
    }
    // addTokenToWalletImpl должен быть определён в вашем проекте
    return await addTokenToWalletImpl(symbol);
  } catch (e) {
    console.error(e);
    showNotification?.(e?.message || t('add_token_failed'), 'error');
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

  const setDropdownOpen = (open) => {
    dd.classList.toggle('open', !!open);
    dd.querySelector('.wallet-list')?.style.setProperty('display', open ? 'block' : 'none');
  };

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    try { await renderWallets(); } catch (err) {
      console.warn('[UI] renderWallets failed:', err?.message || err);
    }

    // toggle + sync display
    setDropdownOpen(!dd.classList.contains('open'));
  });

  dd.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (!dd.classList.contains('open')) return;
    const area = document.querySelector('.wallet-button-area') || btn.closest('.wallet-wrap') || btn.parentElement;
    if (area && !area.contains(e.target)) {
      setDropdownOpen(false);
    }
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
      <p>${t('trading_connect_wallet')}</p>
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

  const placeholders = [
    I18N.ru.trading_connect_wallet,
    I18N.en.trading_connect_wallet,
  ];
  if (!box.innerHTML || placeholders.some((p) => box.textContent.includes(p))) {
    box.innerHTML = `
      <div style="text-align:center; padding:30px;">
        <div style="font-size:2em; margin-bottom:10px;">✅</div>
        <p>${t('trading_connected_note')}</p>
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
window.addEventListener('langChanged', () => {
  try { updateWalletUI?.('langChanged'); } catch (_) {}
  try { updateGlobalStats?.(); } catch (_) {}
  try { syncTradingLock?.('langChanged'); } catch (_) {}
});

async function refreshTradingBalancesSafe(reason = 'unknown') {
  try {
    const ws = window.walletState;
    const addr = ws?.address;
    const signer = ws?.signer;

    const usdtEl = document.getElementById('usdtBalance');
    const arubEl = document.getElementById('arubBalance');

    // если этих элементов нет на странице — тихо выходим
    if (!usdtEl && !arubEl) return;

    // если не подключены — показываем прочерк
    if (!addr || !signer) {
      if (usdtEl) usdtEl.textContent = '—';
      if (arubEl) arubEl.textContent = '—';
      return;
    }

    let roProvider = null;
    try {
      roProvider = await getReadOnlyProviderAsync();
    } catch (_) {}

    let provider = roProvider || signer.provider;
    if (!provider) return;

    // минимальный ERC20 ABI
    const ERC20 = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)'
    ];

    const fetchBalances = async (prov) => {
      // USDT
      if (usdtEl && CONFIG.USDT_ADDRESS) {
        const usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20, prov);
        const [bal, dec] = await Promise.all([usdt.balanceOf(addr), usdt.decimals()]);
        const usdtVal = Number(ethers.utils.formatUnits(bal, dec));
        usdtEl.textContent = usdtVal.toFixed(2);
      }

      // ARUB (token)
      if (arubEl && CONFIG.TOKEN_ADDRESS) {
        const arub = new ethers.Contract(CONFIG.TOKEN_ADDRESS, ERC20, prov);
        const [bal, dec] = await Promise.all([arub.balanceOf(addr), arub.decimals()]);
        arubEl.textContent = ethers.utils.formatUnits(bal, dec);
      }
    };

    try {
      await fetchBalances(provider);
    } catch (e) {
      const fallback = provider === signer.provider ? roProvider : signer.provider;
      if (fallback && fallback !== provider) {
        await fetchBalances(fallback);
      } else {
        throw e;
      }
    }

    console.log('[UI] balances updated', { reason });
  } catch (e) {
    console.warn('[UI] refreshTradingBalancesSafe failed:', e?.message || e);
  }
}

function bindMaxButtonsScoped() {
  if (window.__maxScopedBound) return;
  window.__maxScopedBound = true;

  const tradingRoot = document.getElementById('tradingInterface');
  if (!tradingRoot) return;

  const getNum = (id) => {
    const t = document.getElementById(id)?.textContent ?? '';
    const n = Number(String(t).replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  };

  const findSideContainer = (btn) => {
    // Поднимаемся вверх, пока не дойдём до #tradingInterface, и ищем ближайший блок,
    // который явно относится к "Купівля" или "Продаж"
    let el = btn;
    while (el && el !== tradingRoot) {
      const txt = (el.innerText || '').toLowerCase();
      const hasBuy = txt.includes('купівля') || txt.includes('buy');
      const hasSell = txt.includes('продаж') || txt.includes('sell');

      // Берём контейнер, где есть одно из слов (и не оба сразу)
      if (hasBuy && !hasSell) return { side: 'buy', box: el };
      if (hasSell && !hasBuy) return { side: 'sell', box: el };

      el = el.parentElement;
    }
    return null;
  };

  const findInputInBox = (box) => {
    // Ищем ближайший input именно в этом блоке
    return box.querySelector('input[type="number"], input[type="text"]');
  };

  // CAPTURE: перехватить раньше любых старых обработчиков
  tradingRoot.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button');
    if (!btn) return;

    const label = (btn.textContent || '').trim().toUpperCase();
    if (label !== 'МАКС' && label !== 'MAX') return;

    const info = findSideContainer(btn);
    if (!info) return;

    const input = findInputInBox(info.box);
    if (!input) return;

    // Остановить старые кривые обработчики, чтобы не писали в BUY
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (info.side === 'buy') {
      const usdt = getNum('usdtBalance');
      if (usdt === null) return;
      input.value = usdt.toFixed(2);
    } else {
      const arub = getNum('arubBalance');
      if (arub === null) return;
      // ARUB лучше не резать до 2, оставим до 6 (или как у тебя)
      input.value = String(arub);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);
}

document.addEventListener('DOMContentLoaded', bindMaxButtonsScoped);

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
      connectBtn.textContent = t('connect_wallet');
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
window.addEventListener('walletStateChanged', () => refreshTradingBalancesSafe('walletStateChanged'));
document.addEventListener('DOMContentLoaded', () => refreshTradingBalancesSafe('DOMContentLoaded'));
window.addEventListener('contractsInitialized', () => refreshTradingBalancesSafe('contractsInitialized'));
setupGlobalEventListeners();


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


