import TruffleContract from "truffle-contract"

import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"
import DepositJSON from "@keep-network/tbtc/artifacts/Deposit.json"
import DepositFactoryJSON from "@keep-network/tbtc/artifacts/DepositFactory.json"
import TBTCTokenJSON from "@keep-network/tbtc/artifacts/TBTCToken.json"
import FeeRebateTokenJSON from "@keep-network/tbtc/artifacts/FeeRebateToken.json"
import VendingMachineJSON from "@keep-network/tbtc/artifacts/VendingMachine.json"
const TBTCSystemContract = TruffleContract(TBTCSystemJSON)
const TBTCDepositTokenContract = TruffleContract(TBTCDepositTokenJSON)
const DepositContract = TruffleContract(DepositJSON)
const DepositFactoryContract = TruffleContract(DepositFactoryJSON)
const TBTCTokenContract = TruffleContract(TBTCTokenJSON)
const FeeRebateTokenContract = TruffleContract(FeeRebateTokenJSON)
const VendingMachineContract = TruffleContract(VendingMachineJSON)

export class DepositFactory {
    config/*: TBTCConfig*/;

    systemContract/*: any*/;
    tokenContract/*: any */;
    depositTokenContract/*: any*/;
    feeRebateTokenContract/*: any */;
    depositContract/*: any*/;
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
     */
    async createNewDepositContract(lotSize/*: BN */) {
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
              from: '0x16B129aeDE8eF971DC692e1AbC7cF2921757558a',
            }
        )

        const cloneEvent = result.logs.find((log) => {
            log.event == 'DepositCloneCreated' &&
                log.address == this.depositFactoryContract.address
        })
        if (! cloneEvent) {
            throw new Error(
                `Transaction failed to include deposit creation event. ` +
                `Transaction was: ${result}.`
            )
        }

        return await DepositContract.at(cloneEvent.args.depositCloneAddress)
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
    contract/*: any*/;
    addressHandlers/*: BitcoinAddressHandler[]*/;
    activeHandlers/*: ActiveHandler[]*/;

    static async forLotSize(factory/*: DepositFactory*/, lotSize/*: BN*/)/*: Promise<Deposit>*/ {
        const contract = await factory.createNewDepositContract(lotSize)

        return new Deposit(factory, address)
    }

    static async forAddress(factory/*: DepositFactory*/, address/*: string*/)/*: Promise<Deposit>*/ {
        return new Deposit(factory, address)
    }

    static async forTDT(factory/*: DepositFactory*/, tdt/*: TBTCDepositToken | string*/)/*: Promise<Deposit>*/ {
        return new Deposit(factory, "")
    }

    constructor(factory/*: DepositFactory*/, address/*: string*/) {
        this.factory = factory
        this.address = address
        this.contract = DepositContract.at(address)

        this.addressHandlers = []
        this.activeHandlers = []
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
