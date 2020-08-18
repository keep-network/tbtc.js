import Web3 from "web3"
import TBTC from "../index.js"

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

  // @ts-ignore Web3's provider interface seems to be inaccurate with respect to
  // what actually works, since ProviderEngine works just fine here.
  const web3 = new Web3(engine)
  engine.start()

  web3.eth.defaultAccount = (await web3.eth.getAccounts())[0]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: "simnet",
    electrum: {
      server: "127.0.0.1",
      port: 50003,
      protocol: "ws"
    }
  })

  const deposit = await tbtc.Deposit.withAddress(
    "0xC309D0C7DC827ea92e956324F1e540eeA6e1AEaa"
  )
  const redemption = await deposit.requestRedemption(
    "SZt6evokJ6FSJMgx43L1uosoQpesh7DBjE"
  )
  // const redemption = await deposit.getCurrentRedemption()
  redemption.autoSubmit()

  await new Promise(resolve => {
    redemption.onWithdrawn(transactionID => {
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
  .catch(error => {
    console.error("Boom boom time", error)
    process.exit(1)
  })
