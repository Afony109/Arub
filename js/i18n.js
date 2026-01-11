const STORAGE_KEY = 'arub_lang';
const SUPPORTED = new Set(['ru', 'en']);

function normalizeLang(lang) {
  if (!lang) return null;
  const l = String(lang).toLowerCase();
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ru')) return 'ru';
  return null;
}

export function getStoredLang() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (_) {}

  const normalized = normalizeLang(stored);
  if (normalized && SUPPORTED.has(normalized)) return normalized;

  const nav = normalizeLang(navigator?.language || '');
  if (nav && SUPPORTED.has(nav)) return nav;

  return 'ru';
}

export function applyLang(lang) {
  const normalized = normalizeLang(lang) || 'ru';

  if (document?.documentElement) {
    document.documentElement.lang = normalized;
  }

  document.querySelectorAll('[data-lang]').forEach((el) => {
    if (el.classList.contains('lang-btn')) return;
    const elLang = normalizeLang(el.getAttribute('data-lang'));
    el.hidden = elLang !== normalized;
  });

  document.querySelectorAll('.lang-btn[data-lang]').forEach((btn) => {
    const btnLang = normalizeLang(btn.getAttribute('data-lang'));
    if (btnLang === normalized) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  return normalized;
}

export function setLang(lang) {
  const normalized = normalizeLang(lang) || 'ru';
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch (_) {}
  const applied = applyLang(normalized);
  try {
    window.dispatchEvent(new CustomEvent('langChanged', { detail: { lang: applied } }));
  } catch (_) {}
  return applied;
}

export function initI18n() {
  const boot = () => {
    const applied = applyLang(getStoredLang());
    try {
      window.dispatchEvent(new CustomEvent('langChanged', { detail: { lang: applied } }));
    } catch (_) {}

    document.querySelectorAll('.lang-btn[data-lang]').forEach((btn) => {
      if (btn.dataset.i18nBound === '1') return;
      btn.dataset.i18nBound = '1';
      btn.addEventListener('click', () => setLang(btn.dataset.lang));
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

// Expose a tiny bridge for inline scripts.
try {
  window.getStoredLang = getStoredLang;
  window.setLang = setLang;
  window.applyLang = applyLang;
} catch (_) {}
