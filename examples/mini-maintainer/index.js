import Web3 from "web3"
import sha256 from "bcrypto/lib/sha256.js"
import secp256k1 from "bcrypto/lib/secp256k1.js"
import ConsoleTablePrinter from "console-table-printer"
import EventEmitter from "events"
import bcoin from "bcoin"
const { TX } = bcoin

import TBTC from "../../src/TBTC.js"
import BitcoinHelpers from "../../src/BitcoinHelpers.js"
import { DepositStates } from "../../src/Deposit.js"
import { getSignatureHashData } from "./sighash.js"
import EthereumHelpers from "../../src/EthereumHelpers.js"

function getDepositStateName(i) {
  return Object.entries(DepositStates)
    .filter(([state, j]) => i == j)[0]
    .toString()
}

async function timer(seconds) {
  return new Promise((res, rej) => {
    setTimeout(res, seconds * 1000)
  })
}

let web3
/** @type {import("../../index.js").TBTC} */
let tbtc

let ethBalance
let tbtcBalance

// eslint-disable-next-line no-unused-vars
async function getCreatedDeposits() {
  const createdDeposits = await tbtc.depositFactory.systemContract.getPastEvents(
    "Created",
    { fromBlock: 0, toBlock: "latest" }
  )

  const MAX_DEPOSITS_TO_MAINTAIN = createdDeposits.length
  // const MAX_DEPOSITS_TO_MAINTAIN = 1
  const depositsToMonitor = createdDeposits
    .reverse()
    .slice(0, MAX_DEPOSITS_TO_MAINTAIN)
    .map(ev => ev.returnValues._depositContractAddress)

  return depositsToMonitor
}

const WATCH_AUCTIONS = process.env.WATCH_AUCTIONS == "1"

async function main() {
  console.log(`Maintainer started WATCH_AUCTIONS=${WATCH_AUCTIONS}`)
  // Setup Web3 engine.
  //
  console.log("Connecting to Ethereum provider...")
  web3 = new Web3("ws://localhost:8545")

  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

  tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: "testnet",
    electrum: {
      testnet: {
        server: "electrumx-server.test.tbtc.network",
        port: 50002,
        protocol: "ssl"
      },
      testnetPublic: {
        server: "testnet1.bauerj.eu",
        port: 50002,
        protocol: "ssl"
      },
      testnetWS: {
        server: "electrumx-server.test.tbtc.network",
        port: 8443,
        protocol: "wss"
      }
    }
  })

  console.log("Connected!")

  const depositFactory = tbtc.depositFactory

  // Print maintainer info.
  tbtcBalance = await depositFactory.tokenContract.methods
    .balanceOf(web3.eth.defaultAccount)
    .call()
  ethBalance = await web3.eth.getBalance(web3.eth.defaultAccount)

  console.log(`Maintainer balances:`)
  console.log(`\t${web3.utils.fromWei(tbtcBalance.toString())} TBTC`)
  console.log(`\t${web3.utils.fromWei(ethBalance.toString())} ETH`)

  // Finds all opened deposits
  console.log("Scanning deposits...")
  const deposits = []
  const depositsInfo = []

  const depositsToMonitor = await getCreatedDeposits()
  // const depositsToMonitor = ["0x62efAf2B96F8856B42e6d9d0243f78c891C55D3d"]

  console.log(`${depositsToMonitor.length} deposits`)

  for (const depositAddress of depositsToMonitor) {
    let deposit
    try {
      deposit = await tbtc.Deposit.withAddress(depositAddress)
    } catch (ex) {
      console.error(`Error monitoring deposit [${deposit.address}]: ${ex}`)
    }

    const [
      state,
      size,
      collateralization,
      thresholdCourtesy,
      thresholdSevere
    ] = await Promise.all([
      deposit.getCurrentState(),
      deposit.getLotSizeSatoshis(),
      deposit.getCollateralizationPercentage(),
      deposit.getUndercollateralizedThresholdPercent(),
      deposit.getSeverelyUndercollateralizedThresholdPercent()
    ])

    const stateName = getDepositStateName(state)

    depositsInfo.push({
      address: deposit.address,
      size,
      state: stateName,
      collateralization: collateralization.toNumber(),
      thresholdCourtesy,
      thresholdSevere
    })

    deposits.push(deposit)
  }

  ConsoleTablePrinter.printTable(depositsInfo)

  await Promise.all(deposits.map(monitorDeposit))
}

