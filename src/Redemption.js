import { EventEmitter } from "events"

import web3Utils from "web3-utils"
/** @typedef { import("bn.js") } BN */

import BitcoinHelpers from "./BitcoinHelpers.js"
/** @typedef { import("./BitcoinHelpers.js").TransactionInBlock } BitcoinTransaction */
/** @typedef { import("./BitcoinHelpers.js").OnReceivedConfirmationHandler } OnReceivedConfirmationHandler */

import EthereumHelpers from "./EthereumHelpers.js"
/** @typedef { import("./EthereumHelpers.js").TransactionReceipt } TransactionReceipt */

/** @typedef { import("./Deposit.js").default } Deposit */

const { toBN } = web3Utils

/**
 * Details of a given redemption at a given point in time.
 * @typedef {Object} RedemptionDetails
 * @property {BN} utxoValue The value of the UTXO in the redemption.
 * @property {string} redeemerOutputScript The raw redeemer output script bytes.
 * @property {BN} requestedFee The fee for the redemption transaction.
 * @property {string} outpoint The raw outpoint bytes.
 * @property {string} digest The raw digest bytes.
 */

/**
 * Details of a given unsigned transaction
 * @typedef {Object} UnsignedTransactionDetails
 * @property {string} hex The raw transaction hex string.
 * @property {string} digest The transaction's digest as a hex string.
 */

/**
 * The Redemption class encapsulates the operations that finalize an already-
 * initiated redemption.
 *
 * Typically, you can call `autoSubmit()` and then register an `onWithdrawn`
 * handler to be notified when the Bitcoin transaction completing redemption has
 * been signed, submitted, and proven to the deposit contract.
 *
 * If you prefer to manage the Bitcoin side of the lifecycle separately, you can
 * register to be notified when a Bitcoin transaction is ready for submission
 * using `onBitcoinTransactionSigned`, and submit a redemption proof to once
 * that transaction is sufficiently confirmed using `proveWithdrawal`.
 *
 * `proveWithdrawal` will trigger any `onWithdrawn` handlers that have been
 * registered.
 */
export default class Redemption {
  /**
   * @param {Deposit} deposit The deposit this redemption is attached to.
   * @param {RedemptionDetails} redemptionDetails The details of this
   *        redemption (which should already be in progress).
   */
  constructor(deposit, redemptionDetails) {
    this.deposit = deposit
    this.withdrawnEmitter = new EventEmitter()
    this.receivedConfirmationEmitter = new EventEmitter()

    /** @type {Promise<RedemptionDetails>} */
    this.redemptionDetails = this.getLatestRedemptionDetails(redemptionDetails)

    /** @type {Promise<UnsignedTransactionDetails>} */
    this.unsignedTransactionDetails = this.redemptionDetails.then(details => {
      const outputValue = details.utxoValue.sub(details.requestedFee)
      const unsignedTransaction = BitcoinHelpers.Transaction.constructOneInputOneOutputWitnessTransaction(
        details.outpoint.replace("0x", ""),
        // We set sequence to `0` to be able to replace by fee. It reflects
        // bitcoin-spv:
        // https://github.com/summa-tx/bitcoin-spv/blob/2a9d594d9b14080bdbff2a899c16ffbf40d62eef/solidity/contracts/CheckBitcoinSigs.sol#L154
        0,
        outputValue.toNumber(),
        EthereumHelpers.bytesToRaw(details.redeemerOutputScript)
      )

      return {
        hex: unsignedTransaction,
        digest: details.digest
      }
    })

    this.signedTransaction = this.unsignedTransactionDetails.then(
      async unsignedTransactionDetails => {
        console.debug(
          `Looking up latest redemption details for deposit ` +
            `${this.deposit.address}...`
        )
        const redemptionDigest = (await this.redemptionDetails).digest

        console.debug(
          `Finding or waiting for transaction signature for deposit ` +
            `${this.deposit.address}...`
        )
        const signatureEvent = await EthereumHelpers.getEvent(
          this.deposit.keepContract,
          "SignatureSubmitted",
          { digest: redemptionDigest }
        )

        console.debug(
          `Found submitted signature for deposit ${this.deposit.address}`
        )

        const { r, s, recoveryID } = signatureEvent.returnValues
        const publicKeyPoint = await this.deposit.publicKeyPoint

        // If needed, submit redemption signature to the deposit.
        if (
          (await this.deposit.getCurrentState()) !=
          this.deposit.factory.State.AWAITING_WITHDRAWAL_PROOF
        ) {
          // A constant in the Ethereum ECDSA signature scheme, used for public key recovery [1]
          // Value is inherited from Bitcoin's Electrum wallet [2]
          // [1] https://bitcoin.stackexchange.com/questions/38351/ecdsa-v-r-s-what-is-v/38909#38909
          // [2] https://github.com/ethereum/EIPs/issues/155#issuecomment-253810938
          const ETHEREUM_ECDSA_RECOVERY_V = toBN(27)
          const v = toBN(recoveryID).add(ETHEREUM_ECDSA_RECOVERY_V)

          await EthereumHelpers.sendSafely(
            this.deposit.contract.methods.provideRedemptionSignature(
              v.toString(),
              r.toString(),
              s.toString()
            )
          )

          console.debug(
            `Submitted redemption signature for deposit ${this.deposit.address}`
          )
        }

        const signedTransaction = BitcoinHelpers.Transaction.addWitnessSignature(
          unsignedTransactionDetails.hex,
          0,
          r.replace("0x", ""),
          s.replace("0x", ""),
          BitcoinHelpers.publicKeyPointToPublicKeyString(
            publicKeyPoint.x,
            publicKeyPoint.y
          )
        )

        return signedTransaction
      }
    )
  }

