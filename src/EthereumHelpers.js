/** @typedef { import("web3").default } Web3 */
/** @typedef { import("web3-eth-contract").Contract } Web3Contract */
/** @typedef { import("web3-eth-contract").ContractSendMethod } ContractSendMethod */
/** @typedef { import("web3-eth-contract").SendOptions } SendOptions */
/** @typedef { import("web3-utils").AbiItem } AbiItem */
/** @typedef { import("web3-core").TransactionReceipt } TransactionReceipt */

import { backoffRetrier } from "./lib/backoff.js"
import pWaitFor from "p-wait-for"

const GET_PAST_EVENTS_BLOCK_INTERVAL = 2000

/**
 * @typedef {object} DeploymentInfo
 * @property {string} address The address a contract is deployed at on a given
 *           network.
 * @property {string} transactionHash The hash of a transaction in which contract
 *           was deployed on a given network.
 */

/**
 * @typedef {object} TruffleArtifact
 * @property {string} contractName The name of the contract this artifact
 *           represents.
 * @property {AbiItem[]} abi The ABI of the contract this artifact represents.
 * @property {{ [networkId: string]: DeploymentInfo}} networks Information about
 *           the networks this contract is deployed to.
 */

/**
 * @typedef {object} AbiEventProperties
 * @property {string} signature The method's hex signature.
 */

/**
 * @typedef {AbiItem & AbiEventProperties} AbiEvent
 */

/**
 * Checks whether the given web3 instance is connected to Ethereum mainnet.
 *
 * @param {Web3} web3 The web3 instance whose network should be checked.
 * @return {Promise<boolean>} True if the web3 instance is aimed at Ethereum
 *         mainnet, false otherwise.
 */
async function isMainnet(web3) {
  return (await web3.eth.getChainId()) == 0x1
}

/**
 * From a given transaction result, extracts the first event with the given
 * name from the given source contract.
 *
 * @param {Web3} web3 A web3 instance for operating.
 * @param {TransactionReceipt} transaction A web3 transaction result.
 * @param {Web3Contract} sourceContract A web3 Contract instance whose
 *        event is being read.
 * @param {string} eventName The name of the event to be read.
 *
 * @return {any} A key-value dictionary of the event's parameters.
 */
function readEventFromTransaction(
  web3,
  transaction,
  sourceContract,
  eventName
) {
  const eventABI = /** @type {AbiEvent} */ (sourceContract.options.jsonInterface.find(
    entry => entry.type == "event" && entry.name == eventName
  ))

  return Object.values(transaction.events || {})
    .filter(
      event =>
        event.address == sourceContract.options.address &&
        event.raw &&
        event.raw.topics[0] == eventABI.signature
    )
    .map(_ =>
      web3.eth.abi.decodeLog(
        eventABI.inputs || [],
        (_.raw && _.raw.data) || "",
        (_.raw && _.raw.topics.slice(1)) || []
      )
    )[0]
}

/**
 * Waits until `source` emits the given `event`, including searching past blocks
 * for such `event`, then returns it.
 *
 * @param {Web3} web3 Instance of Web3.
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {any} [filter] An additional filter to apply to the event being
 *        searched for.
 * @param {number} [fromBlock] Starting block for events search.
 *
 * @return {Promise<any>} A promise that will be fulfilled by the event
 *         object once it is received.
 */
function getEvent(web3, sourceContract, eventName, filter, fromBlock) {
  return new Promise(async (resolve, reject) => {
    // As a workaround for a problem with MetaMask version 7.1.1 where subscription
    // for events doesn't work correctly we pull past events in a loop until
    // we find our event. This is a temporary solution which should be removed
    // after problem with MetaMask is solved.
    // See: https://github.com/MetaMask/metamask-extension/issues/7270
    await pWaitFor(
      async () => {
        // Query if an event was already emitted after we start watching
        let event
        try {
          event = await getExistingEvent(
            web3,
            sourceContract,
            eventName,
            filter,
            fromBlock
          )
        } catch (error) {
          console.warn(`failed to get existing event: ${error.message}`)
        }

        if (event) {
          resolve(event)
          return true
        }
        return false
      },
      { interval: 3000 } // every 3 seconds
    )

    sourceContract.once(eventName, { filter }, (error, event) => {
      if (error) {
        // We are not throwing an error as we want to fallback to querying past
        // events in interval defined above.
        console.warn(`failed to register for ${eventName}:`, error.message)
      } else {
        resolve(event)
      }
    })
  })
}

