import ElectrumClient from "electrum-client-js"
import sha256 from "bcrypto/lib/sha256.js"
const { digest } = sha256

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
   * @return {Promise<any>} Transaction details.
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
   * Get unspent outputs sent to a script.
   * @param {string} script ScriptPubKey in a hexadecimal format.
   * @return {Promise<any>} List of unspent outputs. It includes transactions in the mempool.
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
   * @return {Promise<any>} Object with balance data.
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
   * Listens for transactions sent to a script until callback resolves to a
   * 'truthy' value. It includes transactions in the mempool. It passes
   * [status]([Electrum Protocol](https://electrumx.readthedocs.io/en/stable/protocol-basics.html#status))
   * of the transaction to the callback.
   * @param {string} script ScriptPubKey in a hexadecimal format.
   * @param {function} callback Is an async callback function called when an existing
   * transaction for the script is found or a new transaction is sent to the script.
   * @return {Promise<any>} Value resolved by the callback.
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

        const listener = async function(msg) {
          const receivedScriptHash = msg[0]
          const status = msg[1]

          console.log(
            `Received notification for script hash: [${receivedScriptHash}] with status: [${status}]`
          )

          if (receivedScriptHash == scriptHash) {
            const result = await callback(status)
            if (result) {
              await electrumClient.subscribe.off(eventName, listener)

              // TODO: We send request directly, because `electrumjs` library doesn't
              // support `blockchain.scripthash.unsubscribe` method.
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
   * Calls a callback for the current block and next mined blocks until the
   * callback returns a truthy value.
   * @param {function} callback Callback function called for the current block
   * and when a new block is mined. It passes to the callback a value returned by
   * [blockchain.headers.subscribe](https://electrumx.readthedocs.io/en/stable/protocol-methods.html#blockchain-headers-subscribe).
   * @return {Promise<any>} Value resolved by the callback.
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

        const listener = async function(messages) {
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
   * Get proof of transaction inclusion in the block.
   *
   * @param {string} txHash Hash of a transaction.
   * @param {number} blockHeight Height of the block where transaction was
   *        confirmed.
   * @return {Promise<any>} Transaction inclusion proof in hexadecimal form.
   */
  async getTransactionMerkle(txHash, blockHeight) {
    return await this.electrumClient
      .blockchain_transaction_getMerkle(txHash, blockHeight)
      .catch(err => {
        throw new Error(`failed to get transaction merkle: [${err}]`)
      })
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
   * @return {Promise<any>} A list of transactions.
   */
  async getTransactionsForScript(script) {
    const scriptHash = scriptToHash(script)
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

function fromHex(hex) {
  return Buffer.from(hex, "hex")
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex")
}

/**
 * Converts ScriptPubKey to a script hash specified by the [Electrum Protocol](https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes).
 * @param {string} script ScriptPubKey in a hexadecimal format.
 * @return {string} Script hash.
 */
function scriptToHash(script) {
  const scriptHash = digest(fromHex(script)).reverse()
  return toHex(scriptHash)
}
