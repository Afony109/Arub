// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IArubToken {
    function mintTo(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

interface IArubOracle {
    /// @return rate Курс USD/RUB с 6 знаками после запятой (1e6)
    /// @return updatedAt Время последнего обновления курса
    function getRate() external view returns (uint256 rate, uint256 updatedAt);
    function usdRub() external view returns (uint256);
}

interface IArubStakingVault {
    function fundRewards(uint256 amount) external;
}

/// @title AntiRUB protocol
/// @notice Протокол выпуска и погашения токена ARUB под залог USDT с плавающим курсом по оракулу.
contract AntiRUB is ReentrancyGuard, Ownable {
    // ------------------------------------------------------------------------
    //                         CONSTANTS / IMMUTABLES
    // ------------------------------------------------------------------------

    uint256 public constant FEE_DENOM = 10_000;
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Максимальный возраст курса из оракула (сек)
    uint256 public constant ORACLE_MAX_AGE = 1 hours;

    /// @notice Минимальное значение collateral ratio, ниже которого запрещён mint (в bps)
    /// @dev 10000 = 100%. При честном курсе и без внешнего доп.коллатера это минимально достижимый CR.
    uint256 public constant MIN_CR_BPS = 10_000;

    // ------------------------------------------------------------------------
    //                               STATE
    // ------------------------------------------------------------------------

    IERC20 public immutable usdtToken;
    IArubToken public immutable arubToken;
    IArubOracle public oracle;

    /// @notice Адрес стейкинг-контракта, куда отправляется часть комиссий
    address public stakingContract;

    /// @notice Размер комиссии на mint в bps (из FEE_DENOM)
    uint256 public mintFeeBps;

    /// @notice Размер комиссии на burn в bps (из FEE_DENOM)
    uint256 public burnFeeBps;

    /// @notice Сколько USDT всего внесено пользователями (коллатераль)
    uint256 public totalUsdtCollateral;

    /// @notice Сколько ARUB всего выпущено протоколом (обязательства)
    uint256 public totalArubLiability;

    /// @notice Сколько ARUB зарезервировано под стейкинг (часть комиссий)
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
    error CollateralRatioTooLow();
    error ZeroAmount();

    // ------------------------------------------------------------------------
    //                               CONSTRUCTOR
    // ------------------------------------------------------------------------

    /// @param _usdtToken адрес USDT (6 decimals)
    /// @param _arubToken адрес ARUB токена
    /// @param _oracle адрес оракула с курсом USD/RUB (6 decimals)
    constructor(
        address _usdtToken,
        address _arubToken,
        address _oracle
    ) Ownable(msg.sender) {
        if (_usdtToken == address(0) || _arubToken == address(0) || _oracle == address(0)) {
            revert ZeroAddress();
        }

        // Проверяем, что у USDT 6 знаков
        uint8 usdtDec = IERC20Metadata(_usdtToken).decimals();
        if (usdtDec != 6) revert InvalidDecimals();

        usdtToken = IERC20(_usdtToken);
        arubToken = IArubToken(_arubToken);
        oracle = IArubOracle(_oracle);

        // Стартовые комиссии: 0.3% на mint и burn
        mintFeeBps = 30;
        burnFeeBps = 30;
    }

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

    /// @notice Публичный доступ к курсу и timestamp
    function getOracleRate() external view returns (uint256 rate, uint256 updatedAt) {
        (rate, updatedAt) = oracle.getRate();
    }

    /// @notice Текущий collateral ratio протокола в bps.
    /// @dev CR = totalUsdtCollateral * BPS_DENOM / liabilitiesValue, liabilitiesValue в USDT.
    ///      Если нет обязательств, возвращаем max uint.
    function currentCollateralRatio() public view returns (uint256 crBps) {
        if (totalArubLiability == 0) {
            return type(uint256).max;
        }

        uint256 rate = _getOracleRateFresh();

        // Стоимость обязательств в USDT: totalArubLiability * rate / 1e6
        uint256 liabilitiesValue = (totalArubLiability * rate) / 1_000_000;

        if (liabilitiesValue == 0) {
            return type(uint256).max;
        }

        crBps = (totalUsdtCollateral * BPS_DENOM) / liabilitiesValue;
    }

    // ------------------------------------------------------------------------
    //                         VIEW: PREVIEW MINT / BURN
    // ------------------------------------------------------------------------

    /// @notice Предпросмотр, сколько ARUB будет выпущено при депозите usdtAmount.
    /// @dev Возвращает (userArub, feeArub, newCrBps).
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

        // Рассчитываем новый CR
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
    /// @dev Возвращает (userUsdt, feeUsdt, newCrBps).
    function getBurnReturn(uint256 arubAmount)
        external
        view
        returns (uint256 userUsdt, uint256 feeUsdt, uint256 newCrBps)
    {
        if (arubAmount == 0) return (0, 0, currentCollateralRatio());

        uint256 rate = _getOracleRateFresh();

        // Общая сумма USDT (user + fee)
        uint256 grossUsdt = (arubAmount * rate) / 1_000_000;
        if (grossUsdt == 0) {
            return (0, 0, currentCollateralRatio());
        }

        feeUsdt = (grossUsdt * burnFeeBps) / FEE_DENOM;
        userUsdt = grossUsdt - feeUsdt;

        // Новый CR после операции
        uint256 newUsdtCollateral = totalUsdtCollateral >= grossUsdt
            ? totalUsdtCollateral - grossUsdt
            : 0;
        uint256 newArubLiability = totalArubLiability >= arubAmount
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
    /// @param usdtAmount сумма USDT (6 decimals)
    /// @param minArubOut минимальное количество ARUB для защиты от проскальзывания
    function mint(uint256 usdtAmount, uint256 minArubOut) external nonReentrant {
        if (usdtAmount == 0) revert ZeroAmount();

        uint256 rate = _getOracleRateFresh();

        // Переводим USDT от пользователя на контракт
        require(
            usdtToken.transferFrom(msg.sender, address(this), usdtAmount),
            "USDT transfer failed"
        );

        // Считаем, сколько ARUB всего нужно выпустить
        uint256 grossArub = (usdtAmount * 1_000_000) / rate;
        require(grossArub > 0, "Mint amount too small");

        // Комиссия в ARUB
        uint256 feeArub = (grossArub * mintFeeBps) / FEE_DENOM;
        uint256 userArub = grossArub - feeArub;
        require(userArub >= minArubOut, "Slippage");

        // Обновлённые показатели после операции
        uint256 newUsdtCollateral = totalUsdtCollateral + usdtAmount;
        uint256 newArubLiability  = totalArubLiability + grossArub;

        // Проверяем CR после операции
        if (newArubLiability > 0) {
            uint256 liabilitiesValue = (newArubLiability * rate) / 1_000_000;
            if (liabilitiesValue == 0) {
                revert CollateralRatioTooLow();
            }
            uint256 crBps = (newUsdtCollateral * BPS_DENOM) / liabilitiesValue;
            if (crBps < MIN_CR_BPS) revert CollateralRatioTooLow();
        }

        // Обновляем состояние
        totalUsdtCollateral = newUsdtCollateral;
        totalArubLiability  = newArubLiability;

        // Учитываем комиссию в отдельном пуле для стейкинга
        stakingReserve += feeArub;

        // Минтим ARUB пользователю и на этот контракт (для стейкинга)
        arubToken.mintTo(msg.sender, userArub);
        if (feeArub > 0) {
            arubToken.mintTo(address(this), feeArub);
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
        require(grossUsdt > 0, "Burn amount too small");

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
        arubToken.burnFrom(msg.sender, arubAmount);

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
        require(
            amount <= IERC20(address(arubToken)).balanceOf(address(this)),
            "Not enough ARUB"
        );

        stakingReserve -= amount;

        // Отправляем ARUB на стейкинг-контракт
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
    //                         ВЫВОД КАЗНЫ
    // ------------------------------------------------------------------------

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
        require(token != address(usdtToken), "Cannot rescue USDT");
        require(token != address(arubToken), "Cannot rescue ARUB");
        if (amount == 0) revert ZeroAmount();

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
