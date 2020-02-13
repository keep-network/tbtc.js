import Web3 from 'web3';
import TBTC from './src/TBTC.js';

import HDWalletProvider from '@truffle/hdwallet-provider'
const mnemonic = "egg dune news grocery detail frog kiwi hidden tuna noble speak over"

const provider = new HDWalletProvider(
    mnemonic,
    "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5",
)

async function runExample() {
    const web3 = new Web3(provider)
    web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

    const tbtc = TBTC.configure({
        web3: web3,
        bitcoinNetwork: "testnet",
    })

    const DepositFactory = await tbtc.DepositFactory
    const lotSizes = await DepositFactory.availableSatoshiLotSizes()

    console.log("Initiating deposit...")
    const deposit = await DepositFactory.withSatoshiLotSize(lotSizes[0])
    deposit.onBitcoinAddressAvailable(async (address, cancelAutoMonitor) => {
        const lotSize = await deposit.getSatoshiLotSize()
        console.log(
            "\tGot deposit address:", address,
            "; fund with:", lotSize.toString(), "satoshis please.",
        )
        console.log("Now monitoring for deposit transaction...")

        // call cancelAutoMonitor to manage your own BTC lifecycle if preferred
    })

    return await new Promise((resolve, reject) => {
        console.log("Waiting for active deposit...")
        try {
            deposit.onActive(async () => {
                try {
                    console.log("Deposit is active, minting...")
                    const tbtc = await deposit.mintTBTC()
                    console.log(`Minted ${tbtc} TBTC!`)
                    // or
                    // (await deposit.getTDT()).transfer(someLuckyContract)

                    console.log("You have 10s before I redeem this sucker...")

                    // later…
                    setTimeout(async () => {
                        console.log("Redeeming deposit :sunglasses:")
                        (await deposit.requestRedemption("tb....")).autoSubmit()
                            .onWithdrawn((txHash) => {
                            // all done!
                            })
                    }, 10000)
                } catch (error) {
                    reject(error)
                }
            })
        } catch (error) {
            reject(error)
        }
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
