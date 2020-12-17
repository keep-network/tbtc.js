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
//   -f <bitcoin-transaction-fee>
//     The bitcoin transaction fee to use, in satoshis, as a constant. By
//     default, uses a multiplier on the minimum redemption fee allowed by the
//     tBTC system.
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
//      delegation. Defaults to `./beneficiaries`.
//
//   -m <misfund-btc-address-directory>
//      The directory that contains Bitcoin receive addresses for misfunds.
//      These are the addresses designated by accounts that funded incorrectly
//      to retrieve their Bitcoin. The directory should contain a set of JSON
//      files named `misfund-<address>.json`, where `<address>` is the tBTC
//      deposit address. The JSON files should be in the common Ethereum
//      signature format, and should present a Bitcoin address, signed by the
//      owner of the specified deposit. Defaults to `./misfunds`.
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
import PapaParse from "papaparse"
import { promises } from "fs"
const { readdir, stat, readFile } = promises

import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
/** @typedef { import('../src/EthereumHelpers.js').TruffleArtifact } TruffleArtifact */

// @ts-ignore This lib is built all sorts of poorly for imports.
import xpubLib from "@swan-bitcoin/xpub-lib"
// @ts-ignore This lib is built all sorts of poorly for typing.
const { getExtPubKeyMetadata, addressFromExtPubKey } = xpubLib

import TokenStakingJSON from "@keep-network/keep-core/artifacts/TokenStaking.json"
import BondedECDSAKeepJSON from "@keep-network/keep-ecdsa/artifacts/BondedECDSAKeep.json"
import TBTCSystemJSON from "@keep-network/tbtc/artifacts/TBTCSystem.json"
import TBTCConstantsJSON from "@keep-network/tbtc/artifacts/TBTCConstants.json"
import TBTCDepositTokenJSON from "@keep-network/tbtc/artifacts/TBTCDepositToken.json"

import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"
import { spawn } from "child_process"
import { EthereumHelpers } from "../index.js"
import BitcoinHelpers from "../src/BitcoinHelpers.js"
import AvailableBitcoinConfigs from "./config.json"
import { contractsFromWeb3, lookupOwner } from "./owner-lookup.js"
import {
  computeSighash,
  constructSignedTransaction
} from "./commands/bitcoin.js"
import web3Utils from "web3-utils"
const { toBN } = web3Utils

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
  found: {
    mnemonic,
    /* account,*/ rpc,
    f: transactionFee,
    c: keepEcdsaClientPath,
    s: keyShareDirectory,
    o: beneficiaryDirectory,
    m: misfundDirectory
  },
  remaining: commandArgs
} = findAndConsumeArgsValues(
  flagArgs,
  "--mnemonic",
  "--account",
  "--rpc",
  "-f",
  "-c",
  "-s",
  "-o",
  "-m",
  "-r"
)
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

if (commandArgs.length !== 1) {
  console.error(`Only one CSV file is supported, got '${commandArgs}'.`)
  process.exit(1)
}

const [infoCsv] = commandArgs

const web3 = new Web3(engine)
engine.start()

/**
 * @param {string} keepAddress,
 * @param {string} digest
 * @return {Promise<{ signature: string, publicKey: string }>}
 */
function signDigest(keepAddress, digest) {
  const keepDirectory = (keyShareDirectory || "key-shares") + "/" + keepAddress
  return new Promise((resolve, reject) => {
    let output = ""
    let allOutput = ""
    let outputFinished = false
    const process = spawn(keepEcdsaClientPath || "keep-ecdsa", [
      "signing",
      "sign-digest",
      digest,
      keepDirectory
    ])
    process.stdout.setEncoding("utf8")
    process.stdout.on("data", chunk => {
      output += chunk
      allOutput += chunk
    })
    process.stderr.on("data", chunk => {
      allOutput += chunk
    })
    process.stdout.on("end", () => (outputFinished = true))

    process
      .on("exit", (code, signal) => {
        if (code === 0) {
          const processOutput = () => {
            const [publicKey, signature] = output.split("\t")

            if (publicKey && signature) {
              resolve({
                signature: signature.trim(),
                publicKey: publicKey.trim()
              })
            } else {
              reject(new Error(`Unexpected output:\n${allOutput}`))
            }
          }
          if (outputFinished) {
            processOutput()
          } else {
            process.stdout.on("close", processOutput)
          }
        } else {
          reject(
            new Error(
              `Process exited abnormally with signal ${signal} and code ${code}\n` +
                allOutput
            )
          )
        }
      })
      .on("error", error => {
        reject(allOutput || error)
      })
  })
}

