const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("SailFishP2P", function () {
  let sailFishP2P;
  let admin;
  let merchant;
  let buyer;
  let other;
  let adId;

  // Constants for testing
  const RATE = ethers.parseUnits("1000", 6); // 1000 units of fiat per EDU
  const AMOUNT = ethers.parseEther("10"); // 10 EDU
  const MIN_AMOUNT = ethers.parseEther("1"); // 1 EDU
  const MAX_AMOUNT = ethers.parseEther("5"); // 5 EDU
  const ORDER_AMOUNT = ethers.parseEther("2"); // 2 EDU
  const FIAT_CURRENCY = "USD";
  
  // Test helpers
  const createAd = async () => {
    // Merchant creates a sell ad
    const tx = await sailFishP2P.connect(merchant).createAd(
      true, // isSellAd
      RATE,
      AMOUNT,
      MIN_AMOUNT,
      MAX_AMOUNT,
      FIAT_CURRENCY,
      { value: AMOUNT } // Send EDU with the transaction
    );
    
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "AdCreated"
    );
    
    return event.args.adId;
  };

  beforeEach(async function () {
    // Get signers
    [admin, merchant, buyer, other] = await ethers.getSigners();

    // Deploy the contract
    const SailFishP2P = await ethers.getContractFactory("SailFishP2P");
    sailFishP2P = await SailFishP2P.deploy();

    // Approve the merchant
    await sailFishP2P.connect(admin).approveMerchant(merchant.address);
  });

  describe("Merchant Management", function () {
    it("Should allow admin to approve a merchant", async function () {
      // Verify the merchant is approved
      const merchantData = await sailFishP2P.merchants(merchant.address);
      expect(merchantData.isApproved).to.equal(true);
      expect(merchantData.isFrozen).to.equal(false);
    });

    it("Should allow admin to freeze a merchant", async function () {
      await sailFishP2P.connect(admin).setMerchantFreezeStatus(merchant.address, true);
      
      // Verify the merchant is frozen
      const merchantData = await sailFishP2P.merchants(merchant.address);
      expect(merchantData.isApproved).to.equal(true);
      expect(merchantData.isFrozen).to.equal(true);
    });

    it("Should prevent frozen merchants from creating ads", async function () {
      // Freeze the merchant
      await sailFishP2P.connect(admin).setMerchantFreezeStatus(merchant.address, true);
      
      // Try to create an ad
      await expect(
        sailFishP2P.connect(merchant).createAd(
          true,
          RATE,
          AMOUNT,
          MIN_AMOUNT,
          MAX_AMOUNT,
          FIAT_CURRENCY,
          { value: AMOUNT }
        )
      ).to.be.revertedWith("Merchant is frozen");
    });

    it("Should allow admin to transfer admin rights", async function () {
      // Transfer admin rights to another address
      await sailFishP2P.connect(admin).transferAdmin(other.address);
      
      // Verify the new admin
      expect(await sailFishP2P.admin()).to.equal(other.address);
      
      // Verify the old admin can no longer perform admin functions
      await expect(
        sailFishP2P.connect(admin).approveMerchant(merchant.address)
      ).to.be.revertedWith("Only admin can call this function");
      
      // Verify the new admin can perform admin functions
      const newMerchantAddress = buyer.address; // Using buyer as a new merchant for this test
      await sailFishP2P.connect(other).approveMerchant(newMerchantAddress);
      
      // Verify the new merchant is approved
      const newMerchantData = await sailFishP2P.merchants(newMerchantAddress);
      expect(newMerchantData.isApproved).to.equal(true);
    });
  });

  describe("Ad Management", function () {
    it("Should allow merchant to create a sell ad", async function () {
      // Create a sell ad
      adId = await createAd();
      
      // Verify the ad properties
      const ad = await sailFishP2P.ads(adId);
      expect(ad.merchant).to.equal(merchant.address);
      expect(ad.isSellAd).to.equal(true);
      expect(ad.rate).to.equal(RATE);
      expect(ad.amount).to.equal(AMOUNT);
      expect(ad.minAmount).to.equal(MIN_AMOUNT);
      expect(ad.maxAmount).to.equal(MAX_AMOUNT);
      expect(ad.fiatCurrency).to.equal(FIAT_CURRENCY);
      expect(ad.isActive).to.equal(true);
      expect(ad.isPaused).to.equal(false);
      expect(ad.remainingBalance).to.equal(AMOUNT);
    });

    it("Should allow merchant to pause and unpause an ad", async function () {
      // Create a sell ad
      adId = await createAd();
      
      // Pause the ad
      await sailFishP2P.connect(merchant).pauseAd(adId);
      
      // Verify the ad is paused
      let ad = await sailFishP2P.ads(adId);
      expect(ad.isPaused).to.equal(true);
      
      // Unpause the ad
      await sailFishP2P.connect(merchant).unpauseAd(adId);
      
      // Verify the ad is unpaused
      ad = await sailFishP2P.ads(adId);
      expect(ad.isPaused).to.equal(false);
    });

    it("Should allow merchant to close an ad and get refund", async function () {
      // Create a sell ad
      adId = await createAd();
      
      // Get merchant's initial balance
      const initialBalance = await ethers.provider.getBalance(merchant.address);
      
      // Close the ad
      const tx = await sailFishP2P.connect(merchant).closeAd(adId);
      
      // Calculate the gas cost
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * tx.gasPrice;
      
      // Verify the ad is closed
      const ad = await sailFishP2P.ads(adId);
      expect(ad.isActive).to.equal(false);
      expect(ad.remainingBalance).to.equal(0);
      
      // Verify the merchant got the refund (considering gas costs)
      const finalBalance = await ethers.provider.getBalance(merchant.address);
      expect(finalBalance).to.be.closeTo(
        initialBalance + AMOUNT - gasCost,
        ethers.parseEther("0.01") // Allow for small rounding errors
      );
    });
  });

  describe("Order Processing", function () {
    beforeEach(async function () {
      // Create a sell ad for each test in this describe block
      adId = await createAd();
    });

    it("Should allow a user to create an order", async function () {
      // Create an order
      const tx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const receipt = await tx.wait();
      
      // Get order ID from event
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = event.args.orderId;
      
      // Verify the order properties
      const order = await sailFishP2P.orders(orderId);
      expect(order.adId).to.equal(adId);
      expect(order.buyer).to.equal(buyer.address);
      expect(order.amount).to.equal(ORDER_AMOUNT);
      expect(order.status).to.equal(0); // CREATED
    });

    it("Should allow merchant to accept an order", async function () {
      // Create an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      
      // Accept the order
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(1); // ACCEPTED
      
      // Verify the ad's remaining balance is reduced
      const ad = await sailFishP2P.ads(adId);
      expect(ad.remainingBalance).to.equal(AMOUNT - ORDER_AMOUNT);
    });

    it("Should allow merchant to approve order completion", async function () {
      // Create and accept an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      
      // Approve order completion
      const approveTx = await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      const approveReceipt = await approveTx.wait();
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(2); // APPROVED
      
      // Verify the order is in the approved orders array
      const approvedOrders = await sailFishP2P.getApprovedOrders();
      expect(approvedOrders).to.include(orderId);
    });

    it("Should allow user to dispute an order during challenge period", async function () {
      // Create, accept, and approve an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      
      // Dispute the order
      await sailFishP2P.connect(buyer).disputeOrder(orderId);
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(4); // DISPUTED
      
      // Verify the order is removed from approved orders array
      const approvedOrders = await sailFishP2P.getApprovedOrders();
      expect(approvedOrders).to.not.include(orderId);
    });

    it("Should finalize order after challenge period", async function () {
      // Create, accept, and approve an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      
      // Get buyer's initial balance
      const initialBalance = await ethers.provider.getBalance(buyer.address);
      
      // Fast forward time to after challenge period (30 minutes)
      await time.increase(1800 + 1);
      
      // Finalize the order
      await sailFishP2P.finalizeOrder(orderId);
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(3); // COMPLETED
      
      // Verify the buyer received the EDU
      const finalBalance = await ethers.provider.getBalance(buyer.address);
      expect(finalBalance).to.be.closeTo(
        initialBalance + ORDER_AMOUNT,
        ethers.parseEther("0.01") // Allow for small rounding errors
      );
      
      // Verify totalEDUTransacted is updated
      const totalEDUTransacted = await sailFishP2P.totalEDUTransacted();
      expect(totalEDUTransacted).to.equal(ORDER_AMOUNT);
    });

    it("Should allow admin to resolve a dispute", async function () {
      // Create, accept, approve, and dispute an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      await sailFishP2P.connect(buyer).disputeOrder(orderId);
      
      // Get buyer's initial balance
      const initialBalance = await ethers.provider.getBalance(buyer.address);
      
      // Admin resolves in favor of buyer
      await sailFishP2P.connect(admin).resolveDispute(orderId, buyer.address);
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(3); // COMPLETED
      
      // Verify the buyer received the EDU
      const finalBalance = await ethers.provider.getBalance(buyer.address);
      expect(finalBalance).to.be.closeTo(
        initialBalance + ORDER_AMOUNT,
        ethers.parseEther("0.01") // Allow for small rounding errors
      );
    });

    it("Should allow both parties to approve a disputed order", async function () {
      // Create, accept, approve, and dispute an order
      const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const createReceipt = await createTx.wait();
      const createEvent = createReceipt.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId = createEvent.args.orderId;
      await sailFishP2P.connect(merchant).acceptOrder(orderId);
      await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      await sailFishP2P.connect(buyer).disputeOrder(orderId);
      
      // Get buyer's initial balance
      const initialBalance = await ethers.provider.getBalance(buyer.address);
      
      // Both parties approve
      await sailFishP2P.connect(buyer).approveDisputedOrder(orderId);
      await sailFishP2P.connect(merchant).approveDisputedOrder(orderId);
      
      // Verify the order status
      const order = await sailFishP2P.orders(orderId);
      expect(order.status).to.equal(3); // COMPLETED
      
      // Verify the buyer received the EDU
      const finalBalance = await ethers.provider.getBalance(buyer.address);
      expect(finalBalance).to.be.closeTo(
        initialBalance + ORDER_AMOUNT,
        ethers.parseEther("0.01") // Allow for small rounding errors
      );
    });
  });

  describe("Batch Operations", function () {
    it("Should finalize multiple expired orders in batch", async function () {
      // Create multiple orders
      adId = await createAd();
      
      // Create and approve 3 orders
      const orderIds = [];
      for (let i = 0; i < 3; i++) {
        const createTx = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
        const createReceipt = await createTx.wait();
        const createEvent = createReceipt.logs.find(
          (log) => log.fragment && log.fragment.name === "OrderCreated"
        );
        const orderId = createEvent.args.orderId;
        orderIds.push(orderId);
        
        await sailFishP2P.connect(merchant).acceptOrder(orderId);
        await sailFishP2P.connect(merchant).approveOrderCompletion(orderId);
      }
      
      // Fast forward time to after challenge period
      await time.increase(1800 + 1);
      
      // Finalize orders in batch
      await sailFishP2P.finalizeExpiredOrders(10); // Process up to 10 orders
      
      // Verify all orders are completed
      for (const orderId of orderIds) {
        const order = await sailFishP2P.orders(orderId);
        expect(order.status).to.equal(3); // COMPLETED
      }
      
      // Verify approvedOrders array is empty
      const approvedOrders = await sailFishP2P.getApprovedOrders();
      expect(approvedOrders.length).to.equal(0);
      
      // Verify totalEDUTransacted is updated
      const totalEDUTransacted = await sailFishP2P.totalEDUTransacted();
      expect(totalEDUTransacted).to.equal(ORDER_AMOUNT * BigInt(3));
    });
  });

  describe("View Functions", function () {
    it("Should get merchant balance", async function () {
      // Create an ad
      adId = await createAd();
      
      // Verify merchant balance
      const balance = await sailFishP2P.getMerchantBalance(merchant.address);
      expect(balance).to.equal(AMOUNT);
    });

    it("Should get ad balance", async function () {
      // Create an ad
      adId = await createAd();
      
      // Verify ad balance
      const balance = await sailFishP2P.getAdBalance(adId);
      expect(balance).to.equal(AMOUNT);
    });

    it("Should get total active ads balance", async function () {
      // Create two ads
      const adId1 = await createAd();
      const adId2 = await createAd();
      
      // Verify total active ads balance
      const totalBalance = await sailFishP2P.getTotalActiveAdsBalance();
      expect(totalBalance).to.equal(AMOUNT * BigInt(2));
    });

    it("Should get ad orders", async function () {
      // Create an ad
      adId = await createAd();
      
      // Create two orders
      const createTx1 = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const receipt1 = await createTx1.wait();
      const event1 = receipt1.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId1 = event1.args.orderId;
      
      const createTx2 = await sailFishP2P.connect(buyer).createOrder(adId, ORDER_AMOUNT);
      const receipt2 = await createTx2.wait();
      const event2 = receipt2.logs.find(
        (log) => log.fragment && log.fragment.name === "OrderCreated"
      );
      const orderId2 = event2.args.orderId;
      
      // Verify ad orders
      const orders = await sailFishP2P.getAdOrders(adId);
      expect(orders).to.include(orderId1);
      expect(orders).to.include(orderId2);
      expect(orders.length).to.equal(2);
    });
  });
});
