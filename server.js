// server.js

// Imports for server and Web3 interactions
const express = require('express');
const bodyParser = require('body-parser');
const Web3 = require('web3');
const config = require('./config.json'); // Load configuration

// --- CONFIGURATION AND INITIALIZATION ---

// CRITICAL: Load sensitive data from environment variables
const walletPrivateKey = process.env.WALLET_PRIVATE_KEY;
const infuraProjectId = process.env.INFURA_PROJECT_ID || config.infuraProjectId;

// Ensure critical configuration is available
if (!walletPrivateKey || !infuraProjectId) {
  console.error("FATAL: WALLET_PRIVATE_KEY or INFURA_PROJECT_ID environment variables are missing.");
  process.exit(1);
}

// Initialize Web3 provider connection
const infuraUrl = `https://mainnet.infura.io/v3/${infuraProjectId}`;
const web3 = new Web3(infuraUrl);

// Add wallet to Web3 context for transaction signing
try {
  web3.eth.accounts.wallet.add(walletPrivateKey);
} catch (e) {
  console.error("FATAL: Invalid WALLET_PRIVATE_KEY format.");
  process.exit(1);
}

const myWalletAddress = web3.eth.accounts.wallet[0].address;

// Initialize cETH Contract
const cEthAddress = config.cEthAddress;
// NOTE: cEthAbi is assumed to be correctly loaded from config.json or another file
const cEthAbi = config.cEthAbi; 
const cEthContract = new web3.eth.Contract(cEthAbi, cEthAddress);
const cTokenDecimals = config.cTokenDecimals;

const app = express();
const port = 3000;

// Middleware setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Centralized error handling function for API responses
const handleError = (res, endpoint, error) => {
  console.error(`[${endpoint}] Transaction/Call Error:`, error.message || error);
  // Return a 500 status for internal/blockchain errors, not 400 (Bad Request)
  return res.status(500).send({ error: 'Internal server or blockchain error occurred.' });
};

// --- API ENDPOINTS ---

/**
 * @route GET /protocol-balance/eth/
 * @description Fetches the underlying ETH balance supplied to the Compound protocol.
 */
app.get('/protocol-balance/eth/', (req, res) => {
  cEthContract.methods.balanceOfUnderlying(myWalletAddress).call()
    .then((result) => {
      // Convert balance from Wei (for ETH) to Ether
      const balanceOfUnderlying = web3.utils.fromWei(result, 'ether');
      return res.json({ eth_supplied: balanceOfUnderlying });
    })
    .catch((error) => handleError(res, 'protocol-balance', error));
});

/**
 * @route GET /wallet-balance/eth/
 * @description Fetches the native ETH balance in the wallet.
 */
app.get('/wallet-balance/eth/', (req, res) => {
  web3.eth.getBalance(myWalletAddress)
    .then((result) => {
      // Convert balance from Wei to Ether
      const ethBalance = web3.utils.fromWei(result, 'ether');
      return res.json({ eth_wallet: ethBalance });
    })
    .catch((error) => handleError(res, 'wallet-balance', error));
});

/**
 * @route GET /wallet-balance/ceth/
 * @description Fetches the cETH token balance in the wallet.
 */
app.get('/wallet-balance/ceth/', (req, res) => {
  cEthContract.methods.balanceOf(myWalletAddress).call()
    .then((result) => {
      // Convert cToken balance using its specific decimals (usually 8)
      // Use BigInt for safe math with large numbers.
      const rawBalance = BigInt(result);
      const divisor = BigInt(10) ** BigInt(cTokenDecimals);
      const cTokenBalance = Number(rawBalance) / Number(divisor);
      
      return res.json({ ceth_wallet: cTokenBalance.toString() });
    })
    .catch((error) => handleError(res, 'wallet-ctoken-balance', error));
});

/**
 * @route GET /supply/eth/:amount
 * @description Supplies ETH to the Compound protocol (mints cETH).
 * @param {string} amount - The amount of ETH to supply.
 */
app.get('/supply/eth/:amount', async (req, res) => {
  const amountEth = req.params.amount;
  if (isNaN(amountEth) || parseFloat(amountEth) <= 0) {
    return res.status(400).send({ error: 'Invalid ETH amount provided.' });
  }

  try {
    const valueWei = web3.utils.toWei(amountEth, 'ether');
    const from = myWalletAddress;

    // 1. Estimate Gas Limit for safe transaction execution
    const estimatedGas = await cEthContract.methods.mint().estimateGas({ from, value: valueWei });
    const gasLimit = BigInt(estimatedGas) + (BigInt(estimatedGas) / BigInt(10)); // Add 10% buffer

    // 2. Get current Gas Price from the network
    const gasPrice = await web3.eth.getGasPrice(); 

    const tx = await cEthContract.methods.mint().send({
      from,
      gasLimit: web3.utils.toHex(gasLimit),
      gasPrice: web3.utils.toHex(gasPrice),
      value: web3.utils.toHex(valueWei)
    });

    return res.status(200).json({ status: 'Supply successful', transactionHash: tx.transactionHash });

  } catch (error) {
    return handleError(res, 'supply', error);
  }
});

/**
 * @route GET /redeem/eth/:cTokenAmount
 * @description Redeems cETH for underlying ETH.
 * @param {string} cTokenAmount - The amount of cTokens to redeem (in human-readable format).
 */
app.get('/redeem/eth/:cTokenAmount', async (req, res) => {
  const amountCToken = req.params.cTokenAmount;
  if (isNaN(amountCToken) || parseFloat(amountCToken) <= 0) {
    return res.status(400).send({ error: 'Invalid cToken amount provided.' });
  }

  try {
    // Convert human-readable cToken amount to the contract's base unit (e.g., * 1e8)
    const amountToRedeem = BigInt(Math.floor(parseFloat(amountCToken) * (10 ** cTokenDecimals)));
    const from = myWalletAddress;

    // 1. Estimate Gas Limit
    const estimatedGas = await cEthContract.methods.redeem(amountToRedeem.toString()).estimateGas({ from });
    const gasLimit = BigInt(estimatedGas) + (BigInt(estimatedGas) / BigInt(10)); // Add 10% buffer

    // 2. Get current Gas Price
    const gasPrice = await web3.eth.getGasPrice();

    const tx = await cEthContract.methods.redeem(amountToRedeem.toString()).send({
      from,
      gasLimit: web3.utils.toHex(gasLimit),
      gasPrice: web3.utils.toHex(gasPrice)
    });

    return res.status(200).json({ status: 'Redeem successful', transactionHash: tx.transactionHash });

  } catch (error) {
    return handleError(res, 'redeem', error);
  }
});

// Start the Express server
app.listen(port, () => console.log(`API server running on port ${port}`));
