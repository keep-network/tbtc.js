import secp256k1 from 'bcrypto/lib/secp256k1.js'
import BcoinPrimitives from 'bcoin/lib/primitives/index.js'
import BcoinScript from 'bcoin/lib/script/index.js'
import BcryptoSignature from 'bcrypto/lib/internal/signature.js'
const { KeyRing } = BcoinPrimitives
const { Script } = BcoinScript
const { Signature } = BcoinSignature

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

    async withAddress(depositAddress) {
        return await Deposit.forAddress(this, depositAddress)
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
    keepContract/*: string*/;
    contract/*: any*/;

    bitcoinAddress/*: Promise<string>*/;
    activeStatePromise/*: Promise<[]>*/; // fulfilled when deposit goes active
    autoMonitor/*: boolean*/;

    static async forLotSize(factory/*: DepositFactory*/, satoshiLotSize/*: BN*/)/*: Promise<Deposit>*/ {
        console.debug(
            'Creating new deposit contract with lot size',
            satoshiLotSize.toNumber(),
            'satoshis...',
        )
        const { depositAddress, keepAddress } = await factory.createNewDepositContract(satoshiLotSize)
        console.debug(
            `Looking up new deposit with address ${depositAddress} backed by ` +
            `keep at address ${keepAddress}...`
        )
        const contract = await DepositContract.at(depositAddress)

        ECDSAKeepContract.setProvider(factory.config.web3.currentProvider)
        const keepContract = await ECDSAKeepContract.at(keepAddress)

        return new Deposit(factory, contract, keepContract)
    }

    static async forAddress(factory/*: DepositFactory*/, address/*: string*/)/*: Promise<Deposit>*/ {
        console.debug(`Looking up Deposit contract at address ${address}...`)
        const contract = await DepositContract.at(address)

        console.debug(`Looking up Created event for deposit ${address}...`)
        const createdEvent = await getExistingEvent(
            factory.systemContract,
            'Created',
            { _depositContractAddress: address },
        )
        if (! createdEvent) {
            throw new Error(
                `Could not find creation event for deposit at address ${address}.`
            )
        }

        console.debug(`Found keep address ${createdEvent.args._keepAddress}.`)
        ECDSAKeepContract.setProvider(factory.config.web3.currentProvider)
        const keepContract = await ECDSAKeepContract.at(createdEvent.args._keepAddress)

        return new Deposit(factory, contract, keepContract, false)
    }

    static async forTDT(factory/*: DepositFactory*/, tdt/*: TBTCDepositToken | string*/)/*: Promise<Deposit>*/ {
        return new Deposit(factory, "")
    }

    constructor(factory/*: DepositFactory*/, depositContract/*: TruffleContract*/, keepContract/*: TruffleContract */, autoMonitor/*: boolean*/ = true) {
        if (! keepContract) {
            throw "Keep contract required for Deposit instantiation."
        }

        this.factory = factory
        this.address = depositContract.address
        this.keepContract = keepContract
        this.contract = depositContract

        this.autoMonitor = autoMonitor

        // Set up state transition promises.
        this.activeStatePromise = this.waitForActiveState()

        this.publicKeyPoint = this.findOrWaitForPublicKeyPoint()
        this.bitcoinAddress = this.publicKeyPoint.then(this.publicKeyPointToBitcoinAddress.bind(this))
        // Set up funding auto-monitoring. Below, every time we're doing another
        // long wait, we check to see if auto-monitoring has been disabled since
        // last we checked, and return out if so.
        this.bitcoinAddress.then(async (address) => {
            const expectedValue = (await this.getSatoshiLotSize()).toNumber()

            if (! this.autoMonitor) return;
            console.debug(
                `Monitoring Bitcoin for transaction to address ${address}...`,
            )

            const tx = await BitcoinHelpers.Transaction.findOrWaitFor(address, expectedValue)
            // issue event when we find a tx

            const requiredConfirmations = await this.factory.constantsContract.getTxProofDifficultyFactor()

            if (! this.autoMonitor) return;
            console.debug(
                `Waiting for ${requiredConfirmations} confirmations for ` +
                `Bitcoin transaction ${tx.transactionID}...`
            )

            const confirmations =
                await BitcoinHelpers.Transaction.waitForConfirmations(
                    tx,
                    requiredConfirmations.toNumber(),
                )

            if (! this.autoMonitor) return;
            console.debug(
                `Submitting funding proof to deposit ${this.address} for ` +
                `Bitcoin transaction ${tx.transactionID}...`
            )

            const proofArgs = await this.constructFundingProof(tx, confirmations)
            proofArgs.push({ from: this.factory.config.web3.eth.defaultAccount })
            this.contract.provideBTCFundingProof.apply(this.contract, proofArgs)
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
        return await this.factory.depositTokenContract.ownerOf(this.address)
    }

    async inVendingMachine()/*: Promise<boolean>*/ {
        return (await this.getOwner()) == this.factory.vendingMachineContract.address
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
     *        the `cancelAutoMonitor` method for more. Note that exceptions in
     *        this handler are not managed, so the handler itself should deal
     *        with its own failure possibilities.
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
     *        state; receives the deposit as its only parameter. Note that
     *        exceptions in this handler are not managed, so the handler itself
     *        should deal with its own failure possibilities.
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

    /**
     * Mints TBTC from this deposit by giving ownership of it to the tBTC
     * Vending Machine contract in exchange for TBTC. Requires that the deposit
     * already be qualified, i.e. in the ACTIVE state.
     *
     * @return A promise to the amount of TBTC that was minted to the deposit
     *         owner.
     */
    async mintTBTC()/*: Promise<BN>*/ {
        if (! await this.contract.inActive()) {
            throw new Error(
                "Can't mint TBTC with a deposit that isn't in ACTIVE state."
            )
        }

        console.debug(
            `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
        )
        await this.factory.depositTokenContract.approve(
            this.factory.vendingMachineContract.address,
            this.address,
            { from: this.factory.config.web3.eth.defaultAccount },
        )

        console.debug(
            `Minting TBTC...`
        )
        const transaction = await this.factory.vendingMachineContract.tdtToTbtc(
            this.address,
            { from: this.factory.config.web3.eth.defaultAccount },
        )

        // return TBTC minted amount
        const transferEvent = readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.tokenContract,
            'Transfer',
        )

        console.debug(`Found Transfer event for`, transferEvent.value, `TBTC.`)
        return transferEvent.value
    }

    /**
     * Finds a funding transaction to this deposit's funding address with the
     * appropriate number of confirmations, then calls the tBTC Vending
     * Machine's shortcut function to simultaneously qualify the deposit and
     * mint TBTC off of it, transferring ownership of the deposit to the
     * Vending Machine.
     *
     * @return A promise to the amount of TBTC that was minted to the deposit
     *         owner.
     *
     * @throws When there is no existing Bitcoin funding transaction with the
     *         appropriate number of confirmations, or if there is an issue
     *         in the Vending Machine's qualification + minting process.
     */
    async qualifyAndMintTBTC()/*: Promise<BN>*/ {
        const address = await this.bitcoinAddress
        const expectedValue = (await this.getSatoshiLotSize()).toNumber()
        const tx = await BitcoinHelpers.Transaction.find(address, expectedValue)
        if (! tx) {
            throw new Error(
                `Funding transaction not found for deposit ${this.address}.`
            )
        }

        const requiredConfirmations = await this.factory.constantsContract.getTxProofDifficultyFactor()
        const confirmations =
            await BitcoinHelpers.Transaction.checkForConfirmations(
                tx,
                requiredConfirmations.toNumber(),
            )
        if (! confirmations) {
            throw new Error(
                `Funding transaction did not have sufficient confirmations; ` +
                `expected ${requiredConfirmations.toNumber()}.`
            )
        }

        console.debug(
            `Approving transfer of deposit ${this.address} TDT to Vending Machine...`
        )
        await this.factory.depositTokenContract.approve(
            this.factory.vendingMachineContract.address,
            this.address,
            { from: this.factory.config.web3.eth.defaultAccount },
        )

        console.debug(
            `Qualifying and minting off of deposit ${this.address} for ` +
            `Bitcoin transaction ${tx.transactionID}...`,
            tx,
            confirmations,
        )
        const proofArgs = await this.constructFundingProof(tx, confirmations)
        proofArgs.unshift(this.address)
        proofArgs.push({ from: this.factory.config.web3.eth.defaultAccount })
        const transaction = await this.factory.vendingMachineContract.unqualifiedDepositToTbtc.apply(
            this.factory.vendingMachineContract,
            proofArgs,
        )

        // return TBTC minted amount
        const transferEvent = readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.tokenContract,
            'Transfer',
        )

        return transferEvent.value.div(this.factory.config.web3.utils.toBN(10).pow(18))
    }

    /**
     * Returns the cost, in TBTC, to redeem this deposit. If the deposit is in
     * the tBTC Vending Machine, includes the cost of retrieving it from the
     * Vending Machine.
     *
     * @return A promise to the amount of TBTC needed to redeem this deposit.
     */
    async getRedemptionCost()/*: Promise<BN>*/ {
        if (await this.inVendingMachine()) {
            const ownerRedemptionRequirement =
                await this.contract.getOwnerRedemptionTbtcRequirement(
                    this.factory.config.web3.eth.defaultAccount
                )
            const lotSize = await this.getSatoshiLotSize()

            const toBN = this.factory.config.web3.utils.toBN
            return lotSize.mul(toBN(10).pow(toBN(10))).add(
                ownerRedemptionRequirement
            )
        } else {
            return await this.contract.getRedemptionTbtcRequirement(
                this.factory.config.web3.eth.defaultAccount
            )
        }
    }

    async getCurrentRedemption()/*: Promise<Redemption?>*/ {
        const details = await this.getLatestRedemptionDetails()

        return new Redemption(this, details)
    }

    async requestRedemption(redeemerAddress/*: string /* bitcoin address */)/*: Promise<Redemption>*/ {
        const inVendingMachine = await this.inVendingMachine()
        const thisAccount = this.factory.config.web3.eth.defaultAccount
        const owner = await this.getOwner()
        const belongsToThisAccount = owner == thisAccount

        if (! inVendingMachine && ! belongsToThisAccount) {
            throw new Error(
                `Redemption is currently only supported for deposits owned by ` +
                `this account (${thisAccount}) or the tBTC Vending Machine ` +
                `(${this.factory.vendingMachineContract.address}). This ` +
                `deposit is owned by ${owner}.`
            )
        }

        const redeemerPKH = BitcoinHelpers.Address.pubKeyHashFrom(redeemerAddress)
        if (redeemerPKH === null) {
            throw new Error(
                `${redeemerAddress} is not a P2WPKH address. Currently only ` +
                `P2WPKH addresses are supported for redemption.`
            )
        }

        const redemptionCost = await this.getRedemptionCost()
        const availableBalance = await this.factory.tokenContract.balanceOf(thisAccount)
        if (redemptionCost.gt(availableBalance)) {
            throw new Error(
                `Account ${thisAccount} does not have the required balance of ` +
                `${redemptionCost.toString()} to redeem; it only has ` +
                `${availableBalance.toString()} available.`
            )
        }

        const toBN = this.factory.config.web3.utils.toBN
        console.debug(
            `Looking up UTXO size and transaction fee for redemption transaction...`,
        )
        const transactionFee = await BitcoinHelpers.Transaction.estimateFee(
            this.factory.constantsContract,
        )
        const utxoSize = await this.contract.utxoSize()
        const outputValue = toBN(utxoSize).sub(toBN(transactionFee))
        const outputValueBytes = outputValue.toArrayLike(Buffer, 'le', 8)

        let transaction
        if (inVendingMachine) {
            console.debug(
                `Approving transfer of ${redemptionCost} to the vending machine....`,
            )
            this.factory.tokenContract.approve(
                this.factory.vendingMachineContract.address,
                redemptionCost,
            )

            console.debug(
                `Initiating redemption of deposit ${this.address} from ` +
                `vending machine...`,
            )
            transaction = await this.factory.vendingMachineContract.tbtcToBtc(
                this.address,
                outputValueBytes,
                redeemerPKH,
                thisAccount,
                { from: thisAccount }
            )
        } else {
            console.debug(
                `Approving transfer of ${redemptionCost} to the deposit...`,
            )
            this.factory.tokenContract.approve(
                this.address,
                redemptionCost,
            )

            console.debug(`Initiating redemption from deposit ${this.address}...`)
            transaction = await this.contract.requestRedemption(
                outputValueBytes,
                redeemerPKH,
                { from: thisAccount },
            )
        }


        const redemptionRequest = readEventFromTransaction(
            this.factory.config.web3,
            transaction,
            this.factory.systemContract,
            'RedemptionRequested',
        )
        const redemptionDetails = this.redemptionDetailsFromEvent(redemptionRequest)

        return new Redemption(this, s)
    }

    /**
     * Fetches the latest redemption details from the chain. These can change
     * after fee bumps.
     *
     * Returns a promise to the redemption details, or to null if there is no
     * current redemption in progress.
     */
    async getLatestRedemptionDetails() {
        // If the contract is ACTIVE, there's definitely no redemption. This can
        // be generalized to a state check that the contract is either
        // AWAITING_WITHDRAWAL_SIGNATURE or AWAITING_WITHDRAWAL_PROOF, but let's
        // hold on that for now.
        if (await this.contract.inActive()) {
            return null
        }

        const redemptionRequest = await getExistingEvent(
            this.factory.systemContract,
            'RedemptionRequested',
            { _depositContractAddress: this.address },
        )

        if (! redemptionRequest) {
            return null
        }

        return this.redemptionDetailsFromEvent(redemptionRequest.args)
    }

    ///------------------------------- Helpers ---------------------------------

    /**
     * Mostly meant to be called from the onAddressAvailable callback, this
     * method cancels the deposit's default behavior of automatically monitoring
     * for a new Bitcoin transaction to the deposit signers' Bitcoin wallet,
     * then watching that transaction until it has accumulated sufficient work
     * for proof submission, then submitting that proof to the deposit to
     * qualify it and move it into the active state.
     *
     * After calling this function, the deposit will do none of those things;
     * instead, the caller will be in charge of managing (or choosing not to)
     * this process. This can be useful, for example, if a dApp wants to open
     * a deposit, then transfer the deposit to a service provider who will
     * handle deposit qualification.
     *
     * Note that a Deposit object created for a deposit that already exists and
     * has been funded will not do any auto-monitoring.
     */
    cancelAutoMonitor() {
        this.autoMonitor = false
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
    // Returns a promise that will be fulfilled once the public key is
    // available, with a public key point with x and y properties.
    async findOrWaitForPublicKeyPoint() {
        let signerPubkeyEvent = await this.readPublishedPubkeyEvent()
        if (signerPubkeyEvent) {
            console.debug(
                `Found existing Bitcoin address for deposit ${this.address}...`,
            )
            return {
                x: signerPubkeyEvent.args._signingGroupPubkeyX,
                y: signerPubkeyEvent.args._signingGroupPubkeyY,
            }
        }

        console.debug(`Waiting for deposit ${this.address} keep public key...`)

        // Wait for the Keep to be ready.
        await getEvent(this.keepContract, 'PublicKeyPublished')

        console.debug(`Waiting for deposit ${this.address} to retrieve public key...`)
        // Ask the deposit to fetch and store the signer pubkey.
        const pubkeyTransaction = await this.contract.retrieveSignerPubkey(
            {
                from: this.factory.config.web3.eth.defaultAccount,
            }
        )

        console.debug(`Found public key for deposit ${this.address}...`)
        const {
            _signingGroupPubkeyX,
            _signingGroupPubkeyY,
        } = readEventFromTransaction(
                this.factory.config.web3,
                pubkeyTransaction,
                this.factory.systemContract,
                'RegisteredPubkey',
            )

        return {
            x: _signingGroupPubkeyX,
            y: _signingGroupPubkeyY,
        }
    }

    // Returns a promise that is fulfilled when the contract has entered the
    // active state.
    async waitForActiveState() {
        const depositIsActive = await this.contract.inActive()
        if (depositIsActive) {
            return true
        }

        console.debug(`Monitoring deposit ${this.address} for transition to ACTIVE.`)

        // If we weren't active, wait for Funded, then mark as active.
        // FIXME/NOTE: We could be inactive due to being outside of the funding
        // FIXME/NOTE: path, e.g. in liquidation or courtesy call.
        await getEvent(
            this.factory.systemContract,
            'Funded',
            { _depositContractAddress: this.address },
        )
        console.debug(`Deposit ${this.address} transitioned to ACTIVE.`)

        return true
    }

    async readPublishedPubkeyEvent() {
        return getExistingEvent(
            this.factory.systemContract,
            'RegisteredPubkey',
            { _depositContractAddress: this.address },
        )
    }

    async publicKeyPointToBitcoinAddress(publicKeyPoint) {
        return BitcoinHelpers.Address.publicKeyPointToP2WPKHAddress(
            publicKeyPoint.x,
            publicKeyPoint.y,
            this.factory.config.bitcoinNetwork,
        )
    }

    // Given a Bitcoin transaction and the number of confirmations it has,
    // constructs an SPV proof and returns the raw parameters that would be
    // given to an on-chain contract.
    //
    // These are:
    // - version
    // - txInVector
    // - txOutVector
    // - locktime
    // - outputPosition
    // - merkleProof
    // - txInBlockIndex
    // - chainHeaders
    //
    // Constructed this way to serve both qualify + mint and simple
    // qualification flows.
    async constructFundingProof(bitcoinTransaction, confirmations, handlerFn) {
        const { transactionID, outputPosition } = bitcoinTransaction
        const {
            tx,
            merkleProof,
            chainHeaders,
            txInBlockIndex,
        } = await BitcoinHelpers.Transaction.getProof(transactionID, confirmations)

        const {
            version,
            txInVector,
            txOutVector,
            locktime,
        } = BitcoinTxParser.parse(tx)

        return [
            Buffer.from(version, 'hex'),
            Buffer.from(txInVector, 'hex'),
            Buffer.from(txOutVector, 'hex'),
            Buffer.from(locktime, 'hex'),
            outputPosition,
            Buffer.from(merkleProof, 'hex'),
            txInBlockIndex,
            Buffer.from(chainHeaders, 'hex'),
        ]
    }

    redemptionDetailsFromEvent(redemptionRequestedEventArgs)/*: RedemptionDetails*/ {
        const {
            _utxoSize,
            _requesterPKH,
            _requestedFee,
            _outpoint,
            _digest,
        } = redemptionRequestedEventArgs

        const hexToBytes = this.factory.config.web3.utils.hexToBytes
        const toBN = this.factory.config.web3.utils.toBN
        return {
            utxoSize: toBN(_utxoSize),
            requesterPKH: Buffer.from(hexToBytes(_requesterPKH)),
            requestedFee: toBN(_requestedFee),
            outpoint: Buffer.from(hexToBytes(_outpoint)),
            digest: Buffer.from(hexToBytes(_digest)),
        }
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
    /**
     * Converts signature provided as `r` and `s` values to a bitcoin signature
     * encoded to the DER format:
     *   30 <length total> 02 <length r> <r (BE)> 02 <length s> <s (BE)>
     * It also checks `s` value and converts it to a low value if necessary as per
     * [BIP-0062](https://github.com/bitcoin/bips/blob/master/bip-0062.mediawiki#low-s-values-in-signatures).
     *
     * @param {Buffer} r A signature's `r` value.
     * @param {Buffer} s A signature's `s` value.
     *
     * @return {Buffer} The signature in the DER format.
     */
    signatureDER: function(r, s) {
        const size = secp256k1.size
        const signature = new BcryptoSignature(size, r, s)

        // Verifies if either of `r` or `s` values equals zero or is greater or equal
        // curve's order. If so throws an error.
        // Checks if `s` is a high value. As per BIP-0062 signature's `s` value should
        // be in a low half of curve's order. If it's a high value it's converted to
        // `-s`.
        // Checks `s` per BIP-62: signature's `s` value should be in a low half of
        // curve's order. If it's not, it's converted to `-s`.
        const bitcoinSignature = secp256k1.signatureNormalize(signature.encode(size))

        return BcryptoSignature.toDER(bitcoinSignature, size)
    },
    /**
     * Takes the x and y coordinates of a public key point and returns a
     * hexadecimal representation of 64-byte concatenation of x and y
     * coordinates.
     *
     * @param {string} publicKeyX A hex public key X coordinate.
     * @param {string} publicKeyY A hex public key Y coordinate.
     */
    publicKeyPointToPublicKeyString: function(publicKeyX, publicKeyY) {
        return `${publicKeyX.replace('0x', '')}${publicKeyY.replace('0x','')}`
    },
    Address: {
        publicKeyPointToP2WPKHAddress: function(publicKeyX, publicKeyY, bitcoinNetwork) {
            return this.publicKeyToP2WPKHAddress(
                BitcoinHelpers.publicKeyPointToPublicKeyString(publicKeyX, publicKeyY),
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
         * Finds a transaction to the given `bitcoinAddress` of the given
         * `expectedValue`.
         *
         * @param {string} bitcoinAddress A receiving Bitcoin address.
         * @param {number} expectedValue The expected value of the transaction
         *        to fetch.
         *
         * @return {Promise<FoundTransaction>} A promise to an object of
         *         transactionID, outputPosition, and value, that resolves with
         *         either null if such a transaction could not be found, or the
         *         information about the transaction that was found.
         */
        find: async function(bitcoinAddress, expectedValue) {
            const script = BitcoinHelpers.Address.toScript(bitcoinAddress)

            return await BitcoinHelpers.withElectrumClient((electrumClient) => {
                return BitcoinHelpers.Transaction.findWithClient(
                    electrumClient,
                    script,
                    expectedValue,
                )
            })
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
                        const result =  BitcoinHelpers.Transaction.findWithClient(
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
         * Checks the given Bitcoin `transaction` to ensure it has at least
         * `requiredConfirmations` on-chain. If it does, resolves the returned
         * promise with the current number of on-chain confirmations. If it does
         * not, fulfills the promise with `null`.
         *
         * @param {FoundTransaction} transaction A transaction object whose
         *        confirmations will be checked.
         * @param {number} requiredConfirmations A number of required
         *        confirmations below which this function will return null.
         *
         * @return {Promise<number>} A promise to the current number of
         *         confirmations for the given `transaction`, iff that transaction has
         *         at least `requiredConfirmations` confirmations.
         */
        checkForConfirmations: async function(transaction, requiredConfirmations) {
            const id = transaction.transactionID

            return BitcoinHelpers.withElectrumClient(async (electrumClient) => {
                return await BitcoinHelpers.Transaction.checkForConfirmationsWithClient(
                    electrumClient,
                    id,
                    requiredConfirmations,
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
                    return await BitcoinHelpers.Transaction.checkForConfirmationsWithClient(
                        electrumClient,
                        id,
                        requiredConfirmations,
                    )
                }

                return electrumClient.onNewBlock(checkConfirmations)
            })
        },
        /**
         * Estimates the fee that would be needed for a given transaction.
         *
         * @warning This is a stub. Currently it takes the TBTCConstants
         *          contract and returns its reported minimum fee, rather than
         *          calling electrumClient.blockchainEstimateFee.
         */
        estimateFee: async function(tbtcConstantsContract) {
            return tbtcConstantsContract.getMinimumRedemptionFee()
        },
        getProof: async function(transactionID, confirmations) {
            return await BitcoinHelpers.withElectrumClient(async (electrumClient) => {
                const spv = new BitcoinSPV(electrumClient)
                return spv.getTransactionProof(transactionID, confirmations)
            })
        },
        /**
         * Adds a witness signature for an input in a transaction.
         *
         * @param {string} unsignedTransaction Unsigned raw bitcoin transaction
         *        in hexadecimal format.
         * @param {uint32} inputIndex Index number of input to be signed.
         * @param {Buffer} r Signature's `r` value.
         * @param {Buffer} s Signature's `s` value.
         * @param {Buffer} publicKey 64-byte signer's public key's concatenated
         *        x and y coordinates.
         *
         * @return {string} Raw transaction in a hexadecimal format with witness
         *         signature.
         */
        addWitnessSignature: function(unsignedTransaction, inputIndex, r, s, publicKey) {
            // Signature
            let signatureDER
            try {
                signatureDER = BitcoinHelpers.signatureDER(r, s)
            } catch (err) {
                throw new Error(`failed to convert signature to DER format: [${err}]`)
            }

            const hashType = Buffer.from([bcoin.Script.hashType.ALL])
            const sig = Buffer.concat([signatureDER, hashType])

            // Public Key
            let compressedPublicKey
            try {
                compressedPublicKey = secp256k1.publicKeyImport(publicKey, true)
            } catch (err) {
                throw new Error(`failed to import public key: [${err}]`)
            }

            // Combine witness
            let signedTransaction
            try {
                signedTransaction = bcoin.TX.fromRaw(unsignedTransaction, 'hex').clone()
            } catch (err) {
                throw new Error(`failed to import transaction: [${err}]`)
            }

            signedTransaction.inputs[inputIndex].witness.fromItems([
                sig,
                compressedPublicKey,
            ])

            return signedTransaction.toRaw().toString('hex')
        },

        // Raw helpers.
        /**
         * Finds a transaction to the given `receiverScript` of the given
         * `expectedValue` using the given `electrumClient`.
         *
         * @param {ElectrumClient} electrumClient An already-initialized Electrum client.
         * @param {string} receiverScript A receiver script.
         * @param {number} expectedValue The expected value of the transaction
         *        to fetch.
         *
         * @return {Promise<FoundTransaction>} A promise to an object of
         *         transactionID, outputPosition, and value, that resolves with
         *         either null if such a transaction could not be found, or the
         *         information about the transaction that was found.
         */
        findWithClient: async function(electrumClient, receiverScript, expectedValue) {
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
        checkForConfirmationsWithClient: async function(electrumClient, transactionID, requiredConfirmations) {
            const { confirmations } = await electrumClient.getTransaction(transactionID)
            if (confirmations >= requiredConfirmations) {
                return confirmations
            }
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

/**
 * Details of a given redemption at a given point in time.
 * @typedef RedemptionDetails
 * @type {Object}
 * @property {BN} utxoSize The size of the UTXO size in the redemption.
 * @property {Buffer} requesterPKH The raw requester publicKeyHash bytes.
 * @property {BN} requestedFee The fee for the redemption transaction.
 * @property {Buffer} outpoint The raw outpoint bytes.
 * @property {Buffer} digest The raw digest bytes.
 */

/**
 * Details of a given unsigned transaction
 * @typedef UnsignedTransactionDetails
 * @type {Object}
 * @property {string} hex The raw transaction hex string.
 * @property {digest} digest The transaction's digest.
 */

/**
 * The Redemption class encapsulates the operations that finalize an already-
 * initiated redemption.
 *
 * Typically, you can call `autoSubmit()` and then register an `onWithdrawn`
 * handler to be notified when the Bitcoin transaction completing redemption has
 * been signed, submitted, and proven to the deposit contract.
 *
 * If you prefer to manage the Bitcoin side of the lifecycle separately, you can
 * register to be notified when a Bitcoin transaction is ready for submission
 * using `onBitcoinTransactionSigned`, and submit a redemption proof to once
 * that transaction is sufficiently confirmed using `proveWithdrawal`.
 *
 * `proveWithdrawal` will trigger any `onWithdrawn` handlers that have been
 * registered.
 */
class Redemption {
    deposit/*: Deposit*/
    redemptionAddress/*: string*/

    redemptionDetails/*: Promise<RedemptionDetails>*/
    unsignedTransaction/*: Promise<UnsignedTransactionDetails>*/
    signedTransaction/*: Promise<SignedTransactionDetails>*/

    constructor(deposit/*: Deposit*/, redemptionDetails/*: RedemptionDetails?*/) {
        this.deposit = deposit

        this.redemptionDetails = this.getLatestRedemptionDetails(redemptionDetails)

        this.unsignedTransactionDetails = this.redemptionDetails.then((details) => {
            const outputValue = details.utxoSize.sub(details.requestedFee)
            const unsignedTransaction =
                BitcoinHelpers.Transaction.constructOneInputOneOutputWitnessTransaction(
                    details.outpoint,
                    // We set sequence to `0` to be able to replace by fee. It reflects
                    // bitcoin-spv:
                    // https://github.com/summa-tx/bitcoin-spv/blob/2a9d594d9b14080bdbff2a899c16ffbf40d62eef/solidity/contracts/CheckBitcoinSigs.sol#L154
                    0,
                    outputValue,
                    details.requesterPKH,
                )

            return {
                hex: unsignedTransaction,
                digest: details.digest,
            }
        })

        this.signedTransaction = this.unsignedTransaction.then(async (unsignedTransaction) => {
            const {
                r,
                s,
                recoveryID,
                digest,
            } = await getEvent(
                    this.deposit.keepContract,
                    'SignatureSubmitted',
                    { digest: details.digest },
                )
            const publicKeyPoint = await this.deposit.publicKeyPoint

            const hexToBytes = this.deposit.factory.config.web3.utils.hexToBytes
            const toBN = this.deposit.factory.config.web3.utils.toBN
            const signature = {
                r: Buffer.from(hexToBytes(r)),
                s: Buffer.from(hexToBytes(s)),
                recoveryID: toBN(recoveryID),
                digest: Buffer.from(hexToBytes(digest)),
            }

            const signedTransaction = BitcoinHelpers.Transaction.addWitnessSignature(
                unsignedTransaction,
                0,
                signature.r,
                signature.s,
                BitcoinHelpers.publicKeyPointToPublicKeyString(
                    publicKeyPoint.x,
                    publicKeyPoint.y,
                ),
            )

            return signedTransaction
        })
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

    onBitcoinTransactionSigned(transactionHandler/*: (transaction)=>void*/) {

    }

    onWithdrawn(withdrawalHandler/*: (txHash)=>void*/) { // bitcoin txHash
    }

    /**
     * Fetches the latest redemption details from the chain. These can change
     * after fee bumps.
     */
    async getLatestRedemptionDetails(existingRedemptionDetails/*: RedemptionDetails?*/) {
        if (existingRedemptionDetails) {
            return existingRedemptionDetails
        }

        return await this.deposit.getLatestRedemptionDetails()
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
