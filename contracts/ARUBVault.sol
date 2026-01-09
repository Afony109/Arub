// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

interface IERC20ApproveUpgradeable {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV2Router02 {
    function factory() external view returns (address);

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external returns (uint amountA, uint amountB);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair is IERC20Upgradeable {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
}

interface IArubTokenPricing {
    /// input: USDT 6 dec, output: ARUB 6 dec
    function calculateArubAmount(uint256 usdtAmount) external view returns (uint256);

    /// input: ARUB 6 dec, output: USDT 6 dec
    function calculateUsdtAmount(uint256 arubAmount) external view returns (uint256);
}

/**
 * ARUBVaultTwoModeV2 (UUPS upgrade)
 * - Phase 1: strategyEnabled=false => deposit/withdraw (ARUB only)
 * - Phase 2: strategyEnabled=true  => depositWithStrategy/withdrawToARUB
 * Added in V2:
 * - pause/unpause (guardian can pause, owner can unpause)
 * - limits for strategy deposits/withdraws
 * - router updatable (onlyOwner, recommended only when paused)
 */
contract ARUBVaultTwoModeV2 is
    Initializable,
    ERC20Upgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -----------------------
    // V1 STORAGE (do not reorder)
    // -----------------------
    IERC20Upgradeable public ARUB;
    IERC20Upgradeable public USDT;
    IUniswapV2Router02 public router;

    bool public strategyEnabled;
    address public pair;
    IERC20Upgradeable public lpToken;
    /// @notice Where newly minted LP tokens are sent for owner-driven liquidity provisioning.
    /// @dev Does NOT affect user strategy deposits/withdrawals; those LP tokens stay in the vault.
    address public lpReceiver;

    uint8 private _shareDecimals;

    // -----------------------
    // V2 STORAGE (append only)
    // -----------------------
    address public guardian;
    uint256 public maxStrategyDepositArub;     // 0 = no limit
    uint256 public maxStrategyWithdrawShares;  // 0 = no limit
    uint256 public maxOracleDeviationBps;      // 0 = no limit

    // -----------------------
    // Structs to avoid stack-too-deep
    // -----------------------
    struct DepositParams {
        uint256 arubAmount;
        uint256 minUsdtOut;
        uint256 minLpOut;
        uint256 deadline;
    }

    struct WithdrawParams {
        uint256 shares;
        uint256 minArubFromUsdt;
        uint256 amountAMin;
        uint256 amountBMin;
        uint256 deadline;
    }

    // -----------------------
    // Events
    // -----------------------
    event GuardianSet(address indexed guardian);
    event LimitsSet(uint256 maxDepositArub, uint256 maxWithdrawShares);
    event RouterSet(address indexed newRouter);
    event LPReceiverSet(address indexed newReceiver);
    event TreasuryLiquidityAdded(uint256 arubIn, uint256 usdtIn, uint256 lpMinted, address indexed lpReceiver);
    event OracleDeviationSet(uint256 maxDeviationBps);

    event StrategyEnabled(address indexed pair);
    event Deposited(address indexed user, uint256 arubIn, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 sharesBurned, uint256 arubOut);
    event StrategyDeposit(address indexed user, uint256 arubIn, uint256 sharesMinted, uint256 lpMinted);
    event StrategyWithdraw(address indexed user, uint256 sharesBurned, uint256 arubOut, uint256 lpRemoved);

    // -----------------------
    // Initializers
    // -----------------------

    /// @dev This is your V1 initializer signature example.
    /// If your V1 initializer differed, DO NOT call this. Use only initializeV2 below.
    function initialize(
        address arub,
        address usdt,
        address routerV2,
        address initialOwner
    ) external initializer {
        __ERC20_init("ARUB Vault Share", "vARUB");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        require(arub != address(0) && usdt != address(0) && routerV2 != address(0), "zero");

        ARUB = IERC20Upgradeable(arub);
        USDT = IERC20Upgradeable(usdt);
        router = IUniswapV2Router02(routerV2);

        _shareDecimals = IERC20MetadataUpgradeable(arub).decimals();

        strategyEnabled = false;
        pair = address(0);
        lpToken = IERC20Upgradeable(address(0));
        lpReceiver = address(this);
    }

