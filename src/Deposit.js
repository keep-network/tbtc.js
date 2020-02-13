import secp256k1 from 'bcrypto/lib/secp256k1.js'
import BcoinPrimitives from 'bcoin/lib/primitives/index.js'
import BcoinScript from 'bcoin/lib/script/index.js'
const { KeyRing } = BcoinPrimitives
const { Script } = BcoinScript

import { BitcoinSPV } from "./lib/BitcoinSPV.js"
import { BitcoinTxParser } from "./lib/BitcoinTxParser.js"
import ElectrumClient from "./lib/ElectrumClient.js"

import TruffleContract from "@truffle/contract"

import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"
import DepositJSON from "@keep-network/tbtc/artifacts/Deposit.json"
import DepositLogJSON from "@keep-network/tbtc/artifacts/DepositLog.json"
import DepositFactoryJSON from "@keep-network/tbtc/artifacts/DepositFactory.json"
import TBTCTokenJSON from "@keep-network/tbtc/artifacts/TBTCToken.json"
import FeeRebateTokenJSON from "@keep-network/tbtc/artifacts/FeeRebateToken.json"
import VendingMachineJSON from "@keep-network/tbtc/artifacts/VendingMachine.json"
import ECDSAKeepJSON from "@keep-network/tbtc/artifacts/ECDSAKeep.json"
const TBTCConstants = TruffleContract(TBTCConstantsJSON)
const TBTCSystemContract = TruffleContract(TBTCSystemJSON)
const TBTCDepositTokenContract = TruffleContract(TBTCDepositTokenJSON)
const DepositContract = TruffleContract(DepositJSON)
const DepositFactoryContract = TruffleContract(DepositFactoryJSON)
const TBTCTokenContract = TruffleContract(TBTCTokenJSON)
const FeeRebateTokenContract = TruffleContract(FeeRebateTokenJSON)
const VendingMachineContract = TruffleContract(VendingMachineJSON)
const ECDSAKeepContract = TruffleContract(ECDSAKeepJSON)

// TODO Need this configured via TBTC.
import electrumConfig from "./electrum-config.json"

export class DepositFactory {
    config/*: TBTCConfig*/;

    constantsContract/*: any */;
    systemContract/*: any*/;
    tokenContract/*: any */;
    depositTokenContract/*: any*/;
    feeRebateTokenContract/*: any */;
    depositContract/*: any*/;
    depositLogContract/*: any*/;
    depositFactoryContract/*: any */;
    vendingMachineContract/*: any */;

    static async withConfig(config/*: TBTCConfig)*/)/*: Promise<DepositFactory>*/ {
        const statics = new DepositFactory(config)
        await statics.resolveContracts()

        return statics
    }

    constructor(config/*: TBTCConfig*/) {
        this.config = config
    }

    async availableSatoshiLotSizes()/*: Promise<BN[]>*/ {
        return await this.systemContract.getAllowedLotSizes()
    }

    /**
     * Opens a new deposit with the given lot size in satoshis and returns a
     * Deposit handle to it. If the lot size is not currently permitted by the
     * tBTC system, throws an error. If a contract issue occurs during the
     * opening of the deposit, throws an issue.
     * 
     * To follow along once the deposit is initialized, see the `Deposit` API.
     * 
     * @param satoshiLotSize The lot size, in satoshis, of the deposit. Must be
     *        in the list of allowed lot sizes from Deposit.availableLotSizes().
     */
    async withSatoshiLotSize(satoshiLotSize/*: BN*/)/*: Promise<Deposit>*/ {
        if (! await this.systemContract.isAllowedLotSize(satoshiLotSize)) {
            throw new Error(
                `Lot size ${satoshiLotSize} is not permitted; only ` +
                `one of ${(await this.availableSatoshiLotSizes()).join(',')} ` +
                `can be used.`
            )
        }

        const deposit = Deposit.forLotSize(this, satoshiLotSize)
        return deposit
    }

