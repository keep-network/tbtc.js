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
 * @return {Object} The event as decoded from the transaction's raw logs.
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
      _ =>
        _.address == sourceContract.options.address &&
        _.raw.topics[0] == eventABI.signature
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

export default {
  getEvent,
  getExistingEvent,
  readEventFromTransaction
}
