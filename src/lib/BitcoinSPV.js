// JS implementation of merkle.py script from [summa-tx/bitcoin-spv] repository.
//
// [summa-tx/bitcoin-spv]: https://github.com/summa-tx/bitcoin-spv/
import Hash256 from "bcrypto/lib/hash256-browser.js"
import BcryptoMerkle from "bcrypto/lib/merkle.js"
const { deriveRoot } = BcryptoMerkle

/** @typedef { import("./ElectrumClient.js").default } ElectrumClient */

/**
 * @typedef {object} Proof
 * @property {string} tx - Raw transaction in hexadecimal format.
 * @property {string} merkleProof - Transaction merkle proof.
 * @property {number} txInBlockIndex - Transaction index in a block.
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
   * @return {Promise<Proof>} Transaction's SPV proof.
   */
  async getTransactionProof(txHash, confirmations) {
    // GET TRANSACTION
    const tx = await this.client.getTransaction(txHash).catch(err => {
      throw new Error(`failed to get transaction: [${err}]`)
    })

    if (tx.confirmations < confirmations) {
      throw new Error(
        `transaction confirmations number [${tx.confirmations}] is not enough, required [${confirmations}]`
      )
    }

    const latestBlockHeight = await this.client
      .latestBlockHeight()
      .catch(err => {
        throw new Error(`failed to get latest block height: [${err}]`)
      })

    const txBlockHeight = latestBlockHeight - tx.confirmations + 1

    // GET HEADER CHAIN
    const headersChain = await this.client
      .getHeadersChain(txBlockHeight, confirmations)
      .catch(err => {
        throw new Error(`failed to get headers chain: [${err}]`)
      })

    // GET MERKLE PROOF
    const merkleProofInfo = await this.getMerkleProofInfo(
      txHash,
      txBlockHeight
    ).catch(err => {
      throw new Error(`failed to get merkle proof: [${err}]`)
    })

    return {
      tx: tx.hex,
      merkleProof: merkleProofInfo.proof,
      txInBlockIndex: merkleProofInfo.position,
      chainHeaders: headersChain
    }
  }

  /**
   * @typedef {object} MerkleProofInfo
   * @property {string} proof The proof data for a transaction as a hex string.
   * @property {number} position The position of the transaction in question in
   *           its containing block.
   */

  /**
   * Get proof of transaction inclusion in the block. It produces proof as a
   * concatenation of 32-byte values in a hexadecimal form. It converts the
   * values to little endian form.
   *
   * @param {string} txHash Hash of a transaction.
   * @param {number} blockHeight Height of the block where transaction was
   *        confirmed.
   * @return {Promise<MerkleProofInfo>} Transaction inclusion proof in
   *         hexadecimal form.
   */
  async getMerkleProofInfo(txHash, blockHeight) {
    const merkle = await this.client.getTransactionMerkle(txHash, blockHeight)

    let proof = Buffer.from("")

    // Merkle tree
    merkle.merkle.forEach(function(item) {
      proof = Buffer.concat([proof, Buffer.from(item, "hex").reverse()])
    })

    return { proof: proof.toString("hex"), position: merkle.pos }
  }
}
