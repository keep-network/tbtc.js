#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
// ////
// bin/refunds.js <keep-info.csv> [-c <keep-ecdsa-client-path>] [-s <key-share-directory>]
//                [-o <operator-btc-receive-address-directory>]
//                [-r <refund-btc-address-directory>]
//
//   <keep-info.csv>
//     A CSV file that should have a column whose title is `keep`. It may have
//     other columns, which will be ignored.
//
//   -c <keep-ecdsa-client-path>
//     The path to the keep-ecdsa client executable. If omitted, `keep-ecdsa` is
//     assumed (and must be on the PATH).
//
//   -s <key-share-directory>
//     The directory that contains operator key shares for keeps. The directory
//     should have one directory under it per keep, named after the keep
//     address, and each directory should have 3 key share files in it, one per
//     operator. The key share files should be the files outputted by
//     `keep-ecdsa signing decrypt-key-share`. Defaults to `./key-shares`.
//
//    -o <operator-btc-receive-address-directory>
//      The directory that contains Bitcoin receive addresses for operators.
//      These are the addresses designated for liquidation BTC retrieval for
//      each operator. The directory should contain a set of JSON files named
//      `beneficiary-<address>.json`, where `<address>` is the operator address.
//      The JSON files should be in the common Ethereum signature format, and
//      should present a Bitcoin xpub, ypub, zpub, or address, signed by the
//      operator, staker, or beneficiary addresses for that operator's
//      delegation.
//
//   -r <refund-btc-address-directory>
//      The directory that contains Bitcoin refund addresses for misfunds. These
//      are the addresses designated by accounts that funded incorrectly to
//      retrieve their Bitcoin. The directory should contain a set of JSON files
//      named `deposit-<address>.json`, where `<address>` is the tBTC deposit
//      address. The JSON files should be in the common Ethereum signature
//      format, and should present a Bitcoin address, signed by the owner of the
//      specified deposit.
//
//   Iterates through the specified keep ids, looks up their public keys in
//   order to compute their Bitcoin addresses, and verifies that they are still
//   holding Bitcoin. If they are, creates a temp directory and starts checking
//   each operator for key material availability. If key material is available
//   for all three operators and the underlying deposit was liquidated, checks
//   for BTC receive address availability for each operator. If BTC receive
//   addresses are available, creates, signs, and broadcasts a Bitcoin
//   transaction splitting the BTC held by the keep into thirds, each third
//   going to its respective operator's designated BTC receive address. For BTC
//   non-liquidations, checks for BTC refund address availability. If a refund
//   address is available, creates, signs, and broadcasts a Bitcoin transaction
//   sending the BTC held by the keep to the refund address.
//
//   Operator BTC receive addresses must be in JSON format signed by the
//   operator, staker, or beneficiary. BTC refund addresses must be signed by
//   the
//
//    All on-chain state checks on Ethereum require at least 100 confirmations;
//    all on-chain state checks on Bitcoin require at least 6 confirmations.
// ////
import Subproviders from "@0x/subproviders"
// import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
// import EthereumHelpers from "../src/EthereumHelpers.js"
/** @typedef { import('../src/EthereumHelpers.js').TruffleArtifact } TruffleArtifact */

import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"

let args = process.argv.slice(2)
if (process.argv[0].includes("refunds.js")) {
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
  found: { mnemonic, /* account,*/ rpc }
  /* remaining: commandArgs*/
} = findAndConsumeArgsValues(flagArgs, "--mnemonic", "--account", "--rpc")
const engine = new ProviderEngine({ pollingInterval: 1000 })

engine.addProvider(
  // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
  new Subproviders.PrivateKeyWalletSubprovider(
    mnemonic ||
      "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990"
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

// const web3 = new Web3(engine)
engine.start()

run(async () => {
  // TODO
  // - Read CSV.
  // - Check keeps for keyshare availability (= directory exists + has 3 files),
  //   filter accordingly.
  // - Check keep for terminated vs closed; make sure state has been settled for
  //   past 100 blocks.
  // - Check keep to see if it still holds BTC; if it does, make sure it has for
  //   past 6 blocks.
  // - If terminated, assume liquidation.
  // - If closed, assume misfund.
  //
  // TODO liquidation
  // - Check for BTC beneficiary availability for each operator in the keep
  //   (= file exists + is JSON).
  // - If available, verify that each beneficiary address is correctly signed by
  //   the operator, staker, or beneficiary address of its delegation.
  //   (= await web3.eth.personal.ecRecover(address.msg, address.sig) == address.account &&
  //      [operator, staker, beneficiary].includes(message.account))
  // - If yes, build, sign, and broadcast splitter transaction.
  //
  // TODO misfund
  // - Check for BTC refund address availability for the keep's deposit.
  // - If available, verify that the BTC refund address is correctly signed by
  //   the owner of the keep's deposit.
  //   (= await web3.eth.personal.ecRecover(address.msg, address.sig) == address.account &&
  //      deposit.includes(message.account))
  // - If yes, build, sign, and broadcast refund transaction.

  return "boop"
})

/**
 * @param {function():Promise<string?>} action Command action that will yield a
 *        promise to the desired CLI output or error out by failing the promise.
 *        A null or undefined output means no output should be emitted, but the
 *        command should exit successfully.
 */
function run(action) {
  action()
    .catch(error => {
      console.error("Got error", error)
      process.exit(2)
    })
    .then((/** @type {string} */ result) => {
      if (result) {
        console.log(result)
      }
      process.exit(0)
    })
}
