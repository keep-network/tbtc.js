/**
 * From a given transaction result, extracts the first event with the given
 * name from the given source contract.
 *
 * @param {Web3} web3 A web3 instance for operating.
 * @param {Result} transaction A web3 transaction result.
 * @param {Contract} sourceContract A web3 Contract instance whose
 *        event is being read.
 * @param {string} eventName The name of the event to be read.
 *
 * @return {Object} A key-value dictionary of the event's parameters.
 */
function readEventFromTransaction(
  web3,
  transaction,
  sourceContract,
  eventName
) {
  const eventABI = sourceContract.options.jsonInterface.find(
    entry => entry.type == "event" && entry.name == eventName
  )

  return Object.values(transaction.events)
    .filter(
      event =>
        event.address == sourceContract.options.address &&
        event.raw.topics[0] == eventABI.signature
    )
    .map(_ =>
      web3.eth.abi.decodeLog(eventABI.inputs, _.raw.data, _.raw.topics.slice(1))
    )[0]
}

/**
 * Waits until `source` emits the given `event`, including searching past blocks
 * for such `event`, then returns it.
 *
 * @param {Contract} sourceContract The web3 Contract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {object} filter An additional filter to apply to the event being
 *        searched for.
 *
 * @return {Promise<Object>} A promise that will be fulfilled by the event
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

async function getExistingEvent(source, eventName, filter) {
  const events = await source.getPastEvents(eventName, {
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
 * @param {*} boundContractMethod A bound web3 contract method with
 *        `estimateGas`, `send`, and `call` variants available.
 * @param {*} sendParams The parameters to pass to `estimateGas` and `send` for
 *        transaction processing.
 * @param {boolean} forceSend Force the transaction send through even if gas
 *        estimation fails.
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
      ...sendParams,
      gas: gasEstimate
    })
  } catch (exception) {
    // If we're not forcibly sending, try to resolve the true error by using
    // `call`.
    if (
      exception.message &&
      exception.message.match(/always failing transaction/)
    ) {
      let callResult
      try {
        // FIXME Something more is needed here to properly resolve this error...
        callResult = await boundContractMethod.call(sendParams)
      } catch (trueError) {
        if (forceSend) {
          console.error(callResult, trueError)
        } else {
          throw trueError
        }
      }

      if (forceSend) {
        return boundContractMethod.send(sendParams)
      } else {
        // If we weren't able to get a better error from `call`, throw the
        // original exception.
        throw exception
      }
    } else {
      throw exception // rethrow the exception if we don't handle it
    }
  }
}

/**
 * Gets the Web3 Contract for a Truffle artifact and Web3 instance.
 * @param {JSON} artifact
 * @param {*} web3
 * @param {string} networkId
 * @return {Contract}
 */
function getDeployedContract(artifact, web3, networkId) {
  function lookupAddress(artifact) {
    const deploymentInfo = artifact.networks[networkId]
    if (!deploymentInfo) {
      throw new Error(
        `No deployment info found for contract ${artifact.contractName}, network ID ${networkId}.`
      )
    }
    return deploymentInfo.address
  }

  const contract = new web3.eth.Contract(artifact.abi)
  contract.options.address = lookupAddress(artifact)
  contract.options.from = web3.eth.defaultAccount

  return contract
}

export default {
  getEvent,
  getExistingEvent,
  readEventFromTransaction,
  bytesToRaw,
  sendSafely,
  getDeployedContract
}
