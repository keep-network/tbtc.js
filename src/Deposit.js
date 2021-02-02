import { EventEmitter } from "events"

import BitcoinHelpers from "./BitcoinHelpers.js"
/** @typedef { import("./BitcoinHelpers.js").TransactionInBlock } BitcoinTransaction */
/** @typedef { import("./BitcoinHelpers.js").OnReceivedConfirmationHandler } OnReceivedConfirmationHandler */

import EthereumHelpers from "./EthereumHelpers.js"
/** @typedef { import("./EthereumHelpers.js").Contract } Contract */
/** @typedef { import("./EthereumHelpers.js").TruffleArtifact } TruffleArtifact */
/** @typedef { import("./EthereumHelpers.js").TransactionReceipt } TransactionReceipt */

import Redemption from "./Redemption.js"
/** @typedef { import("./Redemption.js").RedemptionDetails } RedemptionDetails */

import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"
import DepositJSON from "@keep-network/tbtc/artifacts/Deposit.json"
import DepositFactoryJSON from "@keep-network/tbtc/artifacts/DepositFactory.json"
import TBTCTokenJSON from "@keep-network/tbtc/artifacts/TBTCToken.json"
import FeeRebateTokenJSON from "@keep-network/tbtc/artifacts/FeeRebateToken.json"
import VendingMachineJSON from "@keep-network/tbtc/artifacts/VendingMachine.json"
import FundingScriptJSON from "@keep-network/tbtc/artifacts/FundingScript.json"
import BondedECDSAKeepJSON from "@keep-network/keep-ecdsa/artifacts/BondedECDSAKeep.json"

import web3Utils from "web3-utils"
const { toBN } = web3Utils

/** @typedef { import("bn.js") } BN */
/** @typedef { import("./TBTC").TBTCConfig } TBTCConfig */

/** @enum {number} */
export const DepositStates = {
  // Not initialized.
  START: 0,

  // Funding flow.
  AWAITING_SIGNER_SETUP: 1,
  AWAITING_BTC_FUNDING_PROOF: 2,

  // Failed setup.
  FAILED_SETUP: 3,

  // Active/qualified, pre- or at-term.
  ACTIVE: 4,

  // Redemption flow.
  AWAITING_WITHDRAWAL_SIGNATURE: 5,
  AWAITING_WITHDRAWAL_PROOF: 6,
  REDEEMED: 7,

  // Signer liquidation flow.
  COURTESY_CALL: 8,
  FRAUD_LIQUIDATION_IN_PROGRESS: 9,
  LIQUIDATION_IN_PROGRESS: 10,
  LIQUIDATED: 11
}
/**
 * Returns the state name of the given numeric state id.
 * @param {number} stateId The numeric state id, as defined on chain by the
 *        deposit `DepositStates` library enum.
 * @return {string | null} The state name, as defined by the tbtc.js
 *         `DepositStates` enum.
 */
function nameOfState(stateId) {
  // Find the right id, then take that entry's name.
  return Object.entries(DepositStates).filter(([_, id]) => id == stateId)[0][0]
}

export class DepositFactory {
  /**
   * Returns a fully-initialized DepositFactory for the given config.
   *
   * @param {TBTCConfig} config The config to use for this factory.
   */
  static async withConfig(config) {
    const statics = new DepositFactory(config)
    await statics.resolveContracts()

    BitcoinHelpers.setElectrumConfig(config.electrum)

    return statics
  }

  /**
   * @private
   * @param {TBTCConfig} config The config to use for this factory.
   */
  constructor(config) {
    /** @package */
    this.config = config

    this.State = DepositStates
    this.stateById = nameOfState
  }

  /**
   * @return {Promise<BN[]>} A list of the available lot sizes, in satoshis,
   *         as BN instances.
   */
  async availableSatoshiLotSizes() {
    return (
      await this.system()
        .methods.getAllowedLotSizes()
        .call()
    ).map(toBN)
  }

  /**
   * Opens a new deposit with the given lot size in satoshis and returns a
   * Deposit handle to it. If the lot size is not currently permitted by the
   * tBTC system, throws an error. If a contract issue occurs during the
   * opening of the deposit, throws an issue.
   *
   * To follow along once the deposit is initialized, see the `Deposit` API.
   *
   * @param {BN} satoshiLotSize The lot size, in satoshis, of the deposit.
   *        Must be in the list of allowed lot sizes from `availableLotSizes`.
   *
   * @return {Promise<Deposit>} The new deposit with the given lot size.
   */
  async withSatoshiLotSize(satoshiLotSize) {
    const isLotSizeAllowed = await this.system()
      .methods.isAllowedLotSize(satoshiLotSize.toString())
      .call()

    if (!isLotSizeAllowed) {
      throw new Error(
        `Lot size ${satoshiLotSize} is not permitted; only ` +
          `one of ${(await this.availableSatoshiLotSizes()).join(",")} ` +
          `can be used.`
      )
    }

    const deposit = Deposit.forLotSize(this, satoshiLotSize)
    return deposit
  }

  /**
   * Looks up an existing deposit at the specified address, and returns a
   * tbtc.js Deposit wrapper for it.
   *
   * @param {string} depositAddress The address of the deposit to resolve.
   *
   * @return {Promise<Deposit>} The deposit at the given address.
   */
  async withAddress(depositAddress) {
    return await Deposit.forAddress(this, depositAddress)
  }

  /**
   * Looks up an existing deposit corresponding to the given TDT id, and
   * returns a tbtc.js Deposit wrapper for it.
   *
   * @param {string} tdtId The TDT id of the deposit's tBTC Deposit Token.
   *
   * @return {Promise<Deposit>} The deposit at the given address.
   */
  async withTdtId(tdtId) {
    return await Deposit.forTDT(this, tdtId)
  }

  /**
   * @private
   *
   * Helper to ensure that the contract is defined before returning it. Throws
   * if the contract is undefined.
   *
   * @param {Contract | undefined} contract The contract to check for existence.
   * @return {Contract} The contract, if defined.
   */
  contractOrBust(contract) {
    if (!contract) throw new Error("Contract initialization incomplete.")

    return contract
  }