/**
 * Looks up all existing events named `eventName` on `sourceContract`, searching
 * past blocks and then returning them. Respects additional filtering rules set
 * in the passed `filter` object, if available. Does not wait for any new
 * events. It starts searching from provided block number. If the `fromBlock`
 * is missing it looks for a contract's defined property `deployedAtBlock`. If the
 * property is missing starts searching from block `0`.
 *
 * @param {Web3} web3 Instance of Web3.
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {any} [filter] An additional filter to apply to the event being
 *        searched for.
 * @param {number} [fromBlock] Starting block for events search.
 * @param {any} [toBlock] Ending block for events search.
 *
 * @return {Promise<any[]>} A promise that will be fulfilled by the list of
 *         event objects once they are found.
 */
async function getExistingEvents(
  web3,
  sourceContract,
  eventName,
  filter,
  fromBlock = 0,
  toBlock = "latest"
) {
  if (!Number.isInteger(fromBlock)) {
    throw new Error(`FromBlock is not a number`)
  }

  if (fromBlock <= 0) {
    console.log(
      `FromBlock is less or equal zero; ` +
        `setting FromBlock to source contract deployment block`
    )

    fromBlock = sourceContract.deployedAtBlock || 0
  }

  if (toBlock !== "latest") {
    if (!Number.isInteger(toBlock) || toBlock < fromBlock) {
      throw new Error(
        `ToBlock should be \'latest'\ or an integer greater ` +
          `than FromBlock, current value: ${toBlock}`
      )
    }
  }

  return new Promise(async (resolve, reject) => {
    /** @type any[] */
    let resultEvents = []
    try {
      resultEvents = await sourceContract.getPastEvents(eventName, {
        fromBlock: fromBlock,
        toBlock: toBlock,
        filter
      })
    } catch (error) {
      console.log(
        `Switching to partial events pulls; ` +
          `failed to get events in one request for event [${eventName}], ` +
          `fromBlock: [${fromBlock}], toBlock: [${toBlock}]: [${error.message}]`
      )

      try {
        if (toBlock === "latest") {
          toBlock = await web3.eth.getBlockNumber()
        }

        let batchStartBlock = fromBlock

        while (batchStartBlock <= toBlock) {
          let batchEndBlock = batchStartBlock + GET_PAST_EVENTS_BLOCK_INTERVAL
          if (batchEndBlock > toBlock) {
            batchEndBlock = toBlock
          }
          console.log(
            `Executing partial events pull for event [${eventName}], ` +
              `fromBlock: [${batchStartBlock}], toBlock: [${batchEndBlock}]`
          )
          const foundEvents = await sourceContract.getPastEvents(eventName, {
            fromBlock: batchStartBlock,
            toBlock: batchEndBlock,
            filter
          })

          resultEvents = resultEvents.concat(foundEvents)
          console.log(
            `Fetched [${foundEvents.length}] events, has ` +
              `[${resultEvents.length}] total`
          )

          batchStartBlock = batchEndBlock + 1
        }
      } catch (error) {
        return reject(error)
      }
    }

    return resolve(resultEvents)
  })
}

/**
 * Looks up an existing event named `eventName` on `sourceContract`, searching
 * past blocks for it and then returning it. Respects additional filtering rules
 * set in the passed `filter` object, if available. Does not wait for any new
 * events.
 *
 * @param {Web3} web3 Instance of Web3.
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {any} [filter] An additional filter to apply to the event being
 *        searched for.
 * @param {number} [fromBlock] Starting block for events search.
 *
 * @return {Promise<any>} A promise that will be fulfilled by the event object
 *         once it is found.
 */
