import secp256k1 from "bcrypto/lib/secp256k1.js"
import BcoinPrimitives from "bcoin/lib/primitives/index.js"
import BcoinScript from "bcoin/lib/script/index.js"
import BcryptoSignature from "bcrypto/lib/internal/signature.js"
const { KeyRing } = BcoinPrimitives
const { Script } = BcoinScript

import bcoin from "bcoin/lib/bcoin-browser.js"

import { BitcoinSPV } from "./lib/BitcoinSPV.js"
import { BitcoinTxParser } from "./lib/BitcoinTxParser.js"
import ElectrumClient from "./lib/ElectrumClient.js"

import BN from "bn.js"

/** @typedef { import("./lib/BitcoinSPV.js").Proof } Proof */

/** @enum {string} */
const BitcoinNetwork = {
  TESTNET: "testnet",
  MAINNET: "mainnet",
  SIMNET: "simnet"
}

/**
 * Found transaction details.
 * @typedef FoundTransaction
 * @type {Object}
 * @property {string} transactionID Transaction ID.
 * @property {number} outputPosition Position of output in the transaction.
 * @property {number} value Value of the output (satoshis).
 */

/**
 * @typedef {Object} ParsedTransaction
 * @property {string} version The transaction version as an unprefixed hex
 *           string.
 * @property {string} txInVector The transaction input vector as an unprefixed
 *           (i.e. without leading 0x), length-prefixed raw hex string.
 * @property {string} txOutVector The transaction output vector as an
 *           unprefixed (i.e. without leading 0x), length-prefixed raw hex
 *           string.
 * @property {string} locktime The transaction locktime as an unprefixed hex
 *           string.
 */

/**
 * @typedef {Object} SPVProof
 * @extends {Proof}
 * @property {ParsedTransaction} parsedTransaction Parsed transaction with
 *           additional data useful in submitting SPV proofs, stored as buffers.
 */