// watch state change of deposit and spawn watcher tasks.
async function monitorDeposit(deposit) {
  const depositEvents = new EventEmitter()

  tbtc.depositFactory.systemContract.events.allEvents(
    {
      filter: { _depositContractAddress: deposit.address }
    },
    ev => {
      // Tell existing watchers to wind down.
      depositEvents.emit("stateTransition")

      // Watch the new state.
      watchCurrentState(deposit, depositEvents)
    }
  )

  // Execute first call.
  watchCurrentState(deposit, depositEvents)
}

async function watchCurrentState(deposit, depositEvents) {
  const state = await deposit.getCurrentState()
  console.log(
    `Watching ${deposit.address} in state ${getDepositStateName(state)}`
  )

  const newBlockSubscription = web3.eth.subscribe("newBlockHeaders")

  // God, I wish I could just use real processes/coroutines.
  // Since we can't kill already executing callbacks,
  // and reimplementing a cross-processs nonce mutex would
  // make me cry, we just choose to supress any thrown exceptions
  // after we know the deposit state has changed.
  let supressErrors = false
  depositEvents.on("stateTransition", () => {
    supressErrors = true
    newBlockSubscription.unsubscribe()
  })

  try {
    switch (state) {
      case DepositStates.AWAITING_SIGNER_SETUP:
        await watchTimeout({ deposit, state })
        break
      case DepositStates.AWAITING_BTC_FUNDING_PROOF:
        await checkFraud({ deposit, state })
        await Promise.all([
          watchFraud({ deposit, state, depositEvents }),
          watchTimeout({ deposit, state })
        ])
        break
      case DepositStates.ACTIVE:
        await checkCollateralization({ deposit, state })
        newBlockSubscription.on("data", async () => {
          checkCollateralization({ deposit, state })
        })
        await watchFraud({ deposit, state, depositEvents })
        break
      case DepositStates.AWAITING_WITHDRAWAL_SIGNATURE:
      case DepositStates.AWAITING_WITHDRAWAL_PROOF:
        await Promise.all([
          watchFraud({ deposit, state, depositEvents }),
          watchTimeout({ deposit, state })
        ])
        break
      case DepositStates.COURTESY_CALL:
        await checkCollateralization({ deposit, state })
        newBlockSubscription.on("data", async () => {
          checkCollateralization({ deposit, state })
        })
        await Promise.all([
          watchFraud({ deposit, state, depositEvents }),
          watchTimeout({ deposit, state })
        ])
        break
      case DepositStates.LIQUIDATION_IN_PROGRESS:
      case DepositStates.FRAUD_LIQUIDATION_IN_PROGRESS:
        if (!WATCH_AUCTIONS) return

        await checkBondAuction({ deposit, state })
        newBlockSubscription.on("data", async () => {
          checkBondAuction({ deposit, state })
        })
        break
      case DepositStates.REDEEMED:
      case DepositStates.LIQUIDATED:
        break
    }
  } catch (err) {
    // Suppress errors if the deposit has changed states since then.
    if (supressErrors)
      console.debug(
        `Deposit state of ${deposit.address} has changed, supressing error from last call.`
      )
    else throw err
  }
}

// Watches for Bitcoin transactions that aren't authorised by a deposit.
async function watchFraud({ deposit, state, depositEvents }) {
  await BitcoinHelpers.withElectrumClient(async electrumClient => {
    return new Promise(async resolve => {
      // Watch for new transactions.
      const bitcoinAddress = await deposit.getBitcoinAddress()
      const script = BitcoinHelpers.Address.toScript(bitcoinAddress)
      electrumClient.onTransactionToScript(script, status => {
        console.debug(
          `New Bitcoin transaction for deposit [${deposit.address}] with script [${script}]`
        )
        checkFraud({ deposit, state })
      })

      // Exit on state transition.
      depositEvents.on("stateTransition", resolve)
    })
  })
}

