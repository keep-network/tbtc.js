import TBTC, { getNetworkIdFromArtifact } from "./src/TBTC.js"
import BitcoinHelpers from "./src/BitcoinHelpers.js"
import EthereumHelpers from "./src/EthereumHelpers.js"
import { nameOfState } from "./src/Deposit.js"

export {
  BitcoinHelpers,
  EthereumHelpers,
  getNetworkIdFromArtifact,
  nameOfState
}

/** @typedef { import("./src/Deposit.js").default } Deposit */
/** @typedef { import("./src/Redemption.js").default } Redemption */
/** @typedef { import("./src/TBTC.js").TBTC } TBTC */

export default TBTC
