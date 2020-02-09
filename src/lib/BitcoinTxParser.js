const bcoin_tx = require('bcoin/lib/primitives').TX
const bufio = require('bufio')

function parse(rawTx) {
  tx = bcoin_tx.fromRaw(rawTx, 'hex')

  return {
    version: getTxVersion(tx),
    txInVector: getTxInputVector(tx),
    txOutVector: getTxOutputVector(tx),
    locktime: getTxLocktime(tx),
  }
}

function getTxVersion(tx) {
  const buffer = bufio.write()
  buffer.writeU32(tx.version)

  return toHex(buffer)
}

function getTxInputVector(tx) {
  return vectorToRaw(tx.inputs)
}

function getTxOutputVector(tx) {
  return vectorToRaw(tx.outputs)
}

function getTxLocktime(tx) {
  const buffer = bufio.write()
  buffer.writeU32(tx.locktime)

  return toHex(buffer)
}

function vectorToRaw(elements) {
  const buffer = bufio.write()
  buffer.writeVarint(elements.length)

  for (const element of elements) {
    element.toWriter(buffer)
  }

  return toHex(buffer)
}

function toHex(buffer) {
  return buffer.render().toString('hex')
}

module.exports = {
  parse,
}
