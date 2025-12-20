/**
 * UI Module
 * Handles UI updates, notifications, and common UI functions
 */

import { CONFIG } from './config.js';
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';

/**
 * Format token amount for UI
 * @param {BigNumber|string|number} value
 * @param {number} decimals - token decimals (default: 6 for ROOP)
 * @param {number} maxFrac - max fractional digits to display
 */
export function formatTokenAmount(value, decimals = 6, maxFrac = 6) {
  const s = ethers.utils.formatUnits(value ?? 0, decimals);
  const [i, f = ''] = String(s).split('.');
  const ff = f.slice(0, maxFrac);
  return ff ? `${i}.${ff}` : i;
}

/**
 * Parse user input into BigNumber
 * - normalizes comma to dot
 * - trims spaces
 * - limits fractional digits to token decimals
 *
 * @param {string|number} raw
 * @param {number} decimals - token decimals (default: 6 for ROOP)
 * @returns {BigNumber}
 */
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


// -----------------------------
// Notifications
// -----------------------------
export function showNotification(message, type = 'info', duration) {
  // Remove existing notification if any
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  // Safe duration: argument -> CONFIG.UI.NOTIFICATION_DURATION -> fallback
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

    setTimeout(() => {
      notification.remove();
    }, 300);
  }, safeDuration);
}

export function formatTokenAmount(value, decimals = 6, maxFrac = 6) {
  const s = ethers.utils.formatUnits(value ?? 0, decimals);
  const [i, f = ''] = String(s).split('.');
  const ff = f.slice(0, maxFrac);
  return ff ? `${i}.${ff}` : i;
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
