// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IAntiRUB {
    function mint(uint256 usdtAmount, uint256 minArubOut) external;
    function burn(uint256 arubAmount, uint256 minUsdtOut) external;

    function getMintAmount(uint256 usdtAmount)
        external
        view
        returns (uint256 userArub, uint256 feeArub, uint256 newCrBps);

    function getBurnReturn(uint256 arubAmount)
        external
        view
        returns (uint256 userUsdt, uint256 feeUsdt, uint256 newCrBps);

    /// @notice Current collateral ratio of the protocol, 1e6 = 100%.
    function currentCollateralRatio() external view returns (uint256 ratio);
}

interface IUniswapV2Router02 {
    function WETH() external pure returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

interface IQuoter {
    function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut);
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
    function quoteExactOutput(bytes memory path, uint256 amountOut) external returns (uint256 amountIn);
    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountIn);
}

/// @title AntiRUBArbitrageManager
/// @notice Умный арбитраж между внутренним курсом AntiRUB и DEX (Uniswap V2/V3).
contract AntiRUBArbitrageManager is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IAntiRUB public immutable antiRub;
    IERC20 public immutable usdt;
    IERC20 public immutable arubToken;

    // минимальная относительная прибыль (в bps, 100 = 1%)
    uint256 public minProfitBps;

    // абсолютный минимум прибыли в USDT (6 decimals)
    uint256 public minProfitAbsolute;

    // максимально допустимое отклонение minOut от ожиданий роутера (bps)
    uint256 public maxSlippageBps;

    // максимальный размер сделки в USDT (6 decimals)
    uint256 public maxTradeUsdt;

    // минимальный collateral ratio AntiRUB для выполнения арбитража (bps, 1e4 = 100%)
    uint256 public minCollateralRatioBps;

    // keeper-адреса, которым разрешено вызывать арбитраж
    mapping(address => bool) public isKeeper;

    // ───────────────────────── Events ─────────────────────────

    event KeeperUpdated(address indexed keeper, bool allowed);
    event MinProfitUpdated(uint256 minProfitBps, uint256 minProfitAbsolute);
    event MaxSlippageUpdated(uint256 maxSlippageBps);
    event MaxTradeUsdtUpdated(uint256 maxTradeUsdt);
    event MinCollateralRatioUpdated(uint256 minCollateralRatioBps);

    event MintSellV2(
        address indexed caller,
        address indexed router,
        address[] path,
        uint256 usdtIn,
        uint256 arubMinted,
        uint256 usdtOut,
        int256 profit
    );

    event BuyBurnV2(
        address indexed caller,
        address indexed router,
        address[] path,
        uint256 usdtIn,
        uint256 arubBought,
        uint256 usdtOutFromBurn,
        int256 profit
    );

    event MintSellV3(
        address indexed caller,
        address indexed router,
        bytes path,
        uint256 usdtIn,
        uint256 arubMinted,
        uint256 usdtOut,
        int256 profit
    );

    event BuyBurnV3(
        address indexed caller,
        address indexed router,
        bytes path,
        uint256 usdtIn,
        uint256 arubBought,
        uint256 usdtOutFromBurn,
        int256 profit
    );

    event Swept(address indexed token, address indexed to, uint256 amount);

    // ───────────────────────── Modifiers ─────────────────────────

    modifier onlyKeeper() {
        require(isKeeper[msg.sender] || msg.sender == owner(), "Not keeper");
        _;
    }

    modifier checkCR() {
        uint256 cr = antiRub.currentCollateralRatio(); // 1e6 = 100%
        require(cr >= minCollateralRatioBps * 1e2, "CR too low");
        _;
    }

    // ───────────────────────── Constructor ─────────────────────────

    constructor(
        address _antiRub,
        address _usdt,
        address _arubToken,
        uint256 _minProfitBps,
        uint256 _minProfitAbsolute,
        uint256 _maxSlippageBps,
        uint256 _maxTradeUsdt,
        uint256 _minCollateralRatioBps
    ) Ownable(msg.sender) {
        require(_antiRub != address(0), "antiRub zero");
        require(_usdt != address(0), "usdt zero");
        require(_arubToken != address(0), "arub zero");

        antiRub = IAntiRUB(_antiRub);
        usdt = IERC20(_usdt);
        arubToken = IERC20(_arubToken);

        minProfitBps = _minProfitBps;
        minProfitAbsolute = _minProfitAbsolute;
        maxSlippageBps = _maxSlippageBps;
        maxTradeUsdt = _maxTradeUsdt;
        minCollateralRatioBps = _minCollateralRatioBps;
    }

    // ───────────────────────── Admin setters ─────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setMinProfit(uint256 _minProfitBps, uint256 _minProfitAbsolute) external onlyOwner {
        require(_minProfitBps <= 10_000, "bps too high");
        minProfitBps = _minProfitBps;
        minProfitAbsolute = _minProfitAbsolute;
        emit MinProfitUpdated(_minProfitBps, _minProfitAbsolute);
    }

    function setMaxSlippageBps(uint256 _maxSlippageBps) external onlyOwner {
        require(_maxSlippageBps <= 3_000, "slippage too high");
        maxSlippageBps = _maxSlippageBps;
        emit MaxSlippageUpdated(_maxSlippageBps);
    }

    function setMaxTradeUsdt(uint256 _maxTradeUsdt) external onlyOwner {
        maxTradeUsdt = _maxTradeUsdt;
        emit MaxTradeUsdtUpdated(_maxTradeUsdt);
    }

    function setMinCollateralRatioBps(uint256 _minCollateralRatioBps) external onlyOwner {
        // 10_000 bps = 100%
        require(_minCollateralRatioBps <= 20_000, "CR too high");
        minCollateralRatioBps = _minCollateralRatioBps;
        emit MinCollateralRatioUpdated(_minCollateralRatioBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────── Internal helpers ─────────────────────────

    function _minRequiredProfit(uint256 usdtIn) internal view returns (uint256) {
        uint256 rel = 0;
        if (minProfitBps > 0) {
            rel = (usdtIn * minProfitBps) / 10_000;
        }
        uint256 absMin = minProfitAbsolute;
        return rel > absMin ? rel : absMin;
    }

    // ───────────────────────── Uniswap V2 helpers ─────────────────────────

    function _validateSlippageV2(
        address router,
        uint256 amountIn,
        uint256 minAmountOut,
        address[] calldata path
    ) internal view {
        require(router != address(0), "router zero");
        require(path.length >= 2, "bad path");
        uint256[] memory amounts = IUniswapV2Router02(router).getAmountsOut(amountIn, path);
        uint256 expectedOut = amounts[amounts.length - 1];
        require(expectedOut > 0, "zero expected");
        uint256 allowedSlippage = (expectedOut * (10_000 - maxSlippageBps)) / 10_000;
        require(minAmountOut >= allowedSlippage, "slippage too high");
    }

    // ───────────────────────── Core arbitrage logic (Uniswap V2) ─────────────────────────

    function mintAndSellV2(
        address router,
        address[] calldata path,
        uint256 usdtIn,
        uint256 minUsdtOut
    ) external onlyKeeper nonReentrant whenNotPaused checkCR {
        require(usdtIn > 0, "usdtIn=0");
        require(usdtIn <= maxTradeUsdt, "usdtIn too big");
        require(path.length >= 2, "bad path");
        require(path[0] == address(arubToken), "path[0]!=ARUB");

        usdt.safeTransferFrom(msg.sender, address(this), usdtIn);

        usdt.safeApprove(address(antiRub), 0);
        usdt.safeApprove(address(antiRub), usdtIn);

        (uint256 arubMinted,,) = antiRub.getMintAmount(usdtIn);

        antiRub.mint(usdtIn, 0);

        arubToken.safeApprove(router, 0);
        arubToken.safeApprove(router, arubMinted);

        _validateSlippageV2(router, arubMinted, minUsdtOut, path);

        uint256[] memory amounts = IUniswapV2Router02(router).swapExactTokensForTokens(
            arubMinted,
            minUsdtOut,
            path,
            address(this),
            block.timestamp
        );

        uint256 usdtOut = amounts[amounts.length - 1];

        int256 profit = int256(usdtOut) - int256(usdtIn);
        require(profit >= 0, "no profit");
        require(uint256(profit) >= _minRequiredProfit(usdtIn), "profit < min");

        usdt.safeTransfer(owner(), usdtOut);

        emit MintSellV2(msg.sender, router, path, usdtIn, arubMinted, usdtOut, profit);
    }

    function buyAndBurnV2(
        address router,
        address[] calldata path,
        uint256 usdtIn,
        uint256 minArubOut
    ) external onlyKeeper nonReentrant whenNotPaused checkCR {
        require(usdtIn > 0, "usdtIn=0");
        require(usdtIn <= maxTradeUsdt, "usdtIn too big");
        require(path.length >= 2, "bad path");
        require(path[path.length - 1] == address(arubToken), "last!=ARUB");

        usdt.safeTransferFrom(msg.sender, address(this), usdtIn);

        usdt.safeApprove(router, 0);
        usdt.safeApprove(router, usdtIn);

        uint256[] memory amounts = IUniswapV2Router02(router).swapExactTokensForTokens(
            usdtIn,
            minArubOut,
            path,
            address(this),
            block.timestamp
        );
        uint256 arubBought = amounts[amounts.length - 1];

        (uint256 usdtFromBurn,,) = antiRub.getBurnReturn(arubBought);

        arubToken.safeApprove(address(antiRub), 0);
        arubToken.safeApprove(address(antiRub), arubBought);

        antiRub.burn(arubBought, 0);

        int256 profit = int256(usdtFromBurn) - int256(usdtIn);
        require(profit >= 0, "no profit");
        require(uint256(profit) >= _minRequiredProfit(usdtIn), "profit < min");

        usdt.safeTransfer(owner(), usdtFromBurn);

        emit BuyBurnV2(msg.sender, router, path, usdtIn, arubBought, usdtFromBurn, profit);
    }

    // ───────────────────────── Uniswap V3: mint->sell, buy->burn ─────────────────────────

    function mintAndSellV3(
        address router,
        bytes calldata path,
        uint256 usdtIn,
        uint256 minUsdtOut
    ) external onlyKeeper nonReentrant whenNotPaused checkCR {
        require(router != address(0), "router zero");
        require(usdtIn > 0, "usdtIn=0");
        require(usdtIn <= maxTradeUsdt, "usdtIn too big");

        usdt.safeTransferFrom(msg.sender, address(this), usdtIn);

        usdt.safeApprove(address(antiRub), 0);
        usdt.safeApprove(address(antiRub), usdtIn);

        (uint256 arubMinted,,) = antiRub.getMintAmount(usdtIn);

        antiRub.mint(usdtIn, 0);

        arubToken.safeApprove(router, 0);
        arubToken.safeApprove(router, arubMinted);

        uint256 usdtOut = ISwapRouter(router).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: arubMinted,
                amountOutMinimum: minUsdtOut
            })
        );

        int256 profit = int256(usdtOut) - int256(usdtIn);
        require(profit >= 0, "no profit");
        require(uint256(profit) >= _minRequiredProfit(usdtIn), "profit < min");

        usdt.safeTransfer(owner(), usdtOut);

        emit MintSellV3(msg.sender, router, path, usdtIn, arubMinted, usdtOut, profit);
    }

    function buyAndBurnV3(
        address router,
        bytes calldata path,
        uint256 usdtIn,
        uint256 minArubOut
    ) external onlyKeeper nonReentrant whenNotPaused checkCR {
        require(router != address(0), "router zero");
        require(usdtIn > 0, "usdtIn=0");
        require(usdtIn <= maxTradeUsdt, "usdtIn too big");

        usdt.safeTransferFrom(msg.sender, address(this), usdtIn);

        usdt.safeApprove(router, 0);
        usdt.safeApprove(router, usdtIn);

        uint256 arubBought = ISwapRouter(router).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: usdtIn,
                amountOutMinimum: minArubOut
            })
        );

        (uint256 usdtFromBurn,,) = antiRub.getBurnReturn(arubBought);

        arubToken.safeApprove(address(antiRub), 0);
        arubToken.safeApprove(address(antiRub), arubBought);

        antiRub.burn(arubBought, 0);

        int256 profit = int256(usdtFromBurn) - int256(usdtIn);
        require(profit >= 0, "no profit");
        require(uint256(profit) >= _minRequiredProfit(usdtIn), "profit < min");

        usdt.safeTransfer(owner(), usdtFromBurn);

        emit BuyBurnV3(msg.sender, router, path, usdtIn, arubBought, usdtFromBurn, profit);
    }

    // ───────────────────────── Симуляции ─────────────────────────

    function simulateMintSellV2(
        uint256 usdtIn,
        address router,
        address[] calldata path
    )
        external
        view
        returns (
            uint256 arubMinted,
            uint256 expectedOut,
            int256 expectedProfit
        )
    {
        require(router != address(0), "router zero");
        require(path.length >= 2, "bad path");
        require(path[0] == address(arubToken), "path[0]!=ARUB");

        (arubMinted,,) = antiRub.getMintAmount(usdtIn);

        uint256[] memory amounts = IUniswapV2Router02(router).getAmountsOut(arubMinted, path);
        expectedOut = amounts[amounts.length - 1];

        if (expectedOut >= usdtIn) {
            expectedProfit = int256(expectedOut - usdtIn);
        } else {
            expectedProfit = -int256(usdtIn - expectedOut);
        }
    }

    function simulateBuyBurnV2(
        uint256 usdtIn,
        address router,
        address[] calldata path
    )
        external
        view
        returns (
            uint256 arubBought,
            uint256 usdtFromBurn,
            int256 expectedProfit
        )
    {
        require(router != address(0), "router zero");
        require(path.length >= 2, "bad path");
        require(path[path.length - 1] == address(arubToken), "last!=ARUB");

        uint256[] memory amounts = IUniswapV2Router02(router).getAmountsOut(usdtIn, path);
        arubBought = amounts[amounts.length - 1];

        (usdtFromBurn,,) = antiRub.getBurnReturn(arubBought);

        if (usdtFromBurn >= usdtIn) {
            expectedProfit = int256(usdtFromBurn - usdtIn);
        } else {
            expectedProfit = -int256(usdtIn - usdtFromBurn);
        }
    }

    // ВНИМАНИЕ: IQuoter функции не view, поэтому simulate*V3 НЕ помечаем view
    function simulateMintSellV3(
        uint256 usdtIn,
        address quoter,
        bytes calldata path
    )
        external
        returns (
            uint256 arubMinted,
            uint256 expectedOut,
            int256 expectedProfit
        )
    {
        require(quoter != address(0), "quoter zero");

        (arubMinted,,) = antiRub.getMintAmount(usdtIn);

        expectedOut = IQuoter(quoter).quoteExactInput(path, arubMinted);

        if (expectedOut >= usdtIn) {
            expectedProfit = int256(expectedOut - usdtIn);
        } else {
            expectedProfit = -int256(usdtIn - expectedOut);
        }
    }

    function simulateBuyBurnV3(
        uint256 usdtIn,
        address quoter,
        bytes calldata path
    )
        external
        returns (
            uint256 arubBought,
            uint256 usdtFromBurn,
            int256 expectedProfit
        )
    {
        require(quoter != address(0), "quoter zero");

        arubBought = IQuoter(quoter).quoteExactInput(path, usdtIn);

        (usdtFromBurn,,) = antiRub.getBurnReturn(arubBought);

        if (usdtFromBurn >= usdtIn) {
            expectedProfit = int256(usdtFromBurn - usdtIn);
        } else {
            expectedProfit = -int256(usdtIn - usdtFromBurn);
        }
    }

    // ───────────────────────── Emergency / sweep ─────────────────────────

    function sweep(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "to zero");
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    function sweepAllUSDT(address to) external onlyOwner {
        require(to != address(0), "to zero");
        uint256 bal = usdt.balanceOf(address(this));
        usdt.safeTransfer(to, bal);
        emit Swept(address(usdt), to, bal);
    }

    function sweepAllARUB(address to) external onlyOwner {
        require(to != address(0), "to zero");
        uint256 bal = arubToken.balanceOf(address(this));
        arubToken.safeTransfer(to, bal);
        emit Swept(address(arubToken), to, bal);
    }
}
