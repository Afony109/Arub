/**
 * UI Module
 * Handles UI updates, notifications, and common UI functions
 */

import { CONFIG } from './config.js';

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