  constants() {
    return this.contractOrBust(this.constantsContract)
  }

  system() {
    return this.contractOrBust(this.systemContract)
  }
  depositFactory() {
    return this.contractOrBust(this.depositFactoryContract)
  }
  depositToken() {
    return this.contractOrBust(this.depositTokenContract)
  }
  token() {
    return this.contractOrBust(this.tokenContract)
  }
  vendingMachine() {
    return this.contractOrBust(this.vendingMachineContract)
  }
  fundingScript() {
    return this.contractOrBust(this.fundingScriptContract)
  }

  /** @private */
  async resolveContracts() {
    // Get the net_version
    const networkId = await this.config.web3.eth.net.getId()

    const resolveContract = (/** @type {TruffleArtifact} */ artifact) => {
      return EthereumHelpers.getDeployedContract(
        artifact,
        this.config.web3,
        networkId.toString()
      )
    }

    /** @package */
    this.constantsContract = await resolveContract(
      /** @type {TruffleArtifact} */ (TBTCConstantsJSON)
    )
    /** @package */
    this.systemContract = await resolveContract(
      /** @type {TruffleArtifact} */ (TBTCSystemJSON)
    )
    /** @package */
    this.tokenContract = await resolveContract(
      /** @type {TruffleArtifact} */ (TBTCTokenJSON)
    )
    /** @package */
    this.depositTokenContract = await resolveContract(
      /** @type {TruffleArtifact} */ (TBTCDepositTokenJSON)
    )
    /** @package */
    this.feeRebateTokenContract = await resolveContract(
      /** @type {TruffleArtifact} */ (FeeRebateTokenJSON)
    )
    /** @package */
    this.depositContract = await resolveContract(
      /** @type {TruffleArtifact} */ (DepositJSON)
    )
    /** @package */
    this.depositFactoryContract = await resolveContract(
      /** @type {TruffleArtifact} */ (DepositFactoryJSON)
    )
    /** @package */
    this.vendingMachineContract = await resolveContract(
      /** @type {TruffleArtifact} */ (VendingMachineJSON)
    )
    /** @package */
    this.fundingScriptContract = await resolveContract(
      /** @type {TruffleArtifact} */ (FundingScriptJSON)
    )
  }

  /**
   * @package
   *
   * INTERNAL USE ONLY
   *
   * Initializes a new deposit and returns a tuple of the deposit contract
   * address and the associated keep address.
   *
   * @param {BN} lotSize The lot size to use, in satoshis.
   */
  async createNewDepositContract(lotSize) {
    const creationCost = toBN(
      await this.system()
        .methods.getNewDepositFeeEstimate()
        .call()
    )

    const accountBalance = toBN(
      // FIXME Need systemic handling of default from address.
      await this.config.web3.eth.getBalance(
        this.config.web3.eth.defaultAccount || ""
      )
    )

    if (creationCost.gt(accountBalance)) {
      throw new Error(
        `Insufficient balance ${accountBalance.toString()} to open ` +
          `deposit (required: ${creationCost.toString()}).`
      )
    }

    const result = await EthereumHelpers.sendSafely(
      this.depositFactory().methods.createDeposit(lotSize.toString()),
      { value: creationCost },
      false,
      1.2
    )

    const createdEvent = EthereumHelpers.readEventFromTransaction(
      this.config.web3,
      result,
      this.system(),
      "Created"
    )
    if (!createdEvent) {
      throw new Error(
        `Transaction failed to include keep creation event. ` +
          `Transaction was: ${JSON.stringify(result)}.`
      )
    }

    return {
      depositAddress: createdEvent._depositContractAddress,
      keepAddress: createdEvent._keepAddress,
      createdAtBlock: createdEvent.blockNumber
    }
  }
}

// Bitcoin address handlers are given the deposit's Bitcoin address.
/** @typedef {(address: string)=>void} BitcoinAddressHandler */
// Active handlers are given the deposit that just entered the ACTIVE state.
/** @typedef {(deposit: Deposit)=>void} ActiveHandler */

export default class Deposit {
  // factory/*: DepositFactory*/;
  // address/*: string*/;
  // keepContract/*: string*/;
  // contract/*: any*/;

  // bitcoinAddress/*: Promise<string>*/;
  // activeStatePromise/*: Promise<[]>*/; // fulfilled when deposit goes active

  /**
   * @param {DepositFactory} factory
   * @param {BN} satoshiLotSize
   */
  static async forLotSize(factory, satoshiLotSize) {
    console.debug(
      "Creating new deposit contract with lot size",
      satoshiLotSize.toString(),
      "satoshis..."
    )
    const {
      depositAddress,
      keepAddress,
      createdAtBlock
    } = await factory.createNewDepositContract(satoshiLotSize)
    console.debug(
      `Looking up new deposit with address ${depositAddress} backed by ` +
        `keep at address ${keepAddress}...`
    )
    const web3 = factory.config.web3
    const contract = EthereumHelpers.buildContract(
      web3,
      /** @type {TruffleArtifact} */ (DepositJSON).abi,
      depositAddress,
      createdAtBlock
    )
    const keepContract = EthereumHelpers.buildContract(
      web3,
      /** @type {TruffleArtifact} */ (BondedECDSAKeepJSON).abi,
      keepAddress,
      createdAtBlock
    )

    return new Deposit(factory, contract, keepContract)
  }

