// JS implementation of merkle.py script from [summa-tx/bitcoin-spv] repository.
//
// [summa-tx/bitcoin-spv]: https://github.com/summa-tx/bitcoin-spv/
import Hash256 from 'bcrypto/lib/hash256.js'
import BcryptoMerkle from 'bcrypto/lib/merkle.js'
const { deriveRoot } = BcryptoMerkle

/**
 * @typedef {Object} Proof
 * @property {string} tx - Raw transaction in hexadecimal format.
 * @property {string} merkleProof - Transaction merkle proof.
 * @property {string} txInBlockIndex - Transaction index in a block.
 * @property {string} chainHeaders - Chain of blocks headers.
 */

export class BitcoinSPV {
  /**
   * Initialize Bitcoin SPV with provided Electrum Client.
   * @param {ElectrumClient} electrumClient
   */
  constructor(electrumClient) {
    this.client = electrumClient
  }

  /**
   * Get SPV transaction proof.
   * @param {string} txHash Transaction hash.
   * @param {number} confirmations Required number of confirmations for the transaction.
   * @return {Proof} Transaction's SPV proof.
   */
  async getTransactionProof(txHash, confirmations) {
    // GET TRANSACTION
    const tx = await this.client.getTransaction(txHash)
      .catch((err) => {
        throw new Error(`failed to get transaction: [${err}]`)
      })

    if (tx.confirmations < confirmations) {
      throw new Error(`transaction confirmations number [${tx.confirmations}] is not enough, required [${confirmations}]`)
    }

    const latestBlockHeight = await this.client.latestBlockHeight()
      .catch((err) => {
        throw new Error(`failed to get latest block height: [${err}]`)
      })

    const txBlockHeight = latestBlockHeight - tx.confirmations + 1

    // GET HEADER CHAIN
    const headersChain = await this.client.getHeadersChain(txBlockHeight, confirmations)
      .catch((err) => {
        throw new Error(`failed to get headers chain: [${err}]`)
      })

    // GET MERKLE PROOF
    const merkleProof = await this.client.getMerkleProof(txHash, txBlockHeight)
      .catch((err) => {
        throw new Error(`failed to get merkle proof: [${err}]`)
      })

    return {
      tx: tx.hex,
      merkleProof: merkleProof.proof,
      txInBlockIndex: merkleProof.position,
      chainHeaders: headersChain,
    }
  }

  /**
   * Verifies merkle proof of transaction inclusion in the block. It expects proof
   * as a concatenation of 32-byte values in a hexadecimal form. The proof should
   * include the merkle tree branches, with transaction hash merkle tree root omitted.
   * @param {string} proofHex hexadecimal representation of the proof
   * @param {string} txHash Transaction hash.
   * @param {number} index is transaction index in the block (1-indexed)
   * @param {number} blockHeight Height of the block where transaction was confirmed.
   * @return {boolean} true if verification passed, else false
   */
  async verifyMerkleProof(proofHex, txHash, index, blockHeight) {
    const proof = Buffer.from(proofHex, 'hex')

    // Retreive merkle tree root.
    let actualRoot = await this.client.getMerkleRoot(blockHeight).catch((err) => {
      throw new Error(`failed to get merkle root: [${err}]`)
    })
    actualRoot = Buffer.from(actualRoot, 'hex')

    // Extract tree branches
    const branches = []
    for (let i = 0; i < (Math.floor(proof.length / 32)); i++) {
      const branch = proof.slice(i * 32, (i + 1) * 32)
      branches.push(branch)
    }

    // Derive expected root from branches and transaction.
    const txHashBuffer = Buffer.from(txHash, 'hex').reverse()
    const expectedRoot = deriveRoot(Hash256, txHashBuffer, branches, index)

    // Validate if calculated root is equal to the one returned from client.
    if (actualRoot.equals(expectedRoot)) {
      return true
    } else {
      return false
    }
  }
}
