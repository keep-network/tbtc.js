import BitcoinHelpers from "./BitcoinHelpers.js"
/** @typedef { import("./BitcoinHelpers.js").FoundTransaction } BitcoinTransaction */

import EthereumHelpers from "./EthereumHelpers.js"

/** @typedef { import("web3").default.Web3.eth.Contract } Contract */

import Redemption from "./Redemption.js"

import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"
import DepositJSON from "@keep-network/tbtc/artifacts/Deposit.json"
import DepositFactoryJSON from "@keep-network/tbtc/artifacts/DepositFactory.json"
import TBTCTokenJSON from "@keep-network/tbtc/artifacts/TBTCToken.json"
import FeeRebateTokenJSON from "@keep-network/tbtc/artifacts/FeeRebateToken.json"
import VendingMachineJSON from "@keep-network/tbtc/artifacts/VendingMachine.json"
import BondedECDSAKeepJSON from "@keep-network/keep-ecdsa/artifacts/BondedECDSAKeep.json"

import web3Utils from "web3-utils"
const { toBN } = web3Utils

/** @typedef { import("bn.js") } BN */
/** @typedef { import("./TBTC").TBTCConfig } TBTCConfig */

/** @enum {number} */
const DepositStates = {
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
   * @param {TBTCConfig} config The config to use for this factory.
   */
  constructor(config) {
    /** @package */
    this.config = config

    this.State = DepositStates
  }

  /**
   * @return {Promise<BN[]>} A list of the available lot sizes, in satoshis,
   *         as BN instances.
   */
  async availableSatoshiLotSizes() {
    return (await this.systemContract.methods.getAllowedLotSizes().call()).map(
      toBN
    )
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
    const isLotSizeAllowed = await this.systemContract.methods
      .isAllowedLotSize(satoshiLotSize.toString())
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

  // Await the deployed() functions of all contract dependencies.
  /** @private */
  async resolveContracts() {
    const web3 = this.config.web3

    // Get the net_version
    const networkId = await this.config.web3.eth.net.getId()

    function lookupAddress(artifact) {
      const deploymentInfo = artifact.networks[networkId]
      if (!deploymentInfo) {
        throw new Error(
          `No deployment info found for contract ${artifact.contractName}, network ID ${networkId}.`
        )
      }
      return deploymentInfo.address
    }

    const contracts = [
      [TBTCConstantsJSON, "constantsContract"],
      [TBTCSystemJSON, "systemContract"],
      [TBTCTokenJSON, "tokenContract"],
      [TBTCDepositTokenJSON, "depositTokenContract"],
      [FeeRebateTokenJSON, "feeRebateTokenContract"],
      [DepositFactoryJSON, "depositFactoryContract"],
      [VendingMachineJSON, "vendingMachineContract"]
    ]

    contracts.map(([artifact, propertyName, deployed]) => {
      const contract = new web3.eth.Contract(artifact.abi)
      contract.options.address = lookupAddress(artifact)
      contract.options.from = web3.eth.defaultAccount
      this[propertyName] = contract
    })

    /**
     * @package
     * @type Contract
     */
    this.constantsContract
    /**
     * @package
     * @type Contract
     */
    this.systemContract
    /**
     * @package
     * @type Contract
     */
    this.tokenContract
    /**
     * @package
     * @type Contract
     */
    this.depositTokenContract
    /**
     * @package
     * @type Contract
     */
    this.feeRebateTokenContract
    /**
     * @package
     * @type Contract
     */
    this.depositContract
    /**
     * @package
     * @type Contract
     */
    this.depositLogContract
    /**
     * @package
     * @type Contract
     */
    this.depositFactoryContract
    /**
     * @package
     * @type Contract
     */
    this.vendingMachineContract
  }

  /**
   * @private
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
      await this.systemContract.methods.getNewDepositFeeEstimate().call()
    )

    const accountBalance = await this.config.web3.eth.getBalance(
      this.config.web3.eth.defaultAccount
    )

    if (creationCost.lt(accountBalance)) {
      throw new Error(
        `Insufficient balance ${accountBalance.toNumber()} to open ` +
          `deposit (required: ${creationCost.toNumber()}).`
      )
    }

    const result = await EthereumHelpers.sendSafely(
      this.depositFactoryContract.methods.createDeposit(lotSize.toString()),
      { value: creationCost },
      true
    )

    const createdEvent = EthereumHelpers.readEventFromTransaction(
      this.config.web3,
      result,
      this.systemContract,
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
      keepAddress: createdEvent._keepAddress
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
      satoshiLotSize.toNumber(),
      "satoshis..."
    )
    const {
      depositAddress,
      keepAddress
    } = await factory.createNewDepositContract(satoshiLotSize)
    console.debug(
      `Looking up new deposit with address ${depositAddress} backed by ` +
        `keep at address ${keepAddress}...`
    )
    const web3 = factory.config.web3
    const contract = new web3.eth.Contract(DepositJSON.abi, depositAddress)
    contract.options.from = web3.eth.defaultAccount
    const keepContract = new web3.eth.Contract(
      BondedECDSAKeepJSON.abi,
      keepAddress
    )
    keepContract.options.from = web3.eth.defaultAccount

    return new Deposit(factory, contract, keepContract)
  }

  /**
   * @param {DepositFactory} factory
   * @param {string} address
   */
  static async forAddress(factory, address) {
    console.debug(`Looking up Deposit contract at address ${address}...`)
    const web3 = factory.config.web3
    const contract = new web3.eth.Contract(DepositJSON.abi, address)
    contract.options.from = web3.eth.defaultAccount

    console.debug(`Looking up Created event for deposit ${address}...`)
    const createdEvent = await EthereumHelpers.getExistingEvent(
      factory.systemContract,
      "Created",
      { _depositContractAddress: address }
    )
    if (!createdEvent) {
      throw new Error(
        `Could not find creation event for deposit at address ${address}.`
      )
    }

    const keepAddress = createdEvent.returnValues._keepAddress
    console.debug(`Found keep address ${keepAddress}.`)
    const keepContract = new web3.eth.Contract(
      BondedECDSAKeepJSON.abi,
      keepAddress
    )
    keepContract.options.from = web3.eth.defaultAccount

    return new Deposit(factory, contract, keepContract)
  }

  /**
   * @param {DepositFactory} factory
   * @param {any | string} tdt
   */
  static async forTDT(factory, tdt) {
    return new Deposit(factory, "")
  }

  /**
   * @param {DepositFactory} factory
   * @param {TruffleContract} depositContract
   * @param {TruffleContract} keepContract
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
    this.bitcoinAddress = this.publicKeyPoint.then(
      this.publicKeyPointToBitcoinAddress.bind(this)
    )
  }

  // /------------------------------- Accessors -------------------------------

  /**
   * @return {Promise<BN>} A promise to the lot size of the deposit, in satoshis.
   */
  async getSatoshiLotSize() {
    return toBN(await this.contract.methods.lotSizeSatoshis().call())
  }

  /**
   * Get the signer fee, to be paid at redemption.
   * @return {Promise<BN>} A promise to the signer fee for this deposit, in TBTC.
   */
  async getSignerFeeTBTC() {
    return toBN(await this.contract.methods.signerFee().call())
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
   * @return {DepositStates} The current state of the deposit.
   */
  async getCurrentState() {
    return parseInt(await this.contract.methods.getCurrentState().call())
  }

  async getTDT() /* : Promise<TBTCDepositToken>*/ {
    return {}
  }

  async getFRT() /* : Promise<FeeRebateToken | null>*/ {
    return {}
  }

  async getOwner() /* : Promise<string>*/ /* ETH address */ {
    return await this.factory.depositTokenContract.methods
      .ownerOf(this.address)
      .call()
  }

  async inVendingMachine() /* : Promise<boolean>*/ {
    return (
      (await this.getOwner()) ==
      this.factory.vendingMachineContract.options.address
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

  onReadyForProof(proofHandler /* : (prove)=>void*/) {
    // prove(txHash) is a thing, will submit funding proof for the given
    // Bitcoin txHash; no verification initially.
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
    if (!(await this.contract.methods.inActive().call())) {
      throw new Error(
        "Can't mint TBTC with a deposit that isn't in ACTIVE state."
      )
    }

    console.debug(
      `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
    )
    await this.factory.depositTokenContract.methods
      .approve(
        this.factory.vendingMachineContract.options.address,
        this.address
      )
      .send()

    console.debug(`Minting TBTC...`)
    const transaction = await EthereumHelpers.sendSafely(
      this.factory.vendingMachineContract.methods.tdtToTbtc(this.address)
    )

    // return TBTC minted amount
    const transferEvent = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      transaction,
      this.factory.tokenContract,
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
    const expectedValue = parseInt(await this.getSatoshiLotSize())
    const tx = await BitcoinHelpers.Transaction.find(address, expectedValue)
    if (!tx) {
      throw new Error(
        `Funding transaction not found for deposit ${this.address}.`
      )
    }

    const requiredConfirmations = parseInt(
      await this.factory.constantsContract.methods
        .getTxProofDifficultyFactor()
        .call()
    )
    const confirmations = await BitcoinHelpers.Transaction.checkForConfirmations(
      tx,
      requiredConfirmations
    )
    if (!confirmations) {
      throw new Error(
        `Funding transaction did not have sufficient confirmations; ` +
          `expected ${requiredConfirmations}.`
      )
    }

    console.debug(
      `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
    )
    await this.factory.depositTokenContract.methods
      .approve(
        this.factory.vendingMachineContract.options.address,
        this.address
      )
      .send()

    console.debug(
      `Qualifying and minting off of deposit ${this.address} for ` +
        `Bitcoin transaction ${tx.transactionID}...`,
      tx,
      confirmations
    )
    const proofArgs = await this.constructFundingProof(
      tx,
      parseInt(requiredConfirmations)
    )
    proofArgs.unshift(this.address)
    const transaction = await this.factory.vendingMachineContract.methods
      .unqualifiedDepositToTbtc(...proofArgs)
      .send()

    // return TBTC minted amount
    const transferEvent = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      transaction,
      this.factory.tokenContract,
      "Transfer"
    )

    return toBN(transferEvent.value).div(toBN(10).pow(18))
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
      const lotSize = await this.getSatoshiLotSize()

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
          `(${this.factory.vendingMachineContract.options.address}). This ` +
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
      await this.factory.tokenContract.methods.balanceOf(thisAccount).call()
    )
    if (redemptionCost.gt(availableBalance)) {
      throw new Error(
        `Account ${thisAccount} does not have the required balance of ` +
          `${redemptionCost.toNumber()} to redeem; it only has ` +
          `${availableBalance.toNumber()} available.`
      )
    }

    console.debug(
      `Looking up UTXO size and transaction fee for redemption transaction...`
    )
    const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
      this.factory.constantsContract
    )
    const utxoSize = await this.contract.methods.utxoSize().call()
    const outputValue = toBN(utxoSize).sub(toBN(transactionFee))
    const outputValueBytes = outputValue.toArrayLike(Buffer, "le", 8)

    let transaction
    if (inVendingMachine) {
      console.debug(
        `Approving transfer of ${redemptionCost} to the vending machine....`
      )
      await this.factory.tokenContract.methods
        .approve(
          this.factory.vendingMachineContract.options.address,
          redemptionCost.toString()
        )
        .send()

      console.debug(
        `Initiating redemption of deposit ${this.address} from ` +
          `vending machine...`
      )
      transaction = await EthereumHelpers.sendSafely(
        this.factory.vendingMachineContract.methods.tbtcToBtc(
          this.address,
          outputValueBytes,
          redeemerOutputScript,
          thisAccount
        )
      )
    } else {
      console.debug(`Approving transfer of ${redemptionCost} to the deposit...`)
      await EthereumHelpers.sendSafely(
        this.factory.tokenContract.methods.approve(
          this.address,
          redemptionCost.toString()
        )
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
      this.factory.systemContract,
      "RedemptionRequested"
    )
    const redemptionDetails = this.redemptionDetailsFromEvent(redemptionRequest)

    return new Redemption(this, redemptionDetails)
  }

  /**
   * Fetches the latest redemption details from the chain. These can change
   * after fee bumps.
   *
   * Returns a promise to the redemption details, or to null if there is no
   * current redemption in progress.
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
      this.factory.systemContract,
      "RedemptionRequested",
      { _depositContractAddress: this.address }
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
   * @prop {Promise<{ transaction: FoundTransaction, requiredConfirmations: Number }>} fundingConfirmations
   * @prop {Promise<EthereumTransaction>} proofTransaction
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
   * Calling this function more than once will return the existing state of
   * the first auto submission process, rather than restarting the process.
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
    const state = (this.autoSubmittingState = {})

    state.fundingTransaction = this.bitcoinAddress.then(async address => {
      const expectedValue = await this.getSatoshiLotSize()

      console.debug(
        `Monitoring Bitcoin for transaction to address ${address}...`
      )
      return BitcoinHelpers.Transaction.findOrWaitFor(address, expectedValue)
    })

    state.fundingConfirmations = state.fundingTransaction.then(
      async transaction => {
        const requiredConfirmations = parseInt(
          await this.factory.constantsContract.methods
            .getTxProofDifficultyFactor()
            .call()
        )

        console.debug(
          `Waiting for ${requiredConfirmations} confirmations for ` +
            `Bitcoin transaction ${transaction.transactionID}...`
        )
        await BitcoinHelpers.Transaction.waitForConfirmations(
          transaction,
          requiredConfirmations
        )

        return { transaction, requiredConfirmations }
      }
    )

    state.proofTransaction = state.fundingConfirmations.then(
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

    return state
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
    const pubkeyTransaction = await EthereumHelpers.sendSafely(
      this.contract.methods.retrieveSignerPubkey()
    )

    console.debug(`Found public key for deposit ${this.address}...`)
    const {
      _signingGroupPubkeyX,
      _signingGroupPubkeyY
    } = EthereumHelpers.readEventFromTransaction(
      this.factory.config.web3,
      pubkeyTransaction,
      this.factory.systemContract,
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
    await EthereumHelpers.getEvent(this.factory.systemContract, "Funded", {
      _depositContractAddress: this.address
    })
    console.debug(`Deposit ${this.address} transitioned to ACTIVE.`)

    return true
  }

  async readPublishedPubkeyEvent() {
    return EthereumHelpers.getExistingEvent(
      this.factory.systemContract,
      "RegisteredPubkey",
      { _depositContractAddress: this.address }
    )
  }

  async publicKeyPointToBitcoinAddress(publicKeyPoint) {
    return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
      publicKeyPoint.x,
      publicKeyPoint.y,
      this.factory.config.bitcoinNetwork
    )
  }

  // Given a Bitcoin transaction and the number of confirmations that need to
  // be proven constructs an SPV proof and returns the raw parameters that
  // would be given to an on-chain contract.
  //
  // These are:
  // - version
  // - txInVector
  // - txOutVector
  // - locktime
  // - outputPosition
  // - merkleProof
  // - txInBlockIndex
  // - chainHeaders
  //
  // Constructed this way to serve both qualify + mint and simple
  // qualification flows.
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

  redemptionDetailsFromEvent(
    redemptionRequestedEventArgs
  ) /* : RedemptionDetails*/ {
    const {
      _utxoSize,
      _redeemerOutputScript,
      _requestedFee,
      _outpoint,
      _digest
    } = redemptionRequestedEventArgs

    return {
      utxoSize: toBN(_utxoSize),
      redeemerOutputScript: _redeemerOutputScript,
      requestedFee: toBN(_requestedFee),
      outpoint: _outpoint,
      digest: _digest
    }
  }
}
