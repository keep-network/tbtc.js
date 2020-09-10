import { BitcoinSPV } from "../src/lib/BitcoinSPV.js"
import ElectrumClient from "../src/lib/ElectrumClient.js"
import fs from "fs"
import chai from "chai"

const txData = fs.readFileSync("./test/data/tx.json", "utf8")
const tx = JSON.parse(txData)
const electrumClient = new ElectrumClient({
  server: "electrumx-server.test.tbtc.network",
  port: 8443,
  protocol: "wss"
})
const bitcoinSPV = new BitcoinSPV(electrumClient)

describe("BitcoinSPV", async () => {
  before(async () => {
    await electrumClient.connect()
  })

  after(async () => {
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

    chai.assert.deepEqual(result, expectedResult)
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

    chai.assert.isTrue(result)
  })
})
