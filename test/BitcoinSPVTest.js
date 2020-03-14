/*
const BitcoinSPV = require("../src/BitcoinSPV").BitcoinSPV
const ElectrumClient = require("../src/ElectrumClient")
const config = require("../../../src/config/config.json")

const fs = require("fs")
const chai = require("chai")
const assert = chai.assert

describe("BitcoinSPV", async () => {
  let tx
  let electrumClient
  let bitcoinSPV

  before(async () => {
    const txData = fs.readFileSync("./test/data/tx.json", "utf8")
    tx = JSON.parse(txData)

    electrumClient = new ElectrumClient.Client(config.electrum.testnetPublic)

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
})*/
