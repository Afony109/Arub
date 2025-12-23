
﻿/**
* wallet.js — Шар підключення кількох гаманців (EIP-6963 + WalletConnect) — ЗАХИЩЕНИЙ
* Виправлення:
*  - Запобігає подвійним викликам eth_requestAccounts (-32002 "already pending")
*  - Якщо -32002 виникає, чекає, поки eth_accounts стануть доступними
*  - Тільки один вибраний провайдер (ніколи window.ethereum для підпису/транзакцій)
*
* Експортує:
*   initWalletModule()
*   getAvailableWallets()
*   connectWallet(options?)
*   disconnectWallet()
*   addTokenToWallet('ARUB'|'USDT')
*   isWalletConnected(), getAddress(), getEthersProvider(), getSigner(), getEip1193Provider()
*
* Глобальні змінні:
*   window.walletState = { provider, signer, address, eip1193, wallet }
*   window.provider, window.signer, window.userAddress, window.selectedAddress
*
* Події:
*   wallet:connected (CustomEvent, detail: {address, wallet})
*   wallet:disconnected (Event)
*/
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { showNotification } from './ui.js';
console.log('[WALLET] wallet.js завантажено, збірка:', Date.now());
// -----------------------------
// Внутрішній стан (єдиний джерело правди)
// -----------------------------
let selectedEip1193 = null;
let ethersProvider = null;
let signer = null;
let currentAddress = null;
let currentChainId = null;
// Запобігти подвійному підключенню
let isConnecting = false;
// Реєстр EIP-6963
const discoveredWallets = new Map(); // rdns -> { rdns, name, icon, provider }
// Посилання на провайдер WalletConnect (для очищення)
let wcProvider = null;
// -----------------------------
// Утиліти
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assertConfig() {
if (!CONFIG?.NETWORK?.chainId) throw new Error('CONFIG.NETWORK.chainId відсутній');
if (!CONFIG?.NETWORK?.chainName) throw new Error('CONFIG.NETWORK.chainName відсутній');
if (!CONFIG?.NETWORK?.rpcUrls?.[0]) throw new Error('CONFIG.NETWORK.rpcUrls[0] відсутній');
if (!CONFIG?.NETWORK?.nativeCurrency) throw new Error('CONFIG.NETWORK.nativeCurrency відсутній');
}
function toHexChainId(chainIdDec) {
return '0x' + Number(chainIdDec).toString(16);
}
function isHexChainIdMatch(chainIdHex, targetChainIdDec) {
if (!chainIdHex) return false;
const v = parseInt(chainIdHex, 16);
return v === Number(targetChainIdDec);
}
function getActiveWalletInfo() {
const m = selectedEip1193?.__arub_meta || {};
return { type: m.type || null, name: m.name || null, rdns: m.rdns || null };
}
function publishGlobals() {
window.walletState = {
provider: ethersProvider,
signer,
address: currentAddress,
eip1193: selectedEip1193,
wallet: getActiveWalletInfo()
};
window.provider = ethersProvider;
window.signer = signer;
window.userAddress = currentAddress;
window.selectedAddress = currentAddress;
}
function clearGlobals() {
window.walletState = null;
window.provider = null;
window.signer = null;
window.userAddress = null;
window.selectedAddress = null;
}
function dispatchConnected() {
window.dispatchEvent(new CustomEvent('wallet:connected', {
detail: { address: currentAddress, wallet: getActiveWalletInfo() }
}));
}
function dispatchDisconnected() {
window.dispatchEvent(new Event('wallet:disconnected'));
}
// -----------------------------
// Допоміжний запит провайдера (НІКОЛИ не використовує window.ethereum)
// -----------------------------
async function pRequest(method, params = []) {
if (!selectedEip1193?.request) throw new Error('Немає вибраного провайдера EIP-1193');
return await selectedEip1193.request({ method, params });
}
/**

Якщо користувач двічі клацає підключення, MetaMask повертає -32002.
У такому випадку ми можемо просто чекати, поки eth_accounts з'являться.
*/
async function requestAccountsSafe() {
try {
return await pRequest('eth_requestAccounts');
} catch (err) {
if (err?.code === -32002) {
// чекати, поки акаунти стануть доступними
const maxWaitMs = 4000;
const step = 200;
let waited = 0;while (waited < maxWaitMs) {
await sleep(step);
waited += step;let acc = null;
try { acc = await pRequest('eth_accounts'); } catch (_) {}
if (acc?.[0]) return acc;
}
}
throw err;
}
}