async function getExistingEvent(
  web3,
  sourceContract,
  eventName,
  filter,
  fromBlock
) {
  return (
    await getExistingEvents(web3, sourceContract, eventName, filter, fromBlock)
  ).slice(-1)[0]
}

/**
 * Converts an Ethereum `bytes` value into the raw bytes it represents.
 * Drops the 0x prefix, and the length prefix.
 * @param {string} bytesString An Ethereum-encoded `bytes` string
 * @return {string} The hexadecimal string.
 */
function bytesToRaw(bytesString) {
  return bytesString.replace("0x", "").slice(2)
}

/**
 * Takes a bound web3 contract method (e.g. `myContract.methods.doSomething(param)`
 * and sends it with proper gas estimation and error handling. In particular,
 * runs a gas estimate beforehand to attach an appropriate gas spend, and, if
 * the gas estimation fails due to an always-failing transaction, `call`s the
 * method to get the proper underlying error message. Otherwise, sends the
 * signed transaction normally.
 *
 * Note that if a gas estimate is calculated but is less than an explicitly
 * specified `sendParams.gas` value, `sendParams.gas` is preferred, and vice
 * versa. The higher of the two gas values is then multiplied by
 * `gasMultiplier`.
 *
 * @param {ContractSendMethod} boundContractMethod A bound web3 contract method
 *        with `estimateGas`, `send`, and `call` variants available.
 * @param {Partial<SendOptions>} [sendParams] The parameters to pass to
 *        `estimateGas` and `send` for transaction processing.
 * @param {boolean} [forceSend] Force the transaction send through even
 *        if gas estimation fails.
 * @param {number} [gasMultiplier=1] If specified, applies a multiplier to the
 *        estimated gas. Defaults to 1, meaning the gas estimate is used as-is
 *        for the transaction.
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function sendSafely(
  boundContractMethod,
  sendParams,
  forceSend = false,
  gasMultiplier = 1
) {
  try {
    // Clone `sendParams` so we aren't exposed to providers that modify `sendParams`.
    const gasEstimate = await boundContractMethod.estimateGas({ ...sendParams })

    return boundContractMethod.send({
      from: "", // FIXME Need systemic handling of default from address.
      ...sendParams,
      gas: Math.round(
        Math.max(gasEstimate, (sendParams && sendParams.gas) || 0) *
          gasMultiplier
      )
    })
  } catch (exception) {
    // For an always failing transaction, if forceSend is set, send it anyway.
    if (
      exception.message &&
      exception.message.match(/always failing transaction/) &&
      forceSend
    ) {
      return boundContractMethod.send({
        from: "", // FIXME Need systemic handling of default from address.
        ...sendParams
      })
    } else {
      // If we're not force-sending, use `call` to throw the true error reason
      // (`estimateGas` doesn't return error messages, it only throws an
      // out-of-gas).
      // @ts-ignore A newer version of Web3 is needed to include call in TS.
      await boundContractMethod.call({
        from: "",
        ...sendParams
      })

      // If `call` doesn't throw an error, something has gone quite awry; since
      // we couldn't estimate gas, throw the original exception, since that's
      // where things first went sideways.
      throw exception
    }
  }
}

/**
 * Wraps the {@link sendSafely} method with a retry logic.
 * @see {@link sendSafely}
 *
 * @param {ContractSendMethod} boundContractMethod A bound web3 contract method
 *        with `estimateGas`, `send`, and `call` variants available.
 * @param {Partial<SendOptions>} [sendParams] The parameters to pass to
 *        `estimateGas` and `send` for transaction processing.
 * @param {boolean} [forceSend] Force the transaction send through even
 *        if gas estimation fails.
 * @param {number} [totalAttempts] Total attempts number which should be
 *        performed in case of an error before rethrowing it to the caller.
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function sendSafelyRetryable(
  boundContractMethod,
  sendParams,
  forceSend = false,
  totalAttempts = 3
) {
  return backoffRetrier(totalAttempts)(async () => {
    return await sendSafely(boundContractMethod, sendParams, forceSend)
  })
}

/**
 * Calls the bound contract method (using `.call`, that is as a read-only call)
 * and retries up to `totalAttempts` number of times, or 3 if unspecified.
 *
 * @param {ContractSendMethod} boundContractMethod A bound web3 contract method
 *        with `estimateGas`, `send`, and `call` variants available.
 * @param {Partial<SendOptions>} [sendParams] The parameters to pass to `call`.
 * @param {number} [totalAttempts=3] Total attempts which should be performed in
 *        case of an error before rethrowing it to the caller.
 * @param {number|string} [block="latest"] Determines the block for which the
 *        call should be performed.
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function callWithRetry(
  boundContractMethod,
  sendParams,
  totalAttempts = 3,
  block = "latest"
) {
  return backoffRetrier(totalAttempts)(async () => {
    // @ts-ignore A newer version of Web3 is needed to include call in TS.
    return await boundContractMethod.call(
      {
        from: "", // FIXME Need systemic handling of default from address.
        ...sendParams
      },
      block
    )
  })
}

/**
 * @typedef {Object} DeployedContract
 * @property {number|undefined} deployedAtBlock Number of block when contract was
 * deployed.
 *
 * @typedef {Web3Contract & DeployedContract} Contract web3.eth.Contract enhanced
 * with property containing block number when contract was deployed.
 */

