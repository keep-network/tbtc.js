#!/usr/bin/env node --experimental-modules
import Web3 from "web3"
import TBTC, { EthereumHelpers } from "../index.js"
import Redemption from "../src/Redemption.js"

import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import Subproviders from "@0x/subproviders"

const engine = new ProviderEngine({ pollingInterval: 1000 })
engine.addProvider(
  // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
  new Subproviders.PrivateKeyWalletSubprovider(
    //"b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990"
    "44a6e77e0d7b22e7401706c28cc93fd5816788812a8eb1e4bfb423cb50696542"
  )
)
engine.addProvider(
  new WebsocketSubprovider({
    rpcUrl: "wss://mainnet.infura.io/ws/v3/414a548bc7434bbfb7a135b694b15aa4"
  })
)

// -------------------------------- SETUP --------------------------------------
const web3 = new Web3(engine)
engine.start()

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}
let action = null

switch (args[0]) {
  case "deposit":
    if (args.length == 2 && bnOrNull(args[1])) {
      let mint = true
      if (args.length == 3 && args[2] == "--no-mint") {
        mint = false
      }
      action = async tbtc => {
        return await createDeposit(tbtc, web3.utils.toBN(args[1]), mint)
      }
    }
    break
  case "resume":
    if (args.length == 2 && web3.utils.isAddress(args[1])) {
      let mint = true
      if (args.length == 3 && args[2] == "--no-mint") {
        mint = false
      }
      action = async tbtc => {
        return await resumeDeposit(tbtc, args[1], mint)
      }
    }
    break
  case "redeem":
    if (args.length == 3 && web3.utils.isAddress(args[1])) {
      action = async tbtc => {
        return await redeemDeposit(tbtc, args[1], args[2])
      }
    } else if (args.length == 1) {
      action = async tbtc => {
        return await availableRedemptions(tbtc)
      }
    }
    break
  case "liquidate":
    if (args.length == 3 && web3.utils.isAddress(args[1])) {
      console.log('unimplemented')
      process.exit(1)
    } else if (args.length == 2 && web3.utils.isAddress(args[1])) {
      action = async tbtc => {
        return await liquidateDeposit(tbtc, args[1])
      }
    }
    break
  case "withdraw":
     if (args.length == 2 && web3.utils.isAddress(args[1])) {
      action = async tbtc => {
        return await withdrawFromDeposit(tbtc, args[1])
      }
    }
    break
  case "beneficiary":
     if (args.length == 2 && web3.utils.isAddress(args[1])) {
      action = async tbtc => {
        return await depositBenficiaries(tbtc, args[1])
      }
    }
    break
}

if (!action) {
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

    redeem
        Without a deposit address specified, looks up all deposits in the
        vending machine that are available for redemption and returns
        information about them.

    redeem <deposit-address> <redeemer-output-script>
	Attempts to redeem a tBTC deposit, passing the Bitcoin to the given
        redeeemer-output-script.

    liquidate <deposit-address> [--for <funding-timeout|undercollateralization|courtesy-timeout|redemption-timeout>]
	Attempts to liquidate a tBTC deposit, reporting back the status of
        the liquidation (\`liquidated\`, \`in-auction\`, or \`failed\`). Looks for
        any available reason to liquidate.

        --for <funding-timeout|undercollateralization|courtesy-timeout|redemption-timeout>
            If specified, only triggers liquidation for the specified reason.
            If the reason does not apply, reports \`not-applicable\` status.

    withdraw <deposit-address> [--dry-run]
        Attempts to withdraw the current account's allowance from a tBTC deposit.
        Only the amount allowed for the current account is withdrawn. Reports
        the withdrawn amount in wei.

        --dry-run
            Reports the amount that would be withdrawn in wei, but does not
            broadcast the transaction to withdraw it.
    `)

  process.exit(1)
}

