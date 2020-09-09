/** @typedef { import("web3").default } Web3 */
/** @typedef { import("web3-eth-contract").Contract } Contract */
/** @typedef { import("web3-eth-contract").ContractSendMethod } ContractSendMethod */
/** @typedef { import("web3-eth-contract").SendOptions } SendOptions */
/** @typedef { import("web3-utils").AbiItem } AbiItem */
/** @typedef { import("web3-core").TransactionReceipt } TransactionReceipt */

import { backoffRetrier } from "./lib/backoff.js"

/**
 * @typedef {object} DeploymentInfo
 * @property {string} address The address a contract is deployed at on a given
 *           network.
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
 * @param {Contract} sourceContract A web3 Contract instance whose
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
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {object} [filter] An additional filter to apply to the event being
 *        searched for.
 *
 * @return {Promise<any>} A promise that will be fulfilled by the event
 *         object once it is received.
 */
function getEvent(sourceContract, eventName, filter) {
  return new Promise((resolve, reject) => {
    // As a workaround for a problem with MetaMask version 7.1.1 where subscription
    // for events doesn't work correctly we pull past events in a loop until
    // we find our event. This is a temporary solution which should be removed
    // after problem with MetaMask is solved.
    // See: https://github.com/MetaMask/metamask-extension/issues/7270
    const handle = setInterval(
      async function() {
        // Query if an event was already emitted after we start watching
        const event = await getExistingEvent(sourceContract, eventName, filter)

        if (event) {
          clearInterval(handle)
          resolve(event)
        }
      },
      3000 // every 3 seconds
    )

    sourceContract.once(eventName, { filter }, (error, event) => {
      clearInterval(handle)
      if (error) reject(error)
      else resolve(event)
    })
  })
}

/**
 * Looks up an existing event named `eventName` on `sourceContract`, searching
 * past blocks for it and then returning it. Respects additional filtering rules
 * set in the passed `filter` object, if available. Does not wait for any new
 * events.
 *
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {object} [filter] An additional filter to apply to the event being
 *        searched for.
 *
 * @return {Promise<any>} A promise that will be fulfilled by the event object
 *         once it is found.
 */
async function getExistingEvent(sourceContract, eventName, filter) {
  const events = await sourceContract.getPastEvents(eventName, {
    fromBlock: 0,
    toBlock: "latest",
    filter
  })

  return events[0]
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
 * @param {ContractSendMethod} boundContractMethod A bound web3 contract method
 *        with `estimateGas`, `send`, and `call` variants available.
 * @param {Partial<SendOptions>} [sendParams] The parameters to pass to
 *        `estimateGas` and `send` for transaction processing.
 * @param {boolean} [forceSend=false] Force the transaction send through even
 *        if gas estimation fails.
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function sendSafely(boundContractMethod, sendParams, forceSend) {
  try {
    // Clone `sendParams` so we aren't exposed to providers that modify `sendParams`.
    const gasEstimate = await boundContractMethod.estimateGas({ ...sendParams })

    return boundContractMethod.send({
      from: "", // FIXME Need systemic handling of default from address.
      ...sendParams,
      gas: gasEstimate
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
 * @param {Partial<SendOptions>} sendParams The parameters to pass to
 *        `estimateGas` and `send` for transaction processing.
 * @param {boolean} forceSend Force the transaction send through even if gas
 *        estimation fails.
 * @param {number} totalAttempts Total attempts number which should be performed
 *        in case of an error before rethrowing it to the caller.
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function sendSafelyRetryable(
  boundContractMethod,
  sendParams,
  forceSend,
  totalAttempts
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
 *
 * @return {Promise<any>} A promise to the result of sending the bound contract
 *         method. Fails the promise if gas estimation fails, extracting an
 *         on-chain error if possible.
 */
async function callWithRetry(
  boundContractMethod,
  sendParams,
  totalAttempts = 3
) {
  return backoffRetrier(totalAttempts)(async () => {
    // @ts-ignore A newer version of Web3 is needed to include call in TS.
    return await boundContractMethod.call({
      from: "", // FIXME Need systemic handling of default from address.
      ...sendParams
    })
  })
}

/**
 * Builds a web3.eth.Contract instance with the given ABI, pointed to the given
 * address, with a default `from` and revert handling set.
 *
 * @param {Web3} web3 The Web3 instance to instantiate the contract on.
 * @param {AbiItem[]} contractABI The ABI of the contract to instantiate.
 * @param {string} [address] The address of the deployed contract; if left
 *        unspecified, the contract won't be pointed to any address.
 *
 * @return {Contract} A contract for the specified ABI at the specified address,
 *         with default `from` and revert handling set.
 */
function buildContract(web3, contractABI, address) {
  const contract = new web3.eth.Contract(contractABI)
  if (address) {
    contract.options.address = address
  }
  contract.options.from = web3.eth.defaultAccount || undefined
  // @ts-ignore A newer version of Web3 is needed to include handleRevert.
  contract.options.handleRevert = true

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
 * @return {Contract} A web3.eth.Contract ready for usage for the given network
 *         and artifact.
 */
function getDeployedContract(artifact, web3, networkId) {
  const deploymentInfo = artifact.networks[networkId]
  if (!deploymentInfo) {
    throw new Error(
      `No deployment info found for contract ${artifact.contractName}, network ID ${networkId}.`
    )
  }

  return buildContract(web3, artifact.abi, deploymentInfo.address)
}

export default {
  isMainnet,
  getEvent,
  getExistingEvent,
  readEventFromTransaction,
  bytesToRaw,
  sendSafely,
  sendSafelyRetryable,
  callWithRetry,
  buildContract,
  getDeployedContract
}
