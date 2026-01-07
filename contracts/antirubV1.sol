// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IArubToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

interface IArubOracle {
    /// @return rate Курс USD/RUB с 6 знаками после запятой
    /// @return updatedAt Время последнего обновления курса
    function getRate() external view returns (uint256 rate, uint256 updatedAt);
    function usdRub() external view returns (uint256);
}

interface IArubStakingVault {
    function fundRewards(uint256 amount) external;
}

/// @title AntiRUB protocol v2 (upgradeable)
/// @notice UUPS-апгрейдируемый протокол выпуска/погашения ARUB.
///         Ключевое отличие от v1: mint НЕ блокируется по CR, покупки всегда разрешены.
///         Ограничения накладываются только на burn (выкуп) и админские операции.
contract AntiRUBV2 is
    Initializable,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ------------------------------------------------------------------------
    //                         CONSTANTS
    // ------------------------------------------------------------------------

    uint256 public constant FEE_DENOM = 10_000;
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Максимальный возраст курса из оракула (сек)
    uint256 public constant ORACLE_MAX_AGE = 1 hours;

    // ------------------------------------------------------------------------
    //                               STATE
    // ------------------------------------------------------------------------

    IERC20 public usdtToken;
    IArubToken public arubToken;
    IArubOracle public oracle;

    /// @notice Адрес стейкинг-контракта, куда отправляется часть комиссий
    address public stakingContract;

    /// @notice Размер комиссии на mint в bps (из FEE_DENOM)
    uint256 public mintFeeBps;

    /// @notice Размер комиссии на burn в bps (из FEE_DENOM)
    uint256 public burnFeeBps;

    /// @notice Сколько USDT всего внесено пользователями (коллатераль)
    uint256 public totalUsdtCollateral;

    /// @notice Сколько ARUB всего выпущено протоколом и ещё не погашено (обязательства)
    uint256 public totalArubLiability;

    /// @notice Сколько ARUB накоплено в резерве под стейкинг (из комиссий)
    uint256 public stakingReserve;

    // ------------------------------------------------------------------------
    //                               EVENTS
    // ------------------------------------------------------------------------

    event Minted(
        address indexed user,
        uint256 usdtIn,
        uint256 arubOutUser,
        uint256 feeArub
    );

    event Burned(
        address indexed user,
        uint256 arubIn,
        uint256 usdtOutUser,
        uint256 feeUsdt
    );

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event StakingContractUpdated(address indexed oldStaking, address indexed newStaking);
    event StakingRewardsSent(uint256 amount);

    event ArubWithdrawn(address indexed to, uint256 amount);
    event UsdtWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------------
    //                               ERRORS
    // ------------------------------------------------------------------------

    error ZeroAddress();
    error InvalidDecimals();
    error OracleRateZero();
    error OracleStale();
    error ZeroAmount();

    // ------------------------------------------------------------------------
    //                      INITIALIZER & UUPS AUTH
    // ------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Инициализация вместо конструктора (под UUPS-прокси).
    /// @param _usdtToken адрес USDT (обязательно 6 decimals)
    /// @param _arubToken адрес ARUB токена
    /// @param _oracle адрес оракула
    function initialize(
        address _usdtToken,
        address _arubToken,
        address _oracle
    ) external initializer {
        if (_usdtToken == address(0) || _arubToken == address(0) || _oracle == address(0)) {
            revert ZeroAddress();
        }

        __ReentrancyGuard_init();
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        // Проверяем, что у USDT 6 знаков
        uint8 usdtDec = IERC20Metadata(_usdtToken).decimals();
        if (usdtDec != 6) revert InvalidDecimals();

        usdtToken = IERC20(_usdtToken);
        arubToken = IArubToken(_arubToken);
        oracle = IArubOracle(_oracle);

        // Стартовые комиссии: 0.3% на mint и burn (можно поменять через setFees)
        mintFeeBps = 30;
        burnFeeBps = 30;
    }

    /// @dev UUPS hook
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ------------------------------------------------------------------------
    //                         VIEW: ORACLE / CR
    // ------------------------------------------------------------------------

    /// @notice Возвращает текущий курс и проверяет, что данные не устарели
    /// @return rate курс USD/RUB с 6 дробными знаками
    function _getOracleRateFresh() internal view returns (uint256 rate) {
        uint256 updatedAt;
        (rate, updatedAt) = oracle.getRate();
        if (rate == 0) revert OracleRateZero();
        if (block.timestamp - updatedAt > ORACLE_MAX_AGE) revert OracleStale();
        return rate;
    }

    /// @notice Текущий collateral ratio протокола в шкале 1e6 (1_000_000 = 100%).
    /// @dev CR = totalUsdtCollateral * rate / totalArubLiability.
    ///      Внутренне считаем в bps (10_000 = 100%) и конвертируем в 1e6-scale (умножаем на 100).
    ///      Если обязательств нет, возвращает max uint256 (по сути «бесконечный CR»).
    function currentCollateralRatio() public view returns (uint256 cr1e6) {
        // NOTE:
        // ArbitrageManager expects 1e6-scale where 1_000_000 = 100%.
        // Internally we compute CR in bps (10_000 = 100%) and convert to 1e6 by *100.

        if (totalArubLiability == 0) {
            return type(uint256).max;
        }

        uint256 rate = _getOracleRateFresh();

        // totalUsdtCollateral и totalArubLiability в 6 dec, rate в 1e6
        uint256 liabilitiesValue = (totalArubLiability * rate) / 1_000_000;
        if (liabilitiesValue == 0) {
            return 0;
        }

        uint256 crBps = (totalUsdtCollateral * BPS_DENOM) / liabilitiesValue;

        // Convert bps (1e4) -> 1e6-scale.
        unchecked {
            uint256 scaled = crBps * 100;
            // In the extremely unlikely event of overflow, clamp to max.
            if (scaled / 100 != crBps) return type(uint256).max;
            return scaled;
        }
    }

    // ------------------------------------------------------------------------
    //                         VIEW: PREVIEW MINT / BURN
    // ------------------------------------------------------------------------

    /// @notice Предпросмотр, сколько ARUB будет выпущено при депозите usdtAmount.
    /// @dev Возвращает (userArub, feeArub, newCrBps) — CR после операции (для информации).
    function getMintAmount(uint256 usdtAmount)
        external
        view
        returns (uint256 userArub, uint256 feeArub, uint256 newCrBps)
    {
        if (usdtAmount == 0) return (0, 0, currentCollateralRatio());

        uint256 rate = _getOracleRateFresh();

        // Сколько ARUB всего нужно выпустить
        uint256 grossArub = (usdtAmount * 1_000_000) / rate;
        if (grossArub == 0) {
            return (0, 0, currentCollateralRatio());
        }

        feeArub = (grossArub * mintFeeBps) / FEE_DENOM;
        userArub = grossArub - feeArub;

        // Рассчитываем новый CR (только как информационный preview)
        uint256 newUsdtCollateral = totalUsdtCollateral + usdtAmount;
        uint256 newArubLiability = totalArubLiability + grossArub;

        if (newArubLiability == 0) {
            newCrBps = type(uint256).max;
        } else {
            uint256 liabilitiesValue = (newArubLiability * rate) / 1_000_000;
            if (liabilitiesValue == 0) {
                newCrBps = type(uint256).max;
            } else {
                newCrBps = (newUsdtCollateral * BPS_DENOM) / liabilitiesValue;
            }
        }
    }

    /// @notice Предпросмотр, сколько USDT пользователь получит за arubAmount.
    /// @dev Возвращает (userUsdt, feeUsdt, newCrBps) — CR после burn (для информации).
    function getBurnReturn(uint256 arubAmount)
        external
        view
        returns (uint256 userUsdt, uint256 feeUsdt, uint256 newCrBps)
    {
        if (arubAmount == 0) return (0, 0, currentCollateralRatio());

        uint256 rate = _getOracleRateFresh();

        // Считаем общую сумму USDT, которую должен получить пользователь + протокол (комиссия)
        uint256 grossUsdt = (arubAmount * rate) / 1_000_000;
        if (grossUsdt == 0) {
            return (0, 0, currentCollateralRatio());
        }

        feeUsdt = (grossUsdt * burnFeeBps) / FEE_DENOM;
        userUsdt = grossUsdt - feeUsdt;

        // Новый CR после операции
        uint256 newUsdtCollateral = totalUsdtCollateral > grossUsdt
            ? totalUsdtCollateral - grossUsdt
            : 0;
        uint256 newArubLiability = totalArubLiability > arubAmount
            ? totalArubLiability - arubAmount
            : 0;

        if (newArubLiability == 0) {
            newCrBps = type(uint256).max;
        } else {
            uint256 liabilitiesValue = (newArubLiability * rate) / 1_000_000;
            if (liabilitiesValue == 0) {
                newCrBps = type(uint256).max;
            } else {
                newCrBps = (newUsdtCollateral * BPS_DENOM) / liabilitiesValue;
            }
        }
    }

    // ------------------------------------------------------------------------
    //                             CORE: MINT
    // ------------------------------------------------------------------------

    /// @notice Mint ARUB под залог USDT.
    /// @dev КЛЮЧЕВОЕ ОТЛИЧИЕ v2: НЕТ ПРОВЕРКИ CR, ПОКУПКА ВСЕГДА РАЗРЕШЕНА.
    /// @param usdtAmount сумма USDT (6 decimals)
    /// @param minArubOut минимальное количество ARUB для защиты от проскальзывания
    function mint(uint256 usdtAmount, uint256 minArubOut) external nonReentrant {
        if (usdtAmount == 0) revert ZeroAmount();

        uint256 rate = _getOracleRateFresh();

        // Переводим USDT от пользователя на контракт
        require(
            usdtToken.transferFrom(msg.sender, address(this), usdtAmount),
            "USDT transferFrom failed"
        );

        // Считаем общее количество ARUB, которые нужно выпустить (до комиссии)
        uint256 grossArub = (usdtAmount * 1_000_000) / rate;
        require(grossArub > 0, "Too small amount");

        uint256 feeArub = (grossArub * mintFeeBps) / FEE_DENOM;
        uint256 userArub = grossArub - feeArub;
        require(userArub >= minArubOut, "Slippage");

        // Обновляем состояние (коллатераль и обязательства)
        totalUsdtCollateral += usdtAmount;
        totalArubLiability  += grossArub;

        // Учитываем комиссию в отдельном пуле для стейкинга
        stakingReserve += feeArub;

        // Минтим ARUB пользователю и на этот контракт (для стейкинга)
        arubToken.mint(msg.sender, userArub);
        if (feeArub > 0) {
            arubToken.mint(address(this), feeArub);
        }

        emit Minted(msg.sender, usdtAmount, userArub, feeArub);
    }

    // ------------------------------------------------------------------------
    //                             CORE: BURN
    // ------------------------------------------------------------------------

    /// @notice Burn ARUB в обмен на USDT.
    /// @param arubAmount количество ARUB (6 decimals)
    /// @param minUsdtOut минимальное количество USDT (slippage protection)
    function burn(uint256 arubAmount, uint256 minUsdtOut) external nonReentrant {
        if (arubAmount == 0) revert ZeroAmount();

        uint256 rate = _getOracleRateFresh();

        // Считаем общую сумму USDT, которую нужно отдать
        uint256 grossUsdt = (arubAmount * rate) / 1_000_000;
        require(grossUsdt > 0, "Too small amount");

        uint256 feeUsdt = (grossUsdt * burnFeeBps) / FEE_DENOM;
        uint256 userUsdt = grossUsdt - feeUsdt;
        require(userUsdt >= minUsdtOut, "Slippage");

        // Проверяем, что достаточно USDT на контракте и в учёте
        require(grossUsdt <= usdtToken.balanceOf(address(this)), "Not enough USDT");
        require(grossUsdt <= totalUsdtCollateral, "Exceeds collateral");

        // Обновляем учёт
        totalUsdtCollateral -= grossUsdt;
        totalArubLiability  -= arubAmount;

        // Сжигаем ARUB у пользователя
        arubToken.burn(msg.sender, arubAmount);

        // Отправляем пользователю его USDT
        require(usdtToken.transfer(msg.sender, userUsdt), "USDT transfer failed");

        emit Burned(msg.sender, arubAmount, userUsdt, feeUsdt);
    }

    // ------------------------------------------------------------------------
    //                         STAKING REWARDS FLOW
    // ------------------------------------------------------------------------

    /// @notice Возвращает свободный баланс ARUB на контракте (без стейкинг-резерва)
    function freeArubBalance() public view returns (uint256) {
        uint256 bal = IERC20(address(arubToken)).balanceOf(address(this));
        if (bal <= stakingReserve) return 0;
        return bal - stakingReserve;
    }

    /// @notice Отправить часть стейкинг-резерва на стейкинг-контракт.
    /// @dev Должен вызываться только владельцем (governance / multisig).
    function sendStakingRewards(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        require(stakingContract != address(0), "Staking not set");
        require(amount <= stakingReserve, "Exceeds stakingReserve");

        stakingReserve -= amount;

        require(
            IERC20(address(arubToken)).transfer(stakingContract, amount),
            "ARUB transfer failed"
        );

        // Нотифицируем стейкинг-контракт о пополнении наград
        IArubStakingVault(stakingContract).fundRewards(amount);

        emit StakingRewardsSent(amount);
    }

    // ------------------------------------------------------------------------
    //                         ADMIN: ORACLE / STAKING
    // ------------------------------------------------------------------------

    function setOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert ZeroAddress();
        address old = address(oracle);
        oracle = IArubOracle(_oracle);
        emit OracleUpdated(old, _oracle);
    }

    function setStakingContract(address _staking) external onlyOwner {
        address old = stakingContract;
        stakingContract = _staking;
        emit StakingContractUpdated(old, _staking);
    }

    // ------------------------------------------------------------------------
    //                         ADMIN: TREASURY / RESCUE
    // ------------------------------------------------------------------------

    /// @notice Вывести часть «свободного» ARUB с контракта (не затрагивая stakingReserve).
    function withdrawArubTreasury(address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "Zero to");
        if (amount == 0) revert ZeroAmount();

        uint256 free = freeArubBalance();
        require(amount <= free, "Touching stakingReserve");

        require(IERC20(address(arubToken)).transfer(to, amount), "ARUB transfer failed");
        emit ArubWithdrawn(to, amount);
    }

    function withdrawUsdtTreasury(address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "Zero to");
        if (amount == 0) revert ZeroAmount();
        require(amount <= usdtToken.balanceOf(address(this)), "Not enough USDT");
        require(amount <= totalUsdtCollateral, "Exceeds collateral");

        totalUsdtCollateral -= amount;

        require(usdtToken.transfer(to, amount), "USDT transfer failed");
        emit UsdtWithdrawn(to, amount);
    }

    /// @notice Аварийный вывод любого стороннего ERC20 (например, USDC, присланный пресейлом)
    /// @dev Нельзя выводить core-токены протокола: USDT и ARUB
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "Zero to");
        if (amount == 0) revert ZeroAmount();
        require(token != address(usdtToken), "Cannot rescue USDT");
        require(token != address(arubToken), "Cannot rescue ARUB");

        IERC20(token).transfer(to, amount);
    }

    // ------------------------------------------------------------------------
    //                         ADMIN: FEES
    // ------------------------------------------------------------------------

    function setFees(uint256 _mintFeeBps, uint256 _burnFeeBps) external onlyOwner {
        require(_mintFeeBps <= 500, "Mint fee too high"); // <= 5%
        require(_burnFeeBps <= 500, "Burn fee too high"); // <= 5%
        mintFeeBps = _mintFeeBps;
        burnFeeBps = _burnFeeBps;
    }
}