    /// @notice Call once after upgrading to V2 (reinitializer).
    function initializeV2(
        address guardian_,
        uint256 maxDepositArub_,
        uint256 maxWithdrawShares_
    ) external reinitializer(2) onlyOwner {
        guardian = guardian_;
        maxStrategyDepositArub = maxDepositArub_;
        maxStrategyWithdrawShares = maxWithdrawShares_;
        emit GuardianSet(guardian_);
        emit LimitsSet(maxDepositArub_, maxWithdrawShares_);
        // Default LP receiver for newly added owner-driven liquidity.
        if (lpReceiver == address(0)) {
            lpReceiver = address(this);
            emit LPReceiverSet(lpReceiver);
        }
    }

    // -----------------------
    // UUPS auth
    // -----------------------
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------
    // ERC20 shares decimals
    // -----------------------
    function decimals() public view override returns (uint8) {
        return _shareDecimals;
    }

    // -----------------------
    // Modifiers
    // -----------------------
    modifier onlyGuardianOrOwner() {
        require(msg.sender == guardian || msg.sender == owner(), "not guardian/owner");
        _;
    }

    // -----------------------
    // Admin: pause controls
    // -----------------------
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // -----------------------
    // Admin: params
    // -----------------------
    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function setLimits(uint256 maxDepositArub_, uint256 maxWithdrawShares_) external onlyOwner {
        maxStrategyDepositArub = maxDepositArub_;
        maxStrategyWithdrawShares = maxWithdrawShares_;
        emit LimitsSet(maxDepositArub_, maxWithdrawShares_);
    }

    function setOracleDeviationBps(uint256 maxBps) external onlyOwner {
        require(maxBps <= 5_000, "deviation too high");
        maxOracleDeviationBps = maxBps;
        emit OracleDeviationSet(maxBps);
    }

    /// @dev Router change is risky; recommended only when paused.
    function setRouter(address newRouter) external onlyOwner {
        require(newRouter != address(0), "zero");
        require(paused(), "pause first");
        router = IUniswapV2Router02(newRouter);
        emit RouterSet(newRouter);
    }

/// @notice Set receiver for LP tokens minted via owner-driven liquidity provisioning.
/// @dev Recommended to update only when paused.
function setLPReceiver(address newReceiver) external onlyOwner {
    require(newReceiver != address(0), "zero");
    lpReceiver = newReceiver;
    emit LPReceiverSet(newReceiver);
}

/// @notice Add ARUB/USDT liquidity using tokens already held by this vault.
/// @dev Mints LP tokens to the vault first, then forwards them to lpReceiver.
///      This function is intended for protocol/treasury operations and does not affect user strategy LP accounting.
function addLiquidityFromVault(
    uint256 arubAmountDesired,
    uint256 usdtAmountDesired,
    uint256 arubAmountMin,
    uint256 usdtAmountMin,
    uint256 deadline
) external onlyOwner nonReentrant whenNotPaused returns (uint256 arubUsed, uint256 usdtUsed, uint256 lpMinted) {
    require(arubAmountDesired > 0 && usdtAmountDesired > 0, "amounts");
    require(deadline >= block.timestamp, "deadline");

    require(ARUB.balanceOf(address(this)) >= arubAmountDesired, "arub balance");
    require(USDT.balanceOf(address(this)) >= usdtAmountDesired, "usdt balance");

    _approveExact(ARUB, address(router), arubAmountDesired);
    _approveExact(USDT, address(router), usdtAmountDesired);

    (arubUsed, usdtUsed, lpMinted) = router.addLiquidity(
        address(ARUB),
        address(USDT),
        arubAmountDesired,
        usdtAmountDesired,
        arubAmountMin,
        usdtAmountMin,
        address(this),
        deadline
    );

    _approveExact(ARUB, address(router), 0);
    _approveExact(USDT, address(router), 0);

    // Ensure we have the LP token address recorded (useful even if strategy is not enabled yet).
    address pairAddr = IUniswapV2Factory(router.factory()).getPair(address(ARUB), address(USDT));
    require(pairAddr != address(0), "pair");
    if (pair == address(0)) {
        pair = pairAddr;
    }
    if (address(lpToken) == address(0)) {
        lpToken = IERC20Upgradeable(pairAddr);
    }

    address recv = lpReceiver == address(0) ? address(this) : lpReceiver;
    if (recv != address(this) && lpMinted > 0) {
        IERC20Upgradeable(pairAddr).safeTransfer(recv, lpMinted);
    }

    emit TreasuryLiquidityAdded(arubUsed, usdtUsed, lpMinted, recv);
}

