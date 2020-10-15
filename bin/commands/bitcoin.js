/** @typedef {import('../tbtc.js').CommandAction} CommandAction */
/** @typedef {import('../../src/TBTC.js').ElectrumConfig} ElectrumConfig */
/** @typedef {import('../../src/TBTC.js').Web3} Web3 */
/** @typedef {import('../../src/TBTC.js').TBTC} TBTCInstance */

import { BitcoinHelpers } from "../../index.js"

import sha256 from "bcrypto/lib/sha256-browser.js"
const { digest } = sha256

export const bitcoinCommandHelp = [
  `digest <transaction-id> <output-index> <output-address>
    Builds a new Bitcoin transaction that can be replaced by fee and outputs the
    digest for that transaction. The transaction id is the id of the transaction
    whose output will be used as an input to this transaction. The output index
    is the index in the referenced transaction that should be used as an input
    to this transaction. The output address should be a bech32 Bitcoin
    address, which will be set up to receive the value at the given transaction
    id and output index, less a Bitcoin transaction fee.`,
  `broadcast <transaction-id> <output-index> <output-address> <signer-pubkey> <digest-signature>
    Builds a new Bitcoin transaction that can be replaced by fee and broadcasts
    it to the Bitcoin chain. The transaction id is the id of the transaction
    whose output will be used as an input to this transaction. The output index
    is the index in the referenced transaction that should be used as an input
    to this transaction. The output address should be a bech32 Bitcoin
    address, which will be set up to receive the value at the given transaction
    id and output index, less a Bitcoin transaction fee. The signer pubkey is
    the public key of the signer as an unprefixed 64-byte hex string of
    concatenated x and y coordinates. The digest signature is an unprefixed
    64-byte hex string representation of the signature's r and s values.`
]

/**
 * @param {Web3} web3 An initialized Web3 instance TBTC is configured to use.
 * @param {Array<string>} args
 * @return {CommandAction | null}
 */
export function parseBitcoinCommand(web3, args) {
  if (args.length > 0) {
    const [command, ...commandArgs] = args
    switch (command) {
      case "digest":
        {
          const [
            previousTransactionID,
            previousOutputIndex,
            outputAddress,
            ...extra
          ] = commandArgs

          if (extra.length === 0) {
            return async tbtc => {
              const toBN = web3.utils.toBN
              const rawOutputScript = BitcoinHelpers.Address.toRawScript(
                outputAddress
              )
              const rawPreviousOutpoint = Buffer.concat([
                toBN(previousTransactionID).toArrayLike(Buffer, "le", 32),
                toBN(previousOutputIndex).toArrayLike(Buffer, "le", 4)
              ])

              const {
                value: previousOutputValueBtc,
                address: previousOutputAddress
              } = await BitcoinHelpers.Transaction.getSimpleOutput(
                previousTransactionID,
                parseInt(previousOutputIndex, 16)
              )
              const previousOutputValue =
                previousOutputValueBtc *
                BitcoinHelpers.satoshisPerBtc.toNumber()
              const rawPreviousOutputScript = BitcoinHelpers.Address.toRawScript(
                previousOutputAddress
              )
              const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
                tbtc.depositFactory.constants()
              )

              const outputValue = toBN(previousOutputValue).sub(
                transactionFee.divn(4)
              )
              /** @type {Buffer} */
              const outputValueBytes = outputValue.toArrayLike(Buffer, "le", 8)

              // Construct per BIP-143; see https://en.bitcoin.it/wiki/BIP_0143
              // for more.
              const sighashPreimage = Buffer.concat(
                [
                  // version
                  `01000000`,
                  // hashPrevouts
                  digest(digest(rawPreviousOutpoint)),
                  // hashSequence(00000000)
                  digest(digest(Buffer.from("00000000", "hex"))),
                  // outpoint
                  rawPreviousOutpoint,
                  // P2wPKH script:
                  Buffer.concat([
                    // length, dup, hash160, pkh_length
                    Buffer.from("1976a914", "hex"),
                    // pkh, without prefix length info
                    rawPreviousOutputScript.slice(2),
                    // equal, checksig
                    Buffer.from("88ac", "hex")
                  ]),
                  // 8-byte little-endian input value (= previous output value)
                  toBN(previousOutputValue).toArrayLike(Buffer, "le", 8),
                  // input nSequence
                  "00000000",
                  // hash of the single output
                  digest(
                    digest(
                      Buffer.concat([
                        // value bytes
                        outputValueBytes,
                        // length of output script
                        Buffer.of(rawOutputScript.byteLength),
                        // output script
                        rawOutputScript
                      ])
                    )
                  ),
                  // nLockTime
                  "00000000",
                  // SIG_ALL
                  "01000000"
                ].map(_ => Buffer.from(_, "hex"))
              )

              return digest(digest(sighashPreimage)).toString("hex")
            }
          }
        }
        break
      case "broadcast": {
        const [
          previousTransactionID,
          previousOutputIndex,
          outputAddress,
          publicKeyString,
          digestSignature,
          ...extra
        ] = commandArgs

        if (extra.length === 0) {
          return async tbtc => {
            const toBN = web3.utils.toBN
            const rawOutputScript = BitcoinHelpers.Address.toRawScript(
              outputAddress
            )
            const rawPreviousOutpoint = Buffer.concat([
              toBN(previousTransactionID).toArrayLike(Buffer, "le", 32),
              toBN(previousOutputIndex).toArrayLike(Buffer, "le", 4)
            ])

            const {
              value: previousOutputValueBtc
            } = await BitcoinHelpers.Transaction.getSimpleOutput(
              previousTransactionID,
              parseInt(previousOutputIndex, 16)
            )
            const previousOutputValue =
              previousOutputValueBtc * BitcoinHelpers.satoshisPerBtc.toNumber()
            const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
              tbtc.depositFactory.constants()
            )

            const outputValue = toBN(previousOutputValue).sub(
              transactionFee.divn(4)
            )

            const rawTransaction = BitcoinHelpers.Transaction.constructOneInputOneOutputWitnessTransaction(
              rawPreviousOutpoint.toString("hex"),
              // We set sequence to `0` to be able to replace by fee. It reflects
              // bitcoin-spv:
              // https://github.com/summa-tx/bitcoin-spv/blob/2a9d594d9b14080bdbff2a899c16ffbf40d62eef/solidity/contracts/CheckBitcoinSigs.sol#L154
              0,
              outputValue.toNumber(),
              rawOutputScript.toString("hex")
            )

            const signatureR = digestSignature.slice(0, 64)
            const signatureS = digestSignature.slice(64)
            const publicKeyPoint = BitcoinHelpers.Address.splitPublicKey(
              publicKeyString
            )

            const signedTransaction = BitcoinHelpers.Transaction.addWitnessSignature(
              rawTransaction,
              0,
              signatureR,
              signatureS,
              BitcoinHelpers.publicKeyPointToPublicKeyString(
                publicKeyPoint.x.toString("hex"),
                publicKeyPoint.y.toString("hex")
              )
            )

            const transaction = await BitcoinHelpers.Transaction.broadcast(
              signedTransaction
            )

            return transaction.transactionID
          }
        }
      }
    }
  }

  // If we're here, no command matched.
  return null
}
