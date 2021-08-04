import { BitcoinSPV } from "../src/lib/BitcoinSPV.js"
import Client from "../src/lib/ElectrumClient.js"
import { readFileSync } from "fs"

import chai from "chai"
const { assert } = chai

describe("BitcoinSPV", async () => {
  let tx
  let electrumClient
  let bitcoinSPV

  before(async () => {
    const txData = readFileSync("./test/data/tx.json", "utf8")
    tx = JSON.parse(txData)

    // TODO: Use config from a config file
    const config = {
      server: "electrumx-server.test.tbtc.network",
      port: 8443,
      protocol: "wss"
    }
    electrumClient = new Client(config)

    bitcoinSPV = new BitcoinSPV(electrumClient)
    await electrumClient.connect()
  })

  after(async () => {
    console.log("Closing")
    await electrumClient.close()
  })

  it("getTransactionProof", async () => {
    const expectedResult = {
      tx: tx.hex,
      merkleProof: tx.merkleProof,
      txInBlockIndex: tx.indexInBlock,
      chainHeaders: tx.chainHeaders
    }

    const result = await bitcoinSPV.getTransactionProof(
      tx.hash,
      tx.chainHeadersNumber
    )

    assert.deepEqual(result, expectedResult)
  })

  it("verifyMerkleProof", async () => {
    const proofHex = tx.merkleProof
    const index = tx.indexInBlock
    const txHash = tx.hash
    const blockHeight = tx.blockHeight
    const result = await bitcoinSPV.verifyMerkleProof(
      proofHex,
      txHash,
      index,
      blockHeight
    )

    assert.isTrue(result)
  })
})
