/** @typedef {import('../tbtc.js').CommandAction} CommandAction */
/** @typedef {import('../../src/TBTC.js').ElectrumConfig} ElectrumConfig */
/** @typedef {import('../../src/TBTC.js').Web3} Web3 */
/** @typedef {import('../../src/TBTC.js').TBTC} TBTCInstance */
/** @typedef {import('../../src/Deposit.js').default} Deposit */
/** @typedef {import('../../src/Deposit.js').RedemptionDetails} RedemptionDetails */
/** @typedef {import('bn.js')} BN */

import EthereumHelpers from "../../src/EthereumHelpers.js"
import Redemption from "../../src/Redemption.js"
import { DepositStates } from "../../src/Deposit.js"
import {
  findAndConsumeArgExistence,
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "../helpers.js"

export const depositCommandHelp = [
  `new [--no-mint] <lot-size-satoshis>
    Initiates a deposit funding flow. Takes the lot size in satoshis.
    Will prompt with a Bitcoin address when funding needs to be
    submitted. When the flow completes, outputs the deposit as a single
    tab-delimited line with the deposit address, current deposit state,
    the deposit lot size in satoshis, and, when applicable, the minted
    amount of TBTC.

    --no-mint
        Specifies not to mint TBTC once the deposit is qualified.`,
  `list [--vending-machine] [--address <address>]
    With no options, lists the deposits currently owned by the web3
    account address. Deposits are output as tab-delimited lines that
    include the deposit address, current deposit state, and deposit
    lot size in satoshis.

    --vending-machine
        Lists the deposits currently owned by the vending machine.

    --address <address>
        Lists the deposits currently owned by the specified address.`,
  `<address> [<resume|redeem|liquidate|withdraw>]
    Operations on a particular address. If no command is provided,
    outputs the deposit as a single tab-delimited line with the deposit
    address, current deposit state, and deposit lot size in satoshis.

    resume [--funding|--redemption] [--no-mint]
        Resumes a funding or redemption flow, depending on the deposit's
        current state. When the flow completes, outputs the deposit as a
        single tab-delimited line with the deposit address, current
        deposit state, and deposit lot size in satoshis.

        --funding
            Only resumes the funding flow and outputs the final deposit
            state; if the deposit is not mid-funding, does not resume and
            outputs an error.

            --no-mint
                When resuming a funding flow, if the deposit is not already
                mid-minting, specifies not to mint TBTC once the deposit is
                qualified.

        --redemption
            Only resumes a flow if it is a redemption flow and outputs
            the final deposit state; if the deposit is not mid-redemption,
            does not resume and outputs an error.

    increase-redemption-fee
        Increases the fee by the predetermined fee increment on the given
        deposit. The deposit must already be in redemption, and must have
        remained without a fee bump for 4 hours.

    redeem <bitcoin-address>
        Initiates a deposit redemption flow that will redeem the deposit's
        BTC to the specified Bitcoin address. When the flow completes,
        outputs the deposit as a single tab-delimited line with the
        deposit address, current deposit state, deposit lot size in
        satoshis, and the transaction hash of the redemption Bitcoin
        transaction.

    courtesy-call
        Attempts to notify the deposit it is undercollateralized and
        should transition into courtesy call.

    liquidate [--for <setup-timeout|funding-timeout|undercollateralization|courtesy-timeout|redemption-signature-timeout|redemption-proof-timeout>]
        Attempts to liquidate the deposit, reporting back the status of
        the liquidation . By default, looks for any available reason to
        liquidate. When the flow completes, outputs the deposit as a
        single tab-delimited line with the deposit address, current
        deposit state, deposit lot size in satoshis, and the liquidation
        status (\`liquidated\`, \`in-auction\`, or \`failed\`).

        --for <setup-timeout|funding-timeout|undercollateralization|courtesy-timeout|redemption-signature-timeout|redemption-proof-timeout>
            If specified, only triggers liquidation for the specified
            reason. If the reason does not apply, reports \`not-applicable\`
            status.

    withdraw [--dry-run]
        Attempts to withdraw the current account's allowance from a tBTC
        deposit. Only the amount allowed for the current account is
        withdrawn. Outputs the withdrawn amount in wei once withdrawal
        is complete.

        --dry-run
            Outputs the amount that would be withdrawn in wei, but does
            not broadcast the transaction to withdraw it.`
]

/**
 * @param {Web3} web3 An initialized Web3 instance TBTC is configured to use.
 * @param {Array<string>} args
 * @return {CommandAction | null}
 */
export function parseDepositCommand(web3, args) {
  if (args.length > 0) {
    const [command, ...commandArgs] = args
    switch (command) {
      case "new":
        {
          const {
            found: { noMint },
            remaining: [lotSizeString]
          } = findAndConsumeArgsExistence(commandArgs, "--no-mint")

          const lotSizeSatoshis = lotSizeString && bnOrNull(web3, lotSizeString)
          if (lotSizeSatoshis) {
            return async tbtc => {
              return createDeposit(tbtc, lotSizeSatoshis, !noMint)
            }
          } else {
            console.error(
              "No lot size specified. Use lot-sizes to find available lot sizes."
            )
          }
        }
        break
      case "list": {
        const {
          found: { vendingMachine: listVendingMachine },
          remaining: postVendingMachine
        } = findAndConsumeArgsExistence(commandArgs, "--vending-machine")
        const {
          found: { address },
          remaining: postAddress
        } = findAndConsumeArgsValues(postVendingMachine, "--address")

        if (postAddress.length == 0) {
          if (address !== null && listVendingMachine) {
            console.error(
              "Vending machine and address flag cannot be specified together."
            )
            break
          }
          if (address !== null && !web3.utils.isAddress(address)) {
            console.error(`Address ${address} is not a valid Ethereum address.`)
            break
          }

          const explicitAddress = address
          return async tbtc => {
            const address = listVendingMachine
              ? tbtc.depositFactory.vendingMachine().options.address
              : explicitAddress !== null
              ? explicitAddress
              : web3.eth.defaultAccount

            return listDeposits(tbtc, address)
          }
        }
      }
      default:
        const depositAddress = command
        const [subcommand, ...subcommandArgs] = commandArgs
        if (!web3.utils.isAddress(depositAddress)) {
          console.error(
            `Deposit address ${depositAddress} is not a valid Ethereum address.`
          )
          break
        }
        if (typeof subcommand == "undefined") {
          return async tbtc =>
            standardDepositOutput(
              tbtc,
              await tbtc.Deposit.withAddress(depositAddress)
            )
        } else if (typeof commandParsers[subcommand] === "undefined") {
          console.error(
            `Invalid command after deposit address; command can be one of:\n` +
              `    ${Object.keys(commandParsers).join(", ")}`
          )
          break
        }

        return commandParsers[subcommand](depositAddress, subcommandArgs)
    }
  }

  // If we're here, no command matched.
  return null
}

/** @enum {{ states: DepositStates[], method: string }} */
const LIQUIDATION_HANDLERS = {
  "setup-timeout": {
    states: [DepositStates.AWAITING_SIGNER_SETUP],
    method: "notifySignerSetupFailed"
  },
  "funding-timeout": {
    states: [DepositStates.AWAITING_BTC_FUNDING_PROOF],
    method: "notifyFundingTimedOut"
  },
  undercollateralization: {
    states: [DepositStates.ACTIVE, DepositStates.COURTESY_CALL],
    method: "notifyUndercollateralizedLiquidation"
  },
  "courtesy-timeout": {
    states: [DepositStates.COURTESY_CALL],
    method: "notifyCourtesyCallExpired"
  },
  "redemption-signature-timeout": {
    states: [DepositStates.AWAITING_WITHDRAWAL_SIGNATURE],
    method: "notifyRedemptionSignatureTimedOut"
  },
  "redemption-proof-timeout": {
    states: [DepositStates.AWAITING_WITHDRAWAL_PROOF],
    method: "notifyRedemptionProofTimedOut"
  }
}

/** @typedef {keyof typeof LIQUIDATION_HANDLERS} AVAILABLE_LIQUIDATION_REASONS */

/**
 * @type {Object.<string,(depositAddress: string, args: string[])=>CommandAction | null>}
 */
const commandParsers = {
  redeem: (depositAddress, args) => {
    const [redemptionBitcoinAddress, ...remaining] = args

    if (!redemptionBitcoinAddress) {
      console.log("Bitcoin address required for redemption.")
      return null
    } else if (remaining.length > 0) {
      return null
    } else {
      return async tbtc => {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        return redeemDeposit(tbtc, deposit, redemptionBitcoinAddress)
      }
    }
  },
  "increase-redemption-fee": (depositAddress, args) => {
    if (args.length > 0) {
      return null
    } else {
      return async tbtc => {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        const redemption = await deposit.getCurrentRedemption()

        if (!redemption) {
          throw new Error(
            `failed to find current redemption for deposit ${depositAddress}`
          )
        }

        await redemption.increaseRedemptionFee()

        return standardDepositOutput(tbtc, deposit)
      }
    }
  },
  withdraw: (depositAddress, args) => {
    const { existence: onlyCall, remaining } = findAndConsumeArgExistence(
      args,
      "--dry-run"
    )

    if (remaining.length > 0) {
      return null
    } else {
      return async tbtc => withdrawFromDeposit(tbtc, depositAddress, onlyCall)
    }
  },
  resume: (depositAddress, args) => {
    const {
      found: { noMint, funding: onlyFunding, redemption: onlyRedemption },
      remaining
    } = findAndConsumeArgsExistence(
      args,
      "--no-mint",
      "--funding",
      "--redemption"
    )

    if (onlyFunding && onlyRedemption) {
      console.error(
        "--funding and --redemption cannot both be specified. Specify neither\n" +
          "if you want to resume all flows no matter the deposit state."
      )
      return null
    } else if (onlyRedemption && noMint) {
      console.error(
        "--redemption specified with --no-mint, but redemption cannot mint."
      )
      return null
    } else if (remaining.length > 0) {
      return null
    } else {
      return async tbtc =>
        resumeDeposit(
          tbtc,
          depositAddress,
          onlyFunding,
          onlyRedemption,
          !noMint
        )
    }
  },
  "courtesy-call": (depositAddress, args) => {
    if (args.length > 0) {
      return null
    } else {
      return async tbtc => {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        await deposit.notifyCourtesyCall()
        return standardDepositOutput(tbtc, deposit)
      }
    }
  },
  liquidate: (depositAddress, args) => {
    const {
      found: { for: liquidationReason },
      remaining
    } = findAndConsumeArgsValues(args, "--for")

    if (liquidationReason && !(liquidationReason in LIQUIDATION_HANDLERS)) {
      console.error(
        `Invalid liquidation reason: ${liquidationReason}; only one of these is allowed:\n` +
          `    ${Object.keys(LIQUIDATION_HANDLERS).join(", ")}`
      )
      return null
    } else if (remaining.length > 0) {
      return null
    } else {
      return async tbtc =>
        liquidateDeposit(
          tbtc,
          depositAddress,
          /** @type {AVAILABLE_LIQUIDATION_REASONS} */ (liquidationReason) ||
            undefined
        )
    }
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string | null} ownerAddress
 */
async function listDeposits(tbtc, ownerAddress) {
  return new Promise(async (resolve, reject) => {
    try {
      // Find tokens that were owned by the owner address at any point.
      const ownedDepositTokens = (
        await EthereumHelpers.getExistingEvents(
          tbtc.Deposit.depositToken(),
          "Transfer",
          { to: ownerAddress || "" }
        )
      ).map(
        (/** @type {any} */ _) => /** @type {string} */ (_.returnValues.tokenId)
      )

      // Filter out any that are no longer owned by the owner address.
      const stillOwned = (
        await Promise.all(
          /** @type Promise<[string, boolean]>[] */
          ownedDepositTokens.map(tokenId =>
            tbtc.Deposit.depositToken()
              .methods.ownerOf(tokenId)
              .call()
              .then((/** @type {string} */ _) => [tokenId, _ == ownerAddress])
          )
        )
      )
        .filter(([, ownedByVm]) => ownedByVm)
        .map(([tokenId]) => tokenId)

      const deposits = await Promise.all(
        stillOwned.map(_ => tbtc.Deposit.withTdtId(_))
      )

      const depositInfo = await Promise.all(
        deposits.map(async _ => {
          return standardDepositOutput(tbtc, _)
        })
      )

      resolve(depositInfo.join("\n"))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * @param {TBTCInstance} tbtc
 * @param {BN} satoshiLotSize
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function createDeposit(tbtc, satoshiLotSize, mintOnActive) {
  const deposit = await tbtc.Deposit.withSatoshiLotSize(satoshiLotSize)

  return runDeposit(tbtc, deposit, mintOnActive)
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {boolean} onlyFunding Only resume a funding flow for this deposit.
 * @param {boolean} onlyRedemption Only resume a redemption flow for this deposit.
 * @param {boolean} mintOnActive If in a funding flow, proceed to minting once
 *        deposit is qualified.
 * @return {Promise<string>}
 */
async function resumeDeposit(
  tbtc,
  depositAddress,
  onlyFunding,
  onlyRedemption,
  mintOnActive
) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const depositState = await deposit.getCurrentState()

  if (
    (onlyFunding && depositState >= tbtc.Deposit.State.ACTIVE) ||
    (onlyRedemption && depositState < tbtc.Deposit.State.ACTIVE)
  ) {
    throw new Error("Nothing to resume for deposit.")
  }

  const existingRedemptionDetails = await deposit.getLatestRedemptionDetails()
  if (existingRedemptionDetails) {
    return redeemDeposit(tbtc, deposit, existingRedemptionDetails)
  } else {
    return runDeposit(tbtc, deposit, mintOnActive)
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {Object} [alreadyResolved] When specified, carries information about
 *        already-resolved properties of the deposit.
 * @param {number} [alreadyResolved.state] The already-resolved state of the
 *        deposit.
 * @param {BN} [alreadyResolved.lotSizeSatoshis] The already-resolved lot size
 *        of the deposit, in satoshis.
 * @param {BN} [alreadyResolved.collateralization] The already-resolved
 *        collateralization percentage of the deposit, as an integer (with 100
 *        being 100%).
 */
async function standardDepositOutput(tbtc, deposit, alreadyResolved) {
  const resolved = alreadyResolved || {
    state: undefined,
    lotSizeSatoshis: undefined,
    collateralization: undefined
  }

  const depositState = resolved.state || (await deposit.getCurrentState())
  const stateName = tbtc.Deposit.stateById(depositState)
  const lotSize =
    resolved.lotSizeSatoshis || (await deposit.getLotSizeSatoshis())
  const collateralization =
    resolved.collateralization ||
    (await deposit.getCollateralizationPercentage())

  return [
    deposit.address,
    stateName,
    lotSize.toString().padEnd(8),
    collateralization
  ].join("\t")
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {RedemptionDetails | string} redemptionInfo When RedemptionDetails,
 *        the details on the existing redemption that should be resumed. When a
 *        string, the Bitcoin address the receiver would like to receive
 *        redeemed BTC at.
 * @return {Promise<string>}
 */
async function redeemDeposit(tbtc, deposit, redemptionInfo) {
  return new Promise(async (resolve, reject) => {
    try {
      let redemption
      if (typeof redemptionInfo == "string") {
        redemption = await deposit.requestRedemption(redemptionInfo)
      } else {
        redemption = new Redemption(deposit, redemptionInfo)
      }
      redemption.autoSubmit()

      redemption.onWithdrawn(async transactionID => {
        resolve(
          (await standardDepositOutput(tbtc, deposit)) + "\t" + transactionID
        )
      })
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function runDeposit(tbtc, deposit, mintOnActive) {
  deposit.onError(console.error)

  deposit.autoSubmit()

  return new Promise(async (resolve, reject) => {
    deposit.onBitcoinAddressAvailable(async address => {
      // TODO Create a flow where output can be easily used to automate.
      try {
        const lotSize = await deposit.getLotSizeSatoshis()
        console.log(
          "\tGot deposit address:",
          address,
          "; fund with:",
          lotSize.toString(),
          "satoshis please."
        )
        console.log("Now monitoring for deposit transaction...")
      } catch (err) {
        reject(err)
      }
    })

    deposit.onActive(async () => {
      try {
        if (mintOnActive) {
          // TODO Create a flow where output can be easily used to automate.
          console.log("Deposit is active, minting...")
          const mintedTbtc = await deposit.mintTBTC()

          resolve(
            (await standardDepositOutput(tbtc, deposit)) +
              "\t" +
              mintedTbtc.toString()
          )
        } else {
          resolve(await standardDepositOutput(tbtc, deposit))
        }
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * Executes a command to withdraw the ETH available to the current account from
 * the given deposit. If `onlyCall` is specified and passed as `true`, only
 * checks the available amount without sending a transaction to withdraw it.
 *
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress The address of
 * @param {boolean} [onlyCall]
 */
async function withdrawFromDeposit(tbtc, depositAddress, onlyCall) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const method = deposit.contract.methods.withdrawFunds()

  if (onlyCall) {
    return await method.call()
  } else {
    return await EthereumHelpers.sendSafely(method, {
      from: tbtc.config.web3.eth.defaultAccount || undefined
    })
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {AVAILABLE_LIQUIDATION_REASONS} [liquidationReason]
 */
async function liquidateDeposit(tbtc, depositAddress, liquidationReason) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const depositState = await deposit.getCurrentState()

  if (liquidationReason) {
    const { states, method } = LIQUIDATION_HANDLERS[liquidationReason]
    if (states.includes(depositState)) {
      await EthereumHelpers.sendSafely(deposit.contract.methods[method](), {
        from: tbtc.config.web3.eth.defaultAccount || undefined
      })
      return standardDepositOutput(tbtc, deposit)
    } else {
      throw new Error(
        `Deposit is not in a state that allows ${liquidationReason} liquidation.`
      )
    }
  } else {
    const depositStateName = tbtc.Deposit.stateById(depositState)
    const matchingHandler = Object.values(
      LIQUIDATION_HANDLERS
    ).find(({ states }) => states.includes(depositState))

    if (matchingHandler) {
      const { method } = matchingHandler
      console.debug(
        `Attempting to liquidate deposit based on state ${depositStateName} using ${method}.`
      )

      await EthereumHelpers.sendSafely(deposit.contract.methods[method](), {
        from: tbtc.config.web3.eth.defaultAccount || undefined
      })
      return standardDepositOutput(tbtc, deposit)
    } else {
      throw new Error(
        `Could not find a possible liquidation strategy for deposit state ${depositStateName}`
      )
    }
  }
}

/**
 * Converts the given string to a `BN` instance, or returns `null` if that
 * fails.
 *
 * @param {Web3} web3 The web3 instance to use for BN conversion.
 * @param {string} str The string to potentially convert to `BN`.
 * @return {BN?} The `BN` instance for the string, or `null` if the string could
 *         not be converted.
 */
function bnOrNull(web3, str) {
  try {
    return web3.utils.toBN(str)
  } catch (_) {
    return null
  }
}