  /**
   * @param {DepositFactory} factory
   * @param {string} depositAddress
   */
  static async forAddress(factory, depositAddress) {
    console.debug(`Looking up Deposit contract at address ${depositAddress}...`)
    const web3 = factory.config.web3

    console.debug(`Looking up Created event for deposit ${depositAddress}...`)
    const createdEvent = await EthereumHelpers.getExistingEvent(
      factory.system(),
      "Created",
      { _depositContractAddress: depositAddress }
    )
    if (!createdEvent) {
      throw new Error(
        `Could not find creation event for deposit at address ${depositAddress}.`
      )
    }

    const contract = EthereumHelpers.buildContract(
      web3,
      /** @type {TruffleArtifact} */ (DepositJSON).abi,
      depositAddress,
      createdEvent.blockNumber
    )

    const keepAddress = createdEvent.returnValues._keepAddress
    console.debug(`Found keep address ${keepAddress}.`)
    const keepContract = EthereumHelpers.buildContract(
      web3,
      /** @type {TruffleArtifact} */ (BondedECDSAKeepJSON).abi,
      keepAddress,
      createdEvent.blockNumber
    )

    return new Deposit(factory, contract, keepContract)
  }

  /**
   * @param {DepositFactory} factory
   * @param {string} tdtId
   */
  static async forTDT(factory, tdtId) {
    return this.forAddress(
      factory,
      factory.config.web3.utils.padLeft("0x" + toBN(tdtId).toString("hex"), 40)
    )
  }

  /**
   * @param {DepositFactory} factory
   * @param {Contract} depositContract
   * @param {Contract} keepContract
   */
  constructor(factory, depositContract, keepContract) {
    if (!keepContract) {
      throw new Error("Keep contract required for Deposit instantiation.")
    }

    this.factory = factory
    /** @type {string} */
    this.address = depositContract.options.address
    this.keepContract = keepContract
    this.contract = depositContract

    // Set up state transition promises.
    this.activeStatePromise = this.waitForActiveState()

    this.publicKeyPoint = this.findOrWaitForPublicKeyPoint()
    this.bitcoinAddress = this.publicKeyPoint.then(point =>
      this.publicKeyPointToBitcoinAddress(point)
    )

    this.receivedFundingConfirmationEmitter = new EventEmitter()
  }

  // /------------------------------- Accessors -------------------------------

  /**
   * Promise to when a Bitcoin funding transaction is found for the address.
   * @type {Promise<BitcoinTransaction>}
   */
  get fundingTransaction() {
    // Lazily initialized.
    /** @type {Promise<BitcoinTransaction>} */
    this._fundingTransaction =
      this._fundingTransaction ||
      this.bitcoinAddress.then(async address => {
        const expectedValue = await this.getLotSizeSatoshis()
        console.debug(
          `Monitoring Bitcoin for transaction to address ${address}...`
        )
        return BitcoinHelpers.Transaction.findOrWaitFor(
          address,
          expectedValue.toNumber()
        )
      })

    return this._fundingTransaction
  }

  /**
   * Promise to the required number of confirmations.
   * @return {Promise<number>}
   */
  get requiredConfirmations() {
    // Lazily initialized.
    /** @type {Promise<number>} */
    this._requiredConfirmations =
      this._requiredConfirmations ||
      (async () => {
        return parseInt(
          await this.factory
            .constants()
            .methods.getTxProofDifficultyFactor()
            .call()
        )
      })()

    return this._requiredConfirmations
  }

  /**
   * @typedef FundingConfirmations
   * @type {Object}
   * @property {BitcoinTransaction} transaction
   * @property {number} requiredConfirmations
   */
  /**
   * Promise to when the deposit funding transaction is sufficiently confirmed.
   * @type {Promise<FundingConfirmations>}
   */
  get fundingConfirmations() {
    // Lazily initialized.
    /** @type {Promise<FundingConfirmations>} */
    this._fundingConfirmations =
      this._fundingConfirmations ||
      this.fundingTransaction.then(async transaction => {
        const requiredConfirmations = await this.requiredConfirmations

        console.debug(
          `Waiting for ${requiredConfirmations} confirmations for ` +
            `Bitcoin transaction ${transaction.transactionID}...`
        )
        await BitcoinHelpers.Transaction.waitForConfirmations(
          transaction.transactionID,
          requiredConfirmations,
          ({ transactionID, confirmations, requiredConfirmations }) => {
            this.receivedFundingConfirmationEmitter.emit(
              "receivedFundingConfirmation",
              {
                transactionID,
                confirmations,
                requiredConfirmations
              }
            )
          }
        )

        return { transaction, requiredConfirmations }
      })

    return this._fundingConfirmations
  }

  /**
   * @return {Promise<BN>} A promise to the lot size of the deposit, in satoshis.
   */
  async getLotSizeSatoshis() {
    return toBN(await this.contract.methods.lotSizeSatoshis().call())
  }

  /**
   * @return {Promise<BN>} A promise to the lot size of the deposit, in TBTC tokens.
   */
  async getLotSizeTBTC() {
    return toBN(await this.contract.methods.lotSizeTbtc().call())
  }

  /**
   * Get the signer fee, to be paid at redemption.
   * @return {Promise<BN>} A promise to the signer fee for this deposit, in TBTC.
   */
  async getSignerFeeTBTC() {
    return toBN(await this.contract.methods.signerFeeTbtc().call())
  }

  /**
   * Returns a promise that resolves to the Bitcoin address for the wallet
   * backing this deposit. May take an extended amount of time if this deposit
   * has just been created.
   */
  async getBitcoinAddress() {
    return await this.bitcoinAddress
  }

  /**
   * @return {Promise<DepositStates>} The current state of the deposit.
   */
  async getCurrentState() {
    return parseInt(await this.contract.methods.currentState().call())
  }

  async getTDT() /* : Promise<TBTCDepositToken>*/ {
    return {}
  }

  async getFRT() /* : Promise<FeeRebateToken | null>*/ {
    return {}
  }

  /**
   * @return {Promise<string>} The ETH address of the deposit owner.
   */
  async getOwner() {
    return await this.factory
      .depositToken()
      .methods.ownerOf(this.address)
      .call()
  }

  async inVendingMachine() /* : Promise<boolean>*/ {
    return (
      (await this.getOwner()) === this.factory.vendingMachine().options.address
    )
  }

  // /---------------------------- Event Handlers -----------------------------

