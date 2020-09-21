import web3Utils from "web3-utils"
/** @typedef { import("bn.js") } BN */

import EthereumHelpers from "./EthereumHelpers.js"
/** @typedef { import("./EthereumHelpers.js").Contract } Contract */
/** @typedef { import("./EthereumHelpers.js").TruffleArtifact } TruffleArtifact */
/** @typedef { import("./TBTC.js").TBTCConfig } TBTCConfig */

import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"

const { toBN } = web3Utils

/**
 * The constants resolved from on-chain via the constants contract.
 * @typedef {object} ConstantFields
 * @property {BN} BENEFICIARY_REWARD_DIVISOR
 * @property {BN} SATOSHI_MULTIPLIER
 * @property {BN} DEPOSIT_TERM
 * @property {BN} TX_PROOF_DIFFICULTY_FACTOR
 * @property {BN} REDEMPTION_SIGNATURE_TIMEOUT
 * @property {BN} INCREASE_FEE_TIMER
 * @property {BN} REDEMPTION_PROOF_TIMEOUT
 * @property {BN} MINIMUM_REDEMPTION_FEE
 * @property {BN} FUNDING_PROOF_TIMEOUT
 * @property {BN} SIGNING_GROUP_FORMATION_TIMEOUT
 * @property {BN} COURTESY_CALL_DURATION
 * @property {BN} AUCTION_DURATION
 * @property {BN} PERMITTED_FEE_BUMPS
 */

/**
 * @typedef {Constants & ConstantFields} ResolvedConstants
 */

/** @mixin ResolvedConstants */
class Constants {
  /**
   * @param {TBTCConfig} config The config to use for this constants instance.
   * @return {Promise<ResolvedConstants>} The TBTC constants.
   */
  static async withConfig(config) {
    const { web3 } = config
    const networkId = await web3.eth.net.getId()
    const tbtcConstantsContract = EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TBTCConstantsJSON),
      web3,
      networkId.toString()
    )

    // BatchRequest makes a batch of Web3 RPC requests as one network payload.
    // However, the API in web3@1 does not return a Promise with all results,
    // as you might expect. So, we have to do this wizardry.
    // See https://github.com/ethereum/web3.js/issues/1446.
    const batch = new web3.BatchRequest()

    // Make a batch request to get all values at once.
    const members = [
      ["getBeneficiaryRewardDivisor", "BENEFICIARY_REWARD_DIVISOR"],
      ["getSatoshiMultiplier", "SATOSHI_MULTIPLIER"],
      ["getDepositTerm", "DEPOSIT_TERM"],
      ["getTxProofDifficultyFactor", "TX_PROOF_DIFFICULTY_FACTOR"],
      ["getSignatureTimeout", "REDEMPTION_SIGNATURE_TIMEOUT"],
      ["getIncreaseFeeTimer", "INCREASE_FEE_TIMER"],
      ["getRedemptionProofTimeout", "REDEMPTION_PROOF_TIMEOUT"],
      ["getMinimumRedemptionFee", "MINIMUM_REDEMPTION_FEE"],
      ["getFundingTimeout", "FUNDING_PROOF_TIMEOUT"],
      ["getSigningGroupFormationTimeout", "SIGNING_GROUP_FORMATION_TIMEOUT"],
      ["getCourtesyCallTimeout", "COURTESY_CALL_DURATION"],
      ["getAuctionDuration", "AUCTION_DURATION"]
    ]

    const calls = members.map(([constantGetter, constantName]) => {
      const call = tbtcConstantsContract.methods[constantGetter]().call
      return new Promise((resolve, reject) => {
        const request = call.request(null, (
          /** @type {any} */ error,
          /** @type {string} */ value
        ) => {
          if (error) {
            reject(error)
          } else {
            resolve({ [constantName]: toBN(value) })
          }
        })
        batch.add(request)
      })
    })

    batch.execute()
    const results = await Promise.all(calls)

    /** @type {ConstantFields} */
    const constants = Object.assign({}, ...results)

    return /** @type {ResolvedConstants} */ (new Constants(
      constants,
      tbtcConstantsContract
    ))
  }

  /**
   * @param {ConstantFields} constants
   * @param {Contract} contract
   */
  constructor(constants, contract) {
    /** @type {Contract} */
    this.contract = contract

    Object.assign(this, constants)
  }
}

export { Constants }
