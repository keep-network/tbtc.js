import Web3 from 'web3';
import TBTC from './src/TBTC.js';

import HDWalletProvider from '@truffle/hdwallet-provider'
const mnemonic = "egg dune news grocery detail frog kiwi hidden tuna noble speak over"

const provider = new HDWalletProvider(
    mnemonic,
    "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5",
)

const depositAddress = "0xb35671830Ee9E6651D1486b32279FB144D449c94"
// const depositAddress = "0x89A2FBB780BFEa3aC4bC4Fed2b6147dEeB66BD58"
const redeemerAddress = "tb1qdajvg4waymq604gpfvjdvpxyd2hc4yd3u4lse5"

async function runExample() {
    const web3 = new Web3(provider)
    web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

    const tbtc = TBTC.configure({
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

    const DepositFactory = await tbtc.DepositFactory

    const deposit = await DepositFactory.withAddress(depositAddress)
    // deposit.autoSubmit()
    // return await new Promise((resolve) => {
    //     deposit.onActive(async () => {
    //         await deposit.mintTBTC()
    //         resolve()
    //     })
    // })
    // console.log("Minted!", await deposit.qualifyAndMintTBTC())
    // console.log("Minted!", await deposit.mintTBTC())
    // console.log("Redemption!", (await deposit.getRedemptionCost()).toString())
    // console.log("Redemption!", (await deposit.getRedemptionCost()).toString())
    // console.log("Redemption!", await (await deposit.requestRedemption(redeemerAddress)).signedTransaction)
    // const lotSizes = await DepositFactory.availableSatoshiLotSizes()

    // console.log("Initiating deposit...")
    // const deposit = await DepositFactory.withSatoshiLotSize(lotSizes[0])
    // deposit.onBitcoinAddressAvailable(async (address, cancelAutoMonitor) => {
    //     const lotSize = await deposit.getSatoshiLotSize()
    //     console.log(
    //         "\tGot deposit address:", address,
    //         "; fund with:", lotSize.toString(), "satoshis please.",
    //     )
    //     console.log("Now monitoring for deposit transaction...")

    //     // call cancelAutoMonitor to manage your own BTC lifecycle if preferred
    // })

    return await new Promise(async (resolve) => {
        console.log("Redemption!")
        
        const redemption = await deposit.getCurrentRedemption(redeemerAddress)
        redemption.autoSubmit()
        redemption.onWithdrawn((transactionID) => {
            console.log(
                `Redeemed deposit ${deposit.address} with Bitcoin transaction ` +
                `${transactionID}.`
            )

            resolve()
        })
    })
}

runExample()
    .then(() => {
        console.log("All done!")
        process.exit(0)
    })
    .catch((error) => {
        console.error("Boom boom time", error)
        process.exit(1)
    })