    // -----------------------
    // Internal: path builder
    // -----------------------
     function _path2 (address a, address b) internal pure returns (address[] memory p) {
    p = new address [] (2);
    p[0] = a;
    p[1] = b;
    }

    // -----------------------
    // Internal: approve (version-proof)
    // -----------------------
    function _callApprove(IERC20Upgradeable token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20ApproveUpgradeable.approve.selector, spender, amount)
        );
        require(ok, "approve call failed");
        if (data.length > 0) require(abi.decode(data, (bool)), "approve false");
    }

    /// @notice USDT-style approve: 0 then amount.
    function _approveExact(IERC20Upgradeable token, address spender, uint256 amount) internal {
        _callApprove(token, spender, 0);
        if (amount > 0) _callApprove(token, spender, amount);
    }

    // -----------------------
    // Phase 2 enabling
    // -----------------------
    function enableStrategy() external onlyOwner whenNotPaused {
        require(!strategyEnabled, "enabled");
        address factory = router.factory();
        address p = IUniswapV2Factory(factory).getPair(address(ARUB), address(USDT));
        require(p != address(0), "pair not created");

        pair = p;
        lpToken = IERC20Upgradeable(p);
        strategyEnabled = true;

        // Safety: ensure reserves are non-empty so totalAssetsArubEq/_usdtToArubEq cannot revert later.
        _getReservesARUB_USDT();

        emit StrategyEnabled(p);
    }

    // -----------------------
    // Phase 1: deposit/withdraw (no DEX)
    // -----------------------
    function deposit(uint256 arubAmount) external nonReentrant whenNotPaused returns (uint256 sharesMinted) {
        require(arubAmount > 0, "amount=0");

        if (!strategyEnabled) {
            // Phase 1: 1:1 mint
            ARUB.safeTransferFrom(msg.sender, address(this), arubAmount);

            sharesMinted = arubAmount;
            _mint(msg.sender, sharesMinted);
        } else {
            // Phase 2: mint shares against NAV to avoid dilution / accounting breaks.
            _requireOracleDeviationOk();
            uint256 assetsBefore = totalAssetsArubEq();
            uint256 supplyBefore = totalSupply();

            ARUB.safeTransferFrom(msg.sender, address(this), arubAmount);

            sharesMinted = _calcShares(arubAmount, assetsBefore, supplyBefore);
            _mint(msg.sender, sharesMinted);
        }

        emit Deposited(msg.sender, arubAmount, sharesMinted);
    }


    /// @dev Withdraw remains available even when paused (exit safety).
    function withdraw(uint256 shares) external nonReentrant returns (uint256 arubOut) {
        require(!strategyEnabled, "use strategy withdraw");
        require(shares > 0, "shares=0");
        require(balanceOf(msg.sender) >= shares, "no shares");

        uint256 supply = totalSupply();
        require(supply > 0, "supply=0");

        uint256 arubBal = ARUB.balanceOf(address(this));
        arubOut = (arubBal * shares) / supply;

        _burn(msg.sender, shares);
        ARUB.safeTransfer(msg.sender, arubOut);

        emit Withdrawn(msg.sender, shares, arubOut);
    }

    // -----------------------
    // NAV helpers
    // -----------------------
    function _getReservesARUB_USDT() internal view returns (uint256 rArub, uint256 rUsdt) {
        require(pair != address(0), "pair=0");
        IUniswapV2Pair p = IUniswapV2Pair(pair);

        (uint112 r0, uint112 r1,) = p.getReserves();
        address t0 = p.token0();
        address t1 = p.token1();

        if (t0 == address(ARUB) && t1 == address(USDT)) {
            rArub = uint256(r0);
            rUsdt = uint256(r1);
        } else if (t0 == address(USDT) && t1 == address(ARUB)) {
            rArub = uint256(r1);
            rUsdt = uint256(r0);
        } else {
            revert("wrong pair");
        }
        require(rArub > 0 && rUsdt > 0, "empty reserves");
    }

    function _oracleUsdtPerArub() internal view returns (uint256) {
        // 1 ARUB = 1_000_000 (6 decimals)
        return IArubTokenPricing(address(ARUB)).calculateUsdtAmount(1_000_000);
    }

    function _poolUsdtPerArub() internal view returns (uint256) {
        (uint256 rArub, uint256 rUsdt) = _getReservesARUB_USDT();
        return (rUsdt * 1_000_000) / rArub;
    }

    function _requireOracleDeviationOk() internal view {
        if (!strategyEnabled || maxOracleDeviationBps == 0) return;

        uint256 oraclePrice = _oracleUsdtPerArub();
        require(oraclePrice > 0, "oracle price=0");

        uint256 poolPrice = _poolUsdtPerArub();
        uint256 diff = poolPrice > oraclePrice ? poolPrice - oraclePrice : oraclePrice - poolPrice;
        uint256 diffBps = (diff * 10_000) / oraclePrice;
        require(diffBps <= maxOracleDeviationBps, "oracle deviation");
    }

    function _usdtToArubEq(uint256 usdtAmt) internal view returns (uint256) {
        if (usdtAmt == 0) return 0;
        return IArubTokenPricing(address(ARUB)).calculateArubAmount(usdtAmt);
    }

    function totalAssetsArubEq() public view returns (uint256) {
        require(strategyEnabled, "strategy off");

        uint256 arubIdle = ARUB.balanceOf(address(this));
        uint256 usdtIdle = USDT.balanceOf(address(this));
        uint256 lpBal = lpToken.balanceOf(address(this));

        if (lpBal == 0) return arubIdle + _usdtToArubEq(usdtIdle);

        IUniswapV2Pair p = IUniswapV2Pair(pair);
        uint256 lpTotal = p.totalSupply();
        require(lpTotal > 0, "lp total=0");

        (uint256 rArub, uint256 rUsdt) = _getReservesARUB_USDT();

        uint256 arubFromLP = (rArub * lpBal) / lpTotal;
        uint256 usdtFromLP = (rUsdt * lpBal) / lpTotal;

        return (arubIdle + arubFromLP) + _usdtToArubEq(usdtIdle + usdtFromLP);
    }

    // -----------------------
    // Internals to avoid stack-too-deep
    // -----------------------
    function _calcShares(uint256 arubAmount, uint256 assetsBefore, uint256 supplyBefore)
        internal
        pure
        returns (uint256 sharesMinted)
    {
        if (supplyBefore == 0) return arubAmount;
        require(assetsBefore > 0, "assets=0");
        sharesMinted = (arubAmount * supplyBefore) / assetsBefore;
        require(sharesMinted > 0, "shares=0");
    }

    function _zapArubToLP(
        uint256 arubAmount,
        uint256 minUsdtOut,
        uint256 minLpOut,
        uint256 deadline
    ) internal returns (uint256 lpMinted) {
        uint256 toSwap = arubAmount / 2;
        uint256 toKeep = arubAmount - toSwap;

        _approveExact(ARUB, address(router), toSwap);

        uint256 usdtReceived = router.swapExactTokensForTokens(
            toSwap,
            minUsdtOut,
            _path2(address(ARUB), address(USDT)),
            address(this),
            deadline
        )[1];

        _approveExact(ARUB, address(router), toKeep);
        _approveExact(USDT, address(router), usdtReceived);

        (,, lpMinted) = router.addLiquidity(
            address(ARUB),
            address(USDT),
            toKeep,
            usdtReceived,
            0,
            0,
            address(this),
            deadline
        );

        require(lpMinted >= minLpOut, "lp slippage");

        _approveExact(ARUB, address(router), 0);
        _approveExact(USDT, address(router), 0);
    }

    function _removeLP(
        uint256 lpAmount,
        uint256 amountAMin,
        uint256 amountBMin,
        uint256 deadline
    ) internal returns (uint256 arubFromLP, uint256 usdtFromLP) {
        if (lpAmount == 0) return (0, 0);

        _approveExact(lpToken, address(router), lpAmount);

        (arubFromLP, usdtFromLP) = router.removeLiquidity(
            address(ARUB),
            address(USDT),
            lpAmount,
            amountAMin,
            amountBMin,
            address(this),
            deadline
        );

        _approveExact(lpToken, address(router), 0);
    }

    function _swapUsdtToArub(uint256 usdtAmount, uint256 minArubOut, uint256 deadline)
        internal
        returns (uint256 arubFromSwap)
    {
        if (usdtAmount == 0) return 0;

        _approveExact(USDT, address(router), usdtAmount);

        arubFromSwap = router.swapExactTokensForTokens(
            usdtAmount,
            minArubOut,
            _path2(address(USDT), address(ARUB)),
            address(this),
            deadline
        )[1];

        _approveExact(USDT, address(router), 0);
    }

    // -----------------------
    // Phase 2: strategy
    // -----------------------
    function depositWithStrategy(DepositParams calldata d)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted, uint256 lpMinted)
    {
        require(strategyEnabled, "strategy off");
        _requireOracleDeviationOk();
        require(d.arubAmount > 0, "amount=0");
        if (maxStrategyDepositArub != 0) require(d.arubAmount <= maxStrategyDepositArub, "deposit limit");

        uint256 assetsBefore = totalAssetsArubEq();
        uint256 supplyBefore = totalSupply();

        ARUB.safeTransferFrom(msg.sender, address(this), d.arubAmount);

        lpMinted = _zapArubToLP(d.arubAmount, d.minUsdtOut, d.minLpOut, d.deadline);
        sharesMinted = _calcShares(d.arubAmount, assetsBefore, supplyBefore);

        _mint(msg.sender, sharesMinted);

        emit StrategyDeposit(msg.sender, d.arubAmount, sharesMinted, lpMinted);
    }

    /// @dev By default strategy-withdraw is blocked when paused (risk control).
    function withdrawToARUB(WithdrawParams calldata w)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 arubOut, uint256 lpRemoved)
    {
        require(strategyEnabled, "strategy off");
        _requireOracleDeviationOk();
        require(w.shares > 0, "shares=0");
        require(balanceOf(msg.sender) >= w.shares, "no shares");
        if (maxStrategyWithdrawShares != 0) require(w.shares <= maxStrategyWithdrawShares, "withdraw limit");

        uint256 supplyBefore = totalSupply();
        require(supplyBefore > 0, "supply=0");

        uint256 lpBal = lpToken.balanceOf(address(this));
        uint256 arubIdle = ARUB.balanceOf(address(this));
        uint256 usdtIdle = USDT.balanceOf(address(this));

        lpRemoved = (lpBal * w.shares) / supplyBefore;
        uint256 arubIdleShare = (arubIdle * w.shares) / supplyBefore;
        uint256 usdtIdleShare = (usdtIdle * w.shares) / supplyBefore;

        _burn(msg.sender, w.shares);

        (uint256 arubFromLP, uint256 usdtFromLP) =
            _removeLP(lpRemoved, w.amountAMin, w.amountBMin, w.deadline);

        uint256 arubFromSwap =
            _swapUsdtToArub(usdtIdleShare + usdtFromLP, w.minArubFromUsdt, w.deadline);

        arubOut = arubIdleShare + arubFromLP + arubFromSwap;
        ARUB.safeTransfer(msg.sender, arubOut);

        emit StrategyWithdraw(msg.sender, w.shares, arubOut, lpRemoved);
    }

    // reserve gap for future upgrades
    uint256[39] private __gap;
}
