/*
const BitcoinAddress = require("../src/Address")
const Network = BitcoinAddress.Network

const chai = require("chai")
const assert = chai.assert

describe("BitcoinAddress", async () => {
  describe("publicKeyToP2WPKHaddress", async () => {
    // Concatenated `x` and `y` coordinates derived from a public key specified in
    // [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki):
    // 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    const publicKey =
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"

    it("calculates testnet address", async () => {
      const chainType = Network.testnet
      const expectedResult = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"

      const result = await BitcoinAddress.publicKeyToP2WPKHaddress(
        publicKey,
        chainType
      )

      assert.equal(result, expectedResult)
    })

    it("calculates mainnet address", async () => {
      const chainType = Network.mainnet
      const expectedResult = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"

      const result = await BitcoinAddress.publicKeyToP2WPKHaddress(
        publicKey,
        chainType
      )

      assert.equal(result, expectedResult)
    })
  })

  describe("addressToScript", async () => {
    it("converts string to script", async () => {
      const address = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
      const expectedResult = "0014751e76e8199196d454941c45d1b3a323f1433bd6"

      const result = await BitcoinAddress.addressToScript(address)

      assert.equal(result, expectedResult)
    })
  })
})*/