async function ensureNetwork() {
assertConfig();
let chainIdHex = null;
try { chainIdHex = await pRequest('eth_chainId'); } catch (_) {}
const targetHex = toHexChainId(CONFIG.NETWORK.chainId);
if (chainIdHex && isHexChainIdMatch(chainIdHex, CONFIG.NETWORK.chainId)) return;
// спробувати перемикнути
try {
await pRequest('wallet_switchEthereumChain', [{ chainId: targetHex }]);
return;
} catch (err) {
// перейти до додавання
if (err?.code !== 4902) console.warn('[WALLET] перемикання ланцюга не вдалося:', err);
}
// додати ланцюг
await pRequest('wallet_addEthereumChain', [{
chainId: targetHex,
chainName: CONFIG.NETWORK.chainName,
rpcUrls: CONFIG.NETWORK.rpcUrls,
nativeCurrency: CONFIG.NETWORK.nativeCurrency,
blockExplorerUrls: CONFIG.NETWORK.blockExplorerUrls || []
}]);
}
function wireProviderEvents(provider) {
if (!provider?.on) return;
try { provider.removeListener?.('accountsChanged', onAccountsChanged); } catch () {}
try { provider.removeListener?.('chainChanged', onChainChanged); } catch () {}
try { provider.removeListener?.('disconnect', onDisconnect); } catch (_) {}
provider.on('accountsChanged', onAccountsChanged);
provider.on('chainChanged', onChainChanged);
provider.on('disconnect', onDisconnect);
}
async function onAccountsChanged(accounts) {
const a = Array.isArray(accounts) ? accounts[0] : null;
currentAddress = a ? ethers.utils.getAddress(a) : null;
if (!currentAddress) {
await disconnectWallet();
return;
}
ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
signer = ethersProvider.getSigner();
publishGlobals();
if (typeof window.onWalletConnected === 'function') {
window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
}
dispatchConnected();
}
async function onChainChanged() {
try {
ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
signer = ethersProvider.getSigner();
currentAddress = ethers.utils.getAddress(await signer.getAddress());
await ensureNetwork();
publishGlobals();
if (typeof window.onWalletConnected === 'function') {
window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
}
dispatchConnected();
} catch (e) {
console.warn('[WALLET] помилка обробки chainChanged:', e);
}
}
async function onDisconnect() {
await disconnectWallet();
}
function setSelectedProvider(provider, meta = {}) {
selectedEip1193 = provider;
selectedEip1193.__arub_meta = meta;
ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
signer = ethersProvider.getSigner();
wireProviderEvents(selectedEip1193);
}
// -----------------------------
// Відкриття EIP-6963
// -----------------------------
let _discoveryReady = false;
function setupEip6963Discovery() {
if (_discoveryReady) return;
_discoveryReady = true;
window.addEventListener('eip6963:announceProvider', (event) => {
const detail = event?.detail;
if (!detail?.info?.rdns || !detail?.provider) return;
const rdns = detail.info.rdns;
discoveredWallets.set(rdns, {
rdns,
name: detail.info.name || rdns,
icon: detail.info.icon || null,
provider: detail.provider
});
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
}
/**

Запасний варіант для спадкових інжектованих (ЛИШЕ для списку/вибору)
*/
function getLegacyInjectedEntries() {
const eth = window.ethereum;
if (!eth) return [];

if (Array.isArray(eth.providers) && eth.providers.length) {
return eth.providers.map((p, idx) => {
const name =
p.isMetaMask ? 'MetaMask' :
p.isTrust ? 'Trust Wallet' :
p.isRabby ? 'Rabby' :
Injected #${idx + 1};
return { id: legacy:${idx}, name, icon: null, type: 'injected-fallback', _provider: p };
});
}
const name =
eth.isMetaMask ? 'MetaMask' :
eth.isTrust ? 'Trust Wallet' :
eth.isRabby ? 'Rabby' :
'Injected Wallet';
return [{ id: 'legacy:single', name, icon: null, type: 'injected-fallback', _provider: eth }];
}
async function waitForWalletsIfNeeded(maxWaitMs = 1200) {
if (discoveredWallets.size > 0 || getLegacyInjectedEntries().length > 0) return;
try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
const step = 150;
let waited = 0;
while (waited < maxWaitMs) {
await sleep(step);
waited += step;
if (discoveredWallets.size > 0 || getLegacyInjectedEntries().length > 0) return;
}
}
// -----------------------------
// Публічний API
// -----------------------------
export function initWalletModule() {
setupEip6963Discovery();
console.log('[WALLET] initWalletModule: відкриття ввімкнено');
}
export function getAvailableWallets() {
const list = [];
for (const w of discoveredWallets.values()) {
list.push({ id: w.rdns, name: w.name, icon: w.icon, type: 'eip6963' });
}
for (const w of getLegacyInjectedEntries()) {
list.push({ id: w.id, name: w.name, icon: null, type: w.type });
}
if (CONFIG?.WALLETCONNECT_PROJECT_ID) {
list.push({ id: 'walletconnect', name: 'WalletConnect', icon: null, type: 'walletconnect' });
}
return list;
}
export async function connectWallet(options = {}) {
const { walletId = null, autoSelect = true } = options;
if (isConnecting) {
// Якщо вже підключено — просто повернути адресу; якщо в процесі — уникнути другого requestAccounts
if (currentAddress) return currentAddress;
throw new Error('Підключення гаманця вже в процесі. Будь ласка, зачекайте.');
}
isConnecting = true;
try {
assertConfig();
// Якщо вже підключено, повторно використати
if (currentAddress && selectedEip1193) {
publishGlobals();
dispatchConnected();
return currentAddress;
}
await waitForWalletsIfNeeded(1200);
const wallets = getAvailableWallets();
if (!wallets.length) throw new Error('Гаманці не знайдено (немає інжектованих гаманців і WalletConnect не налаштовано)');
let chosen = null;
if (walletId) {
chosen = wallets.find(w => w.id === walletId) || null;
} else if (autoSelect) {
const injected = wallets.filter(w => w.type !== 'walletconnect');
if (injected.length === 1) chosen = injected[0];
}
if (!chosen) {
const lines = wallets.map((w, i) => ${i + 1}) ${w.name} [${w.type}]).join('\n');
const pick = window.prompt(Виберіть гаманець:\n${lines}\n\nВведіть номер:);
const idx = Number(pick) - 1;
if (!Number.isFinite(idx) || idx < 0 || idx >= wallets.length) throw new Error('Вибір гаманця скасовано');
chosen = wallets[idx];
}
if (chosen.type === 'eip6963') {
const w = discoveredWallets.get(chosen.id);
if (!w?.provider) throw new Error('Провайдер вибраного гаманця недоступний');
setSelectedProvider(w.provider, { type: 'eip6963', name: chosen.name, rdns: chosen.id });
const accounts = await requestAccountsSafe();
if (!accounts?.[0]) throw new Error('Акаунти не повернено');
await ensureNetwork();
currentAddress = ethers.utils.getAddress(accounts[0]);
}
else if (chosen.type === 'injected-fallback') {
const legacy = getLegacyInjectedEntries();
const entry = legacy.find(x => x.id === chosen.id);
if (!entry?._provider) throw new Error('Інжектований провайдер не знайдено');
setSelectedProvider(entry._provider, { type: 'injected-fallback', name: chosen.name, rdns: null });
const accounts = await requestAccountsSafe();
if (!accounts?.[0]) throw new Error('Акаунти не повернено');
await ensureNetwork();
currentAddress = ethers.utils.getAddress(accounts[0]);
}
else if (chosen.type === 'walletconnect') {
if (!CONFIG.WALLETCONNECT_PROJECT_ID) throw new Error('CONFIG.WALLETCONNECT_PROJECT_ID відсутній для WalletConnect');
const { default: EthereumProvider } = await import(
'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js'
);
wcProvider = await EthereumProvider.init({
projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
chains: [Number(CONFIG.NETWORK.chainId)],
optionalChains: CONFIG?.WALLETCONNECT_OPTIONAL_CHAINS || [],
showQrModal: true,
rpcMap: { [Number(CONFIG.NETWORK.chainId)]: CONFIG.NETWORK.rpcUrls[0] },
metadata: CONFIG?.WALLETCONNECT_METADATA || undefined
});
await wcProvider.connect();
setSelectedProvider(wcProvider, { type: 'walletconnect', name: 'WalletConnect', rdns: null });
// WC часто має eth_accounts відразу
let accounts = null;
try { accounts = await pRequest('eth_accounts'); } catch (_) {}
if (!accounts?.[0]) accounts = await requestAccountsSafe();
if (!accounts?.[0]) throw new Error('Акаунти не повернено');
currentAddress = ethers.utils.getAddress(accounts[0]);
await ensureNetwork();
} else {
throw new Error(Непідтримуваний тип гаманця: ${chosen.type});
}
// ВАЖЛИВО: після того як selectedEip1193 визначено і мережу забезпечено
ethersProvider = new ethers.providers.Web3Provider(selectedEip1193, 'any');
signer = ethersProvider.getSigner();
// Отримуємо chainId і фіксуємо walletState (щоб не було undefined)
const network = await ethersProvider.getNetwork();
window.walletState = {
address: currentAddress,
signer,
provider: ethersProvider,
chainId: network.chainId
};
console.log('[WALLET] підключено', {
address: currentAddress,
chainId: network.chainId
});
publishGlobals();
// Виправлення: забезпечити chainId в walletState
let chainId = null;
try {
const hex = await selectedEip1193.request({ method: 'eth_chainId' });
chainId = parseInt(hex, 16);
currentChainId = chainId;
} catch (_) {
const net = await ethersProvider.getNetwork();
chainId = net?.chainId ?? null;
currentChainId = chainId;
}
window.walletState = {
...(window.walletState || {}),
chainId
};
console.log('[WALLET] chainId зафіксовано в walletState:', window.walletState.chainId);
showNotification?.(Гаманець підключено: ${currentAddress}, 'success');
if (typeof window.onWalletConnected === 'function') {
window.onWalletConnected(currentAddress, { wallet: getActiveWalletInfo() });
}
dispatchConnected();
return currentAddress;
} catch (err) {
console.error('[WALLET] помилка connectWallet:', err);
showNotification?.(err?.message || 'Підключення гаманця не вдалося', 'error');
throw err;
} finally {
isConnecting = false;
}
}
export async function disconnectWallet() {
try {
if (wcProvider) {
try { await wcProvider.disconnect?.(); } catch (_) {}
wcProvider = null;
}
try { selectedEip1193?.disconnect?.(); } catch (_) {}
selectedEip1193 = null;
ethersProvider = null;
signer = null;
currentAddress = null;
clearGlobals();
showNotification?.('Гаманець відключено', 'info');
if (typeof window.onWalletDisconnected === 'function') window.onWalletDisconnected();
dispatchDisconnected();
} catch (err) {
console.warn('[WALLET] помилка disconnectWallet:', err);
} finally {
isConnecting = false;
}
}
export function isWalletConnected() { return !!currentAddress && !!selectedEip1193; }
export function getAddress() { return currentAddress; }
export function getEthersProvider() { return ethersProvider; }
export function getSigner() { return signer; }
export function getEip1193Provider() { return selectedEip1193; }
export async function addTokenToWallet(symbol) {
try {
if (!selectedEip1193) throw new Error('Гаманець не підключено');
const token =
symbol === 'ARUB' ? CONFIG?.ARUB_TOKEN :
symbol === 'USDT' ? CONFIG?.USDT_TOKEN :
null;
if (!token?.address || !token?.symbol || token?.decimals == null) {
throw new Error(Конфігурація токена відсутня для ${symbol}. Очікується CONFIG.ARUB_TOKEN / CONFIG.USDT_TOKEN);
}
const ok = await pRequest('wallet_watchAsset', [{
type: 'ERC20',
options: {
address: token.address,
symbol: token.symbol,
decimals: token.decimals,
image: token.image || undefined
}
}]);
if (ok) showNotification?.(${token.symbol} додано до гаманця, 'success');
else showNotification?.(${token.symbol} не додано, 'info');
return ok;
} catch (err) {
console.error('[WALLET] помилка addTokenToWallet:', err);
showNotification?.(err?.message || 'Додавання токена не вдалося', 'error');
throw err;
}
}
</DOCUMENT>
<DOCUMENT filename="app (17).js">
/**
* Головний вхідний файл додатка (лише Vault)
* Ініціалізує модулі та керує глобальним станом
* Staking/Faucet видалено.
*/
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
window.CONFIG = window.CONFIG || CONFIG;
import { initWalletModule, addTokenToWallet, connectWallet, disconnectWallet } from './wallet.js'; // ВИПРАВЛЕНО: connectWalletUI -> connectWallet
import { initTradingModule, buyTokens, sellTokens, setMaxBuy, setMaxSell } from './trading.js';
import { showNotification, copyToClipboard, formatUSD, formatTokenAmount, formatPrice } from './ui.js';
import { getArubPrice, initReadOnlyContracts, getTotalSupplyArub } from './contracts.js';
// Тема bootstrap: забезпечити клас темної теми
document.documentElement.classList.add('dark');
// Адреса, використовувана для дій у випадаючому меню гаманця
let selectedAddress = null;
/**

Оновлення глобальної статистики (лише Vault)

Ціна ARUB


Загальний запас


Інші віджети staking заповнюємо "—" (якщо вони є в верстці)
*/
async function updateGlobalStats() {
console.log('[APP] 🔄 Оновлення глобальної статистики (лише vault)...');


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
const sourceLabel =
arubPriceInfo?.isFallback ? 'oracle (кешовано)' :
(arubPriceInfo?.isStale ? 'oracle (застаріле)' : 'oracle');
setText('arubPriceSource', 'Джерело курсу: ' + sourceLabel);
setText('arubPriceValue', formatPrice(arubPrice, CONFIG.ORACLE_DECIMALS ?? 6));
const status =
arubPriceInfo?.isFallback ? 'cached' :
(arubPriceInfo?.isStale ? 'stale' : '');
setText('arubPriceStatus', status);
// Повідомити інші скрипти (наприклад, графік) про оновлення ціни oracle
if (Number.isFinite(arubPrice)) {
window.dispatchEvent(new CustomEvent('oraclePriceUpdated', {
detail: {
price: arubPrice,
sourceLabel,
updatedAtSec: arubPriceInfo?.updatedAtSec ?? null,
}
}));
}
const supplyEl = document.getElementById('totalSupplyArub');
if (supplyEl) {
supplyEl.textContent = formatTokenAmount(totalSupply) + ' ARUB';
}
[
'dashHeroStakers', 'dashHeroTvl', 'totalTvl', 'currentApy', 'totalStakers',
'globalTvl', 'globalApy', 'globalStakers', 'globalArubPrice'
].forEach((id) => setText(id, '—'));
console.log('[APP] ✅ Статистика оновлено (лише vault)');
} catch (error) {
console.error('[APP] ❌ Помилка оновлення статистики (лише vault):', error);
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
'(невідомо)';
console.log('[APP] chainId walletState:', chainId);
}
}
/**

Анімації при прокрутці (якщо блоки є на сторінці)
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

Плавна прокрутка + дрібні слухачі (без faucet/staking)
*/
function setupGlobalEventListeners() {
// Плавна прокрутка за якорями
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
anchor.addEventListener('click', function (e) {
e.preventDefault();
const target = document.querySelector(this.getAttribute('href'));
if (target) target.scrollIntoView({ behavior: 'smooth' });
});
});

