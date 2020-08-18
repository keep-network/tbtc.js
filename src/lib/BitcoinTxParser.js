import BcoinPrimitives from "bcoin/lib/primitives/index.js"
const { TX } = BcoinPrimitives
import bufio from "bufio"

/** @typedef { import('bcoin/lib/primitives/tx.js') } TX */
/** @typedef { import('bufio').StaticWriter } StaticWriter */
/** @typedef { import('bufio').BufferWriter } BufferWriter */

/**
 * @typedef {object} TransactionData
 * @property {string} version The transaction's version field as an unprefixed
 *           hexadecimal string.
 * @property {string} txInVector The transaction's input vector as an unprefixed
 *           hexadecimal string.
 * @property {string} txOutVector The transaction's output vector as an
 *           unprefixed hexadecimal string.
 * @property {string} locktime The transaction's locktime field as an unprefixed
 *           hexadecimal string.
 */

/**
 * Parses the given raw transaction data to a set of fields extracted from that
 * transaction.
 *
 * @param {string} rawTx Raw transaction data as an unprefixed hexadecimal
 *        string.
 * @return {TransactionData} The deserialized transaction data.
 */
function parse(rawTx) {
  const tx = TX.fromRaw(Buffer.from(rawTx, "hex"), null)

  return {
    version: getTxVersion(tx),
    txInVector: getTxInputVector(tx),
    txOutVector: getTxOutputVector(tx),
    locktime: getTxLocktime(tx)
  }
}

/**
 * @param {TX} tx The bcoin transaction to pull the version from.
 * @return {string} The transaction version as an unprefixed hexadecimal string.
 */
function getTxVersion(tx) {
  const buffer = bufio.write()
  buffer.writeU32(tx.version)

  return toHex(buffer)
}

/**
 * @param {TX} tx The bcoin transaction to pull the input vector from.
 * @return {string} The transaction input vector as an unprefixed hexadecimal
 *         string.
 */
function getTxInputVector(tx) {
  return vectorToRaw(tx.inputs)
}

/**
 * @param {TX} tx The bcoin transaction to pull the output vector from.
 * @return {string} The transaction output vector as an unprefixed hexadecimal
 *         string.
 */
function getTxOutputVector(tx) {
  return vectorToRaw(tx.outputs)
}

/**
 * @param {TX} tx The bcoin transaction to pull the locktime from.
 * @return {string} The transaction locktime as an unprefixed hexadecimal
 *         string.
 */
function getTxLocktime(tx) {
  const buffer = bufio.write()
  buffer.writeU32(tx.locktime)

  return toHex(buffer)
}

/**
 * @param {any[]} elements A vector of untyped elements.
 * @return {string} The vector as an unprefixed hexadecimal string, with a
 *         varint representing vector length followed by the encoded hex version
 *         of each element.
 */
function vectorToRaw(elements) {
  const buffer = bufio.write()
  buffer.writeVarint(elements.length)

  for (const element of elements) {
    element.toWriter(buffer)
  }

  return toHex(buffer)
}

/**
 * @param {StaticWriter | BufferWriter} bufferWriter The bufferWriter to render
 *        to an unprefixed hex string.
 * @return {string} The unprefixed hex string representation of the data in the
 *         passed buffer writer.
 */
function toHex(bufferWriter) {
  return bufferWriter.render().toString("hex")
}

export const BitcoinTxParser = {
  parse
}