    // Await the deployed() functions of all contract dependencies.
    async resolveContracts() {
        const init = ([contract, propertyName]) => {
            contract.setProvider(this.config.web3.currentProvider)
            return contract.deployed().then((_) => this[propertyName] = _)
        }

        const contracts = [
            [TBTCConstants, 'constantsContract'],
            [TBTCSystemContract, 'systemContract'],
            [TBTCTokenContract, 'tokenContract'],
            [TBTCDepositTokenContract, 'depositTokenContract'],
            [FeeRebateTokenContract, 'feeRebateTokenContract'],
            [DepositContract, 'depositContract'],
            [DepositFactoryContract, 'depositFactoryContract'],
            [VendingMachineContract, 'vendingMachineContract'],
        ]

        await Promise.all(contracts.map(init))
    }

    /**
     * INTERNAL USE ONLY
     *
     * Initializes a new deposit and returns a tuple of the deposit contract
     * address and the associated keep address.
     */
    async createNewDepositContract(lotSize/*: BN */) {
        const funderBondAmount = await this.constantsContract.getFunderBondAmount()
        const accountBalance = await this.config.web3.eth.getBalance(this.config.web3.eth.defaultAccount)
        if (funderBondAmount.lt(accountBalance)) {
            throw `Insufficient balance ${accountBalance.toString()} to open ` +
                `deposit (required: ${funderBondAmount.toString()}).`
        }

        const result = await this.depositFactoryContract.createDeposit(
            this.systemContract.address,
            this.tokenContract.address,
            this.depositTokenContract.address,
            this.feeRebateTokenContract.address,
            this.vendingMachineContract.address,
            1,
            1,
            lotSize,
            {
                from: this.config.web3.eth.defaultAccount,
                value: funderBondAmount,
            }
        )

        const createdEvent = readEventFromTransaction(
            this.config.web3,
            result,
            this.systemContract,
            'Created',
        )
        if (! createdEvent) {
            throw new Error(
                `Transaction failed to include keep creation event. ` +
                `Transaction was: ${JSON.stringify(result)}.`
            )
        }

        return {
            depositAddress: createdEvent._depositContractAddress,
            keepAddress: createdEvent._keepAddress,
        }
    }
}

// Bitcoin address handlers are given an address and a cancelAutoMonitor
// function. By default, when an address is made available, the deposit
// automatically starts monitoring for a Bitcoin chain transaction to that
// address, and, upon seeing such a transaction with the number of confirmations
// required by the tBTC system, submits proof of that transaction to the chain.
// Calling cancelAutoMonitor() disables this, and leaves chain monitoring and
// proof submission to the caller.
// type BitcoinAddressHandler = (address: string, cancelAutoMonitor: ()=>void)=>void
// Active handlers are given the deposit that just entered the ACTIVE state.
// type ActiveHandler = (deposit: Deposit)=>void

export default class Deposit {
    factory/*: DepositFactory*/;
    address/*: string*/;
    keepAddress/*: string*/;
    contract/*: any*/;

    bitcoinAddress/*: Promise<string>*/;
    activeStatePromise/*: Promise<[]>*/; // fulfilled when deposit goes active
    autoMonitor/*: boolean*/;

    static async forLotSize(factory/*: DepositFactory*/, satoshiLotSize/*: BN*/)/*: Promise<Deposit>*/ {
        const { depositAddress, keepAddress } = await factory.createNewDepositContract(satoshiLotSize)
        const contract = await DepositContract.at(depositAddress)

        return new Deposit(factory, contract, keepAddress)
    }

    static async forAddress(factory/*: DepositFactory*/, address/*: string*/)/*: Promise<Deposit>*/ {
        const contract = await DepositContract.at(address)

        return new Deposit(factory, contract)
    }

    static async forTDT(factory/*: DepositFactory*/, tdt/*: TBTCDepositToken | string*/)/*: Promise<Deposit>*/ {
        return new Deposit(factory, "")
    }