async function runAction() {
  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: "main",
    electrum: {
      testnet: {
        server: "electrumx-server.tbtc.network",
        port: 50002,
        protocol: "ssl"
      },
      testnetPublic: {
        server: "testnet1.bauerj.eu",
        port: 50002,
        protocol: "ssl"
      },
      testnetWS: {
        server: "electrumx-server.tbtc.network",
        port: 8443,
        protocol: "wss"
      }
    }
  })

  return action(tbtc)
}

runAction()
  .then(result => {
    console.log(result)

    process.exit(0)
  })
  .catch(error => {
    console.error("Action errored out with error:", error)

    process.exit(1)
  })

async function createDeposit(tbtc, satoshiLotSize, mintOnActive) {
  const deposit = await tbtc.Deposit.withSatoshiLotSize(satoshiLotSize)

  return runDeposit(deposit, mintOnActive)
}

async function resumeDeposit(tbtc, depositAddress, mintOnActive) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)

  const existingRedemptionDetails = await deposit.getLatestRedemptionDetails()
  console.log(existingRedemptionDetails)
  if (existingRedemptionDetails) {
    return redeemDeposit(tbtc, deposit, existingRedemptionDetails)
  } else {
    return runDeposit(deposit, mintOnActive)
  }
}

async function redeemDeposit(tbtc, depositAddress, redeemerAddress) {
  return new Promise(async (resolve, reject) => {
    try {
      let redemption
      if (typeof depositAddress == "string") {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        redemption = await deposit.requestRedemption(redeemerAddress)
      } else {
        redemption = new Redemption(depositAddress, redeemerAddress)
      }

      redemption.onWithdrawn(transactionID => {
        console.log()

        resolve(
          `Redeemed deposit ${depositAddress} with Bitcoin transaction ` +
            `${transactionID}.`
        )
      })

      await redemption.autoSubmit()
    } catch (err) {
      reject(err)
    }
  })
}

async function availableRedemptions(tbtc) {
  return new Promise(async (resolve, reject) => {
    try {
      const vmAddress = tbtc.Deposit.vendingMachineContract.options.address
      const vmDepositTokens = (await EthereumHelpers.getExistingEvents(
        tbtc.Deposit.depositTokenContract,
        "Transfer",
        { to: vmAddress }
      )).map(_ => _.returnValues.tokenId)

      const stillInVm =
        (await Promise.all(vmDepositTokens.map(tokenId =>
          tbtc.Deposit.depositTokenContract.methods.ownerOf(tokenId)
            .call().then(_ => [tokenId, _ == vmAddress])
        ))).filter(([tokenId, ownedByVm]) => ownedByVm).map(([tokenId,]) => tokenId)

      const deposits =
        await Promise.all(stillInVm.map(_ => tbtc.Deposit.withTdtId(_)))

      const depositInfo =
        await Promise.all(deposits.map(async _ => {
          const state = await _.getCurrentState()
          const stateName = Object.entries(tbtc.Deposit.State).filter(([,_]) => _ == state)[0][0]
          return [_.address, stateName, await _.getSatoshiLotSize()].join(" ")
        }))

      resolve(depositInfo.join("\n"))
    } catch (err) {
      reject(err)
    }
  })
}

async function liquidateDeposit(tbtc, depositAddress) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)

  return await deposit.contract.methods.notifySignatureTimeout().send()
}

async function withdrawFromDeposit(tbtc, depositAddress) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)

  return await deposit.contract.methods.withdrawFunds().send()
}

async function depositBenficiaries(tbtc, depositAddress) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)

  return await deposit.keepContract.methods.returnPartialSignerBonds().send({ value: bnOrNull("71029453546650000") })
}

async function runDeposit(deposit, mintOnActive) {
  deposit.autoSubmit()

  return new Promise(async (resolve, reject) => {
    deposit.onBitcoinAddressAvailable(async address => {
      try {
        const lotSize = await deposit.getSatoshiLotSize()
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

          resolve(tbtc)
        } else {
          resolve("Deposit is active. Minting disabled by parameter.")
        }
      } catch (err) {
        reject(err)
      }
    })
  })
}

function bnOrNull(str) {
  try {
    return web3.utils.toBN(str)
  } catch (_) {
    return null
  }
}
