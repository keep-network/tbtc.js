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

    const deposit = await DepositFactory.withSatoshiLotSize(lotSizes[0])
    const fundingAddress = await deposit.getBitcoinAddress()
    console.log("deposit funding address:", fundingAddress)

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