/**
 * @param {string} keepAddress
 */
async function validateKeyShares(keepAddress) {
  const keepDirectory = (keyShareDirectory || "key-shares") + "/" + keepAddress

  if ((await stat(keepDirectory)).isDirectory()) {
    const directoryContents = await readdir(keepDirectory)

    // Below, use semicolons instead of commas since CSV is our output type.
    if (directoryContents.length > 3) {
      return `too many key shares: ${directoryContents.join(";")}.`
    } else if (directoryContents.length < 3) {
      const keepContract = keepAt(keepAddress)
      /** @type {string[]} */
      const operators = await keepContract.methods.getMembers().call()
      const directoryOperators = directoryContents
        .map(_ =>
          _.replace(/share-/, "")
            .replace(/.dat$/, "")
            .toLowerCase()
        )
        .sort()
      const seenOperators = new Set(directoryOperators)
      const unseenOperators = operators.filter(
        _ => !seenOperators.has(_.toLowerCase())
      )

      return `not enough key shares---missing: ${unseenOperators.join("; ")}.`
    } else if ((await signDigest(keepAddress, "deadbeef")) === null) {
      return "unknown key share signing error"
    } else {
      // All is well!
      return null
    }
  } else {
    return "no key share directory"
  }
}
/** @type {import("../src/EthereumHelpers.js").Contract} */
let baseKeepContract
/** @type {import("../src/EthereumHelpers.js").Contract} */
let tokenStakingContract
/** @type {Promise<import("../src/EthereumHelpers.js").Contract>} */
let tbtcSystemContract
/** @type {Promise<import("../src/EthereumHelpers.js").Contract>} */
let tbtcConstantsContract
/** @type {Promise<import("../src/EthereumHelpers.js").Contract>} */
let tbtcDepositTokenContract
/** @type {number} */
let startingBlock

function keepAt(/** @type {string} */ keepAddress) {
  baseKeepContract =
    baseKeepContract ||
    EthereumHelpers.buildContract(
      web3,
      /** @type {TruffleArtifact} */ (BondedECDSAKeepJSON).abi
    )

  const requestedKeep = /** @type {typeof baseKeepContract} */ (baseKeepContract.clone())
  requestedKeep.options.address = keepAddress
  return requestedKeep
}

async function tokenStaking() {
  tokenStakingContract =
    tokenStakingContract ||
    (await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TokenStakingJSON),
      web3,
      "1"
    ))

  return tokenStakingContract
}

function tbtcSystem() {
  tbtcSystemContract =
    tbtcSystemContract ||
    EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TBTCSystemJSON),
      web3,
      "1"
    )

  return tbtcSystemContract
}

function tbtcConstants() {
  tbtcConstantsContract =
    tbtcConstantsContract ||
    EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TBTCConstantsJSON),
      web3,
      "1"
    )

  return tbtcConstantsContract
}

function tbtcDepositToken() {
  tbtcDepositTokenContract =
    tbtcDepositTokenContract ||
    EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TBTCDepositTokenJSON),
      web3,
      "1"
    )

  return tbtcDepositTokenContract
}

async function referenceBlock() {
  startingBlock = startingBlock || (await web3.eth.getBlockNumber())
  return startingBlock
}

/**
 * @type {{ [operatorAddress: string]: { beneficiary?: string?, owner?: string? }}}
 */
const delegationInfoCache = {}

