import BN from "bn.js"
/** @typedef { import("web3").default } Web3 */

import BitcoinHelpers from "./BitcoinHelpers.js"
/** @typedef { import("./BitcoinHelpers.js").BitcoinNetwork } BitcoinNetwork */
import EthereumHelpers from "./EthereumHelpers.js"

import { DepositFactory } from "./Deposit.js"
import { Constants } from "./Constants.js"

import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"

/**
 * @typedef {Object} TBTCConfig
 * @prop {BitcoinNetwork} bitcoinNetwork
 * @prop {Web3} web3
 */

/**
 * The entry point to the TBTC system. Call `TBTC.withConfig()` and pass the
 * appropriate configuration object with web3, Bitcoin network, and Electrum
 * information to receive an initialized instance of the `TBTC` class. The class
 * then exposes two properties, `Deposit` and `Constants`. `Deposit` is a
 * factory object for looking up and creating deposits, while `Constants` allows
 * direct access to tBTC system constants.
 */
export class TBTC {
  /**
   *
   * @param {TBTCConfig} config The configuration to use for this instance.
   * @param {boolean} [networkMatchCheck=true] When true, ensures that the
   *        configured Bitcoin and Ethereum networks are either both mainnet or
   *        both testnet.
   */
  static async withConfig(config, networkMatchCheck = true) {
    const ethereumMainnet = await EthereumHelpers.isMainnet(config.web3)
    const bitcoinMainnet =
      config.bitcoinNetwork == BitcoinHelpers.Network.MAINNET

    if (
      networkMatchCheck &&
      ((ethereumMainnet && !bitcoinMainnet) ||
        (!ethereumMainnet && bitcoinMainnet))
    ) {
      throw new Error(
        `Ethereum network ${await config.web3.eth.getChainId()} ` +
          `and Bitcoin network ${config.bitcoinNetwork} are not both ` +
          `on testnet or both on  mainnet. Quitting while we're ` +
          `ahead. Developers can also pass false as the ` +
          `networkMatchCheck parameter to suppress this error.`
      )
    }

    const depositFactory = await DepositFactory.withConfig(config)
    const constants = await Constants.withConfig(config)
    return new TBTC(depositFactory, constants, config)
  }

  /**
   *
   * @param {DepositFactory} depositFactory
   * @param {Constants} constants
   * @param {TBTCConfig} config
   */
  constructor(depositFactory, constants, config) {
    /** @package */
    this.depositFactory = depositFactory
    /** @package */
    this.constants = constants
    /** @package */
    this.config = config

    this.satoshisPerTbtc = new BN(10).pow(new BN(10))
  }

  /** @return {DepositFactory} */
  get Deposit() {
    return this.depositFactory
  }

  /** @return {Constants} */
  get Constants() {
    return this.constants
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

/**
 * Returns the network ID from the artifact.
 * Artifacts from @keep-network/tbtc for a given build only support a single
 * network id.
 *
 * @return {string} network ID
 */
export const getNetworkIdFromArtifact = () => {
  return Object.keys(TBTCSystemJSON.networks)[0]
}
