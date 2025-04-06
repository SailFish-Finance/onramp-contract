require("dotenv").config();

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const adminAddress = await deployer.getAddress();
  // const oracleAddress = "0xe5301c31445f1392fBAdF04a404857587D142c95";
  const oracleAddress = "0xb80a2820eD522878504D9B46245D1112b2eFf3D9";
  const SailFishPredictionV2 = await ethers.getContractFactory(
    "SailFishPredictionV2"
  );

  const predictionContract = await SailFishPredictionV2.deploy(
    oracleAddress, //_oracleAddress
    adminAddress, // _adminAddress
    adminAddress, // _operatorAddress
    300, // _intervalSeconds (300sec ~ 5 mins)
    60, //_bufferSeconds
    ethers.parseEther("5"), // _minBetAmount 5 EDU
    300, //_oracleUpdateAllowance in seconds
    300 //_treasuryFee
  );
  await predictionContract.waitForDeployment();

  const predictionAddress = await predictionContract.getAddress();

  console.log("Prediction Contract Address deployed to: ", predictionAddress);
}

main();

//npx hardhat run scripts/deploy-prediction-v2.js --network educhain

// npx hardhat verify 0x78F948BeC290213b96BE65F0CCfc54d6A45C2047 0xb80a2820eD522878504D9B46245D1112b2eFf3D9 0xb31799Bd84E1731F186AaBb2BDFEb0fe3818e480 0xb31799Bd84E1731F186AaBb2BDFEb0fe3818e480  300 30 5000000000000000000 300 300 --network educhain
