import bcoin from "bcoin"
import bio from "bufio"
const { consensus } = bcoin
const { hashType } = bcoin.Script
import hash256 from "bcrypto/lib/hash256.js"

// Returns the raw data used for computing the sighash, according
// to the segwit standard (BIP-143).
//
// With thanks to bcoin, this is a line-for-line copy of their
// TX.signatureHashV1 method, without the final double sha256.
//
// This method should be bound to a bcoin.TX object, eg.
// `getSignatureHashData.bind(tx)(...args)`.
/* eslint-disable no-invalid-this */
export function getSignatureHashData(index, prev, value, type) {
  const input = this.inputs[index]
  let prevouts = consensus.ZERO_HASH
  let sequences = consensus.ZERO_HASH
  let outputs = consensus.ZERO_HASH

  if (!(type & hashType.ANYONECANPAY)) {
    if (this._hashPrevouts) {
      prevouts = this._hashPrevouts
    } else {
      const bw = bio.pool(this.inputs.length * 36)

      for (const input of this.inputs) input.prevout.toWriter(bw)

      prevouts = hash256.digest(bw.render())

      if (!this.mutable) this._hashPrevouts = prevouts
    }
  }

  if (
    !(type & hashType.ANYONECANPAY) &&
    (type & 0x1f) !== hashType.SINGLE &&
    (type & 0x1f) !== hashType.NONE
  ) {
    if (this._hashSequence) {
      sequences = this._hashSequence
    } else {
      const bw = bio.pool(this.inputs.length * 4)

      for (const input of this.inputs) bw.writeU32(input.sequence)

      sequences = hash256.digest(bw.render())

      if (!this.mutable) this._hashSequence = sequences
    }
  }

  if ((type & 0x1f) !== hashType.SINGLE && (type & 0x1f) !== hashType.NONE) {
    if (this._hashOutputs) {
      outputs = this._hashOutputs
    } else {
      let size = 0

      for (const output of this.outputs) size += output.getSize()

      const bw = bio.pool(size)

      for (const output of this.outputs) output.toWriter(bw)

      outputs = hash256.digest(bw.render())

      if (!this.mutable) this._hashOutputs = outputs
    }
  } else if ((type & 0x1f) === hashType.SINGLE) {
    if (index < this.outputs.length) {
      const output = this.outputs[index]
      outputs = hash256.digest(output.toRaw())
    }
  }

  const size = 156 + prev.getVarSize()
  const bw = bio.pool(size)

  bw.writeU32(this.version)
  bw.writeBytes(prevouts)
  bw.writeBytes(sequences)
  bw.writeHash(input.prevout.hash)
  bw.writeU32(input.prevout.index)
  bw.writeVarBytes(prev.toRaw())
  bw.writeI64(value)
  bw.writeU32(input.sequence)
  bw.writeBytes(outputs)
  bw.writeU32(this.locktime)
  bw.writeU32(type)

  return bw.render()
}
/* eslint-enable no-invalid-this */