/**
 * Builds a web3.eth.Contract instance with the given ABI, pointed to the given
 * address, with a default `from` and revert handling set.
 *
 * @param {Web3} web3 The Web3 instance to instantiate the contract on.
 * @param {AbiItem[]} contractABI The ABI of the contract to instantiate.
 * @param {string} [address] The address of the deployed contract; if left
 *        unspecified, the contract won't be pointed to any address.
 * @param {number} [deployedAtBlock]
 *
 * @return {Contract} A contract for the specified ABI at the specified address,
 *         with default `from` and revert handling set.
 */
function buildContract(web3, contractABI, address, deployedAtBlock) {
  /** @type {Web3Contract} */
  const web3Contract = /** @type {any} */ (new web3.eth.Contract(contractABI))
  if (address) {
    web3Contract.options.address = address
  }
  web3Contract.options.from = web3.eth.defaultAccount || undefined
  // @ts-ignore A newer version of Web3 is needed to include handleRevert.
  web3Contract.options.handleRevert = true

  /** @type {Contract} */
  const contract = (web3Contract)

  contract.deployedAtBlock = deployedAtBlock || undefined

  return contract
}

/**
 * Gets the Web3 Contract for a Truffle artifact and Web3 instance. Throws if
 * the artifact does not contain deployment information for the specified
 * network id.
 *
 * @param {TruffleArtifact} artifact The Truffle artifact for the deployed
 *        contract.
 * @param {Web3} web3 The Web3 instance to instantiate the contract on.
 * @param {string} networkId The network ID of the network the contract is
 *        deployed at.
 *
 * @return {Promise<Contract>} A contract ready for usage with web3 for the
 *        given network and artifact.
 */
async function getDeployedContract(artifact, web3, networkId) {
  const deploymentInfo = artifact.networks[networkId]
  if (!deploymentInfo) {
    throw new Error(
      `No deployment info found for contract ${artifact.contractName}, network ID ${networkId}.`
    )
  }

  const transaction = await web3.eth.getTransaction(
    artifact.networks[networkId].transactionHash
  )

  let deployedAtBlock
  if (transaction && transaction.blockNumber) {
    deployedAtBlock = transaction.blockNumber
  }

  return buildContract(
    web3,
    artifact.abi,
    deploymentInfo.address,
    deployedAtBlock
  )
}

export default {
  isMainnet,
  getEvent,
  getExistingEvents,
  getExistingEvent,
  readEventFromTransaction,
  bytesToRaw,
  sendSafely,
  sendSafelyRetryable,
  callWithRetry,
  buildContract,
  getDeployedContract
}
