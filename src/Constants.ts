import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import EthereumHelpers from "./EthereumHelpers.js"
import { toBN } from "web3-utils"
import type BN from "bn.js"

/** @typedef { import("web3").default.Web3.eth.Contract } Contract */
import type {Contract} from 'web3-eth-contract'
import type {TBTCConfig} from './CommonTypes'

class Constants {
  /**
   * @param {TBTCConfig} config The config to use for this constants instance.
   * @return {Constants} The TBTC constants.
   */
  static async withConfig(config:TBTCConfig) {
    const { web3 } = config
    const networkId = String(await web3.eth.net.getId())
    const tbtcConstantsContract = EthereumHelpers.getDeployedContract(
      TBTCConstantsJSON,
      web3,
      networkId
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
        const request = call.request(null, (error:Error, value:any) => {
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

    const constants = {}
    results.forEach(constantEntry => {
      Object.assign(constants, constantEntry)
    })

    return new Constants(constants, tbtcConstantsContract)
  }

  public BENEFICIARY_REWARD_DIVISOR:BN;
  public SATOSHI_MULTIPLIER:BN;
  public DEPOSIT_TERM:BN;
  public TX_PROOF_DIFFICULTY_FACTOR:BN;
  public REDEMPTION_SIGNATURE_TIMEOUT:BN;
  public INCREASE_FEE_TIMER:BN;
  public REDEMPTION_PROOF_TIMEOUT:BN;
  public MINIMUM_REDEMPTION_FEE:BN;
  public FUNDING_PROOF_TIMEOUT:BN;
  public SIGNING_GROUP_FORMATION_TIMEOUT:BN;
  public COURTESY_CALL_DURATION:BN;
  public AUCTION_DURATION:BN;
  public PERMITTED_FEE_BUMPS:BN;

  constructor(constants:any, public contract:Contract) {
    /** @type {Contract} */
    this.contract = contract

    /** @type {BN} */
    this.BENEFICIARY_REWARD_DIVISOR = constants.BENEFICIARY_REWARD_DIVISOR
    /** @type {BN} */
    this.SATOSHI_MULTIPLIER = constants.SATOSHI_MULTIPLIER
    /** @type {BN} */
    this.DEPOSIT_TERM = constants.DEPOSIT_TERM
    /** @type {BN} */
    this.TX_PROOF_DIFFICULTY_FACTOR = constants.TX_PROOF_DIFFICULTY_FACTOR
    /** @type {BN} */
    this.REDEMPTION_SIGNATURE_TIMEOUT = constants.REDEMPTION_SIGNATURE_TIMEOUT
    /** @type {BN} */
    this.INCREASE_FEE_TIMER = constants.INCREASE_FEE_TIMER
    /** @type {BN} */
    this.REDEMPTION_PROOF_TIMEOUT = constants.REDEMPTION_PROOF_TIMEOUT
    /** @type {BN} */
    this.MINIMUM_REDEMPTION_FEE = constants.MINIMUM_REDEMPTION_FEE
    /** @type {BN} */
    this.FUNDING_PROOF_TIMEOUT = constants.FUNDING_PROOF_TIMEOUT
    /** @type {BN} */
    this.SIGNING_GROUP_FORMATION_TIMEOUT = constants.SIGNING_GROUP_FORMATION_TIMEOUT
    /** @type {BN} */
    this.COURTESY_CALL_DURATION = constants.COURTESY_CALL_DURATION
    /** @type {BN} */
    this.AUCTION_DURATION = constants.AUCTION_DURATION
    /** @type {BN} */
    this.PERMITTED_FEE_BUMPS = constants.PERMITTED_FEE_BUMPS
  }
}

export { Constants }
