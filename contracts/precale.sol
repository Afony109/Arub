// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";


/// Минимальный интерфейс для ARUBToken
interface IARUBToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;

    /// input: USDT 6 dec, output: ARUB 6 dec
    function calculateArubAmount(uint256 usdtAmount) external view returns (uint256);

    /// input: ARUB 6 dec, output: USDT 6 dec
    function calculateUsdtAmount(uint256 arubAmount) external view returns (uint256);
}


/// @title ARUBPresale (UUPS upgradeable)
/// @notice
///   - withBonus = true  → действует скидка, ВЕСЬ депозит (principal+bonus) лочится на 90 дней;
///   - withBonus = false → без бонуса и без лока, ARUB сразу на кошелёк.
///
/// Продажа ARUB обратно через пресейл с tiered-комиссией:
///   - < 90 дней  → 3%
///   - 90–180 дней → 2%
///   - > 180 дней → 1%
///
/// Есть:
///   - лимиты per-tx и per-wallet (6 decimals) для no-KYC;
///   - долги в USDT-эквиваленте;
///   - накопление комиссий и вывод в AntiRUB;
///   - UUPS-апгрейд.

contract ARUBPresale is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -------------------------
    // Токены
    // -------------------------
    address public arubTokenAddress;
    address public usdtAddress;

    IARUBToken public arubToken;
    IERC20Upgradeable public usdt;

    // -------------------------
    // Долги (USDT-eq, 6 decimals)
    // -------------------------
    mapping(address => uint256) public debtUsdtEquivalent;
    uint256 public totalDebtUsdtEquivalent;

    // -------------------------
    // Скидки / покупатели
    // -------------------------
    
    uint256 public totalBuyers;
    mapping(address => bool) public isBuyer;

    /// @notice Кол-во уникальных кошельков, которые совершили покупку в режиме со скидкой (withBonus=true) хотя бы один раз.
    uint256 public totalDiscountBuyers;
    mapping(address => bool) public isDiscountBuyer;

    /// @notice Максимум кошельков, которые могут участвовать в скидочной программе.
    uint256 public constant DISCOUNT_MAX_BUYERS = 100;

    /// @notice Границы tier'ов по счётчику totalDiscountBuyers (0-based).
    ///         0-33  -> 15%
    ///         34-66 -> 10%
    ///         67-99 -> 5%
    uint256 public constant DISCOUNT_TIER1_END = 34;
    uint256 public constant DISCOUNT_TIER2_END = 67;
    uint256 public constant DISCOUNT_TIER3_END = 100;
    /// сколько "скидки" в USDT-эквиваленте уже использовал кошелёк
    mapping(address => uint256) public discountUsed;
    uint256 public constant MAX_DISCOUNT_PER_WALLET = 1000e6; // 1000 USDT

    // -------------------------
    // Лок депозита (principal + bonus)
    // -------------------------
    uint256 public constant BONUS_LOCK_PERIOD = 90 days;

   mapping(address => uint256) public lockedPrincipalArub; // ARUB units (6 dec)
   mapping(address => uint256) public lockedBonusArub;     // ARUB units (6 dec)
    mapping(address => uint256) public lockedDepositUntil;  // timestamp

    uint256 public totalLockedPrincipalArub;
    uint256 public totalLockedBonusArub;

    // -------------------------
    // Tiered-комиссия по времени холда
    // -------------------------
    uint256 public constant FEE_BPS_SHORT = 300; // 3%
    uint256 public constant FEE_BPS_MID   = 200; // 2%
    uint256 public constant FEE_BPS_LONG  = 100; // 1%

    uint256 public constant HOLD_THRESHOLD_MID  = 90 days;
    uint256 public constant HOLD_THRESHOLD_LONG = 180 days;

    /// время первого входа в пресейл
    mapping(address => uint256) public firstBuyTimestamp;

    
    // --- DCA fair sell-fee tracking (weighted average) ---
    mapping(address => uint256) public avgBuyTimestamp; // weighted-average buy time
    mapping(address => uint256) public trackedBalance;  // ARUB amount participating in age
    mapping(address => uint256) public redeemableBalance; // ARUB amount eligible for redeem (purchased via presale, incl. unlocked bonus)
