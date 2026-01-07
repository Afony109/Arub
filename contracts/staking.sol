// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title ARUB Staking v2 (раздельные пулы USDT и ARUB, фиксированный APY для ранних пользователей)
/// @notice Награды всегда в ARUB, APY берётся по суммарному стейку (USDT + ARUB),
///         НО для каждого пользователя APY фиксируется при первом входе и не меняется до полного выхода.
contract ARUBStakingV2 is ReentrancyGuard {
    IERC20 public immutable usdtToken;
    IERC20 public immutable arubToken;

    address public owner;

    // ---- Глобальная статистика ----
    uint256 public totalUsdtStaked;        // общий стейк USDT (6 decimals)
    uint256 public totalArubStaked;        // общий стейк ARUB (6 decimals)

    uint256 public totalUsdtStakers;       // адреса, у которых >0 USDT стейка
    uint256 public totalArubStakers;       // адреса, у которых >0 ARUB стейка
    uint256 public totalStakers;           // адреса, у которых есть любой стейк (USDT или ARUB)

    uint256 public totalRewardsDistributed;

    // APY tiers (basis points: 1200 = 12%, 1000 = 10%, 800 = 8%, 600 = 6%)
    uint256[] public apyTiers = [1200, 1000, 800, 600];

    // Пороги по суммарному стейку (USDT+ARUB) в 6 decimals
    // TVL < 100k  -> 12%
    // TVL < 200k  -> 10%
    // TVL < 400k  -> 8%
    // TVL >= 400k -> 6%
    uint256[] public thresholds = [
        100_000e6,
        200_000e6,
        400_000e6
    ];

    struct StakeInfo {
        uint256 usdtStaked;        // стейк в USDT (6 decimals)
        uint256 arubStaked;        // стейк в ARUB (6 decimals)
        uint256 pendingRewards;    // невыплаченные награды (в ARUB, 6 decimals)
        uint256 totalClaimed;      // уже полученные награды (ARUB, 6 decimals)
        uint256 lastStakeTime;
        uint256 lastUpdateTime;
        uint256 userAPY;           // APY в bps, зафиксированный для пользователя
    }

    mapping(address => StakeInfo) public stakes;

    event Staked(address indexed user, uint256 amount, bool isArub);
    event Unstaked(address indexed user, uint256 amount, bool isArub);
    event RewardsClaimed(address indexed user, uint256 amount, bool compound);
    event RewardsFunded(uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _usdtToken, address _arubToken) {
        require(_usdtToken != address(0) && _arubToken != address(0), "Zero address");
        usdtToken = IERC20(_usdtToken);
        arubToken = IERC20(_arubToken);
        owner = msg.sender;
    }

    // ------------------------------------------------------------------------
    //                         VIEW / HELPERS
    // ------------------------------------------------------------------------

    /// @notice Общий стейк (USDT + ARUB) в 6 decimals
    function totalStaked() public view returns (uint256) {
        return totalUsdtStaked + totalArubStaked;
    }

    /// @notice ТЕКУЩИЙ ГЛОБАЛЬНЫЙ APY по TVL (basis points)
    ///         Используется для новых пользователей / новых входов.
    function currentAPY() public view returns (uint256) {
        uint256 tvl = totalStaked();

        for (uint256 i = 0; i < thresholds.length; i++) {
            if (tvl < thresholds[i]) {
                return apyTiers[i];
            }
        }
        // Если TVL >= последнего порога — применяем самый низкий APY
        return apyTiers[apyTiers.length - 1];
    }

    /// @notice Расчёт невыплаченных наград для пользователя
    function pendingRewards(address user) public view returns (uint256) {
        StakeInfo memory stake = stakes[user];

        if (stake.lastUpdateTime == 0) {
            return stake.pendingRewards;
        }

        uint256 timeElapsed = block.timestamp - stake.lastUpdateTime;

        // Берём индивидуальный APY пользователя.
        uint256 apy = stake.userAPY;
        if (apy == 0) {
            apy = currentAPY();
        }

        // База для наград: суммарный стейк USDT + ARUB
        uint256 baseAmount = stake.usdtStaked + stake.arubStaked;

        // rewards = base * apyBps / 10000 * timeElapsed / YEAR
        uint256 YEAR = 365 days;

        uint256 rewards = (baseAmount * apy * timeElapsed) / (10000 * YEAR);

        return stake.pendingRewards + rewards;
    }

    /// @notice Внутреннее обновление наград для пользователя
    function _updateRewards(address user) internal {
        StakeInfo storage stake = stakes[user];

        // Инициализация: если это первый вызов — просто ставим lastUpdateTime и фиксируем APY.
        if (stake.lastUpdateTime == 0) {
            stake.lastUpdateTime = block.timestamp;

            if (stake.userAPY == 0) {
                stake.userAPY = currentAPY();
            }
            return;
        }

        uint256 accrued = pendingRewards(user) - stake.pendingRewards;

        if (accrued > 0) {
            stake.pendingRewards += accrued;
            totalRewardsDistributed += accrued;
        }

        stake.lastUpdateTime = block.timestamp;
    }

    /// @notice Возвращает индивидуальный APY пользователя (bps)
    function userAPY(address user) external view returns (uint256) {
        StakeInfo memory stake = stakes[user];
        return stake.userAPY == 0 ? currentAPY() : stake.userAPY;
    }

    // ------------------------------------------------------------------------
    //                                STAKE
    // ------------------------------------------------------------------------

    /// @notice Стейкинг USDT
    function stakeUsdt(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        StakeInfo storage stake = stakes[msg.sender];

        if (stake.usdtStaked > 0 || stake.arubStaked > 0) {
            _updateRewards(msg.sender);
        } else {
            // Новый пользователь — фиксируем APY на момент входа
            stake.userAPY = currentAPY();
            totalStakers++;
        }

        if (stake.usdtStaked == 0) {
            totalUsdtStakers++;
        }

        stake.usdtStaked += amount;
        totalUsdtStaked += amount;

        if (stake.lastStakeTime == 0) {
            stake.lastStakeTime = block.timestamp;
        }
        if (stake.lastUpdateTime == 0) {
            stake.lastUpdateTime = block.timestamp;
        }

        require(usdtToken.transferFrom(msg.sender, address(this), amount), "USDT transfer failed");

        emit Staked(msg.sender, amount, false);
    }

    /// @notice Стейкинг ARUB
    function stakeArub(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        StakeInfo storage stake = stakes[msg.sender];

        if (stake.usdtStaked > 0 || stake.arubStaked > 0) {
            _updateRewards(msg.sender);
        } else {
            stake.userAPY = currentAPY();
            totalStakers++;
        }

        if (stake.arubStaked == 0) {
            totalArubStakers++;
        }

        stake.arubStaked += amount;
        totalArubStaked += amount;

        if (stake.lastStakeTime == 0) {
            stake.lastStakeTime = block.timestamp;
        }
        if (stake.lastUpdateTime == 0) {
            stake.lastUpdateTime = block.timestamp;
        }

        require(arubToken.transferFrom(msg.sender, address(this), amount), "ARUB transfer failed");

        emit Staked(msg.sender, amount, true);
    }

    // ------------------------------------------------------------------------
    //                                UNSTAKE
    // ------------------------------------------------------------------------

    /// @notice Анстейк USDT
    function unstakeUsdt(uint256 amount) external nonReentrant {
        StakeInfo storage stake = stakes[msg.sender];
        require(stake.usdtStaked >= amount, "Insufficient USDT staked");

        _updateRewards(msg.sender);

        stake.usdtStaked -= amount;
        totalUsdtStaked -= amount;

        if (stake.usdtStaked == 0) {
            if (totalUsdtStakers > 0) {
                totalUsdtStakers--;
            }
        }

        // Если вообще не осталось стейка — уменьшаем totalStakers и сбрасываем userAPY
        if (stake.usdtStaked == 0 && stake.arubStaked == 0) {
            if (totalStakers > 0) {
                totalStakers--;
            }
            stake.userAPY = 0;
            stake.lastStakeTime = 0;
        }

        require(usdtToken.transfer(msg.sender, amount), "USDT transfer failed");

        emit Unstaked(msg.sender, amount, false);
    }

    /// @notice Анстейк ARUB
    function unstakeArub(uint256 amount) external nonReentrant {
        StakeInfo storage stake = stakes[msg.sender];
        require(stake.arubStaked >= amount, "Insufficient ARUB staked");

        _updateRewards(msg.sender);

        stake.arubStaked -= amount;
        totalArubStaked -= amount;

        if (stake.arubStaked == 0) {
            if (totalArubStakers > 0) {
                totalArubStakers--;
            }
        }

        // Если вообще не осталось стейка — уменьшаем totalStakers и сбрасываем userAPY
        if (stake.usdtStaked == 0 && stake.arubStaked == 0) {
            if (totalStakers > 0) {
                totalStakers--;
            }
            stake.userAPY = 0;
            stake.lastStakeTime = 0;
        }

        require(arubToken.transfer(msg.sender, amount), "ARUB transfer failed");

        emit Unstaked(msg.sender, amount, true);
    }

    // ------------------------------------------------------------------------
    //                              CLAIM / COMPOUND
    // ------------------------------------------------------------------------

    /// @notice Просто забрать награды (в ARUB)
    function claimRewards() external nonReentrant {
        StakeInfo storage stake = stakes[msg.sender];

        _updateRewards(msg.sender);

        uint256 rewards = stake.pendingRewards;
        require(rewards > 0, "No rewards");

        stake.pendingRewards = 0;
        stake.totalClaimed += rewards;

        require(arubToken.transfer(msg.sender, rewards), "ARUB transfer failed");

        emit RewardsClaimed(msg.sender, rewards, false);
    }

    /// @notice Забрать награды и реинвестировать их в ARUB-стейк (compound)
    function compoundRewards() external nonReentrant {
        StakeInfo storage stake = stakes[msg.sender];

        _updateRewards(msg.sender);

        uint256 rewards = stake.pendingRewards;
        require(rewards > 0, "No rewards");

        stake.pendingRewards = 0;
        stake.totalClaimed += rewards;

        // Реинвестируем награды в ARUB-стейк
        stake.arubStaked += rewards;
        totalArubStaked += rewards;

        emit RewardsClaimed(msg.sender, rewards, true);
        emit Staked(msg.sender, rewards, true);
    }

    // ------------------------------------------------------------------------
    //                        FRONT-END HELPER FUNCTIONS
    // ------------------------------------------------------------------------

    /// @notice Возвращает подробную информацию о стейке пользователя
    function getUserInfo(address user)
        external
        view
        returns (
            uint256 usdtStaked_,
            uint256 arubStaked_,
            uint256 pendingRewards_,
            uint256 totalClaimed_,
            uint256 userAPY_,
            uint256 lastStakeTime_,
            uint256 lastUpdateTime_
        )
    {
        StakeInfo memory stake = stakes[user];

        usdtStaked_ = stake.usdtStaked;
        arubStaked_ = stake.arubStaked;
        pendingRewards_ = pendingRewards(user);
        totalClaimed_ = stake.totalClaimed;
        userAPY_ = stake.userAPY == 0 ? currentAPY() : stake.userAPY;
        lastStakeTime_ = stake.lastStakeTime;
        lastUpdateTime_ = stake.lastUpdateTime;
    }

    /// @notice Возвращает текущий tier по TVL и его описание
    function getCurrentTier()
        external
        view
        returns (
            uint256 currentTier,        // индекс tier (0..3)
            uint256 currentThreshold,   // порог для следующего tier
            uint256 apyBps,             // текущий APY в bps
            string memory description   // человекочитаемое описание
        )
    {
        uint256 tvl = totalStaked();

        if (tvl < thresholds[0]) {
            currentTier = 0;                 // Tier 1
            currentThreshold = thresholds[0];
        } else if (tvl < thresholds[1]) {
            currentTier = 1;                 // Tier 2
            currentThreshold = thresholds[1];
        } else if (tvl < thresholds[2]) {
            currentTier = 2;                 // Tier 3
            currentThreshold = thresholds[2];
        } else {
            currentTier = 3;                 // Tier 4
            currentThreshold = type(uint256).max;
        }

        apyBps = currentAPY();

        if (currentTier == 0) {
            description = "Tier 1: 12% APY (highest)";
        } else if (currentTier == 1) {
            description = "Tier 2: 10% APY";
        } else if (currentTier == 2) {
            description = "Tier 3: 8% APY";
        } else {
            description = "Tier 4: 6% APY (lowest)";
        }
    }

    /// @notice Минимальный стейк в USDT (для фронта)
    function minStakeAmountUsdt() external pure returns (uint256) {
        return 10e6; // 10 USDT
    }

    /// @notice Минимальный стейк в ARUB (для фронта)
    function minStakeAmountArub() external pure returns (uint256) {
        return 1e5; // 0.1 ARUB (6 decimals)
    }

    // ------------------------------------------------------------------------
    //                            OWNER FUNCTIONS
    // ------------------------------------------------------------------------

    /// @notice Пополнение пула наград в ARUB
    /// @dev Предполагается, что ARUB уже переведён на контракт стейкинга
    function fundRewards(uint256 amount) external onlyOwner {
        require(amount > 0, "Zero amount");
        require(arubToken.balanceOf(address(this)) >= amount, "Not enough ARUB on contract");

        emit RewardsFunded(amount);
    }

    /// @notice Аварийное выведение любого токена (только owner)
    function emergencyWithdraw(address _token, uint256 amount) external onlyOwner {
        IERC20(_token).transfer(owner, amount);
    }

    /// @notice Смена владельца (на случай перенастройки)
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}
