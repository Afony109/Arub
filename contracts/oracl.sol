// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArubOracle
/// @notice Простой оракул: хранит курс USD/RUB (== цена 1 ARUB в USDT) * 1e6.
///         Совместим с IArubOracle и IArubOracleForToken.
contract ArubOracle {
    uint256 public rate;        // USD/RUB * 1e6  (например 92_000_000)
    uint256 public updatedAt;   // timestamp последнего обновления

    address public owner;

    event RateUpdated(uint256 rate, uint256 updatedAt);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    constructor(uint256 initialRate) {
        require(initialRate > 0, "rate=0");
        owner = msg.sender;
        rate = initialRate;
        updatedAt = block.timestamp;
        emit RateUpdated(initialRate, block.timestamp);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Устанавливает новый курс (USD/RUB * 1e6)
    function setRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "rate=0");
        rate = newRate;
        updatedAt = block.timestamp;
        emit RateUpdated(newRate, block.timestamp);
    }

    /// @notice Совместимо с IArubOracle.usdRub()
    function usdRub() external view returns (uint256) {
        return rate;
    }

    /// @notice Совместимо с IArubOracle.getRate() / IArubOracleForToken.getRate()
    function getRate() external view returns (uint256, uint256) {
        return (rate, updatedAt);
    }

    /// @notice Опциональная функция, если где-то использовалось currentRate()
    function currentRate() external view returns (uint256) {
        return rate;
    }
}
