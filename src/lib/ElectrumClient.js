import ElectrumClient from "electrum-client-js"
import sha256 from "bcrypto/lib/sha256-browser.js"
import { backoffRetrier } from "./backoff.js"
const { digest } = sha256

/**
 * @typedef {object} ScriptPubKey
 * @property {string[]} addresses The addresses associated with this
 *           ScriptPubKey; one for regular ScriptPubkeys, more for multisigs.
 * @property {"pubkeyhash" | string} type The type of ScriptPubKey.
 */

/**
 * @typedef {object} TransactionInput
 * @property {object} scriptSig The scriptsig that unlocks the specified
 *           outpoint for spending.
 * @property {string} txid The id of the transaction the input UTXO comes from.
 * @property {number} vout The vout from the specified txid that is being used
 *           for this input.
 */

/**
 * @typedef {object} TransactionOutput
 * @property {number} n The 0-based index of the output.
 * @property {number} value The value of the output in BTC.
 * @property {ScriptPubKey} scriptPubKey The receiving ScriptPubKey.
 */

/**
 * @typedef {object} TransactionData
 * @property {string} blockhash The blockhash of the transaction's containing
 *           block as an unprefixed hex string.
 * @property {number} confirmations The number of confirmations the transaction
 *           has received, including the containing blockhash.
 * @property {string} hash The transaction hash (or transaction ID) as an
 *           unprefixed hex string.
 * @property {string} hex The full transaction payload as an unprefixed hex
 *           string.
 * @property {string} txid The transaction ID (or transaction hash) as an
 *           unprefixed hex string.
 * @property {TransactionInput[]} vin The vector of transaction inputs.
 * @property {TransactionOutput[]} vout The vector of transaction outputs.
 */

/**
 * Configuration of electrum client.
 * @typedef {object} Config
 * @property {string} server ElectrumX server hostname.
 * @property {number} port ElectrumX server port.
 * @property {"ssl"|"tls"|"ws"|"wss"} protocol The server connection protocol to
 *           use for the specified `server`.
 * @property {object} [options] Additional options for the server connection.
 *           For WebSocket connections, these are `W3CWebSocket` options; for
 *           SSL/TLS connections, they are Node `TLSSocket` options.
 */

/**
 * Client to interact with [ElectrumX](https://electrumx.readthedocs.io/en/stable/index.html)
 * server.
 * Uses methods exposed by the [Electrum Protocol](https://electrumx.readthedocs.io/en/stable/protocol.html)
 */
export default class Client {
  /**
   * Initializes Electrum Client instance with provided configuration.
   * @param {Config} config Electrum client connection configuration.
   */
  constructor(config) {
    this.electrumClient = new ElectrumClient(
      config.server,
      config.port,
      config.protocol,
      config.options
    )
  }

  /**
   * Establish connection with the server.
   */
  async connect() {
    console.log("Connecting to electrum server...")

    await this.electrumClient.connect("tbtc", "1.4.2").catch(err => {
      throw new Error(`failed to connect: [${err}]`)
    })
  }

  /**
   * Disconnect from the server.
   */
  async close() {
    console.log("Closing connection to electrum server...")
    this.electrumClient.close()
  }

  /**
   * Get height of the latest mined block.
   * @return {Promise<number>} Height of the last mined block.
   */
  async latestBlockHeight() {
    // Get header of the latest mined block.
    const header = await this.electrumClient
      .blockchain_headers_subscribe()
      .catch(err => {
        throw new Error(`failed to get block header: [${err}]`)
      })
    return header.height
  }

  /**
   * Get details of the transaction.
   * @param {string} txHash Hash of a transaction.
   * @return {Promise<TransactionData>} Transaction details.
   */
  async getTransaction(txHash) {
    const tx = await this.electrumClient
      .blockchain_transaction_get(txHash, true)
      .catch(err => {
        throw new Error(`failed to get transaction: [${err}]`)
      })

    return tx
  }

  /**
   * Broadcast a transaction to the network.
   * @param {string} rawTX The raw transaction as a hexadecimal string.
   * @return {Promise<string>} The transaction hash as a hexadecimal string.
   */
  async broadcastTransaction(rawTX) {
    const txHash = await this.electrumClient
      .blockchain_transaction_broadcast(rawTX)
      .catch(err => {
        throw new Error(`failed to broadcast transaction: [${err}]`)
      })

    return txHash
  }

  /**
   * Data about an unspent transaction output. Docs mostly taken from
   * https://electrumx.readthedocs.io/en/latest/protocol-methods.html .
   *
   * @typedef {object} UnspentOutputData
   * @property {number} height The integer height of the block the transaction
   *           was confirmed in. 0 if the transaction is in the mempool.
   * @property {number} tx_pos The zero-based index of the output in the
   *           containing transaction's list of outputs.
   * @property {string} tx_hash The containing transaction's hash (or id) as an
   *           unprefixed hexadecimal string.
   * @property {number} value The value of the unspent output in satoshis.
   */

