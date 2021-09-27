#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import TBTC from "../index.js"
import { depositCommandHelp, parseDepositCommand } from "./commands/deposit.js"
import { bitcoinCommandHelp, parseBitcoinCommand } from "./commands/bitcoin.js"
import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"
import AvailableConfigs from "./config.json"
/** @typedef {import('../src/TBTC.js').TBTC} TBTCInstance */

/**
 * An action that runs a set command on a given TBTC instance and returns a
 * string for console output.
 *
 * @callback CommandAction
 * @param {TBTCInstance} tbtc An initialized TBTC instance.
 * @return {Promise<string>} The output of the command.
 */

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}

// No debugging unless explicitly enabled.
const {
  found: { debug },
  remaining: flagArgs
} = findAndConsumeArgsExistence(args, "--debug")
if (!debug) {
  console.debug = () => {}
}

const {
  found: { mnemonic, account, rpc },
  remaining: commandArgs
} = findAndConsumeArgsValues(flagArgs, "--mnemonic", "--account", "--rpc")

async function run() {
  const engine = new ProviderEngine({ pollingInterval: 1000 })

  // PrivateKeyWalletSubprovider accepts the `chainId` argument, which is by default
  // set to `1` (mainnet). We assume that if the `--rpc` flag is provided the chain
  // is likely to be non-mainnet, so we have to get the `chainId`.
  let chainId
  if (rpc) {
    const web3 = new Web3(rpc)
    chainId = await web3.eth.getChainId()
  }

  engine.addProvider(
    // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
    new Subproviders.PrivateKeyWalletSubprovider(
      mnemonic ||
        "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990",
      chainId // if `chainId` is undefined the provider will default to mainnet
    )
  )
  engine.addProvider(
    new WebsocketSubprovider({
      rpcUrl:
        rpc || "wss://mainnet.infura.io/ws/v3/414a548bc7434bbfb7a135b694b15aa4",
      debug,
      origin: undefined
    })
  )

  // -------------------------------- SETUP --------------------------------------
  // @ts-ignore Web3's provider interface seems to be inaccurate with respect to
  // what actually works, since ProviderEngine works just fine here.
  const web3 = new Web3(engine)
  engine.start()

  /** @type {CommandAction | null} */
  let action = null

  switch (commandArgs[0]) {
    case "deposit":
      action = parseDepositCommand(web3, commandArgs.slice(1))
      break
    case "bitcoin":
      action = parseBitcoinCommand(web3, commandArgs.slice(1))
      break
    case "lot-sizes":
      if (commandArgs.length == 1) {
        action = async tbtc => {
          return (await tbtc.Deposit.availableSatoshiLotSizes())
            .map(_ => _.toString())
            .join("\n")
        }
      }
      break
    case "supply":
      if (commandArgs.length == 1) {
        action = async tbtc => {
          return await tbtc.depositFactory
            .vendingMachine()
            .methods.getMintedSupply()
            .call()
        }
      }
      break
    case "supply-cap":
      if (commandArgs.length == 1) {
        action = async tbtc => {
          return await tbtc.depositFactory
            .vendingMachine()
            .methods.getMaxSupply()
            .call()
        }
      }
      break
    case "balance":
      if (commandArgs.length == 1) {
        action = async tbtc => {
          return await tbtc.Deposit.token()
            .methods.balanceOf(tbtc.config.web3.eth.defaultAccount)
            .call()
        }
      } else if (commandArgs.length == 2) {
        action = async tbtc => {
          return await tbtc.Deposit.token()
            .methods.balanceOf(commandArgs[1])
            .call()
        }
      }
      break
  }

  if (action === null) {
    console.log(`
Unknown command ${commandArgs[0]} or bad parameters.

Supported flags:
    --debug
        Enable debug output.

    --rpc <rpc-url>
        Set RPC URL to the specified value.

    --mnemonic <mnemonic>
        Use the specified for the operating account. Also supports private key
        strings, since the underlying provider accepts these.

    --account <account>
        Use the specified account for all transactions. If --mnemonic is
        specified, it must be able to sign for this account in order for
        mutating transactions to be sent to the Ethereum chain. If this is
        left off, the first account for the private key is used.

Supported commands:
${depositCommandHelp
  .map(
    _ =>
      "    deposit " +
      _.split("\n")[0] +
      "\n" +
      _.split("\n")
        .slice(1)
        .map(_ => "    " + _)
        .join("\n")
  )
  .join("\n\n")}

${bitcoinCommandHelp
  .map(
    _ =>
      "    bitcoin " +
      _.split("\n")[0] +
      "\n" +
      _.split("\n")
        .slice(1)
        .map(_ => "    " + _)
        .join("\n")
  )
  .join("\n\n")}

    lot-sizes
        Returns a list of the currently available lot sizes, one per line.

    supply
        Returns the current supply as a decimal amount in TBTC. 18 decimals of
        precision, but with a decimal point.

    supply-cap
        Returns the current supply cap as a decimal amount in TBTC.

    balance [<address>]
        Returns the balance of the current account in TBTC or, if the address is
        specified, of the specified address.
    `)

    return process.exit(1)
  }

  return runAction(web3, action)
}

/**
 * @param {Web3} web3
 * @param {CommandAction} action
 * @return {Promise<string>}
 */
async function runAction(web3, action) {
  web3.eth.defaultAccount = account || (await web3.eth.getAccounts())[0]
  const chainId = await web3.eth.getChainId()
  // @ts-ignore TypeScript mad.
  const config = AvailableConfigs[chainId.toString()]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: config.bitcoinNetwork,
    electrum: config.electrum
  })

  return action(tbtc)
}

run()
  .then(result => {
    console.log(result)

    process.exit(0)
  })
  .catch(error => {
    console.error("ERROR ", error)

    process.exit(1)
  })
