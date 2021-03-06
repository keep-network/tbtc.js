#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import EthereumHelpers from "../src/EthereumHelpers.js"

/** @typedef { import('../src/EthereumHelpers.js').TruffleArtifact } TruffleArtifact */
/** @typedef { import('../src/EthereumHelpers.js').Contract } Contract */
/** @typedef {{ [contractName: string]: Contract}} Contracts */

import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"

import KeepTokenJSON from "@keep-network/keep-core/artifacts/KeepToken.json"
import TokenGrantJSON from "@keep-network/keep-core/artifacts/TokenGrant.json"
import TokenStakingJSON from "@keep-network/keep-core/artifacts/TokenStaking.json"
import ManagedGrantJSON from "@keep-network/keep-core/artifacts/ManagedGrant.json"
import StakingPortBackerJSON from "@keep-network/keep-core/artifacts/StakingPortBacker.json"
import TokenStakingEscrowJSON from "@keep-network/keep-core/artifacts/TokenStakingEscrow.json"

const ManagedGrantABI = ManagedGrantJSON.abi

const utils = Web3.utils

let standalone = false
const args = process.argv.slice(2)
if (process.argv.some(_ => _.includes("owner-lookup.js"))) {
  standalone = true
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

const web3 = new Web3(engine)
engine.start()

if (standalone) {
  // owner-lookup.js <operator-address>+
  if (!commandArgs.every(utils.isAddress)) {
    console.error("All arguments must be valid Ethereum addresses.")
    process.exit(1)
  }

  doTheThing()
    .then(result => {
      console.log(result)

      process.exit(0)
    })
    .catch(error => {
      console.error("ERROR ", error)

      process.exit(1)
    })
}

async function doTheThing() {
  web3.eth.defaultAccount = account || (await web3.eth.getAccounts())[0]

  const operators = args
  return Promise.all(
    operators.map(
      operator =>
        new Promise(async resolve => {
          resolve(
            [
              operator,
              await lookupOwner(web3, await contractsFromWeb3(web3), operator)
            ].join("\t")
          )
        })
    )
  ).then(_ => _.join("\n"))
}

/**
 * @param {Web3} web3
 * @return {Promise<Contracts>}
 */
export async function contractsFromWeb3(/** @type {Web3} */ web3) {
  const chainId = String(await web3.eth.getChainId())

  return {
    KeepToken: await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (KeepTokenJSON),
      web3,
      chainId
    ),
    TokenGrant: await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TokenGrantJSON),
      web3,
      chainId
    ),
    TokenStaking: await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TokenStakingJSON),
      web3,
      chainId
    ),
    StakingPortBacker: await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (StakingPortBackerJSON),
      web3,
      chainId
    ),
    TokenStakingEscrow: await EthereumHelpers.getDeployedContract(
      /** @type {TruffleArtifact} */ (TokenStakingEscrowJSON),
      web3,
      chainId
    )
  }
}

export function lookupOwner(
  /** @type {Web3} */ web3,
  /** @type {{ [contractName: string]: Contract}} */ contracts,
  /** @type {string} */ operator
) {
  const { TokenStaking } = contracts
  return TokenStaking.methods
    .ownerOf(operator)
    .call()
    .then((/** @type {string} */ owner) => {
      try {
        return resolveOwner(web3, contracts, owner, operator)
      } catch (e) {
        return `Unknown (${e})`
      }
    })
}

export function lookupOwnerAndGrantType(
  /** @type {Web3} */ web3,
  /** @type {{ [contractName: string]: Contract}} */ contracts,
  /** @type {string} */ operator
) {
  const { TokenStaking } = contracts
  return TokenStaking.methods
    .ownerOf(operator)
    .call()
    .then((/** @type {string} */ owner) => {
      try {
        return resolveOwnerAndGrantType(web3, contracts, owner, operator)
      } catch (e) {
        return `Unknown (${e})`
      }
    })
}

/**
 * @param {Web3} web3
 * @param {Contracts} contracts
 * @param {string} owner
 * @param {string} operator
 * @return {Promise<string>}
 */
async function resolveOwner(web3, contracts, owner, operator) {
  return (await resolveOwnerAndGrantType(web3, contracts, owner, operator))
    .owner
}

