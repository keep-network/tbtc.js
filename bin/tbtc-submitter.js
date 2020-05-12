#!/usr/bin/env node --experimental-modules
// @ts-check
const description = `
tbtc-submitter.js <ethereum-key-file> <bitcoin-wallet-file>
    In default mode, creates a single tBTC deposit with the given Ethereum
    key file and funds it using the Bitcoin wallet defined by the given
    file.

    -c,--continuous
        This flag repeatedly creates tBTC deposits and funds them. Rather
        than waiting for each deposit's funding transaction to fully
        confirm, a new deposit opened once the previous deposit's signing
        group becomes available.
`

import Web3 from "web3"
import TBTC from "../index.js"
import UI from "./ui.js"

import BCoin from "bcoin"
const {
  WalletDB,
  Script,
  MTX,
  Coin,
} = BCoin.set('testnet')

import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import Subproviders from "@0x/subproviders"
import BitcoinHelpers from "../src/BitcoinHelpers.js";
import { DepositFactory } from "../src/Deposit.js"

/** @typedef { import("../src/BitcoinHelpers.js").FoundTransaction } FoundTransaction */
/**
 * @typedef {Object} TransactionInfo
 * @prop {any} [transaction]
 */
/**
 * @typedef {TransactionInfo & FoundTransaction} FundingTransactionInfo
 */

const engine = new ProviderEngine({ pollingInterval: 1000 })
engine.addProvider(
  // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
  new Subproviders.PrivateKeyWalletSubprovider(
    "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990",
  ),
)
engine.addProvider(
  new WebsocketSubprovider(
    {
      rpcUrl: "wss://ropsten.infura.io/ws/v3/59fb36a36fa4474b890c13dd30038be5",
      debug: false,
      origin: '',
    },
    // "http://eth-tx-node.default.svc.cluster.local:8545/",
  )
)

// -------------------------------- SETUP --------------------------------------
// @ts-ignore Web3 is declared as taking a `provider`, engine is a `Provider`.
const web3 = new Web3(engine)
engine.start()

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc-submitter.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}

const ethereumKeyFile = args[0]
const bitcoinWalletFile = args[1]

let remainingPromise = Promise.resolve(true)
/** @type {FundingTransactionInfo} */
let latestFundingInfo

/**
 * @param {DepositFactory} Deposit Deposit factory object.
 * @param {import("../src/Deposit.js").BN} lotSize The size of the deposit lot
 *        to create.
 * @param { import("bcoin/lib/wallet/wallet.js") } wallet Bitcoin wallet for
 *        funding the deposit.
 * @param {number} maxFee The highest fee to use for the Bitcoin funding
 *        transaction.
 * 
 * @returns {()=>void} A function that, when called, will create a deposit of
 *          the passed lotSize using the passed deposit factory and fund it
 *          using the passed wallet.
 */
function fundDepositAndCreationFn(Deposit, lotSize, wallet, maxFee) {
  const runner = async () => {
    const deposit = await Deposit.withAddress("0x7C935d413A35c28C9e7b91b82c8B5bfDA57E4780") // withSatoshiLotSize(lotSize)

    deposit
      .onBitcoinAddressAvailable(async address => {
        const receiveAddress = await wallet.receiveAddress()
        const keyRing = await wallet.getPrivateKey(receiveAddress, "")

        const lastTx = MTX.fromRaw(latestFundingInfo.transaction.hex, 'hex')
        const outputIndex =
          lastTx.outputs.findIndex(
            (_) => {
              return _.getAddress().toString(Deposit.config.bitcoinNetwork) ==
                receiveAddress.toString(Deposit.config.bitcoinNetwork)
            }
          )

        const fundingTransaction = new MTX()
        fundingTransaction.addOutput({
          script: Script.fromAddress(address),
          value: lotSize.toNumber(),
        })
        let feePerKb
        try {
          feePerKb = await BitcoinHelpers.Transaction.estimateFeePerKb()
        } catch(_) {
          // Leave feePerKb null if we couldn't estimate.
        }
        await fundingTransaction.fund(
          [Coin.fromTX(lastTx, outputIndex, -1)],
          {
            rate: feePerKb,
            maxFee,
            changeAddress: receiveAddress,
          }
        )
        fundingTransaction.sign(keyRing)

        latestFundingInfo = await BitcoinHelpers.Transaction.broadcast(
          fundingTransaction.toRaw().toString('hex')
        )
        console.log("Got transaction id", latestFundingInfo.transactionID)

        latestFundingInfo.transaction =
          await BitcoinHelpers.withElectrumClient(async electrumClient => {
            return electrumClient.getTransaction(latestFundingInfo.transactionID)
          })
        console.log("Broadcast transaction", latestFundingInfo.transactionID)
      })

    deposit.autoSubmit()
    return deposit.activeStatePromise
  }

  return () => {
    const nextPromise = runner()
    remainingPromise = remainingPromise.then(() => nextPromise)
  }
}

async function doTheThing() {
  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]
  const tbtc = await TBTC.withConfig({
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

  const lotSizes = await tbtc.Deposit.availableSatoshiLotSizes()
  const lowestLotSize = lotSizes.sort((a, b) => a.sub(b).toNumber())[0]
  const maxFee = Math.max(
    await BitcoinHelpers.withElectrumClient(async client => {
      return (await client.getMinimumRelayFee()) * 10**8
    }),
    parseInt(await tbtc.Deposit.constantsContract.methods.getMinimumRedemptionFee().call()),
  ) * 2
  console.log(
    `Opening deposits with ${lowestLotSize.toNumber()} sats once every 2 minutes...`
  )

  const wdb = new WalletDB({ db: 'memory' });
  await wdb.open();
  wdb
  const wallet = await wdb.create({
    master: 'tprv8ZgxMBicQKsPfPae8Tt79fHXewcQqvEiCPyTUAPRtXYznzULBUtCYapXjcVvtWRz7fPsWUPz3bdZE3GWcbJoPifnUoKvSh8XK9g7pUdGraW',
  })
  const addr = await wallet.receiveAddress();
  // Actually let's check its existing balance eh?

  // Fund enough for 3 hours.
  const fundAmount = (lowestLotSize.toNumber() + maxFee) * 90
  console.log(`Please fund address with ${fundAmount} sats: ${addr.toString()}`)
  console.log("Waiting...")
  latestFundingInfo = await BitcoinHelpers.Transaction.findOrWaitFor(
    addr.toString(),
    fundAmount,
  )
  latestFundingInfo.transaction =
    await BitcoinHelpers.Transaction.get(latestFundingInfo.transactionID)
  console.log(`Found transaction ${latestFundingInfo.transactionID}, proceeding optimistically...`)

  const createAndFundDeposit = fundDepositAndCreationFn(
    tbtc.Deposit,
    lowestLotSize,
    wallet,
    maxFee,
  )
  createAndFundDeposit()
  // Then run every 2 minutes.
  const interval = setInterval(
    createAndFundDeposit,
    2 /* minutes */ * 60 /* seconds */ * 1000 /* ms */
  )

  await UI.promptQuestion("Type 'quit' and enter to stop: ", ["quit"])

  console.log('Stopping new deposits...')
  clearInterval(interval)
  console.log('Waiting for existing deposits to finish funding...')
  await remainingPromise
}

doTheThing().then(a => {
  console.log(a)
  process.exit(0)
}).catch(e => {
  console.log(e)
  process.exit(1)
})
