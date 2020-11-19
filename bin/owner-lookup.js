#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import EthereumHelpers from "../src/EthereumHelpers.js"

/** @typedef { import('../src/EthereumHelpers.js').TruffleArtifact } TruffleArtifact */

import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"

const utils = Web3.utils

let args = process.argv.slice(2)
if (process.argv[0].includes("owner-lookup.js")) {
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

import TokenGrantJSON from "@keep-network/keep-core/artifacts/TokenGrant.json"
import TokenStakingJSON from "@keep-network/keep-core/artifacts/TokenStaking.json"
import ManagedGrantJSON from "@keep-network/keep-core/artifacts/ManagedGrant.json"
import StakingPortBackerJSON from "@keep-network/keep-core/artifacts/StakingPortBacker.json"
import TokenStakingEscrowJSON from "@keep-network/keep-core/artifacts/TokenStakingEscrow.json"

const TokenGrantABI = TokenGrantJSON.abi
const ManagedGrantABI = ManagedGrantJSON.abi

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

async function doTheThing() {
  web3.eth.defaultAccount = account || (await web3.eth.getAccounts())[0]
  const chainId = String(await web3.eth.getChainId())

  const TokenGrant = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (TokenGrantJSON),
    web3,
    chainId
  )
  const TokenStaking = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (TokenStakingJSON),
    web3,
    chainId
  )
  const StakingPortBacker = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (StakingPortBackerJSON),
    web3,
    chainId
  )
  const TokenStakingEscrow = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (TokenStakingEscrowJSON),
    web3,
    chainId
  )

  const operators = args
  return Promise.all(
    operators.map(
      operator =>
        new Promise(async resolve => {
          resolve([operator, await lookupOwner(operator)].join("\t"))
        })
    )
  ).then(_ => _.join("\n"))

  function lookupOwner(/** @type {string} */ operator) {
    return TokenStaking.methods
      .ownerOf(operator)
      .call()
      .then((/** @type {string} */ owner) => {
        try {
          return resolveOwner(owner, operator)
        } catch (e) {
          return `Unknown (${e})`
        }
      })
  }

  /**
   * @param {string} owner
   * @param {string} operator
   * @return {Promise<string>}
   */
  async function resolveOwner(
    /** @type {string} */ owner,
    /** @type {string} */ operator
  ) {
    if ((await web3.eth.getStorageAt(owner, 0)) === "0x") {
      return owner // owner is already a user-owned account
    } else if (owner == StakingPortBacker.options.address) {
      const { owner } = await StakingPortBacker.methods
        .copiedStakes(operator)
        .call()
      return resolveOwner(owner, operator)
    } else if (owner == TokenStakingEscrow.options.address) {
      const grantId = await TokenStakingEscrow.methods
        .depositGrantId(operator)
        .call()
      const { grantee } = await TokenGrant.methods.getGrant(grantId).call()
      return resolveGrantee(grantee)
    } else {
      // If it's not a known singleton contract, try to see if it's a
      // TokenGrantStake; if not, assume it's an owner-controlled contract.
      try {
        const {
          transactionHash
        } = await EthereumHelpers.getExistingEvent(
          TokenStaking,
          "StakeDelegated",
          { operator }
        )
        const { logs } = await web3.eth.getTransactionReceipt(transactionHash)
        const TokenGrantStakedABI = TokenGrantABI.filter(
          _ => _.type == "event" && _.name == "TokenGrantStaked"
        )[0]
        let grantId = null
        // eslint-disable-next-line guard-for-in
        for (const i in logs) {
          const { data, topics } = logs[i]
          // @ts-ignore Oh but there is a signature property on events foo'.
          if (topics[0] == TokenGrantStakedABI.signature) {
            const decoded = web3.eth.abi.decodeLog(
              TokenGrantStakedABI.inputs,
              data,
              topics.slice(1)
            )
            grantId = decoded.grantId
            break
          }
        }

        const { grantee } = await TokenGrant.methods.getGrant(grantId).call()
        return resolveGrantee(grantee)
      } catch (_) {
        // If we threw, assume this isn't a TokenGrantStake and the
        // owner is just an unknown contract---e.g. Gnosis Safe.
        return owner
      }
    }
  }

  async function resolveGrantee(/** @type {string} */ grantee) {
    if ((await web3.eth.getStorageAt(grantee, 0)) === "0x") {
      return grantee // grantee is already a user-owned account
    } else {
      try {
        const grant = EthereumHelpers.buildContract(
          web3,
          // @ts-ignore Oh but this is an AbiItem[]
          ManagedGrantABI,
          grantee
        )

        return await grant.methods.grantee().call()
      } catch (_) {
        // If we threw, assume this isn't a ManagedGrant and the
        // grantee is just an unknown contract---e.g. Gnosis Safe.
        return grantee
      }
    }
  }
}
