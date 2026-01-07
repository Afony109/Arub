// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice Минимальный интерфейс оракула под AntiRUB
interface IArubOracleForToken {
    /// @return rate курс USD/RUB с 6 знаками (== цена 1 ARUB в USDT * 1e6)
    /// @return updatedAt timestamp последнего обновления
    function getRate() external view returns (uint256 rate, uint256 updatedAt);
}

/// @title ARUBToken
/// @notice Дорогой токен: 1 ARUB = rate / 1e6 USDT.
///         Десятичность: 6 знаков (как у USDT).
///         Эмиссия только через MINTER_ROLE (пулы, пресейл, AntiRUB).
contract ARUBToken is
    Initializable,
    ERC20Upgradeable,
    OwnableUpgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Максимальная эмиссия в единицах токена (6 decimals)
    uint256 public maxSupply;

    /// @notice Адрес оракула (совместим с IArubOracleForToken)
    address public oracle;

    // ------------------------------------------------------------------------
    //                                  INIT
    // ------------------------------------------------------------------------

    /// @dev UUPS initializer
    function initialize(uint256 _maxSupply) public initializer {
        __ERC20_init("AntiRUB", "ARUB");
        __Ownable_init(msg.sender);
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        maxSupply = _maxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    // ------------------------------------------------------------------------
    //                              DECIMALS
    // ------------------------------------------------------------------------

    /// @notice ARUB использует 6 знаков (как USDT)
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------------------
    //                              ORACLE
    // ------------------------------------------------------------------------

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Zero oracle");
        oracle = _oracle;
    }

    /// @dev Берём курс из оракула. Допущение: rate > 0, stale-чек делает AntiRUB.
    function _rate() internal view returns (uint256) {
        require(oracle != address(0), "Oracle not set");
        (bool ok, bytes memory data) =
            oracle.staticcall(abi.encodeWithSelector(IArubOracleForToken.getRate.selector));
        require(ok && data.length >= 64, "Oracle call failed");

        (uint256 rate, ) = abi.decode(data, (uint256, uint256));
        require(rate > 0, "Rate=0");
        return rate;
    }

    // ------------------------------------------------------------------------
    //                              MINT / BURN
    // ------------------------------------------------------------------------

    /// @notice Минт под интерфейс IArubToken (AntiRUB)
    function mintTo(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        require(totalSupply() + amount <= maxSupply, "Max supply exceeded");
        _mint(to, amount);
    }

    /// @notice Минт под интерфейс IARUBToken (Presale)
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        mintTo(to, amount);
    }

    /// @notice Стандартный burn() — сжигает свои собственные токены
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burn под AntiRUB (IArubToken.burnFrom)
    /// @dev Учитывает allowance, если жжём чужие токены
    function burnFrom(address account, uint256 amount) public {
        if (account != msg.sender) {
            uint256 currentAllowance = allowance(account, msg.sender);
            require(currentAllowance >= amount, "Insufficient allowance");
            _approve(account, msg.sender, currentAllowance - amount);
        }
        _burn(account, amount);
    }

    /// @notice Burn под интерфейс IARUBToken (Presale)
    function burn(address from, uint256 amount) external {
        burnFrom(from, amount);
    }

    /// @notice Изменить maxSupply (на случай governance-решений)
    function setMaxSupply(uint256 newMax) external onlyOwner {
        maxSupply = newMax;
    }

    // ------------------------------------------------------------------------
    //                         PRICE CONVERSION HELPERS
    // ------------------------------------------------------------------------
    //
    // Принято:
    //  - usdtAmount: 6 decimals
    //  - arubAmount: 6 decimals
    //  - rate: 1e6 (пример: 82_000_000 → 1 ARUB = 82 USDT)
    //
    // 1 ARUB = rate / 1e6 USDT
    //
    // => arub = usdt * 1e6 / rate
    //    usdt = arub * rate / 1e6

    /// @notice input: USDT 6 dec, output: ARUB 6 dec
    function calculateArubAmount(uint256 usdtAmount) external view returns (uint256) {
        uint256 rate = _rate(); // 1e6
        return (usdtAmount * 1_000_000) / rate;
    }

    /// @notice input: ARUB 6 dec, output: USDT 6 dec
    function calculateUsdtAmount(uint256 arubAmount) external view returns (uint256) {
        uint256 rate = _rate(); // 1e6
        return (arubAmount * rate) / 1_000_000;
    }

    // ------------------------------------------------------------------------
    //                               UUPS
    // ------------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