  /**
   * Registers a handler for notification when a Bitcoin address is available
   * for this deposit. The handler receives the deposit signer wallet's
   * address.
   *
   * @param {BitcoinAddressHandler} bitcoinAddressHandler A function that
   *        takes a bitcoin address corresponding to this deposit's signer
   *        wallet. Note that exceptions in this handler are not managed, so
   *        the handler itself should deal with its own failure possibilities.
   */
  onBitcoinAddressAvailable(bitcoinAddressHandler) {
    this.bitcoinAddress.then(bitcoinAddressHandler)
  }

  /**
   * Registers a handler for notification when the deposit enters the ACTIVE
   * state, when it has been proven funded and becomes eligible for TBTC
   * minting and other uses. The deposit itself is passed to the handler.
   *
   * @param {ActiveHandler} activeHandler A handler called when this deposit
   *        enters the ACTIVE state; receives the deposit as its only
   *        parameter. Note that exceptions in this handler are not managed,
   *        so the handler itself should deal with its own failure
   *        possibilities.
   */
  onActive(activeHandler) {
    this.activeStatePromise.then(() => {
      activeHandler(this)
    })
  }

  /**
   * Registers a handler for notification when the Bitcoin funding transaction
   * has received a confirmation.
   *
   * @param {OnReceivedConfirmationHandler} onReceivedFundingConfirmationHandler
   *        A handler that receives an object with the transactionID,
   *        confirmations, and requiredConfirmations as its parameter.
   */
  onReceivedFundingConfirmation(onReceivedFundingConfirmationHandler) {
    this.receivedFundingConfirmationEmitter.on(
      "receivedFundingConfirmation",
      onReceivedFundingConfirmationHandler
    )
  }

  // /--------------------------- Deposit Actions -----------------------------

