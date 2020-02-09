const secp256k1 = require('bcrypto/lib/secp256k1')
const KeyRing = require('bcoin/lib/primitives').KeyRing
const Script = require('bcoin/lib/script').Script

/**
 * Network type enumeration.
 */
const Network = Object.freeze({ 'mainnet': 1, 'testnet': 2 })

/**
 * Converts public key to bitcoin Witness Public Key Hash Address according to
 * [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki).
 * @param {string} publicKey Public key as a hexadecimal representation of
 * 64-byte concatenation of x and y coordinates.
 * @param {Network} network Network for which address has to be calculated.
 * @return {string} Bitcoin's P2WPKH address for given network.
 */
function publicKeyToP2WPKHaddress(publicKey, network) {
  // Witness program requires usage of compressed public keys.
  const compress = true

  const publicKeyBytes = Buffer.from(publicKey, 'hex')
  const publicKeyBCOIN = secp256k1.publicKeyImport(publicKeyBytes, compress)

  const keyRing = KeyRing.fromKey(publicKeyBCOIN, compress)

  const p2wpkhScript = Script.fromProgram(0, keyRing.getKeyHash())

  const address = p2wpkhScript.getAddress()

  // Serialize address to a format specific to given network.
  return address.toString(networkToBCOINvalue(network))
}

/**
 * Converts bitcoin address to a script (ScriptPubKey).
 * @param {string} address Bitcoin address.
 * @return {string} Script.
 */
function addressToScript(address) {
  return Script.fromAddress(address).toRaw().toString('hex')
}


/**
 * Converts network type from enumeration to a respective value used in `bcoin`
 * library.
 * @param {Network} network Network value from `Network` enumeration.
 * @return {string} Network type used in `bcoin` library.
 */
function networkToBCOINvalue(network) {
  switch (network) {
  case Network.mainnet:
    return 'main'
  case Network.testnet:
    return 'testnet'
  default:
    throw new Error(
      `unsupported network [${networkType}], use one of: [${Object.keys(network)
        .map((key) => {
          return 'Network.' + key
        })}]`
    )
  }
}

module.exports = {
  Network, publicKeyToP2WPKHaddress, addressToScript,
}
