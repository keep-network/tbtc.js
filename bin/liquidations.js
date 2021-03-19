#!/usr/bin/env NODE_BACKEND=js node --experimental-modules --experimental-json-modules
// ////
// bin/liquidations.js [start-timestamp] [fields]
//  fields is comma-separated list of fields for the CSV, which can include:
//   - operator
//   - owner
//   - beneficiary
//   - keep
//  Order is taken into account, and a header row is emitted with the field
//  name.
// ////
import https from "https"
import moment from "moment"
import BitcoinHelpers, { BitcoinNetwork } from "../src/BitcoinHelpers.js"
import AvailableBitcoinConfigs from "./config.json"
import { findAndConsumeArgsExistence } from "./helpers.js"

let args = process.argv.slice(2)
if (process.argv[0].includes("liquidations.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}

// No debugging unless explicitly enabled.
const {
  found: { debug },
  remaining: remainingArgs
} = findAndConsumeArgsExistence(args, "--debug")
if (!debug) {
  console.debug = () => {}
}

const startDate = remainingArgs[0].match(/^[0-9]+$/)
  ? moment.unix(parseInt(remainingArgs[0]))
  : moment(remainingArgs[0])
if (!startDate.isValid()) {
  console.error(
    `Start time ${remainingArgs[0]} is either invalid or not recent enough.`
  )
  process.exit(1)
}

const validFields = ["operator", "owner", "beneficiary", "keep"]
const fields = (remainingArgs[1] || "operator,owner,beneficiary,keep")
  .toLowerCase()
  .split(",")
  .filter(_ => validFields.includes(_))

run(async () => {
  const liquidations = await queryLiquidations(startDate)

  const liquidationRows = liquidations.reduce(
    (
      rows,
      {
        deposit: {
          bondedECDSAKeep: { keepAddress, members }
        }
      }
    ) => {
      members.forEach(({ address, owner, beneficiary }) => {
        const asFields = /** @type {{ [field: string]: string }} */ ({
          operator: address,
          owner,
          beneficiary,
          keep: keepAddress
        })
        rows.push(fields.map(_ => asFields[_]))
      })
      return rows
    },
    /** @type {string[][]} */ ([])
  )

  BitcoinHelpers.electrumConfig = AvailableBitcoinConfigs["1"].electrum

  const misfunds = await queryMisfunds(startDate)
  const misfundRows = await BitcoinHelpers.withElectrumClient(async () =>
    misfunds.reduce(
      async (
        rowsPromise,
        { bondedECDSAKeep: { keepAddress, publicKey, members } }
      ) => {
        const rows = await rowsPromise
        const keepBtcAddress = BitcoinHelpers.Address.publicKeyToP2WPKHAddress(
          publicKey.replace(/^0x/, ""),
          BitcoinNetwork.MAINNET
        )
        const balance = await BitcoinHelpers.Transaction.getBalance(
          keepBtcAddress
        )

        if (balance > 0) {
          members.forEach(({ address, owner, beneficiary }) => {
            const asFields = /** @type {{ [field: string]: string }} */ ({
              operator: address,
              owner,
              beneficiary,
              keep: keepAddress
            })
            rows.push(fields.map(_ => asFields[_]))
          })
        }

        return rows
      },
      Promise.resolve(/** @type {string[][]} */ ([]))
    )
  )

  return [fields]
    .concat(liquidationRows)
    .concat(misfundRows)
    .map(_ => _.join(","))
    .join("\n")
})

/**
 * @param {function():Promise<string?>} action Command action that will yield a
 *        promise to the desired CLI output or error out by failing the promise.
 *        A null or undefined output means no output should be emitted, but the
 *        command should exit successfully.
 */
function run(action) {
  // Redirect all console logs to debug.
  const originalConsoleLog = console.log
  console.log = (...args) => console.debug(...args)

  action()
    .catch(error => {
      console.error("Got error", error)
      process.exit(2)
    })
    .then((/** @type {string} */ result) => {
      console.log = originalConsoleLog
      if (result) {
        console.log(result)
      }
      process.exit(0)
    })
}

/**
 * @typedef {{
 *     liquidationInitiated: number,
 *     deposit: {
 *       id: string,
 *       owner: string,
 *       bondedECDSAKeep: {
 *         keepAddress: string,
 *         members: [{
 *           address: string,
 *           owner: string,
 *           beneficiary: string
 *         }]
 *       }
 *     }
 *   }} DepositLiquidationInfo
 */

/**
 * @param {moment.Moment} startDate The start time as a Moment object.
 * @return {Promise<[DepositLiquidationInfo]>} The returned query results.
 */
async function queryLiquidations(startDate) {
  return (
    await queryGraph(`{
    depositLiquidations(
      first: 100,
      where: { liquidationInitiated_gt: ${startDate.unix()}, isLiquidated: true }
    ) {
      liquidationInitiated
      deposit {
        id
        owner
        bondedECDSAKeep {
          keepAddress
          members {
            address
            owner
            beneficiary
          }
        }
      }
    }
  }`)
  ).data.depositLiquidations
}

/**
 * @typedef {{
 *   id: string,
 *   owner: string,
 *   bondedECDSAKeep: {
 *     keepAddress: string,
 *     publicKey: string,
 *     members: [{
 *       address: string,
 *       owner: string,
 *       beneficiary: string
 *     }]
 *   }
 * }} DepositMisfundInfo
 */

/**
 * @param {moment.Moment} startDate The start time as a Moment object.
 * @return {Promise<[DepositMisfundInfo]>} The returned query results.
 */
async function queryMisfunds(startDate) {
  return (
    await queryGraph(`{
    deposits(
      first: 100,
      where: { failureReason: FUNDING_TIMEOUT, createdAt_gt: ${startDate.unix()} }
    ) {
        id
        owner
        bondedECDSAKeep {
          keepAddress
          publicKey
          members {
            address
            owner
            beneficiary
          }
        }
    }
  }`)
  ).data.deposits
}

/**
 * @param {string} graphql GraphQL query for the Keep subgraph.
 * @return {Promise<any>} Returned data as a parsed JSON object, or a failed
 *         promise if the request or the JSON conversion fails.
 */
function queryGraph(graphql) {
  return new Promise((resolve, reject) => {
    let responseContent = ""
    const request = https.request(
      "https://api.thegraph.com/subgraphs/name/miracle2k/all-the-keeps",
      { method: "POST" },
      response => {
        response.setEncoding("utf8")
        response.on("data", chunk => (responseContent += chunk))
        response.on("end", () => {
          if (
            response.statusCode &&
            (response.statusCode < 200 || response.statusCode >= 300)
          ) {
            reject(
              new Error(
                `Unexpected status: ${response.statusCode} ${response.statusMessage}`
              )
            )
          } else {
            try {
              resolve(JSON.parse(responseContent))
            } catch (error) {
              reject(
                new Error(
                  `Error parsing response: ${error}; response was: ${responseContent}`
                )
              )
            }
          }
        })
      }
    )

    request.write(
      JSON.stringify({
        query: graphql
      })
    )
    request.end()
  })
}
