import Web3 from "web3"
import TBTC from "./src/TBTC.js"

import ProviderEngine from "web3-provider-engine"
import Subproviders from "@0x/subproviders"

async function runExample() {
  const engine = new ProviderEngine({ pollingInterval: 1000 })
  engine.addProvider(
    // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
    new Subproviders.PrivateKeyWalletSubprovider(
      "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990"
    )
  )
  engine.addProvider(
    new Subproviders.RPCSubprovider(
      "https://:e18ef5ef295944928dd87411bc678f19@ropsten.infura.io/v3/59fb36a36fa4474b890c13dd30038be5"
    )
  )
  const web3 = new Web3(engine)
  engine.start()

  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: "testnet",
    electrum: {
      testnet: {
        server: "electrumx-server.test.tbtc.network",
        port: 50002,
        protocol: "ssl"
      },
      testnetPublic: {
        server: "testnet1.bauerj.eu",
        port: 50002,
        protocol: "ssl"
      },
      testnetWS: {
        server: "electrumx-server.test.tbtc.network",
        port: 8443,
        protocol: "wss"
      }
    }
  })

  const lotSizes = await tbtc.Deposit.availableSatoshiLotSizes()

  console.log("Initiating deposit...")
  const deposit = await tbtc.Deposit.withSatoshiLotSize(lotSizes[0])
  deposit.autoSubmit()
  deposit.onBitcoinAddressAvailable(async address => {
    const lotSize = await deposit.getSatoshiLotSize()
    console.log(
      "\tGot deposit address:",
      address,
      "; fund with:",
      lotSize.toString(),
      "satoshis please."
    )
    console.log("Now monitoring for deposit transaction...")
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
  .catch(error => {
    console.error("Boom boom time", error)
    process.exit(1)
  })