async function beneficiaryOf(/** @type {string} */ operatorAddress) {
  if (
    delegationInfoCache[operatorAddress] &&
    delegationInfoCache[operatorAddress].beneficiary
  ) {
    return delegationInfoCache[operatorAddress].beneficiary
  }

  const beneficiary = (await tokenStaking()).methods
    .beneficiaryOf(operatorAddress)
    .call()
  delegationInfoCache[operatorAddress] =
    delegationInfoCache[operatorAddress] || {}
  delegationInfoCache[operatorAddress].beneficiary = beneficiary

  return beneficiary
}

async function deepOwnerOf(/** @type {string} */ operatorAddress) {
  if (
    delegationInfoCache[operatorAddress] &&
    delegationInfoCache[operatorAddress].owner
  ) {
    return delegationInfoCache[operatorAddress].owner
  }

  const owner = lookupOwner(
    web3,
    await contractsFromWeb3(web3),
    operatorAddress
  )
  delegationInfoCache[operatorAddress] =
    delegationInfoCache[operatorAddress] || {}
  delegationInfoCache[operatorAddress].owner = owner

  return owner
}

/**
 * @param {string} keepAddress
 */
async function keepStatusCompleted(keepAddress) {
  const block = await referenceBlock()
  const keepContract = keepAt(keepAddress)

  if (await keepContract.methods.isClosed().call({}, block)) {
    return "closed"
  } else if (await keepContract.methods.isTerminated().call({}, block)) {
    return "terminated"
  } else {
    return null
  }
}

/**
 * @param {string} keepAddress
 */
async function keepHoldsBtc(keepAddress) {
  const keepContract = keepAt(keepAddress)
  const pubkey = await keepContract.methods.getPublicKey().call()

  const bitcoinAddress = BitcoinHelpers.Address.publicKeyToP2WPKHAddress(
    pubkey.replace(/0x/, ""),
    BitcoinHelpers.Network.MAINNET
  )

  const btcBalance = await BitcoinHelpers.Transaction.getBalance(bitcoinAddress)

  return { bitcoinAddress, btcBalance }
}

/** @type {{[operatorAddress: string]: { beneficiary: string, latestIndex: number}} */
const operatorBeneficiaries = {}

async function generateAddress(
  /** @type {string} */ beneficiary,
  /** @type {number} */ latestIndex
) {
  if (!beneficiary.match(/^.pub/)) {
    return { latestAddress: beneficiary, latestIndex } // standard address, always returns itself
  }

  const metadata = getExtPubKeyMetadata(beneficiary)
  let latestAddress = ""
  let addressIndex = latestIndex
  do {
    const derivedAddressInfo = addressFromExtPubKey({
      extPubKey: beneficiary,
      keyIndex: addressIndex,
      purpose: metadata.type,
      network: metadata.network
    })
    latestAddress = derivedAddressInfo.address
    // TODO Store address index?
    addressIndex++
  } while (await BitcoinHelpers.Transaction.find(latestAddress, 0))

  return { latestAddress, latestIndex: addressIndex }
}

/**
 * @param {string} operatorAddress
 */