async function checkFraud({ deposit, state }) {
  const bitcoinAddress = await deposit.getBitcoinAddress()
  const lotSizeSatoshis = await deposit.getLotSizeSatoshis()
  const script = BitcoinHelpers.Address.toScript(bitcoinAddress)

  console.debug(`Checking signer fraud for deposit [${deposit.address}]`)

  // TODO: fundingTx is the most RECENT transaction funding lotSize to the script.
  // This is technically a bug?
  const fundingTx = await deposit.fundingTransaction

  await BitcoinHelpers.withElectrumClient(async electrumClient => {
    const fundingTx2 = TX.fromRaw(
      (
        await electrumClient.electrumClient.blockchain_transaction_get(
          fundingTx.transactionID,
          true
        )
      ).hex,
      "hex"
    )

    // Find the correct prevout.
    const prevoutScript = fundingTx2.outputs[fundingTx.outputPosition].script

    const transactions = await electrumClient.getTransactionsForScript(script)

    // Returns true if transaction spends the funding UXTO
    for (const electrumTx of transactions) {
      // tBTC v1 has a canonical format for the funding transaction.
      // The funding UXTO is a P2WPKH script.
      // Any transaction that spends this UXTO will have a witness
      // field, that contains the items [<sig>, <pubkey>].
      const tx = bcoin.TX.fromRaw(electrumTx.hex, "hex")

      // Check if the transaction spends the funding UXTO.
      let spendTxIndex = -1
      tx.inputs.map((input, i) => {
        if (input.prevout.txid() == fundingTx.transactionID) {
          spendTxIndex = i
        }
      })

      if (spendTxIndex === -1) {
        continue
      }

      // Extract digest, signedDigest, v, r, s.
      const witness = tx.inputs[spendTxIndex].witness.toItems()
      const [sigRaw, compressedPublicKey] = witness
      const sighashType = sigRaw[sigRaw.length - 1]
      // Slice off last byte as that's the SIGHASH_TYPE.
      const sig = sigRaw.slice(0, -1)
      const version = 1 // segwit
      const value = lotSizeSatoshis.toNumber()

      // Signers can create any type of transaction they want
      // for spending the UXTO. To get the digest that is
      // used for signing, we must calculate the sighash.
      const sighashData = getSignatureHashData.bind(tx)(
        spendTxIndex,
        bcoin.Script.fromPubkeyhash(prevoutScript.getWitnessPubkeyhash()),
        value,
        sighashType,
        version
      )

      // LOL, this is confusing.
      // Since Bitcoin double-hashes, and the Keep verifies only single-hashed preimages,
      // the preimage here is the first application of the SHA256 to the sighash data.
      const preimage = sha256.digest(sighashData)
      const signedDigest = sha256.digest(preimage)

      // Check if tx approved by deposit/keep.
      const approved = await deposit.wasSignatureApproved(signedDigest)
      if (approved) {
        continue
      }
      console.log(`Found fraud tx for deposit ${deposit.address}`)

      // Calculate signature (v,r,s).
      console.debug(`Extracting sig from witness:`, witness)

      // A constant in the Ethereum ECDSA signature scheme, used for public key recovery [1]
      // Value is inherited from Bitcoin's Electrum wallet [2]
      // [1] https://bitcoin.stackexchange.com/questions/38351/ecdsa-v-r-s-what-is-v/38909#38909
      // [2] https://github.com/ethereum/EIPs/issues/155#issuecomment-253810938
      const ETHEREUM_ECDSA_RECOVERY_V = 27
      const rsConcat = secp256k1.signatureImport(sig)
      const r = rsConcat.slice(0, 32)
      const s = rsConcat.slice(32, 64)

      // Verify signature, as a sanity check.
      if (!secp256k1.verifyDER(signedDigest, sig, compressedPublicKey)) {
        throw new Error(`Could not verify signature`)
      }

      // Prove fraud signature to the Deposit / Keep.
      let proveFraudMethod
      switch (state) {
        case DepositStates.AWAITING_BTC_FUNDING_PROOF:
          proveFraudMethod =
            deposit.contract.methods.provideFundingECDSAFraudProof
          // proveFraudMethod = deposit.provideFundingECDSAFraudProof.bind(deposit)
          break
        case DepositStates.ACTIVE:
        case DepositStates.AWAITING_WITHDRAWAL_SIGNATURE:
        case DepositStates.AWAITING_WITHDRAWAL_PROOF:
        case DepositStates.COURTESY_CALL:
          proveFraudMethod = deposit.contract.methods.provideECDSAFraudProof
          // proveFraudMethod = deposit.provideECDSAFraudProof.bind(deposit)
          break
      }

      // HACK: bruteforce the recoveryID.
      // Didn't have time to reimplement
      for (let recoveryID = 0; recoveryID < 5; recoveryID++) {
        try {
          const _call = proveFraudMethod(
            ETHEREUM_ECDSA_RECOVERY_V + recoveryID,
            r,
            s,
            signedDigest,
            preimage
          )
          // Don't waste gas, call first, check if `recoveryID` invalid.
          await _call.call()
          await EthereumHelpers.sendSafely(_call)
          console.debug(`Proved ECDSA fraud on deposit ${deposit.address}`)
          return
        } catch (ex) {
          throw new Error("Error proving fraud: " + ex)
        }
      }
    }
  })
}

