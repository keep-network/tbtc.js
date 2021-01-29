#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
// ////
// bin/copied-stake-status.js
//
//   Iterates through known eligible addresses for stake copying and reports
//   their status in CSV format. The resulting CSV has 7 fields:
//    - operator is the operator address for which stake was copied.
//    - owner is the owner address of the operator.
//    - oldAmount is the amount staked on the old staking contract at the time
//      the script was run. 0 if the stake was undelegated and recovered.
//    - amountCopied is the amount copied to the new staking contract; this
//      should be 0 if stake copying was not used, and equal to oldAmount
//      otherwise.
//    - availableBalance is the current liquid KEEP token balance for the owner
//      account.
//    - paidBack is true if the copied stake was paid back, false otherwise.
//    - oldUndelegatedAt is 0 if the old staking contract's stake was never
//      undelegated, and a block timestamp if the stake was undelegated.
// ////
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
/** @typedef { import('../src/EthereumHelpers.js').TruffleArtifact } TruffleArtifact */

import OldTokenStakingJSON from "@keep-network/keep-core/artifacts/OldTokenStaking.json"
import KeepTokenJSON from "@keep-network/keep-core/artifacts/KeepToken.json"
import StakingPortBackerJSON from "@keep-network/keep-core/artifacts/StakingPortBacker.json"

import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"
import { EthereumHelpers } from "../index.js"

let args = process.argv.slice(2)
if (process.argv[0].includes("refunds.js")) {
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
  found: { mnemonic, /* account,*/ rpc }
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
      rpc ||
      "wss://eth-mainnet.ws.alchemyapi.io/v2/I621JkcPPi7YegYM1hMK89847QX_k9u1",
    debug,
    origin: undefined
  })
)

const web3 = new Web3(engine)
engine.start()

const allowedCopyOperators = [
  "0x835b94982fea704ee3e3a49527aa565571fe790b",
  "0xa31ac31bcd31302f2c7938718e3e3c678dcdc8e6",
  "0x518d9df0704693a51adf2b205e35f9f7cbd87d99",
  "0x85e198b8d4d6d785cd75201425bc2ec9815e2c91",
  "0x284c6571cf35b5879a247922e216ef495441ada7",
  "0x9c49073f0cca880c11db730fefeb54559ef8b378",
  "0x25e458d05253a8e69332a2cc79e6ee06fb8e7743",
  "0xf26d8407970ca01b44437d95ce750061b23a4df4",
  "0x49674ceb89cd175263106670a894c373cc286a28",
  "0x0d0271d1b2906cc472a8e75148937967be788f09",
  "0x93a30cc97cebc14576eac6e14e1a5343a5c6022a",
  "0xf6f4e1e6127f369d74ecce6523c59c75d24ce45c",
  "0x9c2e1dbf17032134145c7ad6d15d604b660034d8",
  "0x8c63b12babeff8758c5aa18629ba2d19ed6a0a58",
  "0x76ca4b2300a2abe46dcd736f71a207ffbcb3c5e8",
  "0xf25796d81d6caaca3616ce17ecc94966821d4f1d",
  "0x07c9a8f8264221906b7b8958951ce4753d39628b",
  "0x03ab65648d9f75da043581efdc8332aede07d70f",
  "0x81e1b56db174a935fe81e4b9839d6d92528090f4",
  "0x00cef852246b08b9215772c3f409d28408bb21bd",
  "0xc2243c8550d03cc112110b940ed8a4b6c42ecc3c",
  "0xe5c8dcd32cabdf97c48853ee14e63487fe15a907",
  "0xa4166c3e14cbdd6d4494945a99616f1c73ad9699",
  "0xaea619d02dcf7299fb24db2f60a08bfc8fb2dbcf",
  "0xca70fea021359778daec479b97d0cd2efe1ad099",
  "0x3712c6fed51ceca83ca953f6ff3458f2339436b4",
  "0x438decafa74cd174ebf71c6b4bd715d001f6fab7",
  "0xb822ec4fabf37b881397bd3425152adbfe516174",
  "0x590204f050a12e61ed5f58188ddeb86c49ee270d",
  "0xdcd4199e22d09248ca2583cbdd2759b2acd22381",
  "0x6757b362bfa1dde1ece9693ec0a6527909e318b7",
  "0xfc97a906c715587b56c2c65a07ce731ba80339de",
  "0xa543441313f7fa7f9215b84854e6dc8386b93383",
  "0x36c56a69c2aea23879b59db0e99d57ef2ff77f06",
  "0x8ba4359ee951944847abf81cda84697c40fab617",
  "0xfbd33b871c6e6e11f9d6a62dfc780ce4bea1ce17",
  "0x7bda94202049858060e4dffa42ecb00c58d12452",
  "0xc010b84528b0809295fcd21cb37415e8c532343a",
  "0x1c51adbf71525002f42abc6e859413a3fc163c4c",
  "0x1e5801db6779b44a90104ae856602424d8853807",
  "0x7e6332d18719a5463d3867a1a892359509589a3d",
  "0x3e5d36bf359698bc53bdaf8bc97de56263fa0a70",
  "0xe81c50802bf9ddf190ce493a6a76cf3d36dd8793",
  "0xdd704c0bc9a5815ff8c7714eaa96b52914c920d1",
  "0xe48495557a31b04693142e33b7a05073ea03b767"
]

run(async () => {
  // Force the poor Web3 provider to initialize before we hit it with the lookup
  // hammer.
  await web3.eth.getBlockNumber()

  const spbContract = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (StakingPortBackerJSON),
    web3,
    "1"
  )
  const otsContract = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (OldTokenStakingJSON),
    web3,
    "1"
  )
  const tokenContract = await EthereumHelpers.getDeployedContract(
    /** @type {TruffleArtifact} */ (KeepTokenJSON),
    web3,
    "1"
  )

  return (
    "operator,owner,oldAmount,amountCopied,availableBalance,paidBack,oldUndelegatedAt" +
    (await allowedCopyOperators.reduce(async (soFar, operatorAddress) => {
      // Don't smash the poor provider with parallel hits for all operators;
      // instead, serialize the process.
      const already = await soFar
      const stakingInfo = await otsContract.methods
        .getDelegationInfo(operatorAddress)
        .call()
      const copyInfo = await spbContract.methods
        .copiedStakes(operatorAddress)
        .call()
      const ownerBalance = await tokenContract.methods
        .balanceOf(copyInfo.owner)
        .call()

      return (
        already +
        "\n" +
        operatorAddress +
        "," +
        copyInfo.owner +
        "," +
        stakingInfo.amount +
        "," +
        copyInfo.amount +
        "," +
        ownerBalance +
        "," +
        copyInfo.paidBack +
        "," +
        stakingInfo.undelegatedAt
      )
    }, Promise.resolve("")))
  )
})

/**
 * @param {function():Promise<string?>} action Command action that will yield a
 *        promise to the desired CLI output or error out by failing the promise.
 *        A null or undefined output means no output should be emitted, but the
 *        command should exit successfully.
 */
function run(action) {
  action()
    .catch(error => {
      console.error("Got error", error)
      process.exit(2)
    })
    .then((/** @type {string} */ result) => {
      if (result) {
        console.log(result)
      }
      process.exit(0)
    })
}