  /**
   * Mints TBTC from this deposit by giving ownership of it to the tBTC
   * Vending Machine contract in exchange for TBTC. Requires that the deposit
   * already be qualified, i.e. in the ACTIVE state.
   *
   * @return {Promise<BN>} A promise to the amount of TBTC that was minted to
   *         the deposit owner.
   */
  async mintTBTC() {
    if (
      !(await EthereumHelpers.callWithRetry(this.contract.methods.inActive()))
    ) {
      throw new Error(
        "Can't mint TBTC with a deposit that isn't in ACTIVE state."
      )
    }

    console.debug(
      `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
    )
    await this.factory
      .depositToken()
      .methods.approve(
        this.factory.vendingMachine().options.address,
        this.address
      )
      .send()

    console.debug(`Minting TBTC...`)
    const transaction = await EthereumHelpers.sendSafely(
      this.factory.vendingMachine().methods.tdtToTbtc(this.address)
    )

    // return TBTC minted amount
    const transferEvent = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      transaction,
      this.factory.token(),
      "Transfer"
    )

    console.debug(`Found Transfer event for`, transferEvent.value, `TBTC.`)
    return transferEvent.value
  }

  /**
   * Finds a funding transaction to this deposit's funding address with the
   * appropriate number of confirmations, then calls the tBTC Vending
   * Machine's shortcut function to simultaneously qualify the deposit and
   * mint TBTC off of it, transferring ownership of the deposit to the
   * Vending Machine.
   *
   * @return {Promise<BN>} A promise to the amount of TBTC that was minted to
   *         the deposit owner.
   *
   * @throws When there is no existing Bitcoin funding transaction with the
   *         appropriate number of confirmations, or if there is an issue
   *         in the Vending Machine's qualification + minting process.
   */
  async qualifyAndMintTBTC() {
    const address = await this.bitcoinAddress
    const expectedValue = (await this.getLotSizeSatoshis()).toNumber()
    const tx = await BitcoinHelpers.Transaction.find(address, expectedValue)
    if (!tx) {
      throw new Error(
        `Funding transaction not found for deposit ${this.address}.`
      )
    }

    const requiredConfirmations = parseInt(
      await this.factory
        .constants()
        .methods.getTxProofDifficultyFactor()
        .call()
    )
    const confirmations = await BitcoinHelpers.Transaction.checkForConfirmations(
      tx.transactionID,
      requiredConfirmations
    )
    if (!confirmations) {
      throw new Error(
        `Funding transaction did not have sufficient confirmations; ` +
          `expected ${requiredConfirmations}.`
      )
    }

    console.debug(
      `Qualifying and minting off of deposit ${this.address} for ` +
        `Bitcoin transaction ${tx.transactionID}...`,
      tx,
      confirmations
    )
    const proofArgs = await this.constructFundingProof(
      tx,
      requiredConfirmations
    )

    // Use approveAndCall pattern to execute VendingMachine.unqualifiedDepositToTbtc.
    const unqualifiedDepositToTbtcCall = this.factory
      .vendingMachine()
      .methods.unqualifiedDepositToTbtc(this.address, ...proofArgs)
      .encodeABI()

    const transaction = await EthereumHelpers.sendSafely(
      this.factory
        .depositToken()
        .methods.approveAndCall(
          this.factory.fundingScript().options.address,
          this.address,
          unqualifiedDepositToTbtcCall
        )
    )

    // return TBTC minted amount
    const transferEvent = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      transaction,
      this.factory.token(),
      "Transfer"
    )

    return toBN(transferEvent.value).div(toBN(10).pow(toBN(18)))
  }

  /**
   * Returns the cost, in TBTC, to redeem this deposit. If the deposit is in
   * the tBTC Vending Machine, includes the cost of retrieving it from the
   * Vending Machine.
   *
   * @return {Promise<BN>} A promise to the amount of TBTC needed to redeem
   *         this deposit.
   */
  async getRedemptionCost() {
    if (await this.inVendingMachine()) {
      const ownerRedemptionRequirement = toBN(
        await this.contract.methods
          .getOwnerRedemptionTbtcRequirement(
            this.factory.config.web3.eth.defaultAccount
          )
          .call()
      )
      const lotSize = await this.getLotSizeSatoshis()

      return lotSize.mul(toBN(10).pow(toBN(10))).add(ownerRedemptionRequirement)
    } else {
      return toBN(
        await this.contract.methods
          .getRedemptionTbtcRequirement(
            this.factory.config.web3.eth.defaultAccount
          )
          .call()
      )
    }
  }

  /**
   * Checks to see if this deposit is already in the redemption process and,
   * if it is, returns the details of that redemption. Returns null if there
   * is no current redemption.
   */
  async getCurrentRedemption() {
    const details = await this.getLatestRedemptionDetails()

    if (details) {
      return new Redemption(this, details)
    } else {
      return null
    }
  }

  /**
   *
   * @param {string} redeemerAddress The Bitcoin address where the redeemer
   *        would like to receive the BTC UTXO the deposit holds, less Bitcoin
   *        transaction fees.
   * @return {Promise<Redemption>} Returns a promise to a Redemption object,
   *         which will be fulfilled once the redemption process is in
   *         progress. Note that the promise can fail in several ways,
   *         including connectivity, a deposit ineligible for redemption, a
   *         deposit that is not owned by the requesting party, an invalid
   *         redeemer address, and a redemption request from a party that has
   *         insufficient TBTC to redeem.
   */
  async requestRedemption(redeemerAddress) {
    const inVendingMachine = await this.inVendingMachine()
    const thisAccount = this.factory.config.web3.eth.defaultAccount
    const owner = await this.getOwner()
    const belongsToThisAccount = owner == thisAccount

    if (!inVendingMachine && !belongsToThisAccount) {
      throw new Error(
        `Redemption is currently only supported for deposits owned by ` +
          `this account (${thisAccount}) or the tBTC Vending Machine ` +
          `(${this.factory.vendingMachine().options.address}). This ` +
          `deposit is owned by ${owner}.`
      )
    }

    const rawOutputScript = BitcoinHelpers.Address.toRawScript(redeemerAddress)
    const redeemerOutputScript =
      "0x" +
      Buffer.concat([
        Buffer.from([rawOutputScript.length]),
        rawOutputScript
      ]).toString("hex")
    if (redeemerOutputScript === null) {
      throw new Error(`${redeemerAddress} is not a valid Bitcoin address.`)
    }

    const redemptionCost = await this.getRedemptionCost()
    const availableBalance = toBN(
      await this.factory
        .token()
        .methods.balanceOf(thisAccount)
        .call()
    )
    if (redemptionCost.gt(availableBalance)) {
      throw new Error(
        `Account ${thisAccount} does not have the required balance of ` +
          `${redemptionCost.toString()} to redeem; it only has ` +
          `${availableBalance.toString()} available.`
      )
    }

    console.debug(
      `Looking up UTXO size and transaction fee for redemption transaction...`
    )
    const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
      this.factory.constants()
    )
    const utxoValue = await this.contract.methods.utxoValue().call()
    const outputValue = toBN(utxoValue).sub(transactionFee)
    const outputValueBytes = outputValue.toArrayLike(Buffer, "le", 8)

    let transaction
    if (inVendingMachine) {
      console.debug(
        `Approving transfer of ${redemptionCost} to the vending machine....`
      )
      await this.factory
        .token()
        .methods.approve(
          this.factory.vendingMachine().options.address,
          redemptionCost.toString()
        )
        .send()

      console.debug(
        `Initiating redemption of deposit ${this.address} from ` +
          `vending machine...`
      )
      transaction = await EthereumHelpers.sendSafely(
        this.factory
          .vendingMachine()
          .methods.tbtcToBtc(
            this.address,
            outputValueBytes,
            redeemerOutputScript
          )
      )
    } else {
      console.debug(`Approving transfer of ${redemptionCost} to the deposit...`)
      await EthereumHelpers.sendSafely(
        this.factory
          .token()
          .methods.approve(this.address, redemptionCost.toString())
      )

      console.debug(`Initiating redemption from deposit ${this.address}...`)
      transaction = await EthereumHelpers.sendSafely(
        this.contract.methods.requestRedemption(
          outputValueBytes,
          redeemerOutputScript
        ),
        {},
        true
      )
    }

    const redemptionRequest = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      transaction,
      this.factory.system(),
      "RedemptionRequested"
    )
    const redemptionDetails = this.redemptionDetailsFromEvent(redemptionRequest)

    return new Redemption(this, redemptionDetails)
  }

  /**
   * Fetches the latest redemption details from the chain. These can change
   * after fee bumps.
   *
   * @return {Promise<RedemptionDetails?>} A promise to the redemption details,
   *         or to null if there is no current redemption in progress.
   */
  async getLatestRedemptionDetails() {
    // If the contract is ACTIVE, there's definitely no redemption. This can
    // be generalized to a state check that the contract is either
    // AWAITING_WITHDRAWAL_SIGNATURE or AWAITING_WITHDRAWAL_PROOF, but let's
    // hold on that for now.
    if (await this.contract.methods.inActive().call()) {
      return null
    }

    const redemptionRequest = await EthereumHelpers.getExistingEvent(
      this.factory.system(),
      "RedemptionRequested",
      { _depositContractAddress: this.address },
      this.contract.deployedAtBlock
    )

    if (!redemptionRequest) {
      return null
    }

    return this.redemptionDetailsFromEvent(redemptionRequest.returnValues)
  }

  // /------------------------------- Helpers ---------------------------------

  /**
   * @typedef {Object} AutoSubmitState
   * @prop {Promise<BitcoinTransaction>} fundingTransaction
   * @prop {Promise<{ transaction: BitcoinTransaction, requiredConfirmations: Number }>} fundingConfirmations
   * @prop {Promise<TransactionReceipt>} [proofTransaction]
   * @prop {Promise<BN>} [mintedTBTC]
   */

  /**
   * This method enables the deposit's auto-submission capabilities. In
   * auto-submit mode, the deposit will automatically monitor for a new
   * Bitcoin transaction to the deposit signers' Bitcoin wallet, then watch
   * that transaction until it has accumulated sufficient work for proof
   * of funding to be submitted to the deposit, then submit that proof to the
   * deposit to qualify it and move it into the ACTIVE state.
   *
   * Without calling this function, the deposit will do none of those things;
   * instead, the caller will be in charge of managing (or choosing not to)
   * this process. This can be useful, for example, if a dApp wants to open
   * a deposit, then transfer the deposit to a service provider who will
   * handle deposit qualification.
   *
   * A deposit can be automatically pushed all the way through a mint (and with
   * one fewer transaction) by using the `autoMint` method instead.
   *
   * Calling this function more than once will return the existing state of
   * the first auto submission or minting process, rather than restarting the
   * process. `autoMint` and `autoSubmission` share an auto-submission state,
   * so a deposit cannot start auto-submitting and then switch to auto-minting
   * mid-stream---whichever is called first will be the flow that will occur.
   *
   * @return {AutoSubmitState} An object with promises to various stages of
   *         the auto-submit lifetime. Each promise can be fulfilled or
   *         rejected, and they are in a sequence where later promises will be
   *         rejected by earlier ones.
   */
  autoSubmit() {
    // Only enable auto-submitting once.
    if (this.autoSubmittingState) {
      return this.autoSubmittingState
    }
    /** @type {AutoSubmitState} */
    this.autoSubmittingState = {
      fundingTransaction: this.fundingTransaction,
      fundingConfirmations: this.fundingConfirmations,
      proofTransaction: this.fundingConfirmations.then(
        async ({ transaction, requiredConfirmations }) => {
          console.debug(
            `Submitting funding proof to deposit ${this.address} for ` +
              `Bitcoin transaction ${transaction.transactionID}...`
          )
          const proofArgs = await this.constructFundingProof(
            transaction,
            requiredConfirmations
          )

          return EthereumHelpers.sendSafely(
            this.contract.methods.provideBTCFundingProof(...proofArgs),
            {},
            true
          )
        }
      )
    }

    return this.autoSubmittingState
  }

  /**
   * This method enables the deposit's auto-minting capabilities. In
   * auto-mint mode, the deposit will automatically monitor for a new
   * Bitcoin transaction to the deposit signers' Bitcoin wallet, then watch
   * that transaction until it has accumulated sufficient work for proof
   * of funding to be submitted to the deposit, then submit a transaction to
   * simultaneously qualify it, move it into the ACTIVE state, and finally
   * turn the deposit over to the vending machine to mint TBTC.
   *
   * Without calling this function, the deposit will do none of those things;
   * instead, the caller will be in charge of managing (or choosing not to)
   * this process. This can be useful, for example, if a dApp wants to open
   * a deposit, then transfer the deposit to a service provider who will
   * handle deposit qualification.
   *
   * A deposit can be automatically pushed through the qualification flow
   * without minting at the end (i.e., preserving the owner's possession of the
   * deposit) by using the `autoSubmit` method instead.
   *
   * Calling this function more than once will return the existing state of
   * the first auto submission or minting process, rather than restarting the
   * process. `autoMint` and `autoSubmission` share an auto-submission state,
   * so a deposit cannot start auto-submitting and then switch to auto-minting
   * mid-stream---whichever is called first will be the flow that will occur.
   *
   * @return {AutoSubmitState} An object with promises to various stages of
   *         the auto-submit lifetime. Each promise can be fulfilled or
   *         rejected, and they are in a sequence where later promises will be
   *         rejected by earlier ones.
   */
  autoMint() {
    // Only enable auto-submitting once.
    if (this.autoSubmittingState) {
      return this.autoSubmittingState
    }
    /** @type {AutoSubmitState} */
    this.autoSubmittingState = {
      fundingTransaction: this.fundingTransaction,
      fundingConfirmations: this.fundingConfirmations,
      mintedTBTC: this.fundingConfirmations.then(
        async ({ transaction: bitcoinTransaction, requiredConfirmations }) => {
          console.debug(
            `Submitting funding proof to deposit ${this.address} for ` +
              `Bitcoin transaction ${bitcoinTransaction.transactionID} and minting TBTC...`
          )

          const proofArgs = await this.constructFundingProof(
            bitcoinTransaction,
            requiredConfirmations
          )

          // Use approveAndCall pattern to execute VendingMachine.unqualifiedDepositToTbtc.
          const unqualifiedDepositToTbtcCall = this.factory
            .vendingMachine()
            .methods.unqualifiedDepositToTbtc(this.address, ...proofArgs)
            .encodeABI()

          const transaction = await EthereumHelpers.sendSafely(
            this.factory
              .depositToken()
              .methods.approveAndCall(
                this.factory.fundingScript().options.address,
                this.address,
                unqualifiedDepositToTbtcCall
              )
          )

          // return TBTC minted amount
          const transferEvent = EthereumHelpers.readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.token(),
            "Transfer"
          )
          console.debug(`Minted`, transferEvent.value, `TBTC.`)

          return toBN(transferEvent.value).div(toBN(10).pow(toBN(18)))
        }
      )
    }

    return this.autoSubmittingState
  }

  // Finds an existing event from the keep backing the Deposit to access the
  // keep's public key, then submits it to the deposit to transition from
  // state AWAITING_SIGNER_SETUP to state AWAITING_BTC_FUNDING_PROOF and
  // provide access to the Bitcoin address for the deposit.
  //
  // Note that the client must do this public key submission to the deposit
  // manually; the deposit is not currently informed by the Keep of its newly-
  // generated pubkey for a variety of reasons.
  //
  // Returns a promise that will be fulfilled once the public key is
  // available, with a public key point with x and y properties.
  async findOrWaitForPublicKeyPoint() {
    const signerPubkeyEvent = await this.readPublishedPubkeyEvent()
    if (signerPubkeyEvent) {
      console.debug(
        `Found existing Bitcoin address for deposit ${this.address}...`
      )
      return {
        x: signerPubkeyEvent.returnValues._signingGroupPubkeyX,
        y: signerPubkeyEvent.returnValues._signingGroupPubkeyY
      }
    }

    console.debug(`Waiting for deposit ${this.address} keep public key...`)

    // Wait for the Keep to be ready.
    await EthereumHelpers.getEvent(this.keepContract, "PublicKeyPublished")

    console.debug(
      `Waiting for deposit ${this.address} to retrieve public key...`
    )
    // Ask the deposit to fetch and store the signer pubkey.
    const pubkeyTransaction = await EthereumHelpers.sendSafelyRetryable(
      this.contract.methods.retrieveSignerPubkey(),
      {},
      false,
      5
    )

    console.debug(`Found public key for deposit ${this.address}...`)
    const {
      _signingGroupPubkeyX,
      _signingGroupPubkeyY
    } = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      pubkeyTransaction,
      this.factory.system(),
      "RegisteredPubkey"
    )

    return {
      x: _signingGroupPubkeyX,
      y: _signingGroupPubkeyY
    }
  }

  // Returns a promise that is fulfilled when the contract has entered the
  // active state.
  async waitForActiveState() {
    const depositIsActive = await this.contract.methods.inActive().call()
    if (depositIsActive) {
      return true
    }

    console.debug(
      `Monitoring deposit ${this.address} for transition to ACTIVE.`
    )

    // If we weren't active, wait for Funded, then mark as active.
    // FIXME/NOTE: We could be inactive due to being outside of the funding
    // FIXME/NOTE: path, e.g. in liquidation or courtesy call.
    await EthereumHelpers.getEvent(
      this.factory.system(),
      "Funded",
      {
        _depositContractAddress: this.address
      },
      this.contract.deployedAtBlock
    )
    console.debug(`Deposit ${this.address} transitioned to ACTIVE.`)

    return true
  }

  async readPublishedPubkeyEvent() {
    return EthereumHelpers.getExistingEvent(
      this.factory.system(),
      "RegisteredPubkey",
      { _depositContractAddress: this.address },
      this.contract.deployedAtBlock
    )
  }

  /**
   * @param {{ x: string, y: string }} publicKeyPoint
   */
  async publicKeyPointToBitcoinAddress(publicKeyPoint) {
    return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
      publicKeyPoint.x,
      publicKeyPoint.y,
      this.factory.config.bitcoinNetwork
    )
  }

  /**
   * Given a Bitcoin transaction and the number of confirmations that need to
   * be proven constructs an SPV proof and returns the raw parameters that
   * would be given to an on-chain contract.
   *
   * These are:
   * - version
   * - txInVector
   * - txOutVector
   * - locktime
   * - outputPosition
   * - merkleProof
   * - txInBlockIndex
   * - chainHeaders
   *
   * Constructed this way to serve both qualify + mint and simple
   * qualification flows.
   *
   * @param {{ transactionID: string, outputPosition: number }} bitcoinTransaction
   *        The transaction id to construct the proof for and the output
   *        position of interest.
   * @param {number} confirmations The number of confirmations that the proof
   *        should show the given transaction has received. Must be >= the
   *        number of confirmations the transaction has already received.
   *
   * @return {Promise<[Buffer,Buffer,Buffer,Buffer,number,Buffer,number,Buffer]>}
   *         The version, input vector, output vector, locktime, output
   *         position, merkle proof, index of the transaction its containing
   *         block, and chain headers as an array in the order that these need
   *         to be passed to on-chain proof verification functions.
   */
  async constructFundingProof(bitcoinTransaction, confirmations) {
    const { transactionID, outputPosition } = bitcoinTransaction
    const {
      parsedTransaction,
      merkleProof,
      chainHeaders,
      txInBlockIndex
    } = await BitcoinHelpers.Transaction.getSPVProof(
      transactionID,
      confirmations
    )

    const { version, txInVector, txOutVector, locktime } = parsedTransaction

    return [
      Buffer.from(version, "hex"),
      Buffer.from(txInVector, "hex"),
      Buffer.from(txOutVector, "hex"),
      Buffer.from(locktime, "hex"),
      outputPosition,
      Buffer.from(merkleProof, "hex"),
      txInBlockIndex,
      Buffer.from(chainHeaders, "hex")
    ]
  }

  /**
   * @param {any} redemptionRequestedEventArgs
   * @return {RedemptionDetails}
   */
  redemptionDetailsFromEvent(redemptionRequestedEventArgs) {
    const {
      _utxoValue,
      _redeemerOutputScript,
      _requestedFee,
      _outpoint,
      _digest
    } = redemptionRequestedEventArgs

    return {
      utxoValue: toBN(_utxoValue),
      redeemerOutputScript: _redeemerOutputScript,
      requestedFee: toBN(_requestedFee),
      outpoint: _outpoint,
      digest: _digest
    }
  }

  // /--------------------- Liquidation helpers -------------------------

  /**
   * Get the current collateralization level for this Deposit.
   * Collateralization will be 0% if the deposit is in liquidation.
   * @return {Promise<BN>} Percentage collateralization, as an integer. eg. 149%
   */
  async getCollateralizationPercentage() {
    return toBN(
      await this.contract.methods.collateralizationPercentage().call()
    )
  }

  /**
   * Get the initial collateralization level for this Deposit.
   * @return {Promise<BN>} Percentage collateralization, as an integer. eg. 150%
   */
  async getInitialCollateralizedPercentage() {
    return toBN(
      await this.contract.methods.initialCollateralizedPercent().call()
    )
  }

  /**
   * Get the first threshold for deposit undercollateralization.
   * If the collateralization level falls below this percentage, the Deposit can
   * get courtesy-called.
   * The deposit can be courtesy called using `Deposit.notifyCourtesyCall`.
   * @return {Promise<BN>} Percentage collateralization, as an integer. eg. 125%
   */
  async getUndercollateralizedThresholdPercent() {
    return toBN(
      await this.contract.methods.undercollateralizedThresholdPercent().call()
    )
  }

  /**
   * Get the threshold for severe deposit undercollateralization.
   * If the collateralization level falls below this percentage, the Deposit
   * can be liquidated.
   * Liquidation can be initiated using `Deposit.notifyUndercollateralizedLiquidation`.
   * @return {Promise<BN>} Percentage collateralization, as an integer. eg. 110%
   */
  async getSeverelyUndercollateralizedThresholdPercent() {
    return toBN(
      await this.contract.methods
        .severelyUndercollateralizedThresholdPercent()
        .call()
    )
  }

  /**
   * Notify the contract that the signers are undercollateralized,
   * and move the deposit into a pre-liquidation state.
   */
  async notifyCourtesyCall() {
    await EthereumHelpers.sendSafely(this.contract.methods.notifyCourtesyCall())
  }

  /**
   * Exit the courtesy call state.
   * Only callable if the deposit is sufficiently collateralised.
   */
  async exitCourtesyCall() {
    await EthereumHelpers.sendSafely(this.contract.methods.exitCourtesyCall())
  }

  /**
   * Notify the contract that the courtesy call period has expired and begin
   * liquidation of the signer bonds.
   *
   * The bonds are auctioned in a falling-price auction. The value of
   * the bonds can be queried using `Deposit.auctionValue`, and bids placed
   * using `Deposit.purchaseSignerBondsAtAuction`.
   */
  async notifyCourtesyCallExpired() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifyCourtesyCallExpired()
    )
  }

  /**
   * Notify the contract that the deposit is severely undercollateralized,
   * and begin liquidation of the signer bonds.
   *
   * The bonds are auctioned in a falling-price auction. The value of
   * the bonds can be queried using `Deposit.auctionValue`, and bids placed
   * using `Deposit.purchaseSignerBondsAtAuction`.
   */
  async notifyUndercollateralizedLiquidation() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifyUndercollateralizedLiquidation()
    )
  }

  /**
   * Pays off the deposit balance and closes the liquidation auction
   * via `Deposit.purchaseSignerBondsAtAuction`, then withdraws the purchased
   * ETH by calling `DepositUtils.withdrawFunds`.
   */
  async takeAuction() {
    await this.purchaseSignerBondsAtAuction()
    await this.withdrawFunds()
  }

  /**
   * Purchases the signer bonds and closes the liquidation auction.
   */
  async purchaseSignerBondsAtAuction() {
    // FIXME Need systemic handling of default from address.
    const owner = this.factory.config.web3.eth.defaultAccount
    const allowance = await this.factory
      .token()
      .methods.allowance(owner, this.address)
      .call()

    const lotSize = await this.getLotSizeTBTC()
    if (toBN(allowance).lt(lotSize)) {
      await this.factory
        .token()
        .methods.approve(this.address, lotSize.toString())
        .send()
    }

    await EthereumHelpers.sendSafely(
      this.contract.methods.purchaseSignerBondsAtAuction()
    )
  }

  /**
   * Withdraw caller's allowance.
   * Withdrawals can only happen when a contract is in an end-state.
   */
  async withdrawFunds() {
    // FIXME Need systemic handling of default from address.
    await EthereumHelpers.sendSafely(this.contract.methods.withdrawFunds())
  }

  /**
   * Gets the current value of signer bonds at auction.
   * Only callable if the deposit is in the liqudation state.
   * @return {Promise<BN>} auction value in wei.
   */
  async auctionValue() {
    return toBN(await this.contract.methods.auctionValue().call())
  }

  // /--------------------- Timeout helpers -------------------------

  /**
   * Notify the contract that signing group setup has timed out.
   * Only applicable during funding.
   */
  async notifySignerSetupFailed() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifySignerSetupFailed()
    )
  }

  /**
   * Notify the contract that the funder has failed to send BTC.
   * Only applicable during funding.
   */
  async notifyFundingTimedOut() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifyFundingTimedOut()
    )
  }

  /**
   * Notify the contract that the signers have failed to produce a signature
   * for a redemption transaction. This is considered fraud, and moves the
   * deposit into liquidation.
   * Only applicable during redemption.
   */
  async notifyRedemptionSignatureTimedOut() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifyRedemptionSignatureTimedOut()
    )
  }

  /**
   * Notify the contract that the signers have failed to produce a redemption proof.
   */
  async notifyRedemptionProofTimedOut() {
    await EthereumHelpers.sendSafely(
      this.contract.methods.notifyRedemptionProofTimedOut()
    )
  }

  /**
   * Checks if signature was requested via the Keep.
   * @param {string} digest Digest to check approval for.
   * @return {Promise<boolean>} True if signature approved, false if not (fraud).
   */
  async wasSignatureApproved(digest) {
    const events = await this.keepContract.getPastEvents("SignatureRequested", {
      fromBlock: 0,
      toBlock: "latest",
      filter: { digest }
    })

    return events.length > 0
  }

  /**
   * Provide a signature that was not requested to prove fraud during funding.
   * @param {*} v Signature recovery value.
   * @param {*} r Signature R value.
   * @param {*} s Signature S value.
   * @param {*} signedDigest The digest signed by the signature vrs tuple.
   * @param {*} preimage The sha256 preimage of the digest.
   */
  async provideFundingECDSAFraudProof(v, r, s, signedDigest, preimage) {
    await EthereumHelpers.sendSafely(
      this.contract.methods.provideFundingECDSAFraudProof(
        v,
        r,
        s,
        signedDigest,
        preimage
      )
    )
  }

  /**
   * Provide a signature that was not requested to prove fraud after a deposit
   * has been funded.
   * @param {*} v Signature recovery value.
   * @param {*} r Signature R value.
   * @param {*} s Signature S value.
   * @param {*} signedDigest The digest signed by the signature vrs tuple.
   * @param {*} preimage The sha256 preimage of the digest.
   */
  async provideECDSAFraudProof(v, r, s, signedDigest, preimage) {
    await EthereumHelpers.sendSafely(
      this.contract.methods.provideECDSAFraudProof(
        v,
        r,
        s,
        signedDigest,
        preimage
      )
    )
  }
}