/**
 * @enum {string}
 */
export const GrantType = {
  None: "no grant",
  SimpleGrant: "direct grant",
  ManagedGrant: "managed grant"
}

/**
 * @param {Web3} web3
 * @param {Contracts} contracts
 * @param {string} owner
 * @param {string} operator
 * @return {Promise<{owner: string, grantType: GrantType}>}
 */
async function resolveOwnerAndGrantType(web3, contracts, owner, operator) {
  const {
    KeepToken,
    StakingPortBacker,
    TokenStaking,
    TokenStakingEscrow,
    TokenGrant
  } = contracts

  const firstStorageSlot = await web3.eth.getStorageAt(owner, 0)

  if (firstStorageSlot === "0x") {
    return { owner, grantType: GrantType.None } // owner is already a user-owned account
  } else if (owner == StakingPortBacker.options.address) {
    const { owner } = await StakingPortBacker.methods
      .copiedStakes(operator)
      .call()
    return resolveOwnerAndGrantType(web3, contracts, owner, operator)
  } else if (owner == TokenStakingEscrow.options.address) {
    const {
      returnValues: { grantId }
    } = await EthereumHelpers.getExistingEvent(
      TokenStakingEscrow,
      "DepositRedelegated",
      { newOperator: operator }
    )
    const { grantee } = await TokenGrant.methods.getGrant(grantId).call()
    const {
      grantee: finalGrantee,
      grantType
    } = await resolveGranteeAndGrantType(web3, grantee)

    return { owner: finalGrantee, grantType }
  } else {
    // If it's not a known singleton contract, try to see if it's a
    // TokenGrantStake; if not, assume it's an owner-controlled contract.
    try {
      let grantId = null

      // TokenGrantStakes have the token address and token staking address as
      // their first two storage slots. They should be the only owner with this
      // characteristic. In this case, the grant id is in the 4th slot.
      //
      // This is unfortunately the only clear strategy for identifying
      // TokenGrantStakes on both the v1.0.1 TokenStaking contract and
      // the v1.3.0 upgraded one. The old contract did not have any
      // events that indexed the operator contract, making it impossible
      // to efficiently check if a token grant stake was at play without
      // already knowing the owner.
      if (
        firstStorageSlot ==
          web3.utils.padLeft(KeepToken.options.address, 64).toLowerCase() &&
        (await web3.eth.getStorageAt(owner, 1)) ==
          web3.utils.padLeft(TokenStaking.options.address, 64).toLowerCase()
      ) {
        const fourthStorageSlot = await web3.eth.getStorageAt(owner, 3)
        // We're making the assumption the grant id doesn't need a BN,
        // which should be a safe assumption for the foreseeable future.
        grantId = web3.utils.hexToNumber(fourthStorageSlot)
      }

      const { grantee } = await TokenGrant.methods.getGrant(grantId).call()
      const {
        grantee: finalGrantee,
        grantType
      } = await resolveGranteeAndGrantType(web3, grantee)

      return { owner: finalGrantee, grantType }
    } catch (_) {
      // If we threw, assume this isn't a TokenGrantStake and the
      // owner is just an unknown contract---e.g. Gnosis Safe.
      return { owner, grantType: GrantType.None }
    }
  }
}

async function resolveGranteeAndGrantType(
  /** @type {Web3} */ web3,
  /** @type {string} */ grantee
) {
  if ((await web3.eth.getStorageAt(grantee, 0)) === "0x") {
    return { grantee, grantType: GrantType.SimpleGrant } // grantee is already a user-owned account
  } else {
    try {
      const grant = EthereumHelpers.buildContract(
        web3,
        // @ts-ignore Oh but this is an AbiItem[]
        ManagedGrantABI,
        grantee
      )

      return {
        grantee: await grant.methods.grantee().call(),
        grantType: GrantType.ManagedGrant
      }
    } catch (_) {
      // If we threw, assume this isn't a ManagedGrant and the
      // grantee is just an unknown contract---e.g. Gnosis Safe.
      return { grantee, grantType: GrantType.SimpleGrant }
    }
  }
}
