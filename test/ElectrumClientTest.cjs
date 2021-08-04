/*
const ElectrumClient = require("../src/ElectrumClient")
const fs = require("fs")
const chai = require("chai")
const assert = chai.assert
const config = require("../../../src/config/config.json")

describe("ElectrumClient", async () => {
  let client
  let tx

  before(async () => {
    const txData = fs.readFileSync("./test/data/tx.json", "utf8")
    tx = JSON.parse(txData)

    client = new ElectrumClient.Client(config.electrum.testnetPublic)

    await client.connect()
  })

  after(async () => {
    await client.close()
  })

  it("getTransaction", async () => {
    const expectedTx = tx.hex
    const result = await client.getTransaction(tx.hash)

    assert.equal(result.hex, expectedTx, "unexpected result")
  })

  it("getUnspentToScript", async () => {
    const script = "00144b47c798d12edd17dfb4ea98e5447926f664731c"

    const result = await client.getUnspentToScript(script)
    const expectedResult = [
      {
        tx_hash:
          "72e7fd57c2adb1ed2305c4247486ff79aec363296f02ec65be141904f80d214e",
        tx_pos: 0,
        height: 1569342,
        value: 101
      }
    ]

    assert.deepEqual(result, expectedResult)
  })

  it("getMerkleProof", async () => {
    const expectedResult = tx.merkleProof
    const expectedPosition = tx.indexInBlock
    const result = await client.getMerkleProof(tx.hash, tx.blockHeight)

    assert.equal(result.proof, expectedResult, "unexpected result")

    assert.equal(result.position, expectedPosition, "unexpected result")
  })

  it("getHeadersChain", async () => {
    const confirmations = tx.chainHeadersNumber
    const expectedResult = tx.chainHeaders
    const result = await client.getHeadersChain(tx.blockHeight, confirmations)

    assert.equal(result, expectedResult, "unexpected result")
  })

  describe("findOutputForAddress", async () => {
    it("finds first element", async () => {
      const address = "tb1qfdru0xx39mw30ha5a2vw23reymmxgucujfnc7l"
      const expectedResult = 0

      const result = await client.findOutputForAddress(tx.hash, address)

      assert.equal(result, expectedResult)
    })

    it("finds second element", async () => {
      const address = "tb1q78ezl08lyhuazzfz592sstenmegdns7durc4cl"
      const expectedResult = 1

      const result = await client.findOutputForAddress(tx.hash, address)

      assert.equal(result, expectedResult)
    })

    it("fails for missing address", async () => {
      const address = "NOT_EXISTING_ADDRESS"

      await client.findOutputForAddress(tx.hash, address).then(
        value => {
          // onFulfilled
          assert.fail("not failed as expected")
        },
        reason => {
          // onRejected
          assert.include(
            reason.toString(),
            `output for address ${address} not found`
          )
        }
      )
    })
  })

  describe("onTransactionToScript", async () => {
    it("subscribe for script hash when transaction already exists", async () => {
      const script = "00144b47c798d12edd17dfb4ea98e5447926f664731c"
      const expectedResult = {
        status:
          "379579d1c5091db8501892e300a02cd7ed441efed82d97bab110d6de2c095ac5",
        msg: "returned from callback"
      }

      const callback = async function(status) {
        return { status: status, msg: "returned from callback" }
      }

      const result = await client.onTransactionToScript(script, callback)

      assert.deepEqual(result, expectedResult)
    })

    it("subscribe for script hash when transaction does not exist", async () => {
      const script = "00144b47c798d12edd17dfb4ea98e5447926f664731d"
      const expectedMsg = "returned from callback"
      const expectedResult = {
        status: null,
        msg: expectedMsg
      }
      const callback = async function(status) {
        return { status: status, msg: expectedMsg }
      }

      const result = await client.onTransactionToScript(script, callback)

      assert.deepEqual(result, expectedResult)
    })

    it("subscribe for new script and wait for notification", async () => {
      const script1 = "00144b47c798d12edd17dfb4ea98e5447926f664731c"
      const initialStatus =
        "379579d1c5091db8501892e300a02cd7ed441efed82d97bab110d6de2c095ac5"
      const expectedStatus = "expected_status"
      const expectedMsg = "returned from callback"

      const expectedResult = {
        status: expectedStatus,
        msg: expectedMsg
      }

      const callback = async function(status) {
        if (status != initialStatus) {
          return { status: status, msg: expectedMsg }
        }
        return null
      }

      // Simulate events emitted by a server. First event for script which is
      // not the one we subscribed for, second event with a script we subscribed
      // for.
      const mockEventEmission = function() {
        client.electrumClient.subscribe.emit(
          "blockchain.scripthash.subscribe",
          [ElectrumClient.scriptToHash(script1), expectedStatus]
        )
      }

      const result = client.onTransactionToScript(script1, callback)

      // Give it some time to register a listener.
      setTimeout(mockEventEmission, 1000)

      assert.deepEqual(await result, expectedResult)
    })

    it("subscribe for new script and wait for notification", async () => {
      const script1 = "00144b47c798d12edd17dfb4ea98e5447926f664731d"
      const script2 = "00144b47c798d12edd17dfb4ea98e5447926f664731e"

      const expectedStatus = "status_for_expected_script"
      const unexpectedStatus = "status_for_unexpected_script"

      const callback = async function(status) {
        if (status != null) {
          return status
        }
        return null
      }

      // Simulate events emitted by a server. First event for script which is
      // not the one we subscribed for, second event with a script we subscribed
      // for.
      const mockEventsEmission = function() {
        client.electrumClient.subscribe.emit(
          "blockchain.scripthash.subscribe",
          [ElectrumClient.scriptToHash(script2), unexpectedStatus]
        )

        client.electrumClient.subscribe.emit(
          "blockchain.scripthash.subscribe",
          [ElectrumClient.scriptToHash(script1), expectedStatus]
        )
      }

      const result = client.onTransactionToScript(script1, callback)

      // Give it some time to register a listener.
      setTimeout(mockEventsEmission, 500)

      assert.equal(await result, expectedStatus)
    })
  })

  describe("onNewBlock", async () => {
    it("get transaction which already exists", async () => {
      const requiredConfirmations = 1
      const txHash = tx.hash

      const callback = async function() {
        // Get current state of the transaction.
        const tx = await client.getTransaction(txHash)

        // Check if transaction has already enough number of confirmations.
        if (tx.confirmations >= requiredConfirmations) {
          return tx.txid
        }
      }

      const result = await client.onNewBlock(callback)

      console.log("result", result)
    })

    it("get transaction which does not exist", async () => {
      const txHash =
        "02437d2f0fedd7cb11766dc6aefbc1dc8c171ef2daebddb02a32349318cc6289"

      const callback = async function() {
        // Get current state of the transaction.
        await client.getTransaction(txHash)
      }

      const result = await client.onNewBlock(callback).then(
        value => {
          // onFulfilled
          assert.fail("not failed as expected")
        },
        reason => {
          // onRejected
          assert.include(
            reason.toString(),
            "No such mempool or blockchain transaction"
          )
        }
      )

      console.log("result", result)
    })

    // This test cannot be executed as part of CI. It takes too long to wait
    // for confirmations. Use this for manual testing.
    // TODO: Make it possible with electrum server mock.
    it.skip("wait for three more confirmations", async () => {
      const txHash = tx.hash

      const currentTx = await client.getTransaction(txHash)

      const requiredConfirmations = currentTx.confirmations + 3

      const callback = async function() {
        // Get current state of the transaction.
        const tx = await client.getTransaction(txHash)

        // Check if transaction has already enough number of confirmations.

        console.log("current confirmations:", tx.confirmations)
        if (tx.confirmations >= requiredConfirmations) {
          return tx.txid
        }
      }

      const result = await client.onNewBlock(callback)

      console.log("result", result)
    })
  })
})*/
