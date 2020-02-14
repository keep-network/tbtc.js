import EventEmitter from 'events'

import BitcoinHelpers from "./BitcoinHelpers.js"

import EthereumHelpers from "./EthereumHelpers.js"

/**
 * Details of a given redemption at a given point in time.
 * @typedef RedemptionDetails
 * @type {Object}
 * @property {BN} utxoSize The size of the UTXO size in the redemption.
 * @property {Buffer} requesterPKH The raw requester publicKeyHash bytes.
 * @property {BN} requestedFee The fee for the redemption transaction.
 * @property {Buffer} outpoint The raw outpoint bytes.
 * @property {Buffer} digest The raw digest bytes.
 */

/**
 * Details of a given unsigned transaction
 * @typedef UnsignedTransactionDetails
 * @type {Object}
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

    constructor(deposit/*: Deposit*/, redemptionDetails/*: RedemptionDetails?*/) {
        this.deposit = deposit
        this.withdrawnEmitter = new EventEmitter()

        this.redemptionDetails = this.getLatestRedemptionDetails(redemptionDetails)

        this.unsignedTransactionDetails = this.redemptionDetails.then((details) => {
            const outputValue = details.utxoSize.sub(details.requestedFee)
            const unsignedTransaction =
                BitcoinHelpers.Transaction.constructOneInputOneOutputWitnessTransaction(
                    details.outpoint.replace('0x', ''),
                    // We set sequence to `0` to be able to replace by fee. It reflects
                    // bitcoin-spv:
                    // https://github.com/summa-tx/bitcoin-spv/blob/2a9d594d9b14080bdbff2a899c16ffbf40d62eef/solidity/contracts/CheckBitcoinSigs.sol#L154
                    0,
                    outputValue.toNumber(),
                    details.requesterPKH.replace('0x', ''),
                )

            return {
                hex: unsignedTransaction,
                digest: details.digest,
            }
        })

        this.signedTransaction = this.unsignedTransactionDetails.then(async (unsignedTransactionDetails) => {
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
                'SignatureSubmitted',
                { digest: redemptionDigest },
            )
            const { r, s } = signatureEvent.args
            const publicKeyPoint = await this.deposit.publicKeyPoint

            const signedTransaction = BitcoinHelpers.Transaction.addWitnessSignature(
                unsignedTransactionDetails.hex,
                0,
                r.replace('0x', ''),
                s.replace('0x', ''),
                BitcoinHelpers.publicKeyPointToPublicKeyString(
                    publicKeyPoint.x,
                    publicKeyPoint.y,
                ),
            )

            return signedTransaction
        })
    }

    // autoSubmitting/*: boolean*/
    autoSubmit() {
        // Only enable auto-submitting once.
        if (this.autoSubmitting) {
            return
        }
        this.autoSubmitting = true

        this.signedTransaction.then(async (signedTransaction) => {
            console.debug(
                `Looking for existing signed redemption transaction on Bitcoin ` +
                `chain for deposit ${this.deposit.address}...`
            )

            const { utxoSize, requestedFee,  requesterPKH } = await this.redemptionDetails
            const expectedValue = utxoSize.sub(requestedFee).toNumber()
            const requesterAddress = BitcoinHelpers.Address.pubKeyHashToBech32(
                requesterPKH.replace('0x', ''),
                this.deposit.factory.config.bitcoinNetwork,
            )
            let transaction = await BitcoinHelpers.Transaction.find(
                requesterAddress,
                expectedValue,
            )

            if (! transaction) {
                console.debug(
                    `Broadcasting signed redemption transaction to Bitcoin chain ` +
                    `for deposit ${this.deposit.address}...`
                )
                transaction = await BitcoinHelpers.Transaction.broadcast(
                    signedTransaction,
                )
            }

            const requiredConfirmations = (await this.deposit.factory.constantsContract.getTxProofDifficultyFactor()).toNumber()

            console.debug(
                `Waiting for ${requiredConfirmations} confirmations for ` +
                `Bitcoin transaction ${transaction.transactionID}...`
            )
            await BitcoinHelpers.Transaction.waitForConfirmations(
                transaction,
                requiredConfirmations,
            )

            console.debug(
                `Transaction is sufficiently confirmed; submitting redemption ` +
                `proof to deposit ${this.deposit.address}...`
            )
            this.proveWithdrawal(transaction.transactionID, requiredConfirmations)
        })
        // TODO bumpFee if needed
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
        if (! confirmations) { // 0 still triggers a lookup
            confirmations = (await this.deposit.factory.constantsContract.getTxProofDifficultyFactor()).toNumber()
        }

        const provableTransaction = {
            transactionID: transactionID,
            // For filtering, see provideRedemptionProof call below.
            outputPosition: 'output position',
        }
        const proofArgs = await this.deposit.constructFundingProof(
            provableTransaction,
            confirmations,
        )

        proofArgs.push({ from: this.deposit.factory.config.web3.eth.defaultAccount })
        await this.deposit.contract.provideRedemptionProof.apply(
            this.deposit.contract,
            // Redemption proof does not take the output position as a
            // parameter, as all redemption transactions are one-input-one-output
            // However, constructFundingProof includes it for deposit funding
            // proofs. Here, we filter it out to produce the right set of
            // parameters.
            proofArgs.filter((_) => _ != 'output position'),
        )

        this.withdrawnEmitter.emit('withdrawn', transactionID)
    }

    onBitcoinTransactionSigned(transactionHandler/*: (transaction)=>void*/) {
        this.signedTransaction.then(transactionHandler)
    }

    onWithdrawn(withdrawalHandler/*: (txHash)=>void*/) { // bitcoin txHash
        this.withdrawnEmitter.on('withdrawn', withdrawalHandler)
    }

    /**
     * Fetches the latest redemption details from the chain. These can change
     * after fee bumps.
     */
    async getLatestRedemptionDetails(existingRedemptionDetails/*: RedemptionDetails?*/) {
        if (existingRedemptionDetails) {
            return existingRedemptionDetails
        }

        return await this.deposit.getLatestRedemptionDetails()
    }
}