// Перемикач мови (якщо є)
const langButtons = document.querySelectorAll('.lang-btn');
langButtons.forEach(btn => {
btn.addEventListener('click', () => {
langButtons.forEach(b => b.classList.remove('active'));
btn.classList.add('active');
showNotification('🌐 Підтримка мови в розробці', 'info');
});
});
// Якщо контракти ініціалізувалися деінде — оновимо статистику
window.addEventListener('contractsInitialized', () => {
console.log('[APP] Оновлення статистики (contractsInitialized)...');
updateGlobalStats();
});
}
async function logWalletNetwork() {
try {
const ws = window.walletState;
if (!ws?.provider) {
console.warn('[APP] walletState.provider відсутній');
return;
}
const net = await ws.provider.getNetwork();
console.log('[APP] Мережа:', net?.name);
console.log('[APP] Chain ID:', net?.chainId);
} catch (e) {
console.error('[APP] помилка logWalletNetwork:', e);
const chainId =
window.walletState?.chainId ??
window.walletState?.provider?.network?.chainId ??
'(невідомо)';
console.log('[APP] walletState:', window.walletState, 'chainId:', chainId ?? '(невідомо)');
}
}
async function logNetworkState(tag = 'APP') {
const ws = window.walletState;
// Беремо chainId максимально надійно
let chainId = ws?.chainId;
if (!chainId && ws?.provider?.getNetwork) {
try {
const net = await ws.provider.getNetwork();
chainId = net?.chainId;
} catch (e) {
console.warn(`[${tag}] getNetwork() не вдалося:', e);
}
}
console.log(`[${tag}] chainId walletState:', chainId ?? '(невідомо)');
}
// Один раз: при завантаженні (якщо хочете)
logNetworkState('APP').catch((e) => console.warn('[APP] ініціалізація logNetworkState не вдалася:', e));
const prevOnWalletConnected = window.onWalletConnected;
window.onWalletConnected = async (address, meta) => {
// синхронізувати адресу в випадаючому меню
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

Ініціалізація додатка
*/
async function initApp() {
console.log('='.repeat(60));
console.log('ANTI RUB - Платформа Vault (лише Vault)');
console.log('Ініціалізація додатка...');
console.log('='.repeat(60));

try {
console.log('[APP] Ініціалізація читання контрактів...');
const readOnlySuccess = await initReadOnlyContracts();
if (readOnlySuccess) {
console.log('[APP] Читання контрактів готово, отримання початкової статистики...');
setTimeout(() => updateGlobalStats(), 500);
} else {
console.warn('[APP] initReadOnlyContracts повернуло false');
}
console.log('[APP] Ініціалізація модуля гаманця...');
initWalletModule();
console.log('[APP] Ініціалізація модуля торгівлі...');
initTradingModule();
setupGlobalEventListeners();
setupScrollAnimations();
// Періодичне оновлення статистики (якщо потрібно)
const interval = CONFIG?.UI?.STATS_UPDATE_INTERVAL ?? 15000;
setInterval(() => updateGlobalStats(), interval);
console.log('[APP] ✅ Додаток готовий!');
// Інформація про мережу (будьте толерантні до назв полів CONFIG)
const netName = CONFIG?.NETWORK?.name || CONFIG?.NETWORK?.chainName || CONFIG?.NETWORK?.chainIdName || 'Arbitrum One';
const chainId = Number(CONFIG?.NETWORK?.chainIdDecimal ?? CONFIG?.NETWORK?.chainId ?? 42161);
console.log('[APP] Мережа:', netName);
console.log('[APP] Chain ID:', chainId);
} catch (error) {
console.error('[APP] ❌ Помилка ініціалізації:', error);
showNotification('❌ Помилка ініціалізації додатка', 'error');
const chainId =
window.walletState?.chainId ??
window.walletState?.provider?.network?.chainId ??
'(невідомо)';
console.log('[APP] chainId walletState:', chainId);
} finally {
// 🔓 Сторінка готова — показати UI (завжди)
document.body.classList.add('page-ready')
}
}
/**

Глобальні функції для обробників HTML (лише Vault)
*/
// Гаманець

window.addTokenToWallet = addTokenToWallet;
window.addArubToMetaMask = () => addTokenToWallet('ARUB');
window.addUsdtToMetaMask = () => addTokenToWallet('USDT');
window.copyTokenAddress = () =>
copyToClipboard(CONFIG.TOKEN_ADDRESS, '✅ Адресу токена скопійовано!');
// Торгівля
window.buyTokens = buyTokens;
window.sellTokens = sellTokens;
window.setMaxBuy = setMaxBuy;
window.setMaxSell = setMaxSell;
// Допоміжник для прокрутки
window.scrollToSection = (sectionId) => {
const element = document.getElementById(sectionId);
if (element) element.scrollIntoView({ behavior: 'smooth' });
};
// Початок
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', initApp);
} else {
initApp();
}
console.log('[APP] Версія: 2.0.0 (лише Vault)');
console.log('[APP] Збірка: ' + new Date().toISOString());
// =========================
// Логіка випадаючого меню гаманця
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
// Скидання поточного і вибір нового гаманця
await disconnectWallet();
await connectWallet();
});
document.getElementById("disconnectBtn")?.addEventListener("click", async () => {
document.getElementById("walletMenu").classList.remove("open");
await disconnectWallet();
});
window.connectWallet = connectWallet; // ДОДАНО: для глобальної доступності в HTML
window.disconnectWallet = disconnectWallet; // ДОДАНО: для глобальної доступності
export { initApp };
