#!/usr/bin/env node --experimental-modules
import Web3 from 'web3';

import TBTC from '@keep-network/tbtc.js'

import HDWalletProvider from '@truffle/hdwallet-provider'
const mnemonic = "egg dune news grocery detail frog kiwi hidden tuna noble speak over"

// -------------------------------- SETUP --------------------------------------
const provider = new HDWalletProvider(
    mnemonic,
    "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5",
)
const web3 = new Web3(provider)

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc.js")) {
    args = process.argv.slice(1) // invoked directly, no node
}
let action = null

switch(args[0]) {
    case "deposit":
        if (args.length == 2 && bnOrNull(args[1])) {
            let mint = true
            if (args.length == 3 && args[2] == "--no-mint") {
                mint = false
            }
            action = async (tbtc) => {
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
            action = async (tbtc) => { return await resumeDeposit(tbtc, args[1], mint) }
        }
        break
    case "redeem":
        if (args.length == 3 && web3.utils.isAddress(args[1])) {
            action = async (tbtc) => { return await redeemDeposit(tbtc, args[1], args[2]) }
        }
        break
}

if (! action) {
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

async function runAction() {
    web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

    const tbtc = await TBTC.withConfig({
        web3: web3,
        bitcoinNetwork: "testnet",
        electrum: {
            "testnet": {
                "server": "electrumx-server.test.tbtc.network",
                "port": 50002,
                "protocol": "ssl"
            },
            "testnetPublic": {
                "server": "testnet1.bauerj.eu",
                "port": 50002,
                "protocol": "ssl"
            },
            "testnetWS": {
                "server": "electrumx-server.test.tbtc.network",
                "port": 50003,
                "protocol": "ws"
            }
        },
    })

    return action(tbtc)
}

runAction()
    .then((result) => {
        console.log("Action completed with final result:", result)

        process.exit(0)
    })
    .catch((error) => {
        console.error("Action errored out with error:", error)

        process.exit(1)
    })

async function createDeposit(tbtc, satoshiLotSize, mintOnActive) {
    const deposit = await tbtc.Deposit.withSatoshiLotSize(satoshiLotSize)

    return runDeposit(deposit, mintOnActive)
}

async function resumeDeposit(tbtc, depositAddress, mintOnActive) {
    const deposit = await tbtc.Deposit.withAddress(depositAddress)

    return runDeposit(deposit, mintOnActive)
}

async function redeemDeposit(tbtc, depositAddress, redeemerAddress) {
    return new Promise(async (resolve, reject) => {
        try {
            const deposit = await tbtc.Deposit.withAddress(depositAddress)
            const redemption = await deposit.requestRedemption(redeemerAddress)
            redemption.autoSubmit()

            redemption.onWithdrawn((transactionID) => {
                console.log(
                )

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

async function runDeposit(deposit, mintOnActive) {
    deposit.autoSubmit()

    return new Promise(async (resolve, reject) => {
        deposit.onBitcoinAddressAvailable(async (address) => {
            try {
                const lotSize = await deposit.getSatoshiLotSize()
                console.log(
                    "\tGot deposit address:", address,
                    "; fund with:", lotSize.toString(), "satoshis please.",
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