// -------------------------
    // Накопленные комиссии (USDT-eq, 6 decimals)
    // -------------------------
    uint256 public accumulatedFees;

    // -------------------------
    // AntiRUB для вывода комиссий
    // -------------------------
    address public antiRUB;

    // -------------------------
    // REFERRAL HOOK (future use)
    // -------------------------
    address public referralManager;

    // -------------------------
    // -------------------------
    uint256 public maxPurchasePerTx;
    uint256 public maxPurchasePerWallet;
    uint256 public constant MIN_PURCHASE_PER_TX = 10e6; // 10 USDT

    mapping(address => uint256) public totalDeposited; // суммарный внесённый amount

    // -------------------------
    // Min redeem (USDT-eq)
    // -------------------------
    uint256 public constant MIN_REDEEM_USDT_EQ = 1e6; // 1 USDT

    // -------------------------
    // События
    // -------------------------
    event Purchased(
        address indexed buyer,
        uint256 usdtAmount,        // внесённая сумма (без учёта скидки)
        uint256 arubTotal,         // всего ARUB под покупку
        uint256 bonusArub,         // бонус, если есть
        uint256 discountPercent,   // теоретический % скидки
        uint256 discountAppliedEq  // реально использованный дисконт (USDT-eq)
    );

    event Redeemed(
        address indexed seller,
        uint256 arubAmount,
        uint256 stablePaid,
        uint256 debtIssued,
        uint256 feeCharged
    );

    event DebtClaimed(address indexed user, uint256 amountPaid, uint256 remainingDebt);
    event DepositUnlocked(address indexed user, uint256 principalArub, uint256 bonusArub);
    event TermsAcknowledgmentRequired();
    event AntiRUBUpdated(address indexed oldAntiRUB, address indexed newAntiRUB);
    event ReferralManagerUpdated(address indexed referralManager);
    event FeesSentToAntiRUB(address indexed antiRUB, uint256 amount);
    event PurchaseLimitsUpdated(uint256 maxPerTx, uint256 maxPerWallet);
    event ArubTransferredToPools(uint256 amount);
    event ArubTransferredToDEX(uint256 amount);

    // -------------------------
    // Конструктор implementation
    // -------------------------
    constructor() {
        _disableInitializers();
    }

   // -------------------------
   // Инициализация UUPS-proxy
   // -------------------------
    function initialize(
    address _arubTokenAddress,
    address _usdtAddress,
    address initialOwner
    ) external initializer {
    __UUPSUpgradeable_init();
    __Ownable_init(initialOwner); // owner задаётся явно
    __ReentrancyGuard_init();
    __Pausable_init();

    require(_arubTokenAddress != address(0), "ARUB zero");
    require(_usdtAddress != address(0), "USDT zero");

    // Жёстко фиксируем ожидания по decimals
    require(
        IERC20MetadataUpgradeable(_arubTokenAddress).decimals() == 6,
        "ARUB decimals != 6"
    );
    require(
        IERC20MetadataUpgradeable(_usdtAddress).decimals() == 6,
        "USDT decimals != 6"
    );

    arubTokenAddress = _arubTokenAddress;
    usdtAddress = _usdtAddress;

    arubToken = IARUBToken(_arubTokenAddress);
    usdt = IERC20Upgradeable(_usdtAddress);

    // дефолтные лимиты: 1000 за сделку, 3000 на кошелёк
    maxPurchasePerTx = 1000e6;
    maxPurchasePerWallet = 3000e6;
    emit PurchaseLimitsUpdated(maxPurchasePerTx, maxPurchasePerWallet);
}

    // UUPS: апгрейд только от владельца
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------
    // Pause
    // -------------------------
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------
    // Лимиты покупок
    // -------------------------
    function setPurchaseLimits(uint256 _maxPerTx, uint256 _maxPerWallet) external onlyOwner {
        require(_maxPerTx >= MIN_PURCHASE_PER_TX, "maxPerTx < min");
        require(_maxPerWallet >= _maxPerTx, "wallet < tx");
        maxPurchasePerTx = _maxPerTx;
        maxPurchasePerWallet = _maxPerWallet;
        emit PurchaseLimitsUpdated(_maxPerTx, _maxPerWallet);
    }


    // -------------------------
    // Hold-time / fee helpers
    // -------------------------
    function _updateFirstBuyTimestamp(address user) internal {
        if (firstBuyTimestamp[user] == 0) {
            firstBuyTimestamp[user] = block.timestamp;
        }
    }

    function _onBuyAge(address user, uint256 buyAmount) internal {
        if (buyAmount == 0) return;

        uint256 oldBal = trackedBalance[user];
        uint256 nowTs = block.timestamp;

        if (oldBal == 0) {
            avgBuyTimestamp[user] = nowTs;
            trackedBalance[user] = buyAmount;
            return;
        }

        uint256 oldAvg = avgBuyTimestamp[user];
        uint256 newAvg = (oldAvg * oldBal + nowTs * buyAmount) / (oldBal + buyAmount);

        avgBuyTimestamp[user] = newAvg;
        trackedBalance[user] = oldBal + buyAmount;
    }

    function _onSellAge(address user, uint256 sellAmount) internal {
        if (sellAmount == 0) return;

        uint256 bal = trackedBalance[user];
        if (sellAmount >= bal) {
            trackedBalance[user] = 0;
            avgBuyTimestamp[user] = 0;
        } else {
            trackedBalance[user] = bal - sellAmount;
        }
    }


    /// @notice 3% <90d, 2% 90–180d, 1% >180d, 3% если не покупал на пресейле
    function getUserSellFeeBps(address user) public view returns (uint256) {
        uint256 ts = avgBuyTimestamp[user];
        if (ts == 0) {
            ts = firstBuyTimestamp[user];
        }
        if (ts == 0) {
            return FEE_BPS_SHORT;
        }

        uint256 holding = block.timestamp - ts;
        if (holding >= HOLD_THRESHOLD_LONG) {
            return FEE_BPS_LONG;
        } else if (holding >= HOLD_THRESHOLD_MID) {
            return FEE_BPS_MID;
        } else {
            return FEE_BPS_SHORT;
        }
    }

    function getMySellFeeBps() external view returns (uint256) {
        return getUserSellFeeBps(msg.sender);
    }

    // -------------------------
    // AntiRUB + комиссии
    // -------------------------
    function setAntiRUB(address _antiRUB) external onlyOwner {
        require(_antiRUB != address(0), "AntiRUB zero");
        address old = antiRUB;
        antiRUB = _antiRUB;
        emit AntiRUBUpdated(old, _antiRUB);
    }

    function setReferralManager(address _referralManager) external onlyOwner {
        referralManager = _referralManager;
        emit ReferralManagerUpdated(_referralManager);
    }

    function sendFeesToAntiRUB(uint256 amount) external onlyOwner nonReentrant {
        require(antiRUB != address(0), "AntiRUB not set");
        require(amount > 0, "Amount > 0");
        require(amount <= accumulatedFees, "Amount exceeds fees");
        // Do not allow withdrawing fees if it would break debt coverage
        uint256 balUSDT = usdt.balanceOf(address(this));
        require(balUSDT >= totalDebtUsdtEquivalent + accumulatedFees, "Balance < debt+fees");
        accumulatedFees -= amount;
        usdt.safeTransfer(antiRUB, amount);
        emit FeesSentToAntiRUB(antiRUB, amount);
    }

    // -------------------------
    // DISCOUNT / BONUS LOGIC
    // -------------------------
    function getDiscountPercent() public view returns (uint256) {
        uint256 n = totalDiscountBuyers;
        if (n < DISCOUNT_TIER1_END) return 15;
        if (n < DISCOUNT_TIER2_END) return 10;
        if (n < DISCOUNT_TIER3_END) return 5;
        return 0;
    }
    // -------------------------
    // LOCK VIEW
    // -------------------------
    function getRemainingLockTime(address user) public view returns (uint256) {
        uint256 unlockTime = lockedDepositUntil[user];
        if (unlockTime == 0 || block.timestamp >= unlockTime) {
            return 0;
        }
        return unlockTime - block.timestamp;
    }

    function getMyLockedInfo()
        external
        view
        returns (uint256 principalLocked, uint256 bonusLocked, uint256 unlockTime, uint256 remaining)
    {
        principalLocked = lockedPrincipalArub[msg.sender];
        bonusLocked = lockedBonusArub[msg.sender];
        unlockTime = lockedDepositUntil[msg.sender];
        remaining = getRemainingLockTime(msg.sender);
    }
    function _checkAndUpdateLimits(address buyer, uint256 amount) internal {
    require(amount >= MIN_PURCHASE_PER_TX, "Below min per tx");
    require(amount <= maxPurchasePerTx, "Exceeds max per tx");

    uint256 newTotal = totalDeposited[buyer] + amount;
    require(newTotal <= maxPurchasePerWallet, "Exceeds max per wallet");

    totalDeposited[buyer] = newTotal;
}

    // -------------------------
    // BUY (с / без бонуса)
    // -------------------------
    function buyWithUSDT(uint256 amount, bool withBonus) external whenNotPaused nonReentrant {
    emit TermsAcknowledgmentRequired();
    require(amount > 0, "Amount > 0");

    _checkAndUpdateLimits(msg.sender, amount);
    _updateFirstBuyTimestamp(msg.sender);

    usdt.safeTransferFrom(msg.sender, address(this), amount);

    uint256 discountPercent = 0;
    uint256 discountAppliedEq = 0;
    uint256 effectiveAmount = amount;

    if (withBonus) {
        // Скидка применяется только к первым DISCOUNT_MAX_BUYERS уникальным кошелькам,
        // которые выбирают режим withBonus=true.
        if (!isDiscountBuyer[msg.sender]) {
            require(totalDiscountBuyers < DISCOUNT_MAX_BUYERS, "Discount slots filled");
        }

        discountPercent = getDiscountPercent();
        require(discountPercent > 0, "Discount slots filled");

        uint256 discountAvailable = MAX_DISCOUNT_PER_WALLET - discountUsed[msg.sender];
        uint256 theoreticalDiscount = (amount * discountPercent) / 100;

        discountAppliedEq = theoreticalDiscount;
        if (discountAppliedEq > discountAvailable) {
            discountAppliedEq = discountAvailable;
        }

        require(discountAppliedEq > 0, "Discount not available");

        // фиксируем участие кошелька в скидочной программе
        if (!isDiscountBuyer[msg.sender]) {
            isDiscountBuyer[msg.sender] = true;
            totalDiscountBuyers++;
        }

        discountUsed[msg.sender] += discountAppliedEq;
        effectiveAmount = amount + discountAppliedEq;
    }

    uint256 arubTotal = arubToken.calculateArubAmount(effectiveAmount);
    arubToken.mint(address(this), arubTotal);

    uint256 bonusArub = 0;
    uint256 principalArub = arubTotal;

    if (withBonus && discountAppliedEq > 0) {
        bonusArub = arubToken.calculateArubAmount(discountAppliedEq);
        principalArub = arubTotal - bonusArub;

        lockedPrincipalArub[msg.sender] += principalArub;
        lockedBonusArub[msg.sender] += bonusArub;
        totalLockedPrincipalArub += principalArub;
        totalLockedBonusArub += bonusArub;

        uint256 newUnlock = block.timestamp + BONUS_LOCK_PERIOD;
        if (newUnlock > lockedDepositUntil[msg.sender]) {
            lockedDepositUntil[msg.sender] = newUnlock;
        }

        // NOTE:
        // We intentionally do NOT call _onBuyAge(...) here because principalArub is locked
        // and not yet transferred to the user's wallet. Age tracking should be updated
        // when the principal is actually released/transferred to the user.
    } else {
        IERC20Upgradeable(arubTokenAddress).safeTransfer(msg.sender, arubTotal);

        // ✅ DCA age tracking: bonus is excluded; here principal == arubTotal
        _onBuyAge(msg.sender, arubTotal);

        // redeemable immediately (instant mode)
        redeemableBalance[msg.sender] += arubTotal;

        principalArub = arubTotal;
        bonusArub = 0;
    }

    if (!isBuyer[msg.sender]) {
        isBuyer[msg.sender] = true;
        totalBuyers++;
    }

    emit Purchased(
        msg.sender,
        amount,
        arubTotal,
        bonusArub,
        discountPercent,
        discountAppliedEq
    );
}

    // -------------------------
    // UNLOCK FULL DEPOSIT (principal + bonus)
    // -------------------------
    function unlockDeposit() external whenNotPaused nonReentrant {
    uint256 principal = lockedPrincipalArub[msg.sender];
    uint256 bonus    = lockedBonusArub[msg.sender];
    uint256 amount   = principal + bonus;

    require(amount > 0, "Nothing locked");
    require(block.timestamp >= lockedDepositUntil[msg.sender], "Deposit locked");

    lockedPrincipalArub[msg.sender] = 0;
    lockedBonusArub[msg.sender] = 0;
    lockedDepositUntil[msg.sender] = 0;

    totalLockedPrincipalArub -= principal;
    totalLockedBonusArub -= bonus;

    IERC20Upgradeable(arubTokenAddress).safeTransfer(msg.sender, amount);


    // unlocked tokens become redeemable (principal + bonus)
    redeemableBalance[msg.sender] += amount;

    // ✅ DCA age tracking: count ONLY principal (bonus does NOT improve sell fee)
    _onBuyAge(msg.sender, principal);

    emit DepositUnlocked(msg.sender, principal, bonus);
}

    // -------------------------
    // REDEEM (tiered fee 1–3%)
    // -------------------------
   function redeemForUSDT(uint256 arubAmount) external whenNotPaused nonReentrant {
    require(arubAmount > 0, "Amount > 0");


    // 🔒 Only allow redeem of ARUB acquired via this contract (presale redeemable balance)
    require(arubAmount <= redeemableBalance[msg.sender], "Exceeds redeemable balance");

    uint256 usdtEqGross = arubToken.calculateUsdtAmount(arubAmount);
    require(usdtEqGross >= MIN_REDEEM_USDT_EQ, "Below min redeem");

    uint256 feeBps = getUserSellFeeBps(msg.sender);
    uint256 fee = (usdtEqGross * feeBps) / 10_000;
    uint256 usdtEqNet = usdtEqGross - fee;

    accumulatedFees += fee;

    IERC20Upgradeable(arubTokenAddress).safeTransferFrom(
        msg.sender,
        address(this),
        arubAmount
    );

    // consume redeem quota
    redeemableBalance[msg.sender] -= arubAmount;

    
    _onSellAge(msg.sender, arubAmount);
uint256 available = usdt.balanceOf(address(this));
    uint256 paid = usdtEqNet;
    uint256 debt = 0;

    if (available < usdtEqNet) {
        paid = available;
        debt = usdtEqNet - available;
        debtUsdtEquivalent[msg.sender] += debt;
        totalDebtUsdtEquivalent += debt;
    }

    if (paid > 0) {
        usdt.safeTransfer(msg.sender, paid);
    }

    emit Redeemed(msg.sender, arubAmount, paid, debt, fee);
}


    // -------------------------
    // -------------------------
    function claimDebt() external whenNotPaused nonReentrant {
        uint256 debt = debtUsdtEquivalent[msg.sender];
        require(debt > 0, "No debt");
        uint256 bal = usdt.balanceOf(address(this));
        require(bal > 0, "No liquidity");
        uint256 pay = debt;
        if (pay > bal) pay = bal;
        usdt.safeTransfer(msg.sender, pay);
        debtUsdtEquivalent[msg.sender] = debt - pay;
        totalDebtUsdtEquivalent -= pay;
        emit DebtClaimed( msg.sender,pay,debtUsdtEquivalent[msg.sender]);

    }

    // -------------------------
    // TREASURY
    // -------------------------
    function depositTreasuryUSDT(uint256 amount) external onlyOwner whenNotPaused {
        usdt.safeTransferFrom(msg.sender, address(this), amount);
    }