async function readBeneficiary(operatorAddress) {
  let beneficiaryInfo = operatorBeneficiaries[operatorAddress]
  if (!beneficiaryInfo) {
    const beneficiaryFile =
      (beneficiaryDirectory || "beneficiaries") +
      "/beneficiary-" +
      operatorAddress.toLowerCase() +
      ".json"

    // If it doesn't exist, return empty.
    try {
      if (!(await stat(beneficiaryFile)).isFile()) {
        return null
      }
    } catch (e) {
      return null
    }

    /** @type {{msg: string, sig: string, address: string}} */
    const jsonContents = JSON.parse(
      await readFile(beneficiaryFile, { encoding: "utf-8" })
    )

    if (!jsonContents.msg || !jsonContents.sig || !jsonContents.address) {
      throw new Error(
        `Invalid format for ${operatorAddress}: message, signature, or signing address missing.`
      )
    }

    // Force a 0x prefix so `recover` works correctly. Some tools omit it from
    // the sig field.
    if (!jsonContents.sig.startsWith("0x")) {
      jsonContents.sig = "0x" + jsonContents.sig
    }

    const recoveredAddress = web3.eth.accounts.recover(
      jsonContents.msg,
      jsonContents.sig
    )
    if (recoveredAddress.toLowerCase() !== jsonContents.address.toLowerCase()) {
      throw new Error(
        `Recovered address does not match signing address for ${operatorAddress}.`
      )
    }

    if (
      recoveredAddress.toLowerCase() !==
        (await beneficiaryOf(operatorAddress)).toLowerCase() &&
      recoveredAddress.toLowerCase() !==
        (await deepOwnerOf(operatorAddress)).toLowerCase() &&
      recoveredAddress.toLowerCase() !== operatorAddress
    ) {
      throw new Error(
        `Beneficiary address for ${operatorAddress} was not signed by operator owner or beneficiary.`
      )
    }

    const pubs = [...jsonContents.msg.matchAll(/[xyz]pub[a-zA-Z0-9]+/g)].map(
      _ => _[0]
    )
    if (pubs.length > 1 && pubs.slice(1).some(_ => _ !== pubs[0])) {
      throw new Error(
        `Beneficiary message for ${operatorAddress} includes too many *pubs: ${pubs}`
      )
    } else if (pubs.length !== 0) {
      beneficiaryInfo = {
        beneficiary: pubs[0],
        latestIndex: 0
      }
    } else {
      const addresses = [
        ...jsonContents.msg.matchAll(
          /(?:1|3)[A-Za-z0-9]{25,34}|bc1[0-9a-z]{11,71}/g
        )
      ].map(_ => _[0])
      if (addresses.length > 1) {
        throw new Error(
          `Beneficiary message for ${operatorAddress} includes too many addresses: ${addresses}`
        )
      } else if (addresses.length !== 0) {
        beneficiaryInfo = {
          beneficiary: addresses[0],
          latestIndex: 0
        }
      }
    }

    if (!beneficiaryInfo) {
      throw new Error(
        `Could not find a valid BTC address or *pub in signed message for ${operatorAddress}: ` +
          `${jsonContents.msg}`
      )
    }
  }

  const { latestAddress, latestIndex } = await generateAddress(
    beneficiaryInfo.beneficiary,
    beneficiaryInfo.latestIndex
  )

  beneficiaryInfo.latestIndex = latestIndex
  operatorBeneficiaries[operatorAddress] = beneficiaryInfo

  return latestAddress
}

async function readRefundAddress(/** @type {string} */ depositAddress) {
  const addressFile =
    (misfundDirectory || "misfunds") +
    "/misfund-" +
    depositAddress.toLowerCase() +
    ".json"

  // If it doesn't exist, return empty.
  try {
    if (!(await stat(addressFile)).isFile()) {
      return null
    }
  } catch (e) {
    return null
  }

  /** @type {{msg: string, sig: string, address: string}} */
  const jsonContents = JSON.parse(
    await readFile(addressFile, { encoding: "utf-8" })
  )

  if (!jsonContents.msg || !jsonContents.sig || !jsonContents.address) {
    throw new Error(
      `Invalid format for signed address: message, signature, or signing address missing.`
    )
  }

  const recoveredAddress = web3.eth.accounts.recover(
    jsonContents.msg,
    jsonContents.sig
  )
  if (recoveredAddress.toLowerCase() !== jsonContents.address.toLowerCase()) {
    throw new Error(`Recovered address does not match signing address.`)
  }

  const depositOwner = await (await tbtcDepositToken()).methods
    .ownerOf(depositAddress)
    .call()

  if (recoveredAddress.toLowerCase() !== depositOwner.toLowerCase()) {
    throw new Error(`Refund address was not signed by deposit owner.`)
  }

  const addresses = [
    ...jsonContents.msg.matchAll(/(?:1|3|bc1)[A-Za-z0-9]{26,33}/g)
  ].map(_ => _[0])
  if (addresses.length > 1) {
    throw new Error(`Refund message includes too many addresses: ${addresses}`)
  } else if (addresses.length === 1) {
    return addresses[0]
  }

  throw new Error(
    `Could not find a valid BTC address in signed message: ` +
      `${jsonContents.msg}`
  )
}

