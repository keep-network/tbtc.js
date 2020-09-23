#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import TBTC from "../index.js"
/** @typedef {import('../src/TBTC.js').ElectrumConfig} ElectrumConfig */
/** @typedef {import('../src/TBTC.js').TBTC} TBTCInstance */
/** @typedef {import('../src/Deposit.js').default} Deposit */
/** @typedef {import('bn.js')} BN */

/**
 * An action that runs a set command on a given TBTC instance and returns a
 * string for console output.
 *
 * @callback CommandAction
 * @param {TBTCInstance} tbtc An initialized TBTC instance.
 * @return {Promise<string>} The output of the command.
 */

/** @type {{ [name: string]: ElectrumConfig }} */
const electrumConfigs = {
  testnet: {
    server: "electrumx-server.test.tbtc.network",
    port: 8443,
    protocol: "wss"
  },
  testnetTCP: {
    server: "electrumx-server.test.tbtc.network",
    port: 50002,
    protocol: "ssl"
  },
  mainnet: {
    server: "electrumx-server.tbtc.network",
    port: 8443,
    protocol: "wss"
  },
  mainnetTCP: {
    server: "electrumx-server.tbtc.network",
    port: 50002,
    protocol: "ssl"
  }
}

const engine = new ProviderEngine({ pollingInterval: 1000 })
engine.addProvider(
  // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
  new Subproviders.PrivateKeyWalletSubprovider(
    "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990"
  )
)
engine.addProvider(
  new Subproviders.RPCSubprovider(
    "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5"
  )
)

// -------------------------------- SETUP --------------------------------------
// @ts-ignore Web3's provider interface seems to be inaccurate with respect to
// what actually works, since ProviderEngine works just fine here.
const web3 = new Web3(engine)
engine.start()

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}

/** @type {CommandAction | null} */
let action = null

switch (args[0]) {
  case "deposit":
    {
      let mint = true
      if (args.length == 3 && args[2] == "--no-mint") {
        mint = false
        args.pop() // drop --no-mint
      }
      if (args.length == 2 && bnOrNull(args[1])) {
        action = async tbtc => {
          return await createDeposit(tbtc, web3.utils.toBN(args[1]), mint)
        }
      }
    }
    break
  case "resume":
    {
      let mint = true
      if (args.length == 3 && args[2] == "--no-mint") {
        mint = false
        args.pop() // drop --no-mint
      }
      if (args.length == 2 && web3.utils.isAddress(args[1])) {
        action = async tbtc => {
          return await resumeDeposit(tbtc, args[1], mint)
        }
      }
    }
    break
  case "redeem":
    if (args.length == 3 && web3.utils.isAddress(args[1])) {
      action = async tbtc => {
        return await redeemDeposit(tbtc, args[1], args[2])
      }
    }
    break
}

if (action === null) {
  console.log(`
Unknown command ${args[0]} or bad parameters. Supported commands:
    deposit <lot-size-satoshis> [--no-mint]
        Initiates a deposit funding flow. Takes the lot size in satoshis.
        Will prompt with a Bitcoin address when funding needs to be
        submitted.

        --no-mint
            specifies not to mint TBTC once the deposit is qualified.

    resume <deposit-address> [--no-mint]
        Resumes a deposit funding flow that did not complete. An existing
        funding transaction can exist, but this can also be run before the
        funding transaction is submitted.

        --no-mint
            specifies not to mint TBTC once the deposit is qualified.

    redeem <deposit-address>
        Attempts to redeem a tBTC deposit.
    `)

  process.exit(1)
}

/**
 * @param {CommandAction} action
 * @return {Promise<string>}
 */
async function runAction(action) {
  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: "testnet",
    electrum: electrumConfigs.testnet
  })

  return action(tbtc)
}

runAction(/** @type {CommandAction} */ (action))
  .then(result => {
    console.log("Action completed with final result:", result)

    process.exit(0)
  })
  .catch(error => {
    console.error("Action errored out with error:", error)

    process.exit(1)
  })

/**
 * @param {TBTCInstance} tbtc
 * @param {BN} satoshiLotSize
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function createDeposit(tbtc, satoshiLotSize, mintOnActive) {
  const deposit = await tbtc.Deposit.withSatoshiLotSize(satoshiLotSize)

  return runDeposit(deposit, mintOnActive)
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function resumeDeposit(tbtc, depositAddress, mintOnActive) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)

  return runDeposit(deposit, mintOnActive)
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {string} redeemerAddress
 * @return {Promise<string>}
 */
async function redeemDeposit(tbtc, depositAddress, redeemerAddress) {
  return new Promise(async (resolve, reject) => {
    try {
      const deposit = await tbtc.Deposit.withAddress(depositAddress)
      const redemption = await deposit.requestRedemption(redeemerAddress)
      redemption.autoSubmit()

      redemption.onWithdrawn(transactionID => {
        console.log()

        resolve(
          `Redeemed deposit ${deposit.address} with Bitcoin transaction ` +
            `${transactionID}.`
        )
      })
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * @param {Deposit} deposit
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function runDeposit(deposit, mintOnActive) {
  deposit.autoSubmit()

  return new Promise(async (resolve, reject) => {
    deposit.onBitcoinAddressAvailable(async address => {
      try {
        const lotSize = await deposit.getLotSizeSatoshis()
        console.log(
          "\tGot deposit address:",
          address,
          "; fund with:",
          lotSize.toString(),
          "satoshis please."
        )
        console.log("Now monitoring for deposit transaction...")
      } catch (err) {
        reject(err)
      }
    })

    deposit.onActive(async () => {
      try {
        if (mintOnActive) {
          console.log("Deposit is active, minting...")
          const tbtc = await deposit.mintTBTC()

          resolve(tbtc.toString())
        } else {
          resolve("Deposit is active. Minting disabled by parameter.")
        }
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * @param {string} str
 * @return {BN?}
 */
function bnOrNull(str) {
  try {
    return web3.utils.toBN(str)
  } catch (_) {
    return null
  }
}