    constructor(factory/*: DepositFactory*/, depositContract/*: TruffleContract*/, keepAddress/*: string */) {
        this.factory = factory
        this.address = depositContract.address
        this.keepAddress = keepAddress
        this.contract = depositContract

        this.autoMonitor = true

        // Set up state transition promises.
        this.activeStatePromise = this.waitForActiveState()
        if (! keepAddress) {
            throw "No keep address currently means no nothin', sorryyyyy."
            // look up keep address via factory.systemContract.getPastEvents("Created"...)
        } else {
            this.bitcoinAddress = this.findOrWaitForBitcoinAddress()
        }

        // Set up funding auto-monitoring. Below, every time we're doing another
        // long wait, we check to see if auto-monitoring has been disabled since
        // last we checked, and return out if so.
        this.bitcoinAddress.then(async (address) => {
            const expectedValue = (await this.getSatoshiLotSize()).toNumber()

            if (! this.autoMonitor) return;
            const tx = await BitcoinHelpers.Transaction.findOrWaitFor(address, expectedValue)
            // issue event when we find a tx

            const requiredConfirmations = await this.factory.constantsContract.getTxProofDifficultyFactor()

            if (! this.autoMonitor) return;
            const confirmations =
                await BitcoinHelpers.Transaction.waitForConfirmations(
                    tx,
                    requiredConfirmations.toNumber(),
                )

            if (! this.autoMonitor) return;
            this.submitFundingProof(tx, confirmations)
        })
    }

    ///------------------------------- Accessors -------------------------------

    /**
     * Returns a promise that resolves to the lot size of the deposit, in
     * satoshis.
     */
    async getSatoshiLotSize() {
        return await this.contract.lotSizeSatoshis()
    }

    /**
     * Returns a promise that resolves to the Bitcoin address for the wallet
     * backing this deposit. May take an extended amount of time if this deposit
     * has just been created.
     */
    async getBitcoinAddress() {
        return await this.bitcoinAddress
    }

    async getTDT()/*: Promise<TBTCDepositToken>*/ {
        return {}
    }

    async getFRT()/*: Promise<FeeRebateToken | null>*/ {
        return {}
    }

    async getOwner()/*: Promise<string>*/ /* ETH address */ {
        return ""
    }

    async inVendingMachine()/*: Promise<boolean>*/ {
        return false
    }

    ///---------------------------- Event Handlers -----------------------------

    /**
     * Registers a handler for notification when a Bitcoin address is available
     * for this deposit. The handler receives the address and a function to call
     * if it wishes to disable auto-monitoring and submission of funding
     * transaction proof.
     * 
     * @param bitcoinAddressHandler A function that takes a bitcoin address and
     *        a cancelAutoMonitor function, and is called when the deposit's
     *        Bitcoin address becomes available. For already-open deposits, this
     *        callback will be invoked as soon as the address is fetched from
     *        the chain. cancelAutoMonitor can be used to turn off the auto-
     *        monitoring functionality that looks for new Bitcoin transactions
     *        to a deposit awaiting funding so as to submit a funding proof; see
     *        the `cancelAutoMonitor` method for more.
     */
    onBitcoinAddressAvailable(bitcoinAddressHandler/*: BitcoinAddressHandler*/) {
        this.bitcoinAddress.then((address) => {
            bitcoinAddressHandler(address, this.cancelAutoMonitor)
        })
    }

    /**
     * Registers a handler for notification when the deposit enters the ACTIVE
     * state, when it has been proven funded and becomes eligible for TBTC
     * minting and other uses. The deposit itself is passed to the handler.
     * 
     * @param activeHandler A handler called when this deposit enters the ACTIVE
     *        state; receives the deposit as its only parameter.
     */
    onActive(activeHandler/*: (Deposit)=>void*/) {
        this.activeStatePromise.then(() => {
            activeHandler(this)
        })
    }

    onReadyForProof(proofHandler/*: (prove)=>void*/) {
        // prove(txHash) is a thing, will submit funding proof for the given
        // Bitcoin txHash; no verification initially.
    }

    ///--------------------------- Deposit Actions -----------------------------

    async mintTBTC()/*: Promise<BN>*/ {
        // check is active
        // throw if not
        // return TBTC minted amount
    }

    async qualifyAndMintTBTC(txHash/*: string*/)/*: Promise<BN>*/ {
        // VendingMachine.tdtToTbtc
        // return TBTC minted amount
    }

    async redemptionCost()/*: Promise<BN>*/ {
        // if inVendingMachine -> 1 TBTC + getOwnerRedemption...
        // else getOwnerRedemption...
    }

    async requestRedemption(redemptionAddress/*: string /* bitcoin address */)/*: Redemption*/ {
        return new Redemption(this, redemption)
    }

    ///------------------------------- Helpers ---------------------------------

