import { BitcoinSPV } from "../src/lib/BitcoinSPV.js"
import ElectrumClient from "../src/lib/ElectrumClient.js"
import { electrumConfig } from "./config/network.js"
import { readFileSync } from "fs"
import { assert } from "chai"

describe("BitcoinSPV", async () => {
  let tx
  let electrumClient
  let bitcoinSPV

  before(async () => {
    const txData = readFileSync("./test/data/tx.json", "utf8")
    tx = JSON.parse(txData)
    electrumClient = new ElectrumClient(electrumConfig["testnet"])
    bitcoinSPV = new BitcoinSPV(electrumClient)
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

  it("getMerkleProofInfo", async () => {
    const expectedResult = tx.merkleProof
    const expectedPosition = tx.indexInBlock
    const result = await bitcoinSPV.getMerkleProofInfo(tx.hash, tx.blockHeight)

    assert.equal(result.proof, expectedResult, "unexpected result")

    assert.equal(result.position, expectedPosition, "unexpected result")
  })
})
