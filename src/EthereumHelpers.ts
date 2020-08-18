/** @typedef { import("web3").default } Web3 */
import type Web3 from 'web3'
import type {Contract, EventOptions, EstimateGasOptions, EventData} from 'web3-eth-contract'
import type {TransactionReceipt, PromiEvent} from 'web3-core'
import type BN from 'bn.js'

/**
 * Checks whether the given web3 instance is connected to Ethereum mainnet.
 *
 * @param {Web3} web3 The web3 instance whose network should be checked.
 * @return {Promise<boolean>} True if the web3 instance is aimed at Ethereum
 *         mainnet, false otherwise.
 */
async function isMainnet(web3:Web3) {
  return (await web3.eth.getChainId()) == 0x1
}

// Types modified from 'web3-eth-contract' because those types are wrong and can't be fixed
// through type augmentation
// 'from' should be optional as if it's not given web3 will use the from assigned to the contract
// See https://github.com/ethereum/web3.js/blob/01518219cd74fc1a016ca6615158fe52daa94722/packages/web3-eth-contract/src/index.js#L357
interface ContractCallOptions {
  from?: string;
  gasPrice?: string;
  gas?: number;
  value?: number | string | BN;
}

interface ContractCall {
  send(
    options: ContractCallOptions,
    callback?: (err: Error, transactionHash: string) => void
  ): PromiEvent<TransactionReceipt>;
  estimateGas(
    options: EstimateGasOptions,
    callback?: (err: Error, gas: number) => void
  ): Promise<number>;
  call(params:any):any;
}

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
  web3:Web3,
  transaction:TransactionReceipt,
  sourceContract:Contract,
  eventName:string
) {
  const eventABI = sourceContract.options.jsonInterface.find(
    entry => entry.type == "event" && entry.name == eventName
  )
  if(eventABI === undefined){
    throw new Error(`Event ${eventName} could not be found in transaction ${transaction.transactionHash}`)
  }

  return Object.values(transaction.events?? [])
    .filter(
      event =>
        event.address == sourceContract.options.address &&
        event?.raw?.topics[0] == (eventABI as any).signature
    )
    .map(_ =>
      web3.eth.abi.decodeLog(eventABI.inputs!, _.raw!.data, _.raw!.topics.slice(1))
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
function getEvent(sourceContract:Contract, eventName:string, filter?:EventOptions['filter']):Promise<EventData> {
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

async function getExistingEvent(source:Contract, eventName:string, filter?:EventOptions['filter']) {
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
function bytesToRaw(bytesString:HexString):string {
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
async function sendSafely(boundContractMethod:ContractCall, sendParams?:ContractCallOptions, forceSend:boolean = false):Promise<TransactionReceipt> {
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
        return boundContractMethod.send(sendParams ?? {})
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

type Artifact = {
  contractName:string,
  abi:any,
  networks:{[netId:string]:{
    address:string
  }}
}
/**
 * Wraps the {@link sendSafely} method with a retry logic.
 * @see {@link sendSafely}
 *
 * @param {*} boundContractMethod A bound web3 contract method with
 *        `estimateGas`, `send`, and `call` variants available.
 * @param {*} sendParams The parameters to pass to `estimateGas` and `send` for
 *        transaction processing.
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
  for (let attempt = 1; true; attempt++) {
    try {
      console.debug(`sending transaction; attempt number ${attempt}`)

      return await sendSafely(boundContractMethod, sendParams, forceSend)
    } catch (exception) {
      if (attempt === totalAttempts) {
        console.debug(`last attempt ${attempt} failed; throwing exception`)
        throw exception
      }

      const backoffMillis = Math.pow(2, attempt) * 1000
      const jitterMillis = Math.floor(Math.random() * 100)
      const waitMillis = backoffMillis + jitterMillis

      console.debug(
        `attempt ${attempt} failed: ${exception}; ` +
          `retrying after ${waitMillis} milliseconds`
      )

      await new Promise(resolve => setTimeout(resolve, waitMillis))
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
function getDeployedContract(artifact:Artifact, web3:Web3, networkId:string) {
  function lookupAddress(artifact:Artifact) {
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
  contract.options.from = web3.eth.defaultAccount ?? undefined
  contract.options.handleRevert = true

  return contract
}

export default {
  isMainnet,
  getEvent,
  getExistingEvent,
  readEventFromTransaction,
  bytesToRaw,
  sendSafely,
  sendSafelyRetryable,
  getDeployedContract
}