    // Finds an existing event from the keep backing the Deposit to access the
    // keep's public key, then submits it to the deposit to transition from
    // state AWAITING_SIGNER_SETUP to state AWAITING_BTC_FUNDING_PROOF and
    // provide access to the Bitcoin address for the deposit.
    //
    // Note that the client must do this public key submission to the deposit
    // manually; the deposit is not currently informed by the Keep of its newly-
    // generated pubkey for a variety of reasons.
    //
    // Returns a promise that will be fulfilled once the public key
    async findOrWaitForBitcoinAddress() {
        let signerPubkeyEvent = await this.readPublishedPubkeyEvent()
        if (signerPubkeyEvent) {
            return this.parseBitcoinAddress(signerPubkeyEvent)
        }

        ECDSAKeepContract.setProvider(this.factory.config.web3.currentProvider)
        const ecdsaKeep = await ECDSAKeepContract.at(this.keepAddress)
        // Wait for the Keep to be ready.
        await getEvent(ecdsaKeep, 'PublicKeyPublished')
        // Ask the deposit to fetch and store the signer pubkey.
        const pubkeyTransaction = await this.contract.retrieveSignerPubkey(
            {
                from: this.factory.config.web3.eth.defaultAccount,
            }
        )

        return this.parseBitcoinAddress(readEventFromTransaction(
            this.factory.config.web3,
            pubkeyTransaction,
            this.factory.systemContract,
            'RegisteredPubkey',
        ))
    }

    // Returns a promise that is fulfilled when the contract has entered the
    // active state.
    async waitForActiveState() {
        const depositIsActive = await this.contract.inActive()
        console.log("Got deposit is active", depositIsActive)
        if (depositIsActive) {
            return true
        }

        // If we weren't active, wait for Funded, then mark as active.
        // FIXME/NOTE: We could be inactive due to being outside of the funding
        // FIXME/NOTE: path, e.g. in liquidation or courtesy call.
        await getEvent(
            this.factory.systemContract,
            'Funded',
            { _depositContractAddress: this.address },
        )
        console.log("GOT IT THIS TIME SOMEHOW")

        return true
    }

    async readPublishedPubkeyEvent() {
        return getExistingEvent(
            this.factory.systemContract,
            'RegisteredPubkey',
            { _depositContractAddress: this.address },
        )
    }

    async parseBitcoinAddress(signerPubkeyEvent) {
        return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
            signerPubkeyEvent._signingGroupPubkeyX,
            signerPubkeyEvent._signingGroupPubkeyY,
            this.factory.config.bitcoinNetwork,
        )
    }

    async submitFundingProof(transaction, confirmations) {
        const { transactionID, outputPosition } = transaction
        const {
            tx,
            merkleProof,
            chainHeaders,
        } = await BitcoinHelpers.Transaction.getProof(transactionID, confirmations)

        const {
            version,
            txInVector,
            txOutVector,
            locktime,
        } = BitcoinTxParser.parse(tx)

        console.log("Submitting proof........")
        return await this.contract.provideBTCFundingProof(
            Buffer.from(version, 'hex'),
            Buffer.from(txInVector, 'hex'),
            Buffer.from(txOutVector, 'hex'),
            Buffer.from(locktime, 'hex'),
            outputPosition,
            Buffer.from(merkleProof, 'hex'),
            proof.txInBlockIndex,
            Buffer.from(chainHeaders, 'hex'),
        )
    }
}

/**
 * Found transaction details.
 * @typedef FoundTransaction
 * @type {Object}
 * @property {string} transactionID Transaction ID.
 * @property {number} outputPosition Position of output in the transaction.
 * @property {number} value Value of the output (satoshis).
*/