async function beneficiariesAvailableAndSigned(
  /** @type {string} */ keepAddress
) {
  const keepContract = keepAt(keepAddress)

  const operators = /** @type {[string,string,string]} */ ([
    ...(await keepContract.methods.getMembers().call())
  ])
    .map(_ => _.toLowerCase())
    // Sort operators so beneficiaries are in a stable order for analysis.
    .sort()
  try {
    const beneficiaries = await Promise.all(operators.map(readBeneficiary))
    const unavailableBeneficiaries = beneficiaries
      .map((beneficiary, i) => {
        if (beneficiary === null) {
          return operators[i]
        } else {
          return null
        }
      })
      .filter(_ => _ !== null)

    if (unavailableBeneficiaries.length > 0) {
      return {
        error: `not all beneficiaries are available (missing ${unavailableBeneficiaries})`
      }
    }

    return {
      beneficiary1: beneficiaries[0],
      beneficiary2: beneficiaries[1],
      beneficiary3: beneficiaries[2]
    }
  } catch (e) {
    return { error: `beneficiary lookup failed: ${e}` }
  }
}

async function buildAndBroadcastLiquidationSplit(/** @type {any} */ keepData) {
  const {
    /** @type {string} */ keep: keepAddress,
    /** @type {string} */ bitcoinAddress,
    /** @type {number} */ btcBalance,
    /** @type {string} */ beneficiary1,
    /** @type {string} */ beneficiary2,
    /** @type {string} */ beneficiary3,
    /** @type {string} */ fundingTransactionID,
    /** @type {number} */ fundingTransactionPosition
  } = keepData

  const fee =
    parseInt(transactionFee || "0") ||
    toBN(await (await tbtcConstants()).methods.getMinimumRedemptionFee().call())
      .muln(15)
      .toNumber()

  // Math this out in BN-land to minimize the likelihood of precision issues.
  const refundAmount = toBN(btcBalance).subn(fee)
  const perBeneficiaryAmount = refundAmount.divn(3).toNumber()
  const sighashToSign = computeSighash(
    {
      transactionID: fundingTransactionID,
      index: fundingTransactionPosition
    },
    btcBalance,
    bitcoinAddress,
    { value: perBeneficiaryAmount, address: beneficiary1 },
    { value: perBeneficiaryAmount, address: beneficiary2 },
    { value: perBeneficiaryAmount, address: beneficiary3 }
  )

  try {
    const { signature, publicKey } = await signDigest(
      keepAddress,
      sighashToSign.toString("hex")
    )
    const signedTransaction = constructSignedTransaction(
      {
        transactionID: fundingTransactionID,
        index: fundingTransactionPosition
      },
      signature,
      publicKey,
      { value: perBeneficiaryAmount, address: beneficiary1 },
      { value: perBeneficiaryAmount, address: beneficiary2 },
      { value: perBeneficiaryAmount, address: beneficiary3 }
    )

    // const { transactionID } = await BitcoinHelpers.Transaction.broadcast(
    //   signedTransaction
    // )
    const transactionID = "lolnope"

    return {
      perBeneficiaryAmount,
      signature,
      publicKey,
      transactionID,
      signedTransaction
    }
  } catch (e) {
    return { refundAmount, error: `Error signing: ${e}` }
  }
}

