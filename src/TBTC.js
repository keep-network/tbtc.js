import { DepositFactory } from "./Deposit.js"
import BitcoinHelpers from "./BitcoinHelpers.js"
import BN from "bn.js"
/** @typedef { import("./BitcoinHelpers.js").BitcoinNetwork } BitcoinNetwork


/**
 * @typedef {Object} TBTCConfig
 * @prop {BitcoinNetwork} bitcoinNetwork
 * @prop {Web3} web3
 */

/** @type {TBTCConfig} */
const defaultConfig = {
  bitcoinNetwork: BitcoinHelpers.Network.TESTNET,
  web3: global.Web3
}

/**
 * @param {Web3} web3
 */
function isMainnet(web3) {
  return web3.currentProvider["chainId"] == 0x1
}
/**
 * @param {Web3} web3
 */
function isTestnet(web3) {
  return !isMainnet(web3)
}

export class TBTC {
  static async withConfig(config = defaultConfig, networkMatchCheck = true) {
    const depositFactory = await DepositFactory.withConfig(config)

    return new TBTC(depositFactory, config, networkMatchCheck)
  }

  /**
   *
   * @param {DepositFactory} depositFactory
   * @param {TBTCConfig} config
   * @param {boolean} networkMatchCheck
   */
  constructor(depositFactory, config, networkMatchCheck = true) {
    if (
      networkMatchCheck &&
      ((isMainnet(config.web3) &&
        config.bitcoinNetwork == BitcoinHelpers.Network.TESTNET) ||
        (isTestnet(config.web3) &&
          config.bitcoinNetwork == BitcoinHelpers.Network.MAINNET))
    ) {
      throw new Error(
        `Ethereum network ${config.web3.currentProvider.chainId} ` +
          `and Bitcoin network ${config.bitcoinNetwork} are not both ` +
          `on testnet or both on  mainnet. Quitting while we're ` +
          `ahead. Developers can also pass false as the ` +
          `networkMatchCheck parameter to suppress this error.`
      )
    }

    /** @package */
    this.depositFactory = depositFactory
    /** @package */
    this.config = config

    this.satoshisPerTbtc = new BN(10).pow(new BN(10))
  }

  get Deposit() /* : DepositFactory*/ {
    return this.depositFactory
  }
}

export default {
  /**
   * @param {TBTCConfig} config
   * @param {boolean} networkMatchCheck
   */
  withConfig: async (config, networkMatchCheck = true) => {
    return await TBTC.withConfig(config, networkMatchCheck)
  },
  BitcoinNetwork: BitcoinHelpers.Network
}