// Watches for protocol timeouts that would constitute an abort
async function watchTimeout({ deposit, state }) {
  async function getLatestEvent(eventName, deposit) {
    const events = await tbtc.depositFactory.systemContract.getPastEvents(
      eventName,
      {
        fromBlock: 0,
        toBlock: "latest",
        filter: { _depositContractAddress: deposit.address }
      }
    )
    // `getPastEvents` returns events in order of their blockNumber, ascending.
    const event = events[events.length - 1]
    return event
  }

  async function getTimerStartFromEvent(eventName, deposit, fromBlock = 0) {
    const event = (
      await tbtc.depositFactory.systemContract.getPastEvents(eventName, {
        fromBlock,
        toBlock: "latest",
        filter: { _depositContractAddress: deposit.address }
      })
    )[0]
    return event.returnValues._timestamp
  }

  async function getTimeOfEvent(eventName, deposit) {
    const event = (
      await tbtc.depositFactory.systemContract.getPastEvents(eventName, {
        fromBlock: 0,
        toBlock: "latest",
        filter: { _depositContractAddress: deposit.address }
      })
    )[0]

    const block = await web3.eth.getBlock(event.blockNumber)
    return block.timestamp
  }

  async function getTimeToWait(timerStart, timeout) {
    const latestBlock = await web3.eth.getBlock("latest")
    const elapsed = latestBlock.timestamp - timerStart
    const waitFor = Math.max(timeout - elapsed, 0)
    return waitFor
  }

  // Funding.
  const FORMATION_TIMEOUT = tbtc.Constants.SIGNING_GROUP_FORMATION_TIMEOUT.toNumber() // seconds
  const FUNDING_PROOF_TIMEOUT = tbtc.Constants.FUNDING_PROOF_TIMEOUT.toNumber() // seconds
  if (state == DepositStates.AWAITING_SIGNER_SETUP) {
    // notifySignerSetupFailure - keep signer group failed to form.
    const createdAt = await getTimerStartFromEvent("Created", deposit)
    const waitFor = await getTimeToWait(createdAt, FORMATION_TIMEOUT)
    console.log(
      `Waiting ${waitFor}s for deposit [${deposit.address}] FORMATION_TIMEOUT`
    )
    await timer(waitFor)
    await deposit.notifySignerSetupFailure()
  }
  if (state == DepositStates.AWAITING_BTC_FUNDING_PROOF) {
    // notifyFundingTimeout - funder has failed to send BTC
    const registeredPubkeyAt = await getTimerStartFromEvent(
      "RegisteredPubkey",
      deposit
    )
    const waitFor = await getTimeToWait(
      registeredPubkeyAt,
      FUNDING_PROOF_TIMEOUT
    )
    console.log(
      `Waiting ${waitFor}s for deposit [${deposit.address}] FUNDING_PROOF_TIMEOUT`
    )
    await timer(waitFor)
    await deposit.notifyFundingTimeout()
  }

  // Redemption.
  const REDEMPTION_SIGNATURE_TIMEOUT = tbtc.Constants.REDEMPTION_SIGNATURE_TIMEOUT.toNumber() // seconds
  const REDEMPTION_PROOF_TIMEOUT = tbtc.Constants.REDEMPTION_PROOF_TIMEOUT.toNumber() // seconds
  if (state == DepositStates.AWAITING_WITHDRAWAL_SIGNATURE) {
    // notifySignatureTimeout - failed to produce signature
    // There can be multiple RedemptionRequested events.
    // The timer starts from the first time redemption is requested.
    // `getTimeOfEvent` will get the first in the list,
    // which since we're listing fromBlock=0, this will be the earliest event.
    const redemptionRequestedAt = await getTimeOfEvent(
      "RedemptionRequested",
      deposit
    )
    const waitFor = await getTimeToWait(
      redemptionRequestedAt,
      REDEMPTION_SIGNATURE_TIMEOUT
    )
    console.log(
      `Waiting ${waitFor}s for deposit [${deposit.address}] REDEMPTION_SIGNATURE_TIMEOUT`
    )
    await timer(waitFor)
    await deposit.notifySignatureTimeout()
  }
  if (state == DepositStates.AWAITING_WITHDRAWAL_PROOF) {
    // notifyRedemptionProofTimeout - failed to produce tx proof
    const gotRedemptionSignatureAt = await getTimerStartFromEvent(
      "GotRedemptionSignature",
      deposit
    )
    const waitFor = await getTimeToWait(
      gotRedemptionSignatureAt,
      REDEMPTION_PROOF_TIMEOUT
    )
    console.log(
      `Waiting ${waitFor}s for deposit [${deposit.address}] REDEMPTION_PROOF_TIMEOUT`
    )
    await timer(waitFor)
    await deposit.notifyRedemptionProofTimeout()
  }

  // Courtesy
  const COURTESY_CALL_DURATION = tbtc.Constants.COURTESY_CALL_DURATION.toNumber() // seconds
  if (state == DepositStates.COURTESY_CALL) {
    // Deposit can enter in and out of the COURTESY_CALL state.
    // So we select the most recent one.
    const courtesyCalled = await getLatestEvent("CourtesyCalled", deposit)

    const waitFor = await getTimeToWait(
      courtesyCalled.returnValues._timestamp,
      COURTESY_CALL_DURATION
    )
    console.log(
      `Waiting ${waitFor}s for deposit [${deposit.address}] COURTESY_CALL_DURATION`
    )
    await timer(waitFor)
    await deposit.notifyCourtesyTimeout()
  }
}