  /**
   * @typedef {Object} AutoSubmitState
   * @prop {Promise<string>} broadcastTransactionID
   * @prop {Promise<{ transactionID: string, requiredConfirmations: Number }>} confirmations
   * @prop {Promise<TransactionReceipt>} proofTransaction
   */
  /**
   * This method enables the redemption's auto-submission capabilities.
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
    if (this.autoSubmittingState) {
      return this.autoSubmittingState
    }

    const broadcastTransactionID = this.signedTransaction.then(
      async signedTransaction => {
        console.debug(
          `Looking for existing signed redemption transaction on Bitcoin ` +
            `chain for deposit ${this.deposit.address}...`
        )

        const {
          utxoValue,
          requestedFee,
          redeemerOutputScript,
          outpoint: fundingOutpoint
        } = await this.redemptionDetails
        const expectedValue = utxoValue.sub(requestedFee).toNumber()
        /** @type {import("./BitcoinHelpers.js").PartialTransactionInBlock?} */
        let transaction = await BitcoinHelpers.Transaction.findScript(
          EthereumHelpers.bytesToRaw(redeemerOutputScript),
          expectedValue,
          fundingOutpoint
        )

        if (transaction) {
          console.debug(
            `Found existing redemption transaction on Bitcoin chain ` +
              `for deposit ${this.deposit.address}`
          )
        } else {
          console.debug(
            `Broadcasting signed redemption transaction to Bitcoin chain ` +
              `for deposit ${this.deposit.address}...`
          )
          transaction = await BitcoinHelpers.Transaction.broadcast(
            signedTransaction
          )
        }
        return transaction.transactionID
      }
    )

    const confirmations = broadcastTransactionID.then(async transactionID => {
      const requiredConfirmations = await this.deposit.requiredConfirmations

      console.debug(
        `Waiting for ${requiredConfirmations} confirmations for ` +
          `Bitcoin transaction ${transactionID}...`
      )
      await BitcoinHelpers.Transaction.waitForConfirmations(
        transactionID,
        requiredConfirmations,
        ({ transactionID, confirmations, requiredConfirmations }) => {
          this.receivedConfirmationEmitter.emit("receivedConfirmation", {
            transactionID,
            confirmations,
            requiredConfirmations
          })
        }
      )

      return { transactionID, requiredConfirmations }
    })

    const proofTransaction = confirmations.then(
      async ({ transactionID, requiredConfirmations }) => {
        console.debug(
          `Transaction is sufficiently confirmed; submitting redemption ` +
            `proof to deposit ${this.deposit.address}...`
        )
        return this.proveWithdrawal(transactionID, requiredConfirmations)
      }
    )

    this.autoSubmittingState = {
      broadcastTransactionID,
      confirmations,
      proofTransaction
    }

    // TODO bumpFee if needed
    return this.autoSubmittingState
  }

  /**
   * Proves the withdrawal of the BTC in this deposit via the Bitcoin
   * transaction with id `transactionID`.
   *
   * @param {string} transactionID A hexadecimal transaction id hash for the
   *        transaction that completes the withdrawal of this deposit's BTC.
   * @param {number} confirmations The number of confirmations required for
   *        the proof; if this is not provided or is 0, looks up the required
   *        confirmations via the deposit.
   */
  async proveWithdrawal(transactionID, confirmations) {
    if (!confirmations) {
      // 0 still triggers a lookup
      confirmations = (
        await this.deposit.factory
          .constants()
          .methods.getTxProofDifficultyFactor()
          .call()
      ).toNumber()
    }

    const provableTransaction = {
      transactionID: transactionID,
      // For filtering, see provideRedemptionProof call below.
      outputPosition: -1
    }
    const proofArgs = await this.deposit.constructFundingProof(
      provableTransaction,
      confirmations
    )

    const proofReceipt = EthereumHelpers.sendSafely(
      this.deposit.contract.methods.provideRedemptionProof(
        // Redemption proof does not take the output position as a
        // parameter, as all redemption transactions are one-input-one-output
        // However, constructFundingProof includes it for deposit funding
        // proofs. Here, we filter it out to produce the right set of
        // parameters.
        ...proofArgs.filter(_ => _ !== -1)
      )
    )

    proofReceipt.then(() =>
      this.withdrawnEmitter.emit("withdrawn", transactionID)
    )

    return proofReceipt
  }

  /**
   * A callback that receives a raw Bitcoin transaction as an unprefixed
   * hexadecimal string. The return value is ignored.
   *
   * @callback RawBitcoinTransactionHandler
   * @param {string} rawTransactionHex The raw Bitcoin transaction as an
   *        unprefixed hexadecimal string.
   */

  /**
   * @param {RawBitcoinTransactionHandler} transactionHandler
   */
  onBitcoinTransactionSigned(transactionHandler) {
    this.signedTransaction.then(transactionHandler)
  }

  /**
   * A callback that receives a Bitcoin transaction id as an unprefixed
   * hexadecimal string. The return value is ignored.
   *
   * @callback BitcoinTransactionIdHandler
   * @param {string} transactionID The Bitcoin transaction id as an unprefixed
   *        hexadecimal string.
   */

  /**
   * @param {BitcoinTransactionIdHandler} withdrawalHandler The handler that
   *        should be called when the redemption transaction is proven. Passes
   *        the transaction id of the redeeming Bitcoin transaction.
   */
  onWithdrawn(withdrawalHandler) {
    this.withdrawnEmitter.on("withdrawn", withdrawalHandler)
  }

  /**
   * Registers a handler for notification when the Bitcoin transaction
   * has received a confirmation
   *
   * @param {OnReceivedConfirmationHandler} onReceivedConfirmationHandler
   *        A handler that passes an object with the transactionID,
   *        confirmations, and requiredConfirmations as its parameter
   */
  onReceivedConfirmation(onReceivedConfirmationHandler) {
    this.receivedConfirmationEmitter.on(
      "receivedConfirmation",
      onReceivedConfirmationHandler
    )
  }

  /**
   * Fetches the latest redemption details from the chain. These can change
   * after fee bumps. Throws if the deposit does not have a redemption
   * currently in progress.
   *
   * @param {RedemptionDetails} existingRedemptionDetails An optional override
   *        to shortcut explicit redemption detail lookup.
   *
   * @return {Promise<RedemptionDetails>} The passed existing redemption
   *         details, or the result of looking these up on-chain if none were
   *         past.
   */
  async getLatestRedemptionDetails(existingRedemptionDetails) {
    if (existingRedemptionDetails) {
      return existingRedemptionDetails
    }

    const latestDetails = await this.deposit.getLatestRedemptionDetails()
    if (!latestDetails) {
      throw new Error(
        `No redemption currently in progress for deposit at address ${this.deposit.address}`
      )
    }

    return latestDetails
  }
}