async function misfundRecipientAvailableAndSigned(
  /** @type {string} */ keepAddress
) {
  // Find associated deposit.
  const {
    returnValues: { _depositContractAddress: depositAddress }
  } = await EthereumHelpers.getExistingEvent(await tbtcSystem(), "Created", {
    _keepAddress: keepAddress
  })

  // find owner
  // check for beneficiary info
  /** @type {[string,string,string]} */
  try {
    const refundAddress = await readRefundAddress(depositAddress)

    if (!refundAddress) {
      return {
        error: `refund address missing`
      }
    }

    return {
      recipientAddress: refundAddress
    }
  } catch (e) {
    return { error: `refund address lookup failed: ${e}` }
  }
}

async function findFundingInfo(/** @type {string} */ bitcoinAddress) {
  const unspent = await BitcoinHelpers.Transaction.findAllUnspent(
    bitcoinAddress
  )

  if (unspent.length > 1) {
    return { error: "Multiple unspent outputs, manual intervention required." }
  } else if (unspent.length == 0) {
    return { error: "No unspent outputs." }
  }

  const { transactionID, outputPosition } = unspent[0]

  return {
    fundingTransactionID: transactionID,
    fundingTransactionPosition: outputPosition
  }
}

async function buildAndBroadcastRefund(/** @type {any} */ keepData) {
  const {
    /** @type {string} */ keep: keepAddress,
    /** @type {string} */ bitcoinAddress,
    /** @type {number} */ btcBalance,
    /** @type {string} */ recipientAddress,
    /** @type {string} */ fundingTransactionID,
    /** @type {number} */ fundingTransactionPosition
  } = keepData

  const fee =
    parseInt(transactionFee || "0") ||
    toBN(await (await tbtcConstants()).methods.getMinimumRedemptionFee().call())
      .muln(18)
      .muln(5)
      .toNumber()

  const refundAmount = btcBalance - fee
  const sighashToSign = computeSighash(
    {
      transactionID: fundingTransactionID,
      index: fundingTransactionPosition
    },
    btcBalance,
    bitcoinAddress,
    { value: refundAmount, address: recipientAddress }
  )

  try {
    const { signature, publicKey } = await signDigest(
      keepAddress,
      sighashToSign.toString("hex")
    )
    const signedTransaction = constructSignedTransaction(
      {
        transactionID: fundingTransactionID,
        index: fundingTransactionPosition
      },
      signature,
      publicKey,
      {
        value: refundAmount,
        address: recipientAddress
      }
    )

    // const { transactionID } = await BitcoinHelpers.Transaction.broadcast(
    //   signedTransaction
    // )
    const transactionID = "lolnope"

    return {
      refundAmount,
      signature,
      publicKey,
      transactionID,
      signedTransaction
    }
  } catch (e) {
    return { refundAmount, error: `Error signing: ${e}` }
  }
}