async function checkCollateralization({ deposit, state }) {
  const collateralization = await deposit.getCollateralizationPercentage()
  const thresholdCourtesy = await deposit.getUndercollateralizedThresholdPercent()
  const thresholdSevere = await deposit.getSeverelyUndercollateralizedThresholdPercent()

  if (collateralization.toNumber() == 0) return // HACK

  if (collateralization.lt(thresholdSevere)) {
    console.log(
      `Deposit ${deposit.address} is severely undercollateralised at`,
      collateralization.toNumber(),
      "percent"
    )
    await deposit.notifyUndercollateralizedLiquidation()
  } else if (
    collateralization.lt(thresholdCourtesy) &&
    state != DepositStates.COURTESY_CALL
  ) {
    console.log(
      `Deposit ${deposit.address} is undercollateralised at`,
      collateralization.toNumber(),
      "percent"
    )
    await deposit.notifyCourtesyCall()
  } else if (
    collateralization.gt(thresholdCourtesy) &&
    state == DepositStates.COURTESY_CALL
  ) {
    console.log(
      `Deposit ${deposit.address} is sufficiently collateralised again at`,
      collateralization.toNumber(),
      `percent, exiting courtesy call.`
    )
    await deposit.exitCourtesyCall()
  }
}

async function checkBondAuction({ deposit, state }) {
  // Deposit auctions are falling-price auctions.
  // Initiator pays 1 TBTC for an increasing amount of ETH bond.
  // ETH bond begins at `getAuctionBasePercentage`, which is 10000/InitialCollateralizationThreshold.
  // This is currently 66%.
  // Then it scales linearly over the auction duration to 100% of the ETH bond is purchasable with 1 TBTC.
  // ie. if 1 TBTC is $10,000
  // You can purchase it for
  // .. 6.6  ETH at t=0%
  // .. 8.3  ETH at t=50%
  // .. 9.15 ETH at t=75%
  // .. 10   ETH at t=100%
  // It seems unintuitive at first, since it's a fixed amount of TBTC to buy.
  // Think of the auction from the perspective of the deposit.
  // At the beginning of the auction, the deposit offers 66% of the bonds for 1 TBTC.
  // As the auction progresses, more of the bonds are offered up, meaning their value
  // increases.
  // For a buyer, it means the bonds become less expensive to trade 1 TBTC for.

  // Log auctionValue for each block.
  const lotSize = await deposit.getLotSizeTBTC()

  const auctionValue = await deposit.auctionValue()
  console.log(
    `Deposit [${deposit.address}] signer bond auction: ` +
      `sellAmount [${web3.utils.fromWei(auctionValue)} ETH], ` +
      `buyAmount [${web3.utils.fromWei(lotSize)} TBTC]`
  )

  if (web3.utils.toBN(tbtcBalance).lt(web3.utils.toBN(lotSize))) {
    console.log("Not enough in TBTC balance to submit auction bids")
    return
  }

  // const goodDeal = auctionValue.toNumber() > 123
  const goodDeal = true
  if (goodDeal) {
    // You get the idea.
    try {
      console.log(
        `Approving ${web3.utils.fromWei(
          lotSize
        )} TBTC for spending by deposit [${deposit.address}]`
      )
      await tbtc.depositFactory.tokenContract.methods
        .approve(deposit.address, lotSize.toString())
        .send()
      console.log(`Purchasing signer bonds from deposit [${deposit.address}]`)
      await deposit.purchaseSignerBondsAtAuction()
    } catch (err) {
      console.error(
        `Error calling purchaseSignerBondsAtAuction for Deposit [${deposit.address}]`
      )
      throw err
    }
  }
}

main().catch(err => {
  throw err
})
