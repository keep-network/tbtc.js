import Web3 from 'web3';
import TBTC from './src/TBTC.js';

import HDWalletProvider from '@truffle/hdwallet-provider'
const mnemonic = "egg dune news grocery detail frog kiwi hidden tuna noble speak over"

const provider = new HDWalletProvider(
    mnemonic,
    "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5",
)

const depositAddress = "0xb35671830Ee9E6651D1486b32279FB144D449c94"

async function runExample() {
    const web3 = new Web3(provider)
    web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

    const tbtc = TBTC.configure({
        web3: web3,
        bitcoinNetwork: "testnet",
    })

    const DepositFactory = await tbtc.DepositFactory

    const deposit = await DepositFactory.withAddress(depositAddress)
    // console.log("Minted!", await deposit.qualifyAndMintTBTC())
    console.log("Minted!", await deposit.mintTBTC())
    // console.log("Redemption!", (await deposit.getRedemptionCost()).toString())
    // console.log("Redemption!", (await deposit.getRedemptionCost()).toString())
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

    // return await new Promise((resolve, reject) => {
    //     console.log("Waiting for active deposit...")
    //     try {
    //         deposit.onActive(async () => {
    //             console.log("Wrapped it, let's go...")
    //             await deposit.mintTBTC()
    //             resolve()
    //             // or
    //             // (await deposit.getTDT()).transfer(someLuckyContract)

    //             // later…

    //             //   (await deposit.requestRedemption("tb....")).autoSubmit()
    //             //     .onWithdrawn((txHash) => {
    //             //       // all done!
    //             //     })
    //         })
    //     } catch (error) {
    //         reject(error)
    //     }
    // })
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
