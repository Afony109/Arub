/**
 * UI Module
 * Notifications + token formatting
 */

import { CONFIG } from './config.js';
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';

// -----------------------------
// Notifications
// -----------------------------
export function showNotification(message, type = 'info', duration) {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  const safeDuration =
    Number.isFinite(duration)
      ? duration
      : (CONFIG?.UI?.NOTIFICATION_DURATION ?? 5000);

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateX(400px)';
    setTimeout(() => notification.remove(), 300);
  }, safeDuration);
}

// -----------------------------
// Token helpers (ROOP = 6 decimals)
// -----------------------------
export function formatTokenAmount(value, decimals = 6, maxFrac = 6) {
  const s = ethers.utils.formatUnits(value ?? 0, decimals);
  const [i, f = ''] = String(s).split('.');
  const ff = f.slice(0, maxFrac);
  return ff ? `${i}.${ff}` : i;
}

/**
 * Format value as USD string
 * @param {number|string|BigNumber} value
 * @param {number} decimals - token decimals (default 6)
 */
export function formatUSD(value, decimals = 6) {
  let n;

  try {
    // If BigNumber — convert first
    if (value?._isBigNumber) {
      n = Number(ethers.utils.formatUnits(value, decimals));
    } else {
      n = Number(value);
    }
  } catch (_) {
    n = 0;
  }

  if (!Number.isFinite(n)) n = 0;

  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}


export function parseTokenAmount(raw, decimals = 6) {
  if (raw == null) throw new Error('Amount is empty');

  const s = String(raw).trim().replace(',', '.');
  if (!s) throw new Error('Amount is empty');

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid amount');
  }

  const [i, f = ''] = s.split('.');
  const safe = f ? `${i}.${f.slice(0, decimals)}` : i;

  return ethers.utils.parseUnits(safe, decimals);
}

export async function copyToClipboard(text) {
  const s = String(text ?? '');

  // Modern API (secure contexts)
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(s);
    return true;
  }

  // Fallback
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();

  try {
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    document.body.removeChild(ta);
    throw e;
  }
}

// -----------------------------
// Loading helper
// -----------------------------
export function showLoading(element, message = 'Завантаження...') {
  if (!element) return;

  element.innerHTML = `
    <div style="text-align: center; padding: 60px; color: var(--gray);">
      <div class="loading" style="width: 40px; height: 40px; margin: 0 auto 20px;"></div>
      <p style="font-size: 1.2em;">${message}</p>
    </div>
  `;
}

// -----------------------------
// Oracle price formatting
// -----------------------------
export function formatPrice(value, maxDecimals = (CONFIG?.ORACLE_DECIMALS ?? 6)) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(maxDecimals).replace(/\.?0+$/, '');
}