function withdrawTreasuryUSDT(uint256 amount) external onlyOwner nonReentrant {
    require(amount > 0, "Amount > 0");

    uint256 usdtBal = usdt.balanceOf(address(this));
    require(usdtBal >= amount, "Insufficient USDT");

    require(
        usdtBal - amount >= totalDebtUsdtEquivalent + accumulatedFees,
        "Debt+fees coverage required"
    );

    usdt.safeTransfer(msg.sender, amount);
}


    // -------------------------
    // ARUB MANAGEMENT
    // -------------------------
    function transferArubToPool(address poolAddress, uint256 amount) external onlyOwner nonReentrant {
    require(poolAddress != address(0), "Invalid pool");
    uint256 balance = IERC20Upgradeable(arubTokenAddress).balanceOf(address(this));
    require(balance >= amount, "Insufficient ARUB");
    uint256 lockedTotal = totalLockedPrincipalArub + totalLockedBonusArub;
    require(balance - amount >= lockedTotal, "Locked coverage required");
    IERC20Upgradeable(arubTokenAddress).safeTransfer(poolAddress, amount);
    emit ArubTransferredToPools(amount);
}

function transferArubToDEX(address dexAddress, uint256 amount) external onlyOwner nonReentrant {
    require(dexAddress != address(0), "Invalid DEX");
    uint256 balance = IERC20Upgradeable(arubTokenAddress).balanceOf(address(this));
    require(balance >= amount, "Insufficient ARUB");
    uint256 lockedTotal = totalLockedPrincipalArub + totalLockedBonusArub;
    require(balance - amount >= lockedTotal, "Locked coverage required");
    IERC20Upgradeable(arubTokenAddress).safeTransfer(dexAddress, amount);
    emit ArubTransferredToDEX(amount);
}

    // --------------------------------------------------------------------
    // View helpers for UI
    // --------------------------------------------------------------------

    /// @notice Amount of ARUB that can be redeemed (only ARUB acquired via this contract, principal-only if bonus is excluded)
    function getRedeemableArub(address user) external view returns (uint256) {
        return trackedBalance[user];
    }

    

    /// @notice Current sell fee (in bps) for a given user (UI helper)
    function getCurrentSellFeeBps(address user) external view returns (uint256) {
        return getUserSellFeeBps(user);
    }
/// @notice Time until the next sell-fee tier is reached, based on the user's weighted-average buy timestamp.
    /// @return secondsToNext Number of seconds until the fee drops to the next tier (0 if already at the lowest tier)
    /// @return nextFeeBps The fee (in bps) that will apply after secondsToNext elapses
    function getNextFeeDropETA(address user) external view returns (uint256 secondsToNext, uint256 nextFeeBps) {
        uint256 t = avgBuyTimestamp[user];
        if (t == 0) t = firstBuyTimestamp[user];

        // If we have no history, treat user as "fresh" (max fee) with no deterministic ETA.
        if (t == 0) {
            return (0, FEE_BPS_SHORT);
        }

        uint256 age = block.timestamp - t;

        if (age < HOLD_THRESHOLD_MID) {
            return (HOLD_THRESHOLD_MID - age, FEE_BPS_MID);
        }
        if (age < HOLD_THRESHOLD_LONG) {
            return (HOLD_THRESHOLD_LONG - age, FEE_BPS_LONG);
        }

        // Already at the lowest tier
        return (0, FEE_BPS_LONG);
    }

}