async function processKeeps(/** @type {{[any: string]: string}[]} */ keepRows) {
  const keeps = keepRows
    .filter(_ => _.keep) // strip any weird undefined lines
    .reduce((keepSet, { keep }) => keepSet.add(keep), new Set())
  const results = Array.from(keeps).reduce(async (previousRows, keep) => {
    // We need to wait for previous work to settle so that beneficiary address
    // generation runs serially rather than in parallel.
    const rows = await previousRows

    // Contract for processors is they take the row data and return updated row
    // data; if the updated row data includes an `error` key, subsequent
    // processors don't run.
    const genericStatusProcessors = [
      async (/** @type {any} */ row) => {
        const status = await keepStatusCompleted(row.keep)

        if (status) {
          return { ...row, status }
        } else {
          return { ...row, error: "no status" }
        }
      },
      async (/** @type {any} */ row) => {
        const balanceData = await keepHoldsBtc(row.keep)

        if (balanceData && balanceData.btcBalance > 0) {
          return { ...row, ...balanceData }
        } else {
          return { ...row, error: "no BTC" }
        }
      },
      async (/** @type {any} */ row) => {
        const validationError = await validateKeyShares(row.keep)

        if (validationError) {
          return {
            ...row,
            error: validationError
          }
        } else {
          return row
        }
      }
    ]
    const liquidationProcessors = [
      async (/** @type {any} */ row) => {
        const beneficiaries = await beneficiariesAvailableAndSigned(row.keep)

        if (beneficiaries) {
          return { ...row, ...beneficiaries }
        } else {
          return {
            ...row,
            error: "no beneficiary"
          }
        }
      },
      async (/** @type {any} */ row) => {
        const fundingInfo = await findFundingInfo(row.bitcoinAddress)

        if (fundingInfo) {
          return { ...row, ...fundingInfo }
        } else {
          return {
            ...row,
            error: "failed to find funding info for keep"
          }
        }
      },
      async (/** @type {any} */ row) => {
        const transactionData = await buildAndBroadcastLiquidationSplit(row)

        if (transactionData) {
          return { ...row, ...transactionData }
        } else {
          return {
            ...row,
            error:
              "failed to build and broadcast liquidation split BTC transaction"
          }
        }
      }
    ]
    const misfundProcessors = [
      // - Check for BTC refund address availability for the keep's deposit.
      // - If available, verify that the BTC refund address is correctly signed by
      //   the owner of the keep's deposit.
      //   (= await web3.eth.personal.ecRecover(address.msg, address.sig) == address.account &&
      //      deposit.includes(message.account))
      // - If yes, build, sign, and broadcast refund transaction.
      async (/** @type {any} */ row) => {
        const misfunderInfo = await misfundRecipientAvailableAndSigned(row.keep)

        if (misfunderInfo) {
          return { ...row, ...misfunderInfo }
        } else {
          return {
            ...row,
            error: "no misfunder"
          }
        }
      },
      async (/** @type {any} */ row) => {
        const fundingInfo = await findFundingInfo(row.bitcoinAddress)

        if (fundingInfo) {
          return { ...row, ...fundingInfo }
        } else {
          return {
            ...row,
            error: "failed to find funding info for keep"
          }
        }
      },
      async (/** @type {any} */ row) => {
        const transactionData = await buildAndBroadcastRefund(row)

        if (transactionData) {
          return { ...row, ...transactionData }
        } else {
          return {
            ...row,
            error: "failed to build and broadcast refund BTC transaction"
          }
        }
      }
    ]

    const processThrough = async (
      /** @type {any} */ inputData,
      /** @type {(function(any):Promise<any>)[]} */ processors
    ) => {
      return await processors.reduce(async (rowPromise, process) => {
        const row = await rowPromise
        try {
          if (!row.error) {
            return await process(row)
          } else {
            return row
          }
        } catch (e) {
          return Promise.resolve({
            ...row,
            error: `Error processing transaction: ${e}`
          })
        }
      }, Promise.resolve(inputData))
    }

    const basicInfo = await processThrough({ keep }, genericStatusProcessors)

    if (basicInfo.status == "terminated") {
      return rows.concat([
        await processThrough(basicInfo, liquidationProcessors)
      ])
    } else if (basicInfo.status == "closed") {
      return rows.concat([await processThrough(basicInfo, misfundProcessors)])
    } else {
      return rows.concat([basicInfo])
    }
  }, [])

  return results
}

run(() => {
  return new Promise(async (resolve, reject) => {
    try {
      PapaParse.parse(await readFile(infoCsv, "utf8"), {
        header: true,
        transformHeader: header => {
          const unspaced = header.trim().replace(/ /g, "")
          return unspaced[0].toLowerCase() + unspaced.slice(1)
        },
        complete: ({ data }) => {
          // @ts-ignore No really, this is a valid config.
          BitcoinHelpers.electrumConfig = AvailableBitcoinConfigs["1"].electrum
          BitcoinHelpers.withElectrumClient(() =>
            processKeeps(data).then(keepRows => {
              const allKeys = Array.from(new Set(keepRows.flatMap(Object.keys)))

              const arrayRows = keepRows.map(row =>
                allKeys.map(key => row[key])
              )
              resolve(
                [allKeys]
                  .concat(arrayRows)
                  .map(_ => _.join(","))
                  .join("\n")
              )
            })
          )
        }
      })
    } catch (err) {
      reject(err)
    }
  })
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