const BitcoinHelpers = {
  satoshisPerBtc: new BN(10).pow(new BN(8)),

  Network: BitcoinNetwork,

  electrumConfig: null,
  /**
   * Updates the config to use for Electrum client connections. Electrum is
   * the core mechanism used to interact with the Bitcoin blockchain.
   *
   * @param {ElectrumConfig} newConfig The config to use for future Electrum
   *        connections.
   */
  setElectrumConfig: function(newConfig) {
    BitcoinHelpers.electrumConfig = newConfig
  },

  /**
   * Converts signature provided as `r` and `s` values to a bitcoin signature
   * encoded to the DER format:
   *   30 <length total> 02 <length r> <r (BE)> 02 <length s> <s (BE)>
   * It also checks `s` value and converts it to a low value if necessary as per
   * [BIP-0062](https://github.com/bitcoin/bips/blob/master/bip-0062.mediawiki#low-s-values-in-signatures).
   *
   * @param {string} r A signature's `r` value in hexadecimal format.
   * @param {string} s A signature's `s` value in hexadecimal format.
   *
   * @return {Buffer} The signature in the DER format.
   */
  signatureDER: function(r, s) {
    const size = secp256k1.size
    const signature = new BcryptoSignature(
      size,
      Buffer.from(r, "hex"),
      Buffer.from(s, "hex")
    )

    // Verifies if either of `r` or `s` values equals zero or is greater or equal
    // curve's order. If so throws an error.
    // Checks if `s` is a high value. As per BIP-0062 signature's `s` value should
    // be in a low half of curve's order. If it's a high value it's converted to
    // `-s`.
    // Checks `s` per BIP-62: signature's `s` value should be in a low half of
    // curve's order. If it's not, it's converted to `-s`.
    const bitcoinSignature = secp256k1.signatureNormalize(
      signature.encode(size)
    )

    return BcryptoSignature.toDER(bitcoinSignature, size)
  },
  /**
   * Takes the x and y coordinates of a public key point and returns a
   * hexadecimal representation of 64-byte concatenation of x and y
   * coordinates.
   *
   * @param {string} publicKeyX A hex public key X coordinate.
   * @param {string} publicKeyY A hex public key Y coordinate.
   *
   * @return {string} An unprefixed, concatenated hex representation of the two
   *         given coordinates.
   */
  publicKeyPointToPublicKeyString: function(publicKeyX, publicKeyY) {
    return `${publicKeyX.replace("0x", "")}${publicKeyY.replace("0x", "")}`
  },
  Address: {
    pubKeyHashFrom: function(address) {
      const script = bcoin.Script.fromAddress(address)
      return script.getWitnessPubkeyhash()
    },
    publicKeyPointToP2WPKHAddress: function(
      publicKeyX,
      publicKeyY,
      bitcoinNetwork
    ) {
      return this.publicKeyToP2WPKHAddress(
        BitcoinHelpers.publicKeyPointToPublicKeyString(publicKeyX, publicKeyY),
        bitcoinNetwork
      )
    },
    /**
     * Converts the specified `pubKeyHash` to a valid Bech32 address for
     * the specified `network`.
     *
     * @param {string} pubKeyHash A pubKeyHash as a string.
     * @param {string} network The Bitcoin network for the Bech32 address.
     *
     * @return {string} A Bech32 address to
     */
    pubKeyHashToBech32: function(pubKeyHash, network) {
      return Script.fromProgram(0, Buffer.from(pubKeyHash, "hex"))
        .getAddress()
        .toBech32(network)
    },
    /**
     * Converts public key to bitcoin Witness Public Key Hash Address according to
     * [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki).
     * @param {string} publicKeyString Public key as a hexadecimal representation of
     * 64-byte concatenation of x and y coordinates.
     * @param {BitcoinNetwork} network Network for which address has to be calculated.
     * @return {string} A Bitcoin P2WPKH address for given network.
     */
    publicKeyToP2WPKHAddress: function(publicKeyString, network) {
      const publicKeyBytes = Buffer.from(publicKeyString, "hex")

      // Witness program requires usage of compressed public keys.
      const compress = true

      const publicKey = secp256k1.publicKeyImport(publicKeyBytes, compress)
      const keyRing = KeyRing.fromKey(publicKey, compress)
      const p2wpkhScript = Script.fromProgram(0, keyRing.getKeyHash())

      // Serialize address to a format specific to given network.
      return p2wpkhScript.getAddress().toString(network)
    },
    /**
     * Converts a Bitcoin ScriptPubKey address string to a hex script
     * string.
     *
     * @param {string} address A Bitcoin address.
     *
     * @return {string} A Bitcoin script for the given address, as an
     *         unprefixed hex string.
     */
    toScript: function(address) {
      return BitcoinHelpers.Address.toRawScript(address).toString("hex")
    },
    /**
     * Converts a Bitcoin ScriptPubKey address string to a raw script
     * buffer.
     *
     * @param {string} address A Bitcoin address.
     *
     * @return {string} A Bitcoin script for the given address, as a Buffer
     *         of bytes.
     */
    toRawScript: function(address) {
      return Script.fromAddress(address).toRaw()
    }
  },
  /**
   * Sets up an Electrum client instance and passes it to the passed `block`,
   * setting the Electrum client to be closed once the promise the block returns
   * completes. Returns a promise to the block's final result.
   *
   * Example usage:
   *
   *   const value = await BitcoinHelpers.withElectrumClient(async (client) => {
   *     return client.lookUpValue()
   *   })
   *
   * @param {function(ElectrumClient):Promise<T>} block A function to execute
   *        with the ElectrumClient passed in; it is expected to return a
   *        Promise that will resolve once the function is finished performing
   *        work with the client. withElectrumClient returns that promise, but
   *        also ensures that the client will be closed once the promise
   *        completes (successfully or unsuccessfully).
   * @template T
   */
  withElectrumClient: async function(block) {
    const electrumClient = new ElectrumClient(
      BitcoinHelpers.electrumConfig.testnetWS
    )

    await electrumClient.connect()

    const result = block(electrumClient)
    result.then(
      () => {
        electrumClient.close()
      },
      () => {
        electrumClient.close()
      }
    )

    return result
  },
  Transaction: {
    /**
     * Finds a transaction to the given `bitcoinAddress` of the given
     * `expectedValue`. If there is more than one such transaction, returns
     * the most recent one.
     *
     * @param {string} bitcoinAddress A receiving Bitcoin address.
     * @param {number} expectedValue The expected value of the transaction
     *        to fetch.
     *
     * @return {Promise<FoundTransaction>} A promise to an object of
     *         transactionID, outputPosition, and value, that resolves with
     *         either null if such a transaction could not be found, or the
     *         information about the transaction that was found.
     */
    find: async function(bitcoinAddress, expectedValue) {
      const script = BitcoinHelpers.Address.toScript(bitcoinAddress)

      return await BitcoinHelpers.Transaction.findScript(script, expectedValue)
    },
    /**
     * Finds a transaction to the given `outputScript` of the given
     * `expectedValue`. If there is more than one such transaction, returns
     * the most recent one.
     *
     * @param {string} outputScript A Bitcoin output script to look for as a
     *        non-0x-prefixed hex string.
     * @param {number} expectedValue The expected value of the transaction
     *        to fetch.
     *
     * @return {Promise<FoundTransaction>} A promise to an object of
     *         transactionID, outputPosition, and value, that resolves with
     *         either null if such a transaction could not be found, or the
     *         information about the transaction that was found.
     */
    findScript: async function(outputScript, expectedValue) {
      return await BitcoinHelpers.withElectrumClient(electrumClient => {
        return BitcoinHelpers.Transaction.findWithClient(
          electrumClient,
          outputScript,
          expectedValue
        )
      })
    },
    /**
     * Watches the Bitcoin chain for a transaction of value `expectedValue`
     * to address `bitcoinAddress`.
     *
     * @param {string} bitcoinAddress Bitcoin address to watch.
     * @param {number} expectedValue The expected value to watch for.
     *
     * @return {Promise<FoundTransaction>} A promise to the found
     *         transaction once it is seen on the chain.
     */
    findOrWaitFor: async function(bitcoinAddress, expectedValue) {
      return await BitcoinHelpers.withElectrumClient(async electrumClient => {
        const script = BitcoinHelpers.Address.toScript(bitcoinAddress)

        // This function is used as a callback to electrum client. It is
        // invoked when an existing or a new transaction is found.
        const checkTransactions = async function(status) {
          // If the status is set, transactions were seen for the
          // script.
          if (status) {
            const result = BitcoinHelpers.Transaction.findWithClient(
              electrumClient,
              script,
              expectedValue
            )

            return result
          }
        }

        return electrumClient.onTransactionToScript(script, checkTransactions)
      })
    },
    /**
     * Checks the given Bitcoin `transaction` to ensure it has at least
     * `requiredConfirmations` on-chain. If it does, resolves the returned
     * promise with the current number of on-chain confirmations. If it does
     * not, fulfills the promise with `null`.
     *
     * @param {FoundTransaction} transaction A transaction object whose
     *        confirmations will be checked.
     * @param {number} requiredConfirmations A number of required
     *        confirmations below which this function will return null.
     *
     * @return {Promise<number>} A promise to the current number of
     *         confirmations for the given `transaction`, iff that transaction has
     *         at least `requiredConfirmations` confirmations.
     */
    checkForConfirmations: async function(transaction, requiredConfirmations) {
      const id = transaction.transactionID

      return BitcoinHelpers.withElectrumClient(async electrumClient => {
        return await BitcoinHelpers.Transaction.checkForConfirmationsWithClient(
          electrumClient,
          id,
          requiredConfirmations
        )
      })
    },
    /**
     * Watches the Bitcoin chain until the given `transactionID` has the given
     * number of `requiredConfirmations`.
     *
     * @param {string} transactionID A hex Bitcoin transaction id hash.
     * @param {number} requiredConfirmations The number of required
     *        confirmations to wait before returning.
     *
     * @return {Promise<number>} A promise to the final number of confirmations
     *         observed that was at least equal to the required confirmations.
     */
    waitForConfirmations: async function(transactionID, requiredConfirmations) {
      return BitcoinHelpers.withElectrumClient(async electrumClient => {
        const checkConfirmations = async function() {
          return await BitcoinHelpers.Transaction.checkForConfirmationsWithClient(
            electrumClient,
            transactionID,
            requiredConfirmations
          )
        }

        return electrumClient.onNewBlock(checkConfirmations)
      })
    },
    /**
     * Estimates the fee that would be needed for a given transaction.
     *
     * @param {object} tbtcConstantsContract The TBTCConstants contract that
     *        provides the stub value for this function.
     *
     * @warning This is a stub. Currently it takes the TBTCConstants
     *          contract and returns its reported minimum fee, rather than
     *          calling electrumClient.blockchainEstimateFee.
     *
     * @return {Promise<number>} The estimated fee to execute the provided
     *         transaction.
     */
    estimateFee: async function(tbtcConstantsContract) {
      return tbtcConstantsContract.methods.getMinimumRedemptionFee().call()
    },
    /**
     * For the given `transactionID`, constructs an SPV proof that proves it
     * has at least `confirmations` confirmations on the Bitcoin chain.
     * Returns data for this proof, as well as the parsed Bitcoin
     * transaction data.
     *
     * @param {string} transactionID A hex Bitcoin transaction id hash.
     * @param {number} confirmations The number of confirmations to include
     *        in the proof.
     *
     * @return {SPVProof} The proof data, plus the parsed transaction for the proof.
     */
    getSPVProof: async function(transactionID, confirmations) {
      return await BitcoinHelpers.withElectrumClient(async electrumClient => {
        const spv = new BitcoinSPV(electrumClient)
        const proof = await spv.getTransactionProof(
          transactionID,
          confirmations
        )

        return {
          ...proof,
          parsedTransaction: BitcoinTxParser.parse(proof.tx)
        }
      })
    },
    /**
     * Broadcasts the given signed transaction to the Bitcoin chain.
     *
     * @param {string} signedTransaction The signed transaction in
     *        hexadecimal format.
     *
     * @return {Promise<FoundTransaction>} A partial FoundTransaction with
     *         the transactionID field set.
     */
    broadcast: async function(signedTransaction) {
      return await BitcoinHelpers.withElectrumClient(async electrumClient => {
        const transactionID = await electrumClient.broadcastTransaction(
          signedTransaction
        )

        return {
          transactionID: transactionID
        }
      })
    },
    /**
     * Adds a witness signature for an input in a transaction.
     *
     * @param {string} unsignedTransaction Unsigned raw bitcoin transaction
     *        in hexadecimal format.
     * @param {uint32} inputIndex Index number of input to be signed.
     * @param {string} r Signature's `r` value in hexadecimal format.
     * @param {string} s Signature's `s` value in hexadecimal format.
     * @param {string} publicKey 64-byte signer's public key's concatenated
     *        x and y coordinates in hexadecimal format.
     *
     * @return {string} Raw transaction in a hexadecimal format with witness
     *         signature.
     */
    addWitnessSignature: function(
      unsignedTransaction,
      inputIndex,
      r,
      s,
      publicKey
    ) {
      // Signature
      let signatureDER
      try {
        signatureDER = BitcoinHelpers.signatureDER(r, s)
      } catch (err) {
        throw new Error(`failed to convert signature to DER format: [${err}]`)
      }

      const hashType = Buffer.from([bcoin.Script.hashType.ALL])
      const sig = Buffer.concat([signatureDER, hashType])

      // Public Key
      let compressedPublicKey
      try {
        const publicKeyBytes = Buffer.from(publicKey, "hex")
        compressedPublicKey = secp256k1.publicKeyImport(publicKeyBytes, true)
      } catch (err) {
        throw new Error(`failed to import public key: [${err}]`)
      }

      // Combine witness
      let signedTransaction
      try {
        signedTransaction = bcoin.TX.fromRaw(unsignedTransaction, "hex").clone()
      } catch (err) {
        throw new Error(`failed to import transaction: [${err}]`)
      }

      signedTransaction.inputs[inputIndex].witness.fromItems([
        sig,
        compressedPublicKey
      ])

      return signedTransaction.toRaw().toString("hex")
    },
    /**
     * Constructs a Bitcoin SegWit transaction with one input and one
     * output. Difference between previous output's value and current's
     * output value will be taken as a transaction fee.
     *
     * @param {string} previousOutpoint Previous transaction's output to be
     *        used as an input. Provided in hexadecimal format, consists of
     *        32-byte transaction ID and 4-byte output index number.
     * @param {uint32} inputSequence Input's sequence number. As per
     *        BIP-125 the value is used to indicate that transaction should
     *        be able to be replaced in the future. If input sequence is set
     *        to `0xffffffff` the transaction won't be replaceable.
     * @param {number} outputValue Value for the output.
     * @param {string} outputScript Output script for the transaction as an
     *        unprefixed hexadecimal string.
     *
     * @return {string} Raw bitcoin transaction in hexadecimal format.
     */
    constructOneInputOneOutputWitnessTransaction(
      previousOutpoint,
      inputSequence,
      outputValue,
      outputScript
    ) {
      // Input
      const prevOutpoint = bcoin.Outpoint.fromRaw(
        Buffer.from(previousOutpoint, "hex")
      )

      const input = bcoin.Input.fromOptions({
        prevout: prevOutpoint,
        sequence: inputSequence
      })

      // Output
      const rawOutputScript = Buffer.from(outputScript, "hex")

      const output = bcoin.Output.fromOptions({
        value: outputValue,
        script: rawOutputScript
      })

      // Transaction
      const transaction = bcoin.TX.fromOptions({
        inputs: [input],
        outputs: [output]
      })

      return transaction.toRaw().toString("hex")
    },

    // Raw helpers.
    /**
     * Finds a transaction to the given `receiverScript` of the given
     * `expectedValue` using the given `electrumClient`. If there is more
     * than one such transaction, returns the most recent one.
     *
     * @param {ElectrumClient} electrumClient An already-initialized Electrum client.
     * @param {string} receiverScript A receiver script.
     * @param {number} expectedValue The expected value of the transaction
     *        to fetch.
     *
     * @return {Promise<FoundTransaction>} A promise to an object of
     *         transactionID, outputPosition, and value, that resolves with
     *         either null if such a transaction could not be found, or the
     *         information about the transaction that was found.
     */
    findWithClient: async function(
      electrumClient,
      receiverScript,
      expectedValue
    ) {
      const unspentTransactions = await electrumClient.getUnspentToScript(
        receiverScript
      )

      for (const tx of unspentTransactions.reverse()) {
        if (tx.value == expectedValue) {
          return {
            transactionID: tx.tx_hash,
            outputPosition: tx.tx_pos,
            value: tx.value
          }
        }
      }
    },
    checkForConfirmationsWithClient: async function(
      electrumClient,
      transactionID,
      requiredConfirmations
    ) {
      const { confirmations } = await electrumClient.getTransaction(
        transactionID
      )
      if (confirmations >= requiredConfirmations) {
        return confirmations
      }
    }
  }
}

export default BitcoinHelpers
