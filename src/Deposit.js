import secp256k1 from 'bcrypto/lib/secp256k1.js'
import BcoinPrimitives from 'bcoin/lib/primitives/index.js'
import BcoinScript from 'bcoin/lib/script/index.js'
const KeyRing = BcoinPrimitives.KeyRing
const Script = BcoinScript.Script

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
const DepositLogContract = TruffleContract(DepositLogJSON)
const DepositFactoryContract = TruffleContract(DepositFactoryJSON)
const TBTCTokenContract = TruffleContract(TBTCTokenJSON)
const FeeRebateTokenContract = TruffleContract(FeeRebateTokenJSON)
const VendingMachineContract = TruffleContract(VendingMachineJSON)
const ECDSAKeepContract = TruffleContract(ECDSAKeepJSON)

export class DepositFactory {
    config/*: TBTCConfig*/;

    constants/*: any */;
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
            [TBTCConstants, 'constants'],
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
        const funderBondAmount = await this.constants.getFunderBondAmount()
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
    addressHandlers/*: BitcoinAddressHandler[]*/;
    activeHandlers/*: ActiveHandler[]*/;

    bitcoinAddress/*: string*/;

    static async forLotSize(factory/*: DepositFactory*/, lotSize/*: BN*/)/*: Promise<Deposit>*/ {
        const { depositAddress, keepAddress } = await factory.createNewDepositContract(lotSize)
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

        this.addressHandlers = []
        this.activeHandlers = []

        if (! keepAddress) {
            throw "No keep address currently means no nothin', sorryyyyy."
            // look up keep address via factory.systemContract.getPastEvents("Created"...)
        } else {
            this.bitcoinAddress = this.findOrWaitForBitcoinAddress()
        }
    }

    async getBitcoinAddress() {
        return await this.bitcoinAddress
    }

    async open() {
        // 
    }

    /**
     * Registers a handler for notification when a Bitcoin address is available
     * for this deposit. The handler receives the address and a function to call
     * if it wishes to disable auto-monitoring and submission of funding
     * transaction proof.
     * 
     * @note Currently, this function will only notify the passed handler if the
     *       Bitcoin address becomes available _after_ the function is called.
     *       If the address was already available at call time, the handler will
     *       never be called.
     * 
     * @param bitcoinAddressHandler Add
     */
    onAddressAvailable(bitcoinAddressHandler/*: BitcoinAddressHandler*/) {
        this.addressHandlers.push(bitcoinAddressHandler)
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
        this.activeHandlers.push(activeHandler)
    }

    onReadyForProof(proofHandler/*: (prove)=>void*/) {
        // prove(txHash) is a thing, will submit funding proof for the given
        // Bitcoin txHash; no verification initially.
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

    async readPublishedPubkeyEvent() {
        return getExistingEvent(
            this.factory.systemContract,
            'RegisteredPubkey',
            { _depositContractAddress: this.address }
        )
    }

    async parseBitcoinAddress(signerPubkeyEvent) {
        return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
            signerPubkeyEvent._signingGroupPubkeyX,
            signerPubkeyEvent._signingGroupPubkeyY,
            this.factory.config.bitcoinNetwork,
        )
    }
}

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
        publicKeyToP2WPKHAddress: function (publicKeyString, network) {
            const publicKeyBytes = Buffer.from(publicKeyString, 'hex')

            // Witness program requires usage of compressed public keys.
            const compress = true

            const publicKey = secp256k1.publicKeyImport(publicKeyBytes, compress)
            const keyRing = KeyRing.fromKey(publicKey, compress)
            const p2wpkhScript = Script.fromProgram(0, keyRing.getKeyHash())
        
            // Serialize address to a format specific to given network.
            return p2wpkhScript.getAddress().toString(network)
        }
    }
}

/**
 * From a given transaction result, extracts the first event with the given
 * name from the given source contract.
 * 
 * @param {Web3} web3 A web3 instance for operating.
 * @param {Result} transaction A web3 transaction result.
 * @param {TruffleContract} sourceContract A TruffleContract instance whose event is being read.
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
 *
 * @return A promise that will be fulfilled by the event object once it is
 *         received.
 */
function getEvent(sourceContract, eventName) {
    return new Promise((resolve) => {
        sourceContract[eventName]().once("data", (event) => {
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
                const event = await getExistingEvent(sourceContract, eventName)

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