const BitcoinHelpers = {
    Address: {
        publicKeyPointToP2WPKHAddress: function(publicKeyX, publicKeyY, bitcoinNetwork) {
            return this.publicKeyToP2WPKHAddress(
                `${publicKeyX.replace('0x', '')}${publicKeyY.replace('0x','')}`,
                bitcoinNetwork,
            )
        },
        /**
         * Converts public key to bitcoin Witness Public Key Hash Address according to
         * [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki).
         * @param {string} publicKeyString Public key as a hexadecimal representation of
         * 64-byte concatenation of x and y coordinates.
         * @param {Network} network Network for which address has to be calculated.
         * @return {string} A Bitcoin P2WPKH address for given network.
         */
        publicKeyToP2WPKHAddress: function(publicKeyString, network) {
            const publicKeyBytes = Buffer.from(publicKeyString, 'hex')

            // Witness program requires usage of compressed public keys.
            const compress = true

            const publicKey = secp256k1.publicKeyImport(publicKeyBytes, compress)
            const keyRing = KeyRing.fromKey(publicKey, compress)
            const p2wpkhScript = Script.fromProgram(0, keyRing.getKeyHash())
        
            // Serialize address to a format specific to given network.
            return p2wpkhScript.getAddress().toString(network)
        },
        /**
         * Converts a Bitcoin ScriptPubKey address string to a hex script
         * string.
         *
         * @param {string} address A Bitcoin address.
         *
         * @return {string} A Bitcoin script for the given address.
         */
        toScript: function(address) {
            return Script.fromAddress(address).toRaw().toString('hex')
        }
    },
    /**
     *
     * @param {(ElectrumClient)=>Promise<any>} block A function to execute with
     *        the ElectrumClient passed in; it is expected to return a Promise
     *        that will resolve once the function is finished performing work
     *        with the client. withElectrumClient returns that promise, but also
     *        ensures that the client will be closed once the promise completes
     *        (successfully or unsuccessfully).
     */
    withElectrumClient: async function(block) {
        const electrumClient = new ElectrumClient(electrumConfig.electrum.testnetWS)

        await electrumClient.connect()

        const result = block(electrumClient)
        result.then(
            () => { electrumClient.close() },
            () => { electrumClient.close() },
        )

        return result
    },
    Transaction: {
        /**
         * Finds a transaction to the given `receiverScript` of the given
         * `expectedValue` using the given `electrumClient`.
         *
         * @param {ElectrumClient} electrumClient An already-initialized Electrum client.
         * @param {string} receiverScript A receiver script.
         * @param {number} expectedValue The expected value of the transaction
         *        to fetch.
         *
         * @return {FoundTransaction} A promise to an object of transactionID,
         *         outputPosition, and value, that resolves with either null
         *         if such a transaction could not be found, or the information
         *         about the transaction that was found.
         */
        find: async function(electrumClient, receiverScript, expectedValue) {
            const unspentTransactions = await electrumClient.getUnspentToScript(receiverScript)

            for (const tx of unspentTransactions) {
                if (tx.value == expectedValue) {
                    return {
                        transactionID: tx.tx_hash,
                        outputPosition: tx.tx_pos,
                        value: tx.value,
                    }
                }
            }
        },
        /**
         * Watches the Bitcoin chain for a transaction of value `expectedValue`
         * to address `bitcoinAddress`.
         *
         * @param {string} bitcoinAddress Bitcoin address to watch.
         * @param {number} expectedValue The expected value to watch for.
         *
         * @return {Promise<FoundTransaction>} A promise to the found
         *         transaction once it is seen on the chain.
         */
        findOrWaitFor: async function(bitcoinAddress, expectedValue) {
            return await BitcoinHelpers.withElectrumClient(async (electrumClient) => {
                const script = BitcoinHelpers.Address.toScript(bitcoinAddress)

                // This function is used as a callback to electrum client. It is
                // invoked when an existing or a new transaction is found.
                const checkTransactions = async function(status) {
                    // If the status is set, transactions were seen for the
                    // script.
                    if (status) {
                        const result =  BitcoinHelpers.Transaction.find(
                            electrumClient,
                            script,
                            expectedValue,
                        )

                        return result
                    }
                }

                return electrumClient.onTransactionToScript(
                    script,
                    checkTransactions,
                )
            })
        },
        /**
         * Watches the Bitcoin chain until the given `transaction` has the given
         * number of `requiredConfirmations`.
         *
         * @param {Transaction} transaction Transaction object from Electrum.
         * @param {number} requiredConfirmations The number of required
         *        confirmations to wait before returning.
         *
         * @return A promise to the final number of confirmations observed that
         *         was at least equal to the required confirmations.
         */
        waitForConfirmations: async function(transaction, requiredConfirmations) {
            const id = transaction.transactionID

            return BitcoinHelpers.withElectrumClient(async (electrumClient) => {
                const checkConfirmations = async function() {
                    const { confirmations } = await electrumClient.getTransaction(id)
                    if (confirmations >= requiredConfirmations) {
                        return confirmations
                    }
                }

                return electrumClient.onNewBlock(checkConfirmations)
            })
        },
        getProof: async function(transactionID, confirmations) {
            return await BitcoinHelpers.withElectrumClient(async (electrumClient) => {
                const spv = new BitcoinSPV(electrumClient)
                return spv.getTransactionProof(transactionID, confirmations)
            })
        },
    }
}