  /**
   * Get unspent outputs sent to a script.
   * @param {string} script ScriptPubKey in a hexadecimal format.
   * @return {Promise<UnspentOutputData[]>} List of unspent outputs. It includes
   *         transactions in the mempool.
   */
  async getUnspentToScript(script) {
    const scriptHash = scriptToHash(script)

    const listUnspent = await this.electrumClient
      .blockchain_scripthash_listunspent(scriptHash)
      .catch(err => {
        throw new Error(JSON.stringify(err))
      })

    return listUnspent
  }

  /**
   * Get balance of a script.
   *
   * @param {string} script ScriptPubKey in a hexadecimal format.
   *
   * @return {Promise<{ confirmed: string, unconfirmed: string }>} Object with
   *         the confirmed and unconfirmed BTC balance of the given script as
   *         decimal strings.
   */
  async getBalanceOfScript(script) {
    const scriptHash = scriptToHash(script)

    const balance = await this.electrumClient
      .blockchain_scripthash_getBalance(scriptHash)
      .catch(err => {
        throw new Error(JSON.stringify(err))
      })

    return balance
  }

  /**
   * @callback TransactionToScriptReceived
   * @param {string?} status The updated status of the script. The status is an
   *        unprefixed hexadecimal string computed according to the rules at
   *        https://electrumx.readthedocs.io/en/latest/protocol-basics.html#status,
   *        or null if there are no transactions to that script.
   * @return {Promise<T | null>}
   * @template T
   */

  /**
   * Listens for transactions sent to a script until callback resolves to a
   * non-`null` value. It includes transactions in the mempool. It passes
   * the status of the transaction to the callback (see
   * {@link TransactionToScriptReceived<T>}).
   *
   * @template T
   * @param {string} script ScriptPubKey in a hexadecimal format.
   * @param {TransactionToScriptReceived<T>} callback An async callback
   *        function called when an existing transaction for the script is found
   *        or a new transaction is sent to the script. If the transaction
   *        returns non-`null`, the returned value is also returned from
   *        `onTransactionToScript` and monitoring of the specified script is
   *        discontinued.
   * @return {Promise<T>} Value resolved by the callback.
   */
  async onTransactionToScript(script, callback) {
    const scriptHash = scriptToHash(script)

    // Check if transaction for script already exists.
    const initialStatus = await this.electrumClient
      .blockchain_scripthash_subscribe(scriptHash)
      .catch(err => {
        throw new Error(`failed to subscribe: ${err}`)
      })

    // Invoke callback for the current status.
    const result = await callback(initialStatus)
    if (result) {
      // TODO: We send request directly, because `electrumjs` library doesn't
      // support `blockchain.scripthash.unsubscribe` method.
      await this.electrumClient
        .blockchain_scripthash_unsubscribe(scriptHash)
        .catch(err => {
          throw new Error(`failed to unsubscribe: ${err}`)
        })

      return result
    }

    // If callback have not resolved wait for new transaction notifications.
    return new Promise(async resolve => {
      try {
        const eventName = "blockchain.scripthash.subscribe"
        const electrumClient = this.electrumClient

        const listener = async function(/** @type {[string, string]} */ msg) {
          const receivedScriptHash = msg[0]
          const status = msg[1]

          console.log(
            `Received notification for script hash: [${receivedScriptHash}] with status: [${status}]`
          )

          if (receivedScriptHash == scriptHash) {
            const result = await callback(status)
            if (result) {
              await electrumClient.subscribe.off(eventName, listener)

              await electrumClient
                .blockchain_scripthash_unsubscribe(scriptHash)
                .catch(err => {
                  throw new Error(`failed to unsubscribe: ${err}`)
                })

              return resolve(result)
            }
          }
        }

        this.electrumClient.subscribe.on(eventName, listener)
      } catch (err) {
        throw new Error(`failed listening for notification: ${err}`)
      }
    })
  }

  /**
   * @typedef {object} NewBlockData
   * @property {number} height The height of the new block.
   * @property {string} hex The header of the new block as an unprefixed hex
   *           string.
   */

  /**
   * @callback NewBlockReceived
   * @param {NewBlockData} blockData Data about the newly-seen block.
   * @return {Promise<T | null>}
   * @template T
   */

