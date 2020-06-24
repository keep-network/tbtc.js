import EventEmitter from "events"

import BitcoinHelpers from "./BitcoinHelpers.js"

import EthereumHelpers from "./EthereumHelpers.js"

import web3Utils from "web3-utils"
const { toBN } = web3Utils

/**
 * Details of a given redemption at a given point in time.
 * @typedef {Object} RedemptionDetails
 * @property {BN} utxoSize The size of the UTXO size in the redemption.
 * @property {Buffer} redeemerOutputScript The raw redeemer output script bytes.
 * @property {BN} requestedFee The fee for the redemption transaction.
 * @property {Buffer} outpoint The raw outpoint bytes.
 * @property {Buffer} digest The raw digest bytes.
 */

/**
 * Details of a given unsigned transaction
 * @typedef {Object} UnsignedTransactionDetails
 * @property {string} hex The raw transaction hex string.
 * @property {digest} digest The transaction's digest.
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
  // deposit/*: Deposit*/

  // redemptionDetails/*: Promise<RedemptionDetails>*/
  // unsignedTransaction/*: Promise<UnsignedTransactionDetails>*/
  // signedTransaction/*: Promise<SignedTransactionDetails>*/

  // withdrawnEmitter/*: EventEmitter*/

  constructor(
    deposit /* : Deposit*/,
    redemptionDetails /* : RedemptionDetails?*/
  ) {
    this.deposit = deposit
    this.withdrawnEmitter = new EventEmitter()

    this.redemptionDetails = this.getLatestRedemptionDetails(redemptionDetails)

    this.unsignedTransactionDetails = this.redemptionDetails.then(details => {
      const outputValue = details.utxoSize.sub(details.requestedFee)
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
   * @prop {Promise<BitcoinTransaction>} signedTransaction
   * @prop {Promise<{ transaction: FoundTransaction, requiredConfirmations: Number }>} confirmations
   * @prop {Promise<EthereumTransaction>} proofTransaction
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

    const state = (this.autoSubmittingState = {})

    state.broadcastTransactionID = this.signedTransaction.then(
      async signedTransaction => {
        console.debug(
          `Looking for existing signed redemption transaction on Bitcoin ` +
            `chain for deposit ${this.deposit.address}...`
        )

        const { utxoSize, requestedFee, redeemerOutputScript } = await this
          .redemptionDetails
        const expectedValue = utxoSize.sub(requestedFee).toNumber()
        // FIXME Check that the transaction spends the right UTXO, not just
        // FIXME that it's the right amount to the right address. outpoint
        // FIXME compared against vin is probably the move here.
        let transaction = await BitcoinHelpers.Transaction.findScript(
          EthereumHelpers.bytesToRaw(redeemerOutputScript),
          expectedValue
        )

        if (!transaction) {
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

    state.confirmations = state.broadcastTransactionID.then(
      async transactionID => {
        const requiredConfirmations = parseInt(
          await this.deposit.factory.constantsContract.methods
            .getTxProofDifficultyFactor()
            .call()
        )

        console.debug(
          `Waiting for ${requiredConfirmations} confirmations for ` +
            `Bitcoin transaction ${transactionID}...`
        )
        await BitcoinHelpers.Transaction.waitForConfirmations(
          transactionID,
          requiredConfirmations
        )

        return { transactionID, requiredConfirmations }
      }
    )

    state.proofTransaction = state.confirmations.then(
      async ({ transactionID, requiredConfirmations }) => {
        console.debug(
          `Transaction is sufficiently confirmed; submitting redemption ` +
            `proof to deposit ${this.deposit.address}...`
        )
        return this.proveWithdrawal(transactionID, requiredConfirmations)
      }
    )
    // TODO bumpFee if needed

    return state
  }

  /**
   * Proves the withdrawal of the BTC in this deposit via the Bitcoin
   * transaction with id `transactionID`.
   *
   * @param {string} transactionID A hexadecimal transaction id hash for the
   *        transaction that completes the withdrawal of this deposit's BTC.
   * @param {number} confirmations The number of confirmations required for
   *        the proof; if this is not provided, looks up the required
   *        confirmations via the deposit.
   */
  async proveWithdrawal(transactionID, confirmations) {
    if (!confirmations) {
      // 0 still triggers a lookup
      confirmations = (
        await this.deposit.factory.constantsContract.getTxProofDifficultyFactor()
      ).toNumber()
    }

    const provableTransaction = {
      transactionID: transactionID,
      // For filtering, see provideRedemptionProof call below.
      outputPosition: "output position"
    }
    const proofArgs = await this.deposit.constructFundingProof(
      provableTransaction,
      confirmations
    )

    await EthereumHelpers.sendSafely(
      this.deposit.contract.methods.provideRedemptionProof(
        // Redemption proof does not take the output position as a
        // parameter, as all redemption transactions are one-input-one-output
        // However, constructFundingProof includes it for deposit funding
        // proofs. Here, we filter it out to produce the right set of
        // parameters.
        ...proofArgs.filter(_ => _ != "output position")
      )
    )

    this.withdrawnEmitter.emit("withdrawn", transactionID)
  }

  onBitcoinTransactionSigned(transactionHandler /* : (transaction)=>void*/) {
    this.signedTransaction.then(transactionHandler)
  }

  onWithdrawn(withdrawalHandler /* : (txHash)=>void*/) {
    // bitcoin txHash
    this.withdrawnEmitter.on("withdrawn", withdrawalHandler)
  }

  /**
   * Fetches the latest redemption details from the chain. These can change
   * after fee bumps.
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

    return await this.deposit.getLatestRedemptionDetails()
  }
}
