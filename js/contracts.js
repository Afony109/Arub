import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js';
import { CONFIG } from './config.js';
import { ERC20_ABI, PRESALE_ABI } from './abis.js';
import { getSigner, isWalletConnected } from './wallet.js';

let usdtContract = null;
let presaleContract = null;

export function getContracts() {
  return {
    usdtContract,
    presaleContract,
    isInitialized: !!(usdtContract && presaleContract),
  };
}

export async function ensureContractsReady() {
  if (!isWalletConnected()) return false;

  const signer = getSigner();
  if (!signer) return false;

  usdtContract = new ethers.Contract(
    CONFIG.USDT_ADDRESS,
    ERC20_ABI,
    signer
  );

  presaleContract = new ethers.Contract(
    CONFIG.PRESALE_ADDRESS,
    PRESALE_ABI,
    signer
  );

  return true;
}