/**
 * From a given transaction result, extracts the first event with the given
 * name from the given source contract.
 * 
 * @param {Web3} web3 A web3 instance for operating.
 * @param {Result} transaction A web3 transaction result.
 * @param {TruffleContract} sourceContract A TruffleContract instance whose
 *        event is being read.
 * @param {string} eventName The name of the event to be read.
 * 
 * @return The event as read from the transaction's raw logs; note that this
 *         event has a different structure than the event passed to event
 *         handlers---it returns the equivalent of `event.args` from event
 *         handlers.
 */
function readEventFromTransaction(web3, transaction, sourceContract, eventName) {
    const inputsABI = sourceContract.abi.find(
        (entry) => entry.type == "event" && entry.name == eventName
    ).inputs

    return transaction.receipt.rawLogs.
        filter((_) => _.address == sourceContract.address).
        map((_) => web3.eth.abi.decodeLog(inputsABI, _.data, _.topics.slice(1)))
        [0]
}

/**
 * Waits until `source` emits the given `event`, including searching past blocks
 * for such `event`, then returns it.
 *
 * @param {TruffleContract} sourceContract The TruffleContract that emits the event.
 * @param {string} eventName The name of the event to wait on.
 * @param {object} filter An additional filter to apply to the event being
 *        searched for.
 *
 * @return A promise that will be fulfilled by the event object once it is
 *         received.
 */
function getEvent(sourceContract, eventName, filter) {
    return new Promise((resolve) => {
        sourceContract[eventName](filter).once("data", (event) => {
            clearInterval(handle);
            resolve(event)
        })

        // As a workaround for a problem with MetaMask version 7.1.1 where subscription
        // for events doesn't work correctly we pull past events in a loop until
        // we find our event. This is a temporary solution which should be removed
        // after problem with MetaMask is solved.
        // See: https://github.com/MetaMask/metamask-extension/issues/7270
        const handle = setInterval(
            async function() {
                // Query if an event was already emitted after we start watching
                const event = await getExistingEvent(
                    sourceContract,
                    eventName,
                    filter,
                )

                if (event) {
                    clearInterval(handle)
                    resolve(event)
                }
            },
            3000, // every 3 seconds
        )
    })
}

async function getExistingEvent(source, eventName, filter) {
    const events = await source.getPastEvents(
        eventName,
        {
            fromBlock: 0,
            toBlock: 'latest',
            filter,
        }
    )

    return events[0]
}

class Redemption {
    deposit/*: Deposit*/
    redemptionAddress/*: string*/

    constructor(deposit/*: Deposit*/, redemptionAddress/*: string*/) {
        this.deposit = deposit
        this.redemptionAddress = redemptionAddress

        // if deposit.inVendingMachine
        //    vendingMachine.tbtcToBtc
        // else
        //    deposit.requestRedemption
    }

    autoSubmit() {
        // monitor chain for signature
        // construct + submit transaction
        // TODO bumpFee if needed
        // prove transaction
        // onWithdrawn
    }

    proveWithdrawal(txHash) {
        // submit withdrawal proof
    }

    onWithdrawn(withdrawalHandler/*: (txHash)=>void*/) { // bitcoin txHash
    }
}

/*

import TBTC from 'tbtc.js'
const tbtc = TBTC.configure({
    web3: web3
    // maybe contractAddresses
    btcNetwork: 'testnet'
})

const deposit = await Deposit.withLotSize(100000)
deposit.onAddressAvailable((address, cancelAutoMonitor) => {
  // show QR code
  // call cancelAutoMonitor to manage your own BTC lifecycle if preferred
})
deposit.onActive(async () => {
  await deposit.mintTBTC()
  // or
  (await deposit.getTDT()).transfer(someLuckyContract)
})

// later…

(await deposit.requestRedemption("tb....")).autoSubmit()
  .onWithdrawn((txHash) => {
    // all done!
  })
  */
