import Web3 from 'web3';
import TBTC from './src/TBTC.js';

const provider = new Web3(
    new Web3.providers.HttpProvider(
        "https://ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5",
        0,
        ":e18ef5ef295944928dd87411bc678f19",
    )
);

const web3 = new Web3(provider)

async function booyan() {
const tbtc = TBTC.configure({
    web3: new Web3(provider),
    bitcoinNetwork: "testnet",
})

const DepositFactory = await tbtc.DepositFactory
const lotSizes = await DepositFactory.availableSatoshiLotSizes()
console.log("available", lotSizes.map(_ => _.toString()))

const deposit = await DepositFactory.withSatoshiLotSize(lotSizes[0])
console.log("deposit", deposit)
}

booyan()
    .then(() => console.log("SHAMAN"))
    .catch((error) => {
        console.log("Boom boom time", error)
    })
