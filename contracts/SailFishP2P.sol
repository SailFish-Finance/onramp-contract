// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SailFishP2P
 * @dev A P2P escrow contract for EDU token trading on EDUCHAIN
 * Allows merchants to create ads to sell EDU tokens for fiat currencies
 * Manages the escrow process and dispute resolution
 */
contract SailFishP2P {
    // Struct definitions
    struct Merchant {
        bool isApproved;
        bool isFrozen;
        uint256 totalBalance;
    }

    struct Ad {
        uint256 id;
        address merchant;
        bool isSellAd;
        uint256 rate; // Rate per EDU in fiat (scaled by 1e6)
        uint256 amount; // Total amount of EDU
        uint256 minAmount; // Minimum order amount
        uint256 maxAmount; // Maximum order amount
        string fiatCurrency; // ISO 4217 currency code
        bool isActive;
        bool isPaused;
        uint256 remainingBalance;
    }

    enum OrderStatus {
        CREATED,
        ACCEPTED,
        APPROVED,
        COMPLETED,
        DISPUTED,
        CANCELLED
    }

    struct Order {
        uint256 id;
        uint256 adId;
        address buyer;
        uint256 amount;
        OrderStatus status;
        uint256 approvalTimestamp;
        bool buyerApprovedDispute;
        bool merchantApprovedDispute;
        uint256 timestamp;
    }

    // State variables
    address public admin;
    mapping(address => Merchant) public merchants;
    mapping(uint256 => Ad) public ads;
    mapping(uint256 => Order) public orders;
    mapping(uint256 => uint256[]) public adOrders; // Ad ID => Order IDs

    uint256[] public approvedOrderIds;
    mapping(uint256 => uint256) public approvedOrderIndexes;
    
    uint256 public totalEDUTransacted;
    uint256 public nextAdId = 1;
    uint256 public nextOrderId = 1;
    uint256 public challengePeriod = 30 minutes;
    
    // Events
    event MerchantApproved(address indexed merchant);
    event MerchantFrozen(address indexed merchant, bool isFrozen);
    
    event AdCreated(uint256 indexed adId, address indexed merchant, bool isSellAd, uint256 amount, string fiatCurrency);
    event AdPaused(uint256 indexed adId, bool isPaused);
    event AdClosed(uint256 indexed adId, uint256 refundedAmount);
    
    event OrderCreated(uint256 indexed orderId, uint256 indexed adId, address indexed buyer, uint256 amount);
    event OrderAccepted(uint256 indexed orderId, uint256 indexed adId);
    event OrderApproved(uint256 indexed orderId, uint256 approvalTimestamp);
    event OrderDisputed(uint256 indexed orderId);
    event OrderCompleted(uint256 indexed orderId, uint256 amount);
    event OrderCancelled(uint256 indexed orderId);
    event DisputeApproved(uint256 indexed orderId, address indexed approver);
    event DisputeResolved(uint256 indexed orderId, address indexed winner);
    
    event EDUDeposited(address indexed merchant, uint256 amount);
    event EDUWithdrawn(address indexed recipient, uint256 amount);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // Modifiers
    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can call this function");
        _;
    }

    modifier onlyApprovedMerchant() {
        require(merchants[msg.sender].isApproved, "Merchant not approved");
        require(!merchants[msg.sender].isFrozen, "Merchant is frozen");
        _;
    }

    modifier onlyAdOwner(uint256 adId) {
        require(ads[adId].merchant == msg.sender, "Not the ad owner");
        _;
    }

    modifier orderExists(uint256 orderId) {
        require(orders[orderId].id == orderId, "Order does not exist");
        _;
    }

    modifier onlyBuyer(uint256 orderId) {
        require(orders[orderId].buyer == msg.sender, "Not the order buyer");
        _;
    }

    // Constructor
    constructor() {
        admin = msg.sender;
    }

    // Receive function to accept native EDU
    receive() external payable {
        // Only accept payments from approved merchants for now
        require(merchants[msg.sender].isApproved, "Only approved merchants can send EDU");
        merchants[msg.sender].totalBalance += msg.value;
        emit EDUDeposited(msg.sender, msg.value);
    }

    // Admin functions
    function approveMerchant(address merchant) external onlyAdmin {
        require(!merchants[merchant].isApproved, "Merchant already approved");
        merchants[merchant].isApproved = true;
        emit MerchantApproved(merchant);
    }

    function setMerchantFreezeStatus(address merchant, bool freezeStatus) external onlyAdmin {
        require(merchants[merchant].isApproved, "Merchant not approved");
        require(merchants[merchant].isFrozen != freezeStatus, "Merchant freeze status already set");
        merchants[merchant].isFrozen = freezeStatus;
        emit MerchantFrozen(merchant, freezeStatus);
    }

    function setChallengePeriod(uint256 newPeriod) external onlyAdmin {
        require(newPeriod > 0, "Challenge period must be greater than 0");
        challengePeriod = newPeriod;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "New admin cannot be zero address");
        require(newAdmin != admin, "New admin is the same as current admin");
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    function resolveDispute(uint256 orderId, address winner) external onlyAdmin orderExists(orderId) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.DISPUTED, "Order not in disputed state");
        require(winner == order.buyer || winner == ads[order.adId].merchant, "Invalid winner address");

        if (winner == order.buyer) {
            // Transfer funds to buyer
            _transferEDU(order.buyer, order.amount);
            order.status = OrderStatus.COMPLETED;
            emit OrderCompleted(orderId, order.amount);
        } else {
            // Return funds to merchant's balance
            Ad storage ad = ads[order.adId];
            ad.remainingBalance += order.amount;
            merchants[ad.merchant].totalBalance += order.amount;
            order.status = OrderStatus.CANCELLED;
            emit OrderCancelled(orderId);
        }

        emit DisputeResolved(orderId, winner);
    }

    // Merchant functions
    function createAd(
        bool isSellAd,
        uint256 rate,
        uint256 amount,
        uint256 minAmount,
        uint256 maxAmount,
        string calldata fiatCurrency
    ) external payable onlyApprovedMerchant returns (uint256) {
        require(isSellAd == true, "Only sell ads are supported for now");
        require(rate > 0, "Rate must be greater than 0");
        require(amount > 0, "Amount must be greater than 0");
        require(minAmount > 0 && minAmount <= maxAmount, "Invalid min/max amount");
        require(maxAmount <= amount, "Max amount cannot exceed total amount");
        require(bytes(fiatCurrency).length == 3, "Invalid currency code format");

        // For sell ads, merchant must deposit EDU
        require(msg.value == amount, "Deposit amount must match ad amount");

        uint256 adId = nextAdId++;
        ads[adId] = Ad({
            id: adId,
            merchant: msg.sender,
            isSellAd: isSellAd,
            rate: rate,
            amount: amount,
            minAmount: minAmount,
            maxAmount: maxAmount,
            fiatCurrency: fiatCurrency,
            isActive: true,
            isPaused: false,
            remainingBalance: amount
        });

        // Update merchant balance
        merchants[msg.sender].totalBalance += amount;

        emit AdCreated(adId, msg.sender, isSellAd, amount, fiatCurrency);
        return adId;
    }

    function pauseAd(uint256 adId) external onlyApprovedMerchant onlyAdOwner(adId) {
        Ad storage ad = ads[adId];
        require(ad.isActive, "Ad is not active");
        require(ad.isPaused != true, "Ad is already paused");
        
        ad.isPaused = true;
        emit AdPaused(adId, true);
    }

    function unpauseAd(uint256 adId) external onlyApprovedMerchant onlyAdOwner(adId) {
        Ad storage ad = ads[adId];
        require(ad.isActive, "Ad is not active");
        require(ad.isPaused != false, "Ad is already unpaused");
        
        ad.isPaused = false;
        emit AdPaused(adId, false);
    }

    function closeAd(uint256 adId) external onlyApprovedMerchant onlyAdOwner(adId) {
        Ad storage ad = ads[adId];
        require(ad.isActive, "Ad is not active");
        
        uint256 refundAmount = ad.remainingBalance;
        require(refundAmount > 0, "No balance to refund");
        
        // Update ad state
        ad.isActive = false;
        ad.remainingBalance = 0;
        
        // Update merchant balance
        merchants[msg.sender].totalBalance -= refundAmount;
        
        // Transfer refund to merchant
        _transferEDU(msg.sender, refundAmount);
        
        emit AdClosed(adId, refundAmount);
    }

    function acceptOrder(uint256 orderId) external onlyApprovedMerchant orderExists(orderId) {
        Order storage order = orders[orderId];
        uint256 adId = order.adId;
        
        require(ads[adId].merchant == msg.sender, "Not the ad owner");
        require(order.status == OrderStatus.CREATED, "Order not in created state");
        require(ads[adId].isActive && !ads[adId].isPaused, "Ad not active or paused");
        
        // Check if there's enough balance
        require(ads[adId].remainingBalance >= order.amount, "Insufficient ad balance");
        
        // Update ad balance
        ads[adId].remainingBalance -= order.amount;
        
        // Update order status
        order.status = OrderStatus.ACCEPTED;
        
        emit OrderAccepted(orderId, adId);
    }

    function approveOrderCompletion(uint256 orderId) external onlyApprovedMerchant orderExists(orderId) {
        Order storage order = orders[orderId];
        uint256 adId = order.adId;
        
        require(ads[adId].merchant == msg.sender, "Not the ad owner");
        require(order.status == OrderStatus.ACCEPTED, "Order not in accepted state");
        
        // Start challenge period
        order.status = OrderStatus.APPROVED;
        order.approvalTimestamp = block.timestamp;
        
        // Add to approved orders array
        _addToApprovedOrders(orderId);
        
        emit OrderApproved(orderId, order.approvalTimestamp);
    }

    function approveDisputedOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.DISPUTED, "Order not in disputed state");
        
        if (msg.sender == order.buyer) {
            require(!order.buyerApprovedDispute, "Buyer already approved");
            order.buyerApprovedDispute = true;
            emit DisputeApproved(orderId, msg.sender);
        } else if (msg.sender == ads[order.adId].merchant) {
            require(!order.merchantApprovedDispute, "Merchant already approved");
            order.merchantApprovedDispute = true;
            emit DisputeApproved(orderId, msg.sender);
        } else {
            revert("Not authorized");
        }
        
        // If both approved, complete the order
        if (order.buyerApprovedDispute && order.merchantApprovedDispute) {
            // Transfer funds to buyer
            _transferEDU(order.buyer, order.amount);
            
            // Update order status
            order.status = OrderStatus.COMPLETED;
            
            // Update total transacted
            totalEDUTransacted += order.amount;
            
            emit OrderCompleted(orderId, order.amount);
        }
    }

    // User functions
    function createOrder(uint256 adId, uint256 amount) external returns (uint256) {
        Ad storage ad = ads[adId];
        require(ad.isActive && !ad.isPaused, "Ad not active or paused");
        require(ad.merchant != msg.sender, "Cannot create order for own ad");
        require(amount >= ad.minAmount && amount <= ad.maxAmount, "Amount outside allowed range");
        require(amount <= ad.remainingBalance, "Insufficient ad balance");
        
        uint256 orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            adId: adId,
            buyer: msg.sender,
            amount: amount,
            status: OrderStatus.CREATED,
            approvalTimestamp: 0,
            buyerApprovedDispute: false,
            merchantApprovedDispute: false,
            timestamp: block.timestamp
        });
        
        // Add to ad orders
        adOrders[adId].push(orderId);
        
        emit OrderCreated(orderId, adId, msg.sender, amount);
        return orderId;
    }

    function disputeOrder(uint256 orderId) external onlyBuyer(orderId) orderExists(orderId) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.APPROVED, "Order not in approved state");
        require(block.timestamp <= order.approvalTimestamp + challengePeriod, "Challenge period expired");
        
        // Update order status
        order.status = OrderStatus.DISPUTED;
        
        // Remove from approved orders
        _removeFromApprovedOrders(orderId);
        
        emit OrderDisputed(orderId);
    }

    // System functions
    function finalizeOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.APPROVED, "Order not in approved state");
        require(block.timestamp > order.approvalTimestamp + challengePeriod, "Challenge period not expired");
        
        _finalizeOrder(orderId);
    }

    function finalizeExpiredOrders(uint256 batchSize) external {
        uint256 processedCount = 0;
        uint256 i = 0;
        
        while (i < approvedOrderIds.length && processedCount < batchSize) {
            uint256 orderId = approvedOrderIds[i];
            Order storage order = orders[orderId];
            
            if (block.timestamp > order.approvalTimestamp + challengePeriod) {
                // Order challenge period has expired, finalize it
                // Note: We don't increment i here because _finalizeOrder will remove the item from the array
                _finalizeOrder(orderId);
                processedCount++;
            } else {
                // This order is still in challenge period, move to next
                i++;
            }
        }
    }

    // View functions
    function getMerchantBalance(address merchant) external view returns (uint256) {
        return merchants[merchant].totalBalance;
    }

    function getAdBalance(uint256 adId) external view returns (uint256) {
        return ads[adId].remainingBalance;
    }

    function getTotalActiveAdsBalance() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 1; i < nextAdId; i++) {
            if (ads[i].isActive && !ads[i].isPaused) {
                total += ads[i].remainingBalance;
            }
        }
        return total;
    }

    function getAdOrders(uint256 adId) external view returns (uint256[] memory) {
        return adOrders[adId];
    }

    function getApprovedOrders() external view returns (uint256[] memory) {
        return approvedOrderIds;
    }

    function isOrderInChallengePeriod(uint256 orderId) external view orderExists(orderId) returns (bool) {
        Order storage order = orders[orderId];
        return (
            order.status == OrderStatus.APPROVED &&
            block.timestamp <= order.approvalTimestamp + challengePeriod
        );
    }

    // Internal functions
    function _transferEDU(address recipient, uint256 amount) internal {
        (bool success, ) = payable(recipient).call{value: amount}("");
        require(success, "EDU transfer failed");
    }

    function _addToApprovedOrders(uint256 orderId) internal {
        approvedOrderIds.push(orderId);
        approvedOrderIndexes[orderId] = approvedOrderIds.length - 1;
    }

    function _removeFromApprovedOrders(uint256 orderId) internal {
        uint256 index = approvedOrderIndexes[orderId];
        uint256 lastIndex = approvedOrderIds.length - 1;
        
        if (index != lastIndex) {
            uint256 lastOrderId = approvedOrderIds[lastIndex];
            approvedOrderIds[index] = lastOrderId;
            approvedOrderIndexes[lastOrderId] = index;
        }
        
        approvedOrderIds.pop();
        delete approvedOrderIndexes[orderId];
    }

    function _finalizeOrder(uint256 orderId) internal {
        Order storage order = orders[orderId];
        
        // Transfer funds to buyer
        _transferEDU(order.buyer, order.amount);
        
        // Update order status
        order.status = OrderStatus.COMPLETED;
        
        // Update total transacted
        totalEDUTransacted += order.amount;
        
        // Remove from approved orders
        _removeFromApprovedOrders(orderId);
        
        emit OrderCompleted(orderId, order.amount);
    }
}