  /**
   * Calls a callback for the current block and next mined blocks until the
   * callback returns a truthy value.
   *
   * @template T
   * @param {NewBlockReceived<T>} callback An async callback function called for
   *        the current block and when a new block is mined. If the transaction
   *        returns non-`null`, the returned value is also returned from
   *        `onNewBlock` and monitoring for new blocks is discontinued.
   * @return {Promise<T>} Value resolved by the callback.
   */
  async onNewBlock(callback) {
    // Subscribe for new block notifications.
    const blockHeader = await this.electrumClient
      .blockchain_headers_subscribe()
      .catch(err => {
        throw new Error(`failed to subscribe: ${err}`)
      })

    // Invoke callback for the current block.
    const result = await callback(blockHeader)
    if (result) {
      return result
    }

    // If callback have not resolved wait for new blocks notifications.
    return new Promise(async resolve => {
      try {
        const eventName = "blockchain.headers.subscribe"
        const electrumClient = this.electrumClient

        const listener = async function(
          /** @type {NewBlockData[]} */ messages
        ) {
          for (const msg of messages) {
            const height = msg.height

            console.log(
              `Received notification of a new block at height: [${height}]`
            )

            // Invoke callback for the current block.
            const result = await callback(msg)
            if (result) {
              await electrumClient.subscribe.off(eventName, listener)

              return resolve(result)
            }
          }
        }

        this.electrumClient.subscribe.on(eventName, listener)

        console.log(`Registered listener for ${eventName} event`)
      } catch (err) {
        throw new Error(`failed listening for notification: ${err}`)
      }
    })
  }

  /**
   * Get merkle root hash for block.
   * @param {number} blockHeight Block height.
   * @return {Promise<Buffer>} Merkle root hash.
   */
  async getMerkleRoot(blockHeight) {
    const header = await this.electrumClient
      .blockchain_block_header(blockHeight)
      .catch(err => {
        throw new Error(`failed to get block header: [${err}]`)
      })

    return Buffer.from(header, "hex").slice(36, 68)
  }

  /**
   * Get concatenated chunk of block headers built on a starting block.
   * @param {number} blockHeight Starting block height.
   * @param {number} confirmations Number of confirmations (subsequent blocks)
   * built on the starting block.
   * @return {Promise<string>} Concatenation of block headers in a hexadecimal format.
   */
  async getHeadersChain(blockHeight, confirmations) {
    const headersChain = await this.electrumClient
      .blockchain_block_headers(blockHeight, confirmations + 1)
      .catch(err => {
        throw new Error(`failed to get block headers: [${err}]`)
      })
    return headersChain.hex
  }

  /**
   * Information about the merkle branch to a confirmed transaction.
   *
   * @typedef {object} TransactionMerkleBranch
   * @property {number} block_height The height of the block the transaction was
   *           confirmed in.
   * @property {string[]} merkle A list of transaction hashes the current hash
   *           is paired with, recursively, in order to trace up to obtain the
   *           merkle root of the including block, deepest pairing first. Each
   *           hash is an unprefixed hex string.
   * @property {number} pos The 0-based index of the transaction's position in
   *           the block.
   */

  /**
   * Get proof of transaction inclusion in the block.
   *
   * @param {string} txHash Hash of a transaction.
   * @param {number} blockHeight Height of the block where transaction was
   *        confirmed.
   * @return {Promise<TransactionMerkleBranch>} Transaction inclusion proof in
   *         hexadecimal form.
   */
  async getTransactionMerkle(txHash, blockHeight) {
    return backoffRetrier(3, err =>
      err.message.includes("not in block at height")
    )(
      async () =>
        /** @type {TransactionMerkleBranch} */ (await this.electrumClient
          .blockchain_transaction_getMerkle(txHash, blockHeight)
          .catch(err => {
            throw new Error(`failed to get transaction merkle: [${err}]`)
          }))
    )
  }

  /**
   * Finds index of output in a transaction for a given address.
   * @param {string} txHash Hash of a transaction.
   * @param {string} address Bitcoin address for the output.
   * @return {Promise<number>} Index of output in the transaction (0-indexed).
   */
  async findOutputForAddress(txHash, address) {
    const tx = await this.getTransaction(txHash).catch(err => {
      throw new Error(`failed to get transaction: [${err}]`)
    })

    const outputs = tx.vout

    for (let index = 0; index < outputs.length; index++) {
      for (const a of outputs[index].scriptPubKey.addresses) {
        if (a == address) {
          return index
        }
      }
    }

    throw new Error(`output for address ${address} not found`)
  }

  /**
   * Gets a history of all transactions the script is involved in.
   * @param {string} script The script in raw hexadecimal format.
   * @return {Promise<TransactionData[]>} A list of transactions.
   */
  async getTransactionsForScript(script) {
    const scriptHash = scriptToHash(script)
    /** @type {{ height: number, tx_hash: string }[]} */
    const history = await this.electrumClient.blockchain_scripthash_getHistory(
      scriptHash
    )

    // Get all transactions for script.
    const transactions = await Promise.all(
      history
        .map(confirmedTx => confirmedTx.tx_hash)
        .map(txHash => this.getTransaction(txHash))
    )

    return transactions
  }
}

/**
 * Converts ScriptPubKey to a script hash specified by the [Electrum Protocol](https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes).
 * @param {string} script ScriptPubKey in a hexadecimal format.
 * @return {string} Script hash as a hex string.
 */
function scriptToHash(script) {
  /** @type {Buffer} */
  const scriptHash = digest(Buffer.from(script, "hex")).reverse()
  return scriptHash.toString("hex")
}
