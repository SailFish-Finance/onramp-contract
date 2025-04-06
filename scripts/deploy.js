// Deployment script for SailFishP2P contract
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying SailFishP2P contract...");
  console.log("Deployer address:", await deployer.getAddress());

  // Get the contract factory
  const SailFishP2P = await ethers.getContractFactory("SailFishP2P");

  // Deploy the contract
  const sailFishP2P = await SailFishP2P.deploy();

  // Wait for deployment to complete
  await sailFishP2P.waitForDeployment();

  // Get the contract address
  const sailFishP2PAddress = await sailFishP2P.getAddress();

  console.log("SailFishP2P deployed to:", sailFishP2PAddress);
  console.log("Admin address:", await sailFishP2P.admin());

  // Print deployment details for verification
  console.log("\nDeployment details for verification:");
  console.log("Network:", network.name);
  console.log("Contract address:", sailFishP2PAddress);
  console.log("Transaction hash:", sailFishP2P.deploymentTransaction().hash);

  console.log("\nVerify with:");
  console.log(
    `npx hardhat verify --network ${network.name} ${sailFishP2PAddress}`
  );
}

// Execute the deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
